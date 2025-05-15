const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
const path = require("path");
const twilio = require("twilio");
// Add Firebase Admin SDK for push notifications
const admin = require("firebase-admin");
// Add Stripe initialization
const Stripe = require("stripe");

// Import database connection pool (previously commented out)
const pool = require("./app/config/dbconfig");

dotenv.config();

// Initialize Stripe with your secret key
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

admin.initializeApp({
  credential: admin.credential.cert({
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
  }),
});
// FCM token store to manage user device tokens
// In production, store these in a database
const fcmTokenStore = {
  tokens: {},

  // Register a token for a user
  registerToken: function (userId, platform, token) {
    if (!this.tokens[userId]) {
      this.tokens[userId] = [];
    }

    // Check if token already exists
    const existingToken = this.tokens[userId].find((t) => t.token === token);
    if (!existingToken) {
      this.tokens[userId].push({ platform, token, lastUpdated: Date.now() });
    } else {
      // Update existing token's timestamp
      existingToken.lastUpdated = Date.now();
      existingToken.platform = platform;
    }

    return this.tokens[userId];
  },

  // Get tokens for a user
  getTokens: function (userId) {
    return this.tokens[userId] || [];
  },

  // Remove a token
  removeToken: function (userId, token) {
    if (this.tokens[userId]) {
      this.tokens[userId] = this.tokens[userId].filter(
        (t) => t.token !== token
      );
    }
  },
};

// Helper function to send push notifications for incoming calls
async function sendCallNotification(userId, callData) {
  try {
    // Skip if Firebase Admin SDK is not initialized
    if (!admin.messaging) {
      console.log(
        "Firebase Admin SDK not initialized, skipping push notification"
      );
      return false;
    }

    // Get user's FCM tokens
    const userTokens = fcmTokenStore.getTokens(userId);

    if (!userTokens || userTokens.length === 0) {
      console.log(`No FCM tokens found for user ${userId}`);
      return false;
    }

    console.log(
      `Sending push notification to user ${userId} with ${userTokens.length} devices`
    );

    // Send to all user devices
    const sendPromises = userTokens.map(async (tokenData) => {
      try {
        // Prepare notification payload based on platform
        let message = {
          token: tokenData.token,
          data: {
            type: "incomingCall",
            callerId: callData.from || "Unknown",
            callSid: callData.callSid || "",
            callerName: callData.callerName || "Unknown Caller",
            timestamp: Date.now().toString(),
          },
        };

        // Add platform-specific configurations
        if (tokenData.platform.toLowerCase() === "android") {
          message.android = {
            priority: "high",
            notification: {
              channelId: "incoming_calls",
              priority: "high",
            },
          };
        } else if (tokenData.platform.toLowerCase() === "ios") {
          message.apns = {
            payload: {
              aps: {
                contentAvailable: true,
                sound: "default",
                badge: 1,
                alert: {
                  title: "Incoming Call",
                  body: `Call from ${
                    callData.callerName || callData.from || "Unknown"
                  }`,
                },
              },
            },
            headers: {
              "apns-push-type": "voip",
              "apns-priority": "10",
              "apns-topic": `${process.env.IOS_BUNDLE_ID}.voip`,
            },
          };
        }

        // Send the notification
        const response = await admin.messaging().send(message);
        console.log(`Successfully sent notification to device: ${response}`);
        return true;
      } catch (error) {
        console.error(
          `Error sending notification to device ${tokenData.token.substring(
            0,
            10
          )}...`,
          error
        );

        // If the token is invalid, remove it
        if (
          error.code === "messaging/invalid-registration-token" ||
          error.code === "messaging/registration-token-not-registered"
        ) {
          fcmTokenStore.removeToken(userId, tokenData.token);
        }

        return false;
      }
    });

    const results = await Promise.all(sendPromises);
    return results.some((result) => result === true);
  } catch (error) {
    console.error("Error in sendCallNotification:", error);
    return false;
  }
}

const {
  jwt: { AccessToken },
  twiml,
} = require("twilio");

// In-memory call tracking store for managing call state
// In production, consider using Redis or a database
const callStore = {
  calls: {},

  // Add or update a call in the store
  trackCall: function (callSid, data = {}) {
    if (!this.calls[callSid]) {
      this.calls[callSid] = {
        startTime: Date.now(),
        status: "initiated",
        duration: 0,
        ...data,
      };
    } else {
      this.calls[callSid] = {
        ...this.calls[callSid],
        ...data,
      };
    }
    return this.calls[callSid];
  },

  // Update call status
  updateStatus: function (callSid, status) {
    if (this.calls[callSid]) {
      this.calls[callSid].status = status;

      // Calculate duration if call is completed
      if (status === "completed" && this.calls[callSid].startTime) {
        const duration = Math.floor(
          (Date.now() - this.calls[callSid].startTime) / 1000
        );
        this.calls[callSid].duration = duration;
      }

      // Start tracking duration when call is answered
      if (status === "in-progress" && !this.calls[callSid].answeredAt) {
        this.calls[callSid].answeredAt = Date.now();
      }
    }
    return this.calls[callSid];
  },

  // Get call details
  getCall: function (callSid) {
    return this.calls[callSid];
  },

  // Calculate current duration for active calls
  calculateDuration: function (callSid) {
    const call = this.calls[callSid];
    if (!call) return 0;

    if (call.status === "completed") {
      return call.duration;
    }

    if (call.answeredAt) {
      return Math.floor((Date.now() - call.answeredAt) / 1000);
    }

    return 0;
  },

  // Remove call from store
  removeCall: function (callSid) {
    const call = this.calls[callSid];
    delete this.calls[callSid];
    return call;
  },
};

const app = express();
// const port = 3091;
const port = 3091;

// Twilio Config
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const appSid = process.env.TWILIO_APP_SID;
const callerId = process.env.TWILIO_CALLER_ID;

// Configure CORS properly - place this before any routes
// This will handle OPTIONS preflight and set proper headers for all routes
app.use(
  cors({
    origin: "*", // Allow any origin for testing in Postman
    methods: ["GET", "POST", "DELETE", "UPDATE", "PUT", "PATCH", "OPTIONS"],
    credentials: true, // Allow credentials
    allowedHeaders:
      "Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin",
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// Set up middleware first, before any routes
app.use(express.json());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Special middleware for Twilio webhooks
app.use("/call/incoming", bodyParser.urlencoded({ extended: false }));
app.use("/twiml", bodyParser.urlencoded({ extended: false }));
app.use("/call-action", bodyParser.urlencoded({ extended: false }));

// Add middleware to ensure proper JSON handling for API routes
// app.use('/token', (req, res, next) => {
//   res.set('Content-Type', 'application/json; charset=utf-8');
//   next();
// });

// Set up EJS as the template engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "app/views"));
const backend_url = process.env.BACKEND_URL || "http://localhost:3091";

// Helper: Generate Twilio Access Token
const generateAccessToken = (identity) => {
  try {
    // Create an Access Token
    const token = new AccessToken(
      accountSid,
      apiKey,
      apiSecret,
      { identity: identity, ttl: 3600 * 24 } // 24 hour token lifetime
    );

    // Create a Voice grant and add it to the token
    const voiceGrant = new AccessToken.VoiceGrant({
      outgoingApplicationSid: appSid,
      incomingAllow: true, // Allow incoming calls
    });

    // Add the grant to the token
    token.addGrant(voiceGrant);

    console.log(`Generated token for identity: ${identity}`);
    return token.toJwt();
  } catch (error) {
    console.error("Error generating token:", error);
    throw error;
  }
};

// Route: Generate Access Token
app.get("/token", (req, res) => {
  const identity = req.query.identity;
  if (!identity) {
    return res.status(400).json({ error: "Identity is required" });
  }
  try {
    const token = generateAccessToken(identity);
    console.log("token", token);

    // Use res.json() instead of manually setting header and stringifying
    return res.json({
      identity,
      token,
    });
  } catch (error) {
    console.error("Token generation error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Route: Handle Incoming Call (Webhook)
app.post("/call/incoming", async (req, res) => {
  console.log("Incoming call webhook received:", req.body);

  const voiceResponse = new twiml.VoiceResponse();
  const client = await pool.connect();

  try {
    // Get the parameters from the request
    const to = req.body.To; // The Twilio number that was called
    const from = req.body.From; // The number that initiated the call
    const callSid = req.body.CallSid;

    // Track the call in the store
    callStore.trackCall(callSid, { from, to });

    // Extract custom parameters if included in the TwiML app configuration
    // These parameters can be set in the Twilio console or via API
    let userId = req.body.userId || req.query.userId;
    const clientIdentity = req.body.identity || req.query.identity;

    console.log(`Incoming call ${callSid} from ${from} to ${to}`);
    console.log(`Custom params: userId=${userId}, identity=${clientIdentity}`);

    // IMPORTANT: Look up the user associated with this Twilio number in our database
    let targetEmail = null;
    let targetUserId = userId;

    try {
      // First, try to find the user by the Twilio number
      if (to) {
        const formattedTo = to.trim(); // Ensure no leading/trailing spaces
        const numberLookupQuery = await client.query(
          `SELECT user_id, email FROM twilio_number_mapping WHERE twilio_number = $1 AND is_active = true`,
          [formattedTo]
        );
        console.log("to data", to, numberLookupQuery.rows);

        if (numberLookupQuery.rows.length > 0) {
          targetUserId = numberLookupQuery.rows[0].user_id;
          targetEmail = numberLookupQuery.rows[0].email;
          console.log(
            `✅ Found user ID ${targetUserId} with email ${targetEmail} for Twilio number ${formattedTo}`
          );
        } else {
          console.warn(`⚠️ No user found for Twilio number: ${formattedTo}`);
        }
      }

      //     if (to) {
      //       // const numberLookupQuery = await client.query(
      //       //   `SELECT user_id, email FROM twilio_number_mapping WHERE twilio_number = $1 AND is_active = true`,
      //       //   [to]
      //       // );
      //       const numberLookupQuery = await client.query(
      //         `SELECT u.id as user_id, u.email
      //  FROM user_numbers un
      //  JOIN Users u ON u.id = un.user_id
      //  WHERE un.number = $1`,
      //         [to]
      //       );
      //       console.log("to data", to, numberLookupQuery.rows);
      //       if (numberLookupQuery.rows.length > 0) {
      //         targetUserId = numberLookupQuery.rows[0].user_id;
      //         targetEmail = numberLookupQuery.rows[0].email;
      //         console.log(
      //           `Found user ID ${targetUserId} with email ${targetEmail} for Twilio number ${to}`
      //         );
      //       } else {
      //         console.log(`No user found for Twilio number ${to} in database`);
      //       }
      //     }

      // If still no user found, try to determine from clientIdentity
      if (!targetUserId && !targetEmail && clientIdentity) {
        // Check if clientIdentity is an email
        if (clientIdentity.includes("@")) {
          targetEmail = clientIdentity;
          const userQuery = await client.query(
            `SELECT id FROM Users WHERE email = $1`,
            [targetEmail]
          );

          if (userQuery.rows.length > 0) {
            targetUserId = userQuery.rows[0].id;
          }
        } else {
          // Try to look up user by clientIdentity if it's user_XXX format
          if (clientIdentity.startsWith("user_")) {
            const userIdPart = clientIdentity.split("_")[1];
            if (userIdPart) {
              const userQuery = await client.query(
                `SELECT id, email FROM Users WHERE id = $1`,
                [userIdPart]
              );

              if (userQuery.rows.length > 0) {
                targetUserId = userQuery.rows[0].id;
                targetEmail = userQuery.rows[0].email;
              }
            }
          }
        }
      }

      // If no user ID, but we have email, try to get user ID from email
      if (!targetUserId && targetEmail) {
        const userQuery = await client.query(
          `SELECT id FROM Users WHERE email = $1`,
          [targetEmail]
        );

        if (userQuery.rows.length > 0) {
          targetUserId = userQuery.rows[0].id;
        }
      }

      // If we still don't have a user ID or email, use the default pattern
      if (!targetUserId && !targetEmail && to) {
        const numberIdentifier = to.replace(/[^\d]/g, "");
        targetUserId = `user_${numberIdentifier}`;
      }

      console.log(
        `Resolved target user: ID=${targetUserId}, Email=${targetEmail}`
      );
    } catch (dbError) {
      console.error("Database error looking up user:", dbError);
      // Continue with call handling even if DB lookup fails
    }

    // Send push notification if we have a targetUserId or targetEmail
    let notificationSent = false;

    if (targetUserId || targetEmail) {
      try {
        console.log(
          `Attempting to send push notification to user ${
            targetUserId || targetEmail
          }`
        );

        // Extract caller name from caller ID info if available
        const callerName = req.body.CallerName || "Unknown Caller";

        // Get FCM tokens from database
        let deviceTokens = [];

        if (targetUserId) {
          // Try to get tokens by user ID
          const tokenQuery = await client.query(
            `SELECT device_token, platform FROM device_tokens WHERE user_id = $1`,
            [targetUserId]
          );

          if (tokenQuery.rows.length > 0) {
            deviceTokens = tokenQuery.rows;
          }
        }

        // If no tokens found by ID and we have email, try by email
        if (deviceTokens.length === 0 && targetEmail) {
          const tokenQuery = await client.query(
            `SELECT device_token, platform FROM device_tokens WHERE email = $1`,
            [targetEmail]
          );

          if (tokenQuery.rows.length > 0) {
            deviceTokens = tokenQuery.rows;
          }
        }

        // If we found tokens in the database, register them in memory for immediate use
        if (deviceTokens.length > 0) {
          console.log(`Found ${deviceTokens.length} device tokens in database`);

          // Register tokens in memory store
          deviceTokens.forEach((token) => {
            if (targetUserId) {
              fcmTokenStore.registerToken(
                targetUserId.toString(),
                token.platform,
                token.device_token
              );
            }
            if (targetEmail) {
              fcmTokenStore.registerToken(
                targetEmail,
                token.platform,
                token.device_token
              );
            }
          });

          // Try sending notification with user ID
          if (targetUserId) {
            notificationSent = await sendCallNotification(
              targetUserId.toString(),
              {
                from: from,
                callSid: callSid,
                callerName: callerName,
              }
            );
          }

          // If that failed and we have email, try with email
          if (!notificationSent && targetEmail) {
            notificationSent = await sendCallNotification(targetEmail, {
              from: from,
              callSid: callSid,
              callerName: callerName,
            });
          }
        } else {
          console.log(
            `No device tokens found in database for ${
              targetUserId || targetEmail
            }`
          );
        }

        // Log the call notification in the database
        await client.query(
          `INSERT INTO call_logs
           (call_sid, from_number, to_number, user_id, direction, status, notification_sent, notification_timestamp, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [
            callSid,
            from,
            to,
            targetUserId,
            "inbound",
            "ringing",
            notificationSent,
            notificationSent ? new Date() : null,
          ]
        );

        if (notificationSent) {
          console.log(
            `Successfully sent push notification to user ${
              targetUserId || targetEmail
            }`
          );
        } else {
          console.log(
            `No push notification sent for user ${
              targetUserId || targetEmail
            } - no registered devices`
          );
        }
      } catch (notifError) {
        console.error(`Error sending push notification: ${notifError.message}`);
        // Continue with call handling even if notification fails
      }
    }

    // Client-to-client calls (app-to-app)
    if (to && to.indexOf("client:") === 0) {
      const client = to.split(":")[1];
      const dial = voiceResponse.dial({
        callerId: from || callerId,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client(client);
      console.log(`Routing call to client: ${client}`);
    }
    // If we have a specific client identity passed as a parameter
    else if (clientIdentity) {
      voiceResponse.say(
        "Thanks for calling. Please wait while we connect you."
      );
      const dial = voiceResponse.dial({
        callerId: from || callerId,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client(clientIdentity);
      console.log(`Routing call to specified client: ${clientIdentity}`);
    }
    // If we resolved a target user/email from our database
    else if (
      targetEmail ||
      (targetUserId && typeof targetUserId === "number")
    ) {
      // Construct client identity based on email or user ID
      const targetClientId = targetEmail
        ? targetEmail.split("@")[0] // Use first part of email
        : `user_${targetUserId}`; // Use user ID with prefix

      voiceResponse.say(
        "Thanks for calling. Please wait while we connect you."
      );
      const dial = voiceResponse.dial({
        callerId: from || callerId,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client(targetClientId);
      console.log(
        `Routing call to database-resolved client: ${targetClientId}`
      );
    }
    // Default case - use the To number (without the +) as part of the client identity
    else {
      // Extract the number without the + sign
      const numberIdentifier = to.replace(/[^\d]/g, "");

      // Construct a client identity based on the Twilio number
      // Frontend should register with a token using this same pattern
      const targetClientId = `user_${numberIdentifier}`;

      voiceResponse.say(
        "Thanks for calling. Please wait while we connect you."
      );
      const dial = voiceResponse.dial({
        callerId: from || callerId,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client(targetClientId);
      console.log(`Routing call to number-based client: ${targetClientId}`);
    }
  } catch (error) {
    console.error("Error in call/incoming:", error);
    voiceResponse.say(
      "Sorry, an error occurred while processing your call. Please try again later."
    );
  } finally {
    // Make sure to release the database connection
    client.release();
  }

  console.log("TwiML response:", voiceResponse.toString());
  res.type("text/xml");
  res.send(voiceResponse.toString());
});

// Add endpoint to handle dial action results
app.post("/call-action-result", (req, res) => {
  console.log("Call action result received:", req.body);
  const dialCallStatus = req.body.DialCallStatus;

  const voiceResponse = new twiml.VoiceResponse();

  // Handle different dial outcomes
  if (dialCallStatus === "no-answer") {
    voiceResponse.say(
      "The person you are calling is not available. Please try again later."
    );
  } else if (dialCallStatus === "failed") {
    voiceResponse.say(
      "We could not connect your call. Please try again later."
    );
  } else if (dialCallStatus === "busy") {
    voiceResponse.say(
      "The person you are calling is busy. Please try again later."
    );
  } else if (dialCallStatus === "canceled") {
    voiceResponse.say("The call was canceled.");
  }

  voiceResponse.hangup();

  res.type("text/xml");
  res.send(voiceResponse.toString());
});

// Route: Make Outgoing Call

// Improve the TwiML response for outgoing calls
app.post("/twiml", (req, res) => {
  console.log("TwiML endpoint called with body:", req.body);

  try {
    const voiceResponse = new twiml.VoiceResponse();

    // Get the To parameter (who we're calling)
    const to = req.body.To || "";
    const from = req.body.From || "";

    console.log(`Call from ${from} to ${to}`);

    // Add defensive check for empty 'to' parameter
    if (!to) {
      console.error("Missing 'to' parameter in TwiML request");
      voiceResponse.say(
        "Sorry, we couldn't determine who to call. Please try again."
      );
      voiceResponse.hangup();
      res.type("text/xml");
      return res.send(voiceResponse.toString());
    }

    // Check if we're calling a client (app user) or regular number
    if (to.indexOf("client:") === 0) {
      // This is a call to another app user
      const clientId = to.split(":")[1];
      voiceResponse.say("Connecting you to another user.");

      const dial = voiceResponse.dial({
        callerId: from,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
        // Record the call if needed
        // record: 'record-from-answer',
      });
      dial.client(clientId);
      console.log(`Connecting to client: ${clientId}`);
    } else {
      // This is a call to a regular phone number
      voiceResponse.say("Connecting your call.");

      const dial = voiceResponse.dial({
        callerId: from,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
        // Record the call if needed
        // record: 'record-from-answer',
      });
      dial.number(to);
      console.log(`Connecting to number: ${to}`);
    }

    console.log("Generated TwiML:", voiceResponse.toString());
    res.type("text/xml");
    res.send(voiceResponse.toString());
  } catch (error) {
    console.error("Error in /twiml:", error);
    const errorResponse = new twiml.VoiceResponse();
    errorResponse.say(
      "Sorry, there was a technical problem. Please try again later."
    );
    res.type("text/xml");
    res.status(500).send(errorResponse.toString());
  }
});

// Fix: Initialize Twilio client properly with Account SID and Auth Token
// Note: For API Key auth, need to use different initialization method
let twilioClient;
try {
  // First try initializing with Account SID and Auth Token
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    console.log("Initializing Twilio client with Account SID and Auth Token");
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  // Fall back to API Key authentication if available
  else if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_API_KEY &&
    process.env.TWILIO_API_SECRET
  ) {
    console.log("Initializing Twilio client with API Key and Secret");
    twilioClient = twilio(
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
      }
    );
  } else {
    console.error("Missing required Twilio credentials!");
  }
} catch (error) {
  console.error("Error initializing Twilio client:", error.message);
}

app.post("/call/make", async (req, res) => {
  const { to, from, fromIdentity } = req.body;

  if (!to) {
    console.log("Missing 'to' parameter.");
    return res.status(400).json({ error: "Missing 'to' parameter." });
  }

  try {
    // Use the backend_url from environment variable as the base for all webhook URLs
    // This ensures that Twilio can reach your server regardless of where the request comes from
    const twimlUrl = `${backend_url}/twiml`;
    const statusCallback = `${backend_url}/call-status`;

    console.log("Using TwiML URL:", twimlUrl);
    console.log("Using status callback URL:", statusCallback);

    // Add debug logging to help identify issues
    console.log("Twilio credentials:", {
      sid: process.env.TWILIO_ACCOUNT_SID ? "exists" : "missing",
      token: process.env.TWILIO_AUTH_TOKEN ? "exists" : "missing",
    });

    const call = await twilioClient.calls.create({
      url: twimlUrl,
      to: to,
      from: from,
      statusCallback: statusCallback,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    // Extract destination identity for client calls
    let toIdentity = null;
    if (to.startsWith("client:")) {
      toIdentity = to.split(":")[1];
    }

    // Track the call in the store with identity information
    callStore.trackCall(call.sid, {
      from,
      to,
      fromIdentity: fromIdentity || null,
      toIdentity: toIdentity,
      direction: "outbound",
    });

    console.log("Call initiated:", call.sid);
    return res.status(200).json({
      success: true,
      sid: call.sid,
      message: "Call initiated successfully",
    });
  } catch (error) {
    console.error("Twilio error:", error.message);
    // Check for specific Twilio error codes
    let message = error.message;
    if (error.code) {
      switch (error.code) {
        case 21211:
          message = "Invalid 'to' phone number format";
          break;
        case 21214:
          message = "To phone number is not a valid or verified number";
          break;
        case 20404:
          message = "Twilio configuration issue - check your account";
          break;
        default:
          message = `Twilio error (code: ${error.code}): ${error.message}`;
      }
    }

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

// Add a route to handle call status callbacks
app.post("/call-status", (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log(`Call ${callSid} status update: ${callStatus}`);
  console.log("Call status details:", req.body);

  // Update call status in the store
  callStore.updateStatus(callSid, callStatus);

  // Always respond with 200 to Twilio callbacks
  res.status(200).send("OK");
});
// Add this route to handle ending calls
app.post("/call/end", async (req, res) => {
  try {
    const { callSid } = req.body;

    // If no callSid is provided, return an error
    if (!callSid) {
      console.log("Missing callSid parameter");
      return res.status(400).json({
        success: false,
        error: "Missing callSid parameter",
      });
    }

    console.log(`Attempting to end call with SID: ${callSid}`);

    // Use Twilio client to update the call status to 'completed' (this ends the call)
    await twilioClient.calls(callSid).update({ status: "completed" });

    // Remove the call from the store
    callStore.removeCall(callSid);

    console.log(`Successfully ended call: ${callSid}`);

    return res.status(200).json({
      success: true,
      message: "Call ended successfully",
    });
  } catch (error) {
    console.error("Error ending call:", error.message);

    return res.status(500).json({
      success: false,
      error: `Failed to end call: ${error.message}`,
    });
  }
});
// Add a new route to handle DTMF input during calls
app.post("/call-action", (req, res) => {
  console.log("Call action received:", req.body);

  const voiceResponse = new twiml.VoiceResponse();
  voiceResponse.say("Thank you for your input. Ending the call now.");
  voiceResponse.hangup();

  res.type("text/xml");
  res.send(voiceResponse.toString());
});
// Add support for push notifications in React Native apps
app.post("/register-push-notification", async (req, res) => {
  try {
    const { identity, platform, deviceToken } = req.body;

    if (!identity || !platform || !deviceToken) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: identity, platform, deviceToken",
      });
    }

    console.log(
      `Registering push notification for ${identity} on ${platform} with token: ${deviceToken.substring(
        0,
        10
      )}...`
    );

    // For production, you would store this token in your database and associate it with the user
    // And register it with Twilio's notification service

    // For iOS (APNs)
    if (platform.toLowerCase() === "ios") {
      // In a production app, you would register this with Twilio
      console.log("Registering iOS device for push notifications");
    }

    // For Android (FCM)
    if (platform.toLowerCase() === "android") {
      // In a production app, you would register this with Twilio
      console.log("Registering Android device for push notifications");
    }

    return res.json({
      success: true,
      message: `Push notification registered for ${platform}`,
    });
  } catch (error) {
    console.error("Error registering push notification:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
// Add support for push notifications in React Native apps
app.post("/register-fcm-token", async (req, res) => {
  try {
    const { userId, platform, token } = req.body;

    if (!userId || !platform || !token) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: userId, platform, token",
      });
    }

    console.log(
      `Registering FCM token for user ${userId} on ${platform}: ${token.substring(
        0,
        10
      )}...`
    );

    // Register the token in our token store
    fcmTokenStore.registerToken(userId, platform, token);

    return res.json({
      success: true,
      message: `FCM token registered for ${platform}`,
      registeredTokens: fcmTokenStore.getTokens(userId).length,
    });
  } catch (error) {
    console.error("Error registering FCM token:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Add the new API endpoint for device token registration as per workflow requirements
app.post("/register-device-token", async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, device_token, platform, device_name, app_version } =
      req.body;

    if (!email || !device_token || !platform) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: email, device_token, platform",
      });
    }

    console.log(
      `Registering device token for ${email} on ${platform}: ${device_token.substring(
        0,
        10
      )}...`
    );

    // First, check if the user exists by email
    const userQuery = await client.query(
      "SELECT id FROM Users WHERE email = $1",
      [email]
    );

    let userId = null;
    // If user exists, use their ID
    if (userQuery.rows.length > 0) {
      userId = userQuery.rows[0].id;
      console.log(`Found existing user with ID ${userId} for email ${email}`);
    } else {
      // If user doesn't exist, create a new user with auto-incrementing ID
      console.log(`User with email ${email} not found, creating new user...`);

      const newUserResult = await client.query(
        `INSERT INTO Users 
         (email, name, role, signup_type, created_at, updated_at) 
         VALUES ($1, $2, 'user', 'device_token', NOW(), NOW()) 
         RETURNING id`,
        [email, email.split("@")[0]] // Use part before @ as default name
      );

      if (newUserResult.rows.length > 0) {
        userId = newUserResult.rows[0].id;
        console.log(`Created new user with ID ${userId} for email ${email}`);
      } else {
        console.log(`Failed to create user for email ${email}`);
      }
    }

    // No need to check for existing token, as we allow duplicates now
    // Just insert a new record for this user and token
    const insertResult = await client.query(
      `INSERT INTO device_tokens 
       (user_id, email, device_token, platform, device_name, app_version) 
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, email, device_token, platform, device_name, app_version]
    );

    let tokenId = null;
    if (insertResult.rows.length > 0) {
      tokenId = insertResult.rows[0].id;
      console.log(
        `Inserted new device token with ID ${tokenId} for user ID ${userId}`
      );
    }

    // Register in memory store as well for immediate use
    if (userId) {
      fcmTokenStore.registerToken(userId.toString(), platform, device_token);
      fcmTokenStore.registerToken(email, platform, device_token);
    }

    // Get all tokens for this user
    const userTokensQuery = await client.query(
      `SELECT * FROM device_tokens WHERE user_id = $1 ORDER BY id`,
      [userId]
    );

    return res.json({
      success: true,
      message: `Device token registered successfully for ${platform}`,
      userId: userId,
      tokenId: tokenId,
      tokenCount: userTokensQuery.rows.length,
      tokens: userTokensQuery.rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        device_token: `${row.device_token.substring(0, 10)}...`,
        created_at: row.created_at,
      })),
    });
  } catch (error) {
    console.error("Error registering device token:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// Endpoint to list registered FCM tokens (for debugging purposes)
app.get("/fcm-tokens/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    const tokens = fcmTokenStore.getTokens(userId);

    return res.json({
      success: true,
      userId,
      tokenCount: tokens.length,
      tokens: tokens.map((t) => ({
        platform: t.platform,
        token: `${t.token.substring(0, 10)}...${t.token.substring(
          t.token.length - 5
        )}`,
        lastUpdated: new Date(t.lastUpdated).toISOString(),
      })),
    });
  } catch (error) {
    console.error("Error retrieving FCM tokens:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Add API endpoint for syncing purchased phone numbers
app.post("/sync-purchased-number", async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, twilio_number, friendly_name } = req.body;

    if (!email || !twilio_number) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameters: email, twilio_number",
      });
    }

    // First, check if the user exists by email
    const userQuery = await client.query(
      "SELECT id FROM Users WHERE email = $1",
      [email]
    );

    let userId = null;
    if (userQuery.rows.length > 0) {
      userId = userQuery.rows[0].id;
    } else {
      return res.status(404).json({
        success: false,
        error: "User not found with the provided email",
      });
    }

    // Check if the number already exists in the mapping table
    const numberQuery = await client.query(
      "SELECT id FROM twilio_number_mapping WHERE twilio_number = $1",
      [twilio_number]
    );

    if (numberQuery.rows.length > 0) {
      // Update existing number mapping
      await client.query(
        `UPDATE twilio_number_mapping 
         SET user_id = $1, 
             email = $2,
             friendly_name = $3,
             is_active = true,
             updated_at = NOW()
         WHERE twilio_number = $4`,
        [userId, email, friendly_name || twilio_number, twilio_number]
      );
    } else {
      // Insert new number mapping
      await client.query(
        `INSERT INTO twilio_number_mapping
         (user_id, email, twilio_number, friendly_name, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [userId, email, twilio_number, friendly_name || twilio_number]
      );
    }

    console.log(
      `Synced Twilio number ${twilio_number} for user ${email} (ID: ${userId})`
    );

    return res.json({
      success: true,
      message: "Twilio number synced successfully",
      userId,
      twilio_number,
    });
  } catch (error) {
    console.error("Error syncing Twilio number:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    client.release();
  }
});

app.all("/*", (req, res, next) => {
  // Check if this is a Twilio request by looking for common Twilio parameters
  const isTwilioRequest =
    (req.body && (req.body.CallSid || req.body.AccountSid)) ||
    (req.query && (req.query.CallSid || req.query.AccountSid));

  if (isTwilioRequest) {
    console.log(
      `Unhandled Twilio callback to ${req.path}:`,
      req.method === "POST" ? req.body : req.query
    );
    return res.status(200).send("OK");
  }

  // If not a Twilio request, pass through to the next middleware
  next();
});
app.use(
  "/subscription",
  require("./app/routes/subscription/subscriptionRoutes")
);

// Add payment routes for Stripe Payment Intent
app.post("/create-payment-intent", async (req, res) => {
  const client = await pool.connect();
  try {
    const { amount, currency = "usd", email } = req.body;

    let customer;

    // Create a new Stripe customer if none exists
    customer = await stripe.customers.create({
      email,
      description: "App User",
    });

    console.log(`New Stripe Customer Created: ${customer.id}`);

    // Generate an Ephemeral Key
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2023-10-16" }
    );

    // Create a Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // Convert to cents
      currency,
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
    });

    return res.json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id, // Stripe customer ID
      paymentIntent2: paymentIntent,
    });
  } catch (error) {
    console.error("Stripe Error:", error);
    res.status(500).json({ error: true, message: error.message });
  } finally {
    client.release();
  }
});
app.get("/", (req, res) => {
  res.json({ error: false, message: `Server is running on port ${port}.` });
});

// Add the route to handle the success page
app.get("/success", (req, res) => {
  const { session_id } = req.query;

  res.render("success", {
    session_id,
  });
});

// Add route to get call information (status, duration, etc)
app.get("/call/info/:callSid", async (req, res) => {
  try {
    const callSid = req.params.callSid;

    if (!callSid) {
      return res.status(400).json({
        success: false,
        error: "Call SID is required",
      });
    }

    // First check our local store for the call info
    let callInfo = callStore.getCall(callSid);

    // If we have local info, enhance it with latest info from Twilio API
    if (callInfo) {
      try {
        // Get the latest call details from Twilio API
        const twilioCallInfo = await twilioClient.calls(callSid).fetch();

        // Calculate current duration for in-progress calls
        if (
          callInfo.status === "in-progress" ||
          twilioCallInfo.status === "in-progress"
        ) {
          callInfo.currentDuration = callStore.calculateDuration(callSid);
        }

        // Merge Twilio data with our local data
        callInfo = {
          ...callInfo,
          twilioStatus: twilioCallInfo.status,
          twilioDirection: twilioCallInfo.direction,
          twilioStartTime: twilioCallInfo.startTime,
          twilioEndTime: twilioCallInfo.endTime,
          twilioPrice: twilioCallInfo.price,
          twilioRecordingUrl: twilioCallInfo.recordingUrl,
        };
      } catch (twilioError) {
        console.error("Error fetching call from Twilio:", twilioError);
        // Continue with local data if Twilio API fails
      }

      return res.json({
        success: true,
        data: callInfo,
      });
    }

    // If not in local store, try to fetch from Twilio API directly
    const twilioCallInfo = await twilioClient.calls(callSid).fetch();

    return res.json({
      success: true,
      data: {
        status: twilioCallInfo.status,
        duration: parseInt(twilioCallInfo.duration || 0),
        from: twilioCallInfo.from,
        to: twilioCallInfo.to,
        direction: twilioCallInfo.direction,
        startTime: twilioCallInfo.startTime,
        endTime: twilioCallInfo.endTime,
        price: twilioCallInfo.price,
      },
    });
  } catch (error) {
    console.error("Error getting call info:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint to check if user is on a call
app.get("/call/active/:identity", (req, res) => {
  const identity = req.params.identity;

  if (!identity) {
    return res.status(400).json({
      success: false,
      error: "Identity is required",
    });
  }

  // Find any active calls for this identity
  const activeCalls = Object.entries(callStore.calls)
    .filter(([_, call]) => {
      return (
        (call.status === "in-progress" || call.status === "ringing") &&
        (call.toIdentity === identity || call.fromIdentity === identity)
      );
    })
    .map(([callSid, call]) => ({
      callSid,
      status: call.status,
      direction: call.fromIdentity === identity ? "outbound" : "inbound",
      duration: callStore.calculateDuration(callSid),
      from: call.from,
      to: call.to,
      startTime: call.startTime,
    }));

  return res.json({
    success: true,
    onCall: activeCalls.length > 0,
    activeCalls,
  });
});

// Endpoint for call events like ringing and answered
app.post("/call/event", (req, res) => {
  try {
    const { callSid, event, identity } = req.body;

    if (!callSid || !event) {
      return res.status(400).json({
        success: false,
        error: "CallSid and event are required",
      });
    }

    const call = callStore.getCall(callSid);
    if (!call) {
      return res.status(404).json({
        success: false,
        error: "Call not found",
      });
    }

    // Handle different events
    switch (event) {
      case "ringing":
        callStore.trackCall(callSid, { status: "ringing" });
        break;

      case "answered":
        callStore.trackCall(callSid, {
          status: "in-progress",
          answeredAt: Date.now(),
          answeredBy: identity,
        });
        break;

      case "rejected":
        callStore.trackCall(callSid, { status: "rejected" });
        break;
    }

    return res.json({
      success: true,
      status: callStore.getCall(callSid).status,
    });
  } catch (error) {
    console.error("Error handling call event:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Add a new route to check database tables and diagnose issues
app.get("/db-check", async (req, res) => {
  const client = await pool.connect();
  try {
    // First check all tables
    const tableQuery = `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position;
    `;

    const tableResult = await client.query(tableQuery);

    // Group the columns by table
    const tables = {};
    tableResult.rows.forEach((row) => {
      if (!tables[row.table_name]) {
        tables[row.table_name] = [];
      }
      tables[row.table_name].push(row.column_name);
    });

    // Check if our crucial tables exist
    const requiredTables = [
      "users",
      "device_tokens",
      "twilio_number_mapping",
      "call_logs",
      "user_numbers",
      "subscriptions",
    ];

    const missingTables = requiredTables.filter(
      (table) => !Object.keys(tables).includes(table.toLowerCase())
    );

    // Check record counts
    const countQueries = Object.keys(tables).map(async (tableName) => {
      try {
        const countResult = await client.query(
          `SELECT COUNT(*) FROM ${tableName}`
        );
        return {
          table: tableName,
          count: parseInt(countResult.rows[0].count, 10),
        };
      } catch (err) {
        return {
          table: tableName,
          count: "Error counting",
          error: err.message,
        };
      }
    });

    const recordCounts = await Promise.all(countQueries);

    return res.json({
      success: true,
      tablesFound: Object.keys(tables).length,
      tables,
      missingRequiredTables: missingTables,
      recordCounts,
      message:
        missingTables.length > 0
          ? `Warning: Some required tables are missing: ${missingTables.join(
              ", "
            )}`
          : "All required database tables exist!",
    });
  } catch (error) {
    console.error("Error checking database:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Database check failed. See error details.",
    });
  } finally {
    client.release();
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
