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

// Call deduplication store to prevent duplicate calls
const callDedupStore = {
  recentCalls: {},

  // Check if a call to this number was recently initiated (within debounce time)
  checkAndAddCall: function (fromNumber, toNumber, debounceTimeMs = 3000) {
    const callKey = `${fromNumber}->${toNumber}`;
    const now = Date.now();

    // Check if a call to this number was initiated recently
    if (
      this.recentCalls[callKey] &&
      now - this.recentCalls[callKey] < debounceTimeMs
    ) {
      console.log(
        `Duplicate call attempt detected: ${callKey} (within ${debounceTimeMs}ms)`
      );
      return false; // Don't allow the call - too soon after last attempt
    }

    // Allow the call and record the timestamp
    this.recentCalls[callKey] = now;
    return true;
  },

  // Cleanup method to remove old entries (called periodically)
  cleanup: function (maxAgeMs = 60000) {
    const now = Date.now();
    for (const key in this.recentCalls) {
      if (now - this.recentCalls[key] > maxAgeMs) {
        delete this.recentCalls[key];
      }
    }
  },
};

// Set up periodic cleanup of the deduplication store (every minute)
setInterval(() => {
  callDedupStore.cleanup();
}, 60000);

const app = express();
// const port = 3091;
const port = 3091;

// Twilio Config
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const appSid = process.env.TWILIO_APP_SID;
const callerId = process.env.TWILIO_CALLER_ID;
const messagingNumber =
  process.env.TWILIO_MESSAGING_NUMBER || process.env.TWILIO_CALLER_ID; // Use the caller ID as the SMS number if no specific messaging number is set

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
app.use("/message/webhook", bodyParser.urlencoded({ extended: false })); // Middleware for SMS webhook

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
      // Direct connection without a message
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
      // Brief message followed by connection
      voiceResponse.say("Connecting you now");
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
  console.log(`[TWIML] Called with SID: ${req.body.CallSid || "unknown"}`);

  try {
    const voiceResponse = new twiml.VoiceResponse();

    // Get the To parameter (who we're calling)
    const to = req.body.To || "";
    const from = req.body.From || "";
    const callSid = req.body.CallSid || "";

    // Add debug logs to trace call flow
    console.log(`Call from ${from} to ${to} with SID ${callSid}`);
    console.log("Call details:", JSON.stringify(req.body));

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

    // Create a deduplication key using CallSid and To number
    const dedupKey = `${callSid}-${to}`;

    // See if this is a duplicate call attempt
    if (global.processedCalls && global.processedCalls[dedupKey]) {
      console.log(
        `Duplicate call detected for ${dedupKey}, skipping dial action`
      );
      voiceResponse.say("Call is already in progress.");
      voiceResponse.hangup();
      res.type("text/xml");
      return res.send(voiceResponse.toString());
    }

    // Mark this call as processed to prevent duplicates
    if (!global.processedCalls) {
      global.processedCalls = {};
    }
    global.processedCalls[dedupKey] = Date.now();

    // Set up automatic cleanup of processed calls after 5 minutes
    setTimeout(() => {
      if (global.processedCalls && global.processedCalls[dedupKey]) {
        delete global.processedCalls[dedupKey];
      }
    }, 5 * 60 * 1000);

    // Check if this call is already in our store to prevent duplicates
    const existingCall = callStore.getCall(callSid);
    if (existingCall && existingCall.dialed) {
      console.log(`Call ${callSid} already dialed, skipping duplicate dial`);
      // Just add a simple message instead of dialing again
      voiceResponse.say("Call is already connected.");
      voiceResponse.hangup();
      res.type("text/xml");
      return res.send(voiceResponse.toString());
    }

    // Mark this call as dialed to prevent duplicate dials
    if (callSid) {
      callStore.trackCall(callSid, { dialed: true });
    }

    // Check if we're calling a client (app user) or regular number
    if (to.indexOf("client:") === 0) {
      // This is a call to another app user
      const clientId = to.split(":")[1];

      // DIRECT CONNECTION: Removed the "Connecting you to another user" message to avoid the call being perceived as a new call
      const dial = voiceResponse.dial({
        callerId: from,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client(clientId);
      console.log(`Connecting to client: ${clientId}`);
    } else {
      // This is a call to a regular phone number
      // DIRECT CONNECTION: Removed the "Connecting your call" message to avoid the call being perceived as a new call
      const dial = voiceResponse.dial({
        callerId: from,
        timeout: 30,
        action: `${backend_url}/call-action-result`,
        method: "POST",
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

// Add simple greeting call API endpoint
app.post("/call/make-greeting", async (req, res) => {
  const { to, from, audioUrl } = req.body;

  if (!to) {
    console.log("Missing 'to' parameter for greeting call.");
    return res.status(400).json({
      success: false,
      error: "Missing 'to' parameter. Please provide a phone number to call.",
    });
  }

  if (!from) {
    console.log("Missing 'from' parameter for greeting call.");
    return res.status(400).json({
      success: false,
      error: "Missing 'from' parameter. Please provide a valid Twilio number.",
    });
  }

  try {
    // Check for duplicate call attempt
    if (!callDedupStore.checkAndAddCall(from, to)) {
      console.log(
        `Rejecting duplicate greeting call attempt from ${from} to ${to}`
      );
      return res.status(429).json({
        success: false,
        error:
          "A call to this number was just initiated. Please wait a moment before trying again.",
      });
    }

    // Use the greeting TwiML endpoint with full URL
    let greetingTwimlUrl = `${backend_url}/twiml-greeting`;

    // If an audio URL is provided for a human voice recording, pass it to the TwiML endpoint
    if (audioUrl) {
      greetingTwimlUrl += `?audioUrl=${encodeURIComponent(audioUrl)}`;
    }

    // Add extensive debugging
    console.log("Making greeting call with the following parameters:");
    console.log("- From:", from);
    console.log("- To:", to);
    console.log("- TwiML URL:", greetingTwimlUrl);
    console.log("- Audio URL:", audioUrl || "Not provided (using robot voice)");
    console.log("- Backend URL:", backend_url);

    // Simplified call with minimal parameters - just what's needed for the greeting
    const call = await twilioClient.calls.create({
      url: greetingTwimlUrl,
      to: to,
      from: from,
    });

    // // Track the call in our store
    callStore.trackCall(call.sid, {
      from,
      to,
      direction: "outbound",
      callType: "greeting",
      audioUrl: audioUrl || null,
    });

    console.log("Greeting call initiated:", call.sid);
    return res.status(200).json({
      success: true,
      sid: call.sid,
      message: "Greeting call initiated successfully",
    });
  } catch (error) {
    console.error("Error making greeting call:", error.message);

    // Handle specific Twilio errors
    let message = error.message;
    if (error.code) {
      switch (error.code) {
        case 21211:
          message = "Invalid 'to' phone number format";
          break;
        case 21214:
          message = "To phone number is not a valid or verified number";
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

app.post("/call/make", async (req, res) => {
  const { to, from, fromIdentity } = req.body;

  if (!to) {
    console.log("Missing 'to' parameter.");
    return res.status(400).json({ error: "Missing 'to' parameter." });
  }

  try {
    // Check for duplicate call attempt
    if (!callDedupStore.checkAndAddCall(from, to)) {
      console.log(`Rejecting duplicate call attempt from ${from} to ${to}`);
      return res.status(429).json({
        success: false,
        error:
          "A call to this number was just initiated. Please wait a moment before trying again.",
      });
    }

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
  console.log(
    `[CALL STATUS] SID: ${req.body.CallSid} | Status: ${req.body.CallStatus}`
  );

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

// Add a new route to handle simple greeting calls TwiML - support both GET and POST
app.all("/twiml-greeting", (req, res) => {
  console.log(
    `Greeting TwiML endpoint called with ${req.method}:`,
    req.body || req.query
  );

  try {
    // Create a simple voice response
    const voiceResponse = new twiml.VoiceResponse();

    // Check if a custom audio URL is provided (for human voice recordings)
    const audioUrl = req.query.audioUrl || req.body.audioUrl;

    if (audioUrl) {
      // Play a pre-recorded human voice message
      console.log("Using custom audio recording:", audioUrl);
      voiceResponse.play({ loop: 1 }, audioUrl);
      voiceResponse.pause({ length: 1 });
    } else {
      // Fallback to the text-to-speech robot voice if no audio URL is provided
      voiceResponse.say(
        { voice: "woman", language: "en-US" },
        "Hello, this is an automated greeting call from Numee. Thank you for your interest in our service. We are excited to have you on board and look forward to helping you with your communication needs."
      );

      // Add a significant pause to make the call last longer
      voiceResponse.pause({ length: 3 });

      // Add another message
      voiceResponse.say(
        { voice: "woman", language: "en-US" },
        "If you have any questions or need assistance, please don't hesitate to contact our support team. Have a great day!"
      );
    }

    // Add another pause before ending
    voiceResponse.pause({ length: 2 });

    // End the call after the greeting
    voiceResponse.hangup();

    // Log the generated TwiML for debugging
    const twimlString = voiceResponse.toString();
    console.log("Generated Greeting TwiML:", twimlString);

    // Set content type and send response
    res.type("text/xml");
    res.send(twimlString);
  } catch (error) {
    console.error("Error in /twiml-greeting:", error);
    const errorResponse = new twiml.VoiceResponse();
    errorResponse.say(
      "Sorry, there was a technical problem. Please try again later."
    );
    res.type("text/xml");
    res.status(500).send(errorResponse.toString());
  }
});

// Add a test endpoint to easily verify TwiML is working correctly
app.get("/test-greeting-twiml", (req, res) => {
  console.log("Test greeting TwiML endpoint called");

  const voiceResponse = new twiml.VoiceResponse();
  voiceResponse.say(
    { voice: "woman", language: "en-US" },
    "This is a test greeting with an extended message. The real greeting will be longer and include pauses to ensure the call doesn't end too quickly. If you see this, TwiML generation is working correctly."
  );
  voiceResponse.pause({ length: 2 });
  voiceResponse.say("Thank you for testing our system.");
  voiceResponse.hangup();

  // Send as both XML and in an HTML wrapper for easy browser testing
  if (req.query.format === "xml") {
    res.type("text/xml");
    res.send(voiceResponse.toString());
  } else {
    res.send(`
      <html>
        <head><title>TwiML Test</title></head>
        <body>
          <h1>TwiML Test</h1>
          <h2>Generated TwiML:</h2>
          <pre>${voiceResponse
            .toString()
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</pre>
          <p>To see raw XML, add ?format=xml to the URL</p>
        </body>
      </html>
    `);
  }
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

// =============================================
// SMS Messaging API Endpoints
// =============================================

// Endpoint to send an SMS message
app.post("/message/send", async (req, res) => {
  const { to, body, from, mediaUrl } = req.body;

  if (!to || !body) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameters: 'to' and 'body' are required",
    });
  }

  // Use the provided 'from' number or default to the environment variable
  const fromNumber = from || messagingNumber;

  if (!fromNumber) {
    return res.status(400).json({
      success: false,
      error:
        "No 'from' number provided and no default messaging number configured",
    });
  }

  try {
    console.log(`Sending message from ${fromNumber} to ${to}`);

    // Create message options
    const messageOptions = {
      to: to,
      from: fromNumber,
      body: body,
      statusCallback: `${backend_url}/message/status`, // Add status callback URL
    };

    // Add media URL if provided
    if (mediaUrl) {
      messageOptions.mediaUrl = mediaUrl;
    }

    console.log(`Message options:`, {
      ...messageOptions,
      statusCallback: messageOptions.statusCallback,
    });

    // Send the message
    const message = await twilioClient.messages.create(messageOptions);

    console.log(`Message sent with SID: ${message.sid}`);

    // Store message in database
    try {
      const client = await pool.connect();
      try {
        const userQuery = await client.query(
          `SELECT user_id FROM twilio_number_mapping WHERE twilio_number = $1`,
          [fromNumber]
        );

        const userId =
          userQuery.rows.length > 0 ? userQuery.rows[0].user_id : null;

        await client.query(
          `INSERT INTO message_logs 
           (message_sid, from_number, to_number, body, status, direction, media_url, user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [
            message.sid,
            fromNumber,
            to,
            body,
            message.status,
            "outbound",
            mediaUrl || null,
            userId,
          ]
        );
        console.log(`Message ${message.sid} logged to database`);
      } finally {
        client.release();
      }
    } catch (dbError) {
      console.error("Database error logging message:", dbError);
      // Continue even if database logging fails
    }

    return res.status(200).json({
      success: true,
      sid: message.sid,
      status: message.status,
      message: "Message sent successfully",
    });
  } catch (error) {
    console.error("Error sending message:", error);

    // Handle specific Twilio error codes
    let errorMessage = error.message;
    if (error.code) {
      switch (error.code) {
        case 21211:
          errorMessage = "Invalid 'to' phone number format";
          break;
        case 21214:
          errorMessage =
            "The 'to' phone number is not a valid or verified number";
          break;
        case 21606:
          errorMessage =
            "The 'from' number is not a valid Twilio number for messaging";
          break;
        default:
          errorMessage = `Twilio error (code: ${error.code}): ${error.message}`;
      }
    }

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

// Endpoint to receive SMS webhook callbacks from Twilio
app.post("/message/webhook", async (req, res) => {
  try {
    console.log("Incoming message webhook received:", req.body);

    // Extract message details
    const messageSid = req.body.MessageSid;
    const from = req.body.From;
    const to = req.body.To;
    const body = req.body.Body;
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    // Array to hold media URLs if any
    const mediaUrls = [];

    // Extract media if present
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      const contentType = req.body[`MediaContentType${i}`];
      if (mediaUrl) {
        mediaUrls.push({
          url: mediaUrl,
          contentType: contentType,
        });
      }
    }

    // Log the incoming message to database
    let targetUserId = null;
    let targetEmail = null;

    try {
      const client = await pool.connect();
      try {
        // Find user associated with the Twilio number
        const numberLookupQuery = await client.query(
          `SELECT user_id, email FROM twilio_number_mapping WHERE twilio_number = $1 AND is_active = true`,
          [to]
        );

        if (numberLookupQuery.rows.length > 0) {
          targetUserId = numberLookupQuery.rows[0].user_id;
          targetEmail = numberLookupQuery.rows[0].email;
          console.log(
            `Found user ID ${targetUserId} with email ${targetEmail} for Twilio number ${to}`
          );
        }

        // Insert the message into the database
        await client.query(
          `INSERT INTO message_logs 
           (message_sid, from_number, to_number, body, status, direction, media_url, user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [
            messageSid,
            from,
            to,
            body,
            "received",
            "inbound",
            mediaUrls.length > 0 ? JSON.stringify(mediaUrls) : null,
            targetUserId,
          ]
        );
        console.log(`Incoming message ${messageSid} logged to database`);

        // Send push notification to user if we have a user ID
        if (targetUserId) {
          try {
            // Get user's FCM tokens
            const userTokens = fcmTokenStore.getTokens(targetUserId);

            if (userTokens && userTokens.length > 0) {
              console.log(
                `Sending push notification to user ${targetUserId} for incoming message`
              );

              // Send to all user devices
              for (const tokenData of userTokens) {
                try {
                  const message = {
                    token: tokenData.token,
                    notification: {
                      title: "New Message",
                      body: `Message from ${from}: ${body.substring(0, 100)}${
                        body.length > 100 ? "..." : ""
                      }`,
                    },
                    data: {
                      type: "incomingMessage",
                      from: from,
                      messageSid: messageSid,
                      timestamp: new Date().toISOString(),
                    },
                    android: {
                      priority: "high",
                      notification: {
                        sound: "default",
                      },
                    },
                    apns: {
                      payload: {
                        aps: {
                          sound: "default",
                        },
                      },
                    },
                  };

                  await admin.messaging().send(message);
                  console.log(
                    `Push notification sent to device: ${tokenData.token.substring(
                      0,
                      10
                    )}...`
                  );
                } catch (fcmError) {
                  console.error("Error sending FCM notification:", fcmError);
                }
              }
            }
          } catch (notificationError) {
            console.error(
              "Error sending push notification for incoming message:",
              notificationError
            );
          }
        }
      } finally {
        client.release();
      }
    } catch (dbError) {
      console.error("Database error logging incoming message:", dbError);
    }

    // Send an acknowledgment response
    res.status(200).send("OK");
  } catch (error) {
    console.error("Error handling incoming message webhook:", error);
    res.status(500).send("Error");
  }
});

// Endpoint to retrieve message history for a user
app.post("/message/history", async (req, res) => {
  // Query parameters: userId (required), phoneNumber (optional), limit (optional), offset (optional)
  const { userId, phoneNumber, limit = 50, offset = 0 } = req.body;
  console.log("Received request for message history with params:", {
    userId,
    phoneNumber,
    limit,
    offset,
  });

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameter: userId",
    });
  }

  try {
    const client = await pool.connect();
    try {
      let query, params;

      if (phoneNumber) {
        // Get messages between this user and a specific phone number
        query = `
          SELECT DISTINCT ON (ml.id) ml.*, 
                 CASE WHEN ml.direction = 'outbound' THEN true ELSE false END AS is_from_me,
                 tnm.friendly_name AS contact_name
          FROM message_logs ml
          LEFT JOIN twilio_number_mapping tnm ON 
            (ml.direction = 'inbound' AND ml.from_number = tnm.twilio_number) OR 
            (ml.direction = 'outbound' AND ml.to_number = tnm.twilio_number)
          WHERE ml.user_id = $1 AND 
                ((ml.from_number = $2) OR (ml.to_number = $2))
          ORDER BY ml.id, ml.created_at DESC
          LIMIT $3 OFFSET $4
        `;
        params = [userId, phoneNumber, limit, offset];
      } else {
        // Get all messages for this user
        query = `
          SELECT DISTINCT ON (ml.id) ml.*, 
                 CASE WHEN ml.direction = 'outbound' THEN true ELSE false END AS is_from_me,
                 tnm.friendly_name AS contact_name
          FROM message_logs ml
          LEFT JOIN twilio_number_mapping tnm ON 
            (ml.direction = 'inbound' AND ml.from_number = tnm.twilio_number) OR 
            (ml.direction = 'outbound' AND ml.to_number = tnm.twilio_number)
          WHERE ml.user_id = $1
          ORDER BY ml.id, ml.created_at DESC
          LIMIT $2 OFFSET $3
        `;
        params = [userId, limit, offset];
      }

      const result = await client.query(query, params);
      console.log(
        `Message history query executed. Found ${result.rows.length} messages.`
      );
      console.log("Query:", query);
      console.log("Params:", params);

      // Count total messages for pagination
      const countQuery = phoneNumber
        ? `SELECT COUNT(*) FROM message_logs WHERE user_id = $1 AND ((from_number = $2) OR (to_number = $2))`
        : `SELECT COUNT(*) FROM message_logs WHERE user_id = $1`;

      const countParams = phoneNumber ? [userId, phoneNumber] : [userId];
      const countResult = await client.query(countQuery, countParams);
      const totalCount = parseInt(countResult.rows[0].count, 10);

      // Additional check for empty results
      if (result.rows.length === 0) {
        console.log("No messages found. Checking if user exists...");
        const userCheck = await client.query(
          `SELECT id FROM Users WHERE id = $1`,
          [userId]
        );
        if (userCheck.rows.length === 0) {
          console.log(`No user found with ID ${userId}`);
        } else {
          console.log(`User with ID ${userId} exists but has no messages`);
        }
      }

      return res.status(200).json({
        success: true,
        count: result.rows.length,
        messages: result.rows,
        pagination: {
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
          total: totalCount,
          hasMore: parseInt(offset, 10) + result.rows.length < totalCount,
        },
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error retrieving message history:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to retrieve message history: " + error.message,
    });
  }
});

// Endpoint to check if a user has any unread messages
app.get("/message/unread/:userId", async (req, res) => {
  const { userId } = req.params;
  console.log("Checking unread messages for user:", userId);
  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "Missing required parameter: userId",
    });
  }

  try {
    const client = await pool.connect();
    try {
      // First check if we have any messages for this user at all
      const checkMessagesQuery = `
        SELECT COUNT(*) as total_count
        FROM message_logs
        WHERE user_id = $1
      `;

      const checkResult = await client.query(checkMessagesQuery, [userId]);
      const totalMessages = parseInt(checkResult.rows[0].total_count, 10);
      console.log(`Total messages for user ${userId}: ${totalMessages}`);

      // Check if there are any messages with 'inbound' direction for this user
      const inboundCheckQuery = `
        SELECT COUNT(*) as inbound_count
        FROM message_logs
        WHERE user_id = $1
      `;

      const inboundResult = await client.query(inboundCheckQuery, [userId]);
      const inboundCount = parseInt(inboundResult.rows[0].inbound_count, 10);
      console.log(`Inbound messages for user ${userId}: ${inboundCount}`);

      // Now check for any unread messages regardless of direction (for debugging)
      const allUnreadQuery = `
        SELECT COUNT(*) as all_unread_count
        FROM message_logs
        WHERE user_id = $1 AND read_at IS NULL
      `;

      const allUnreadResult = await client.query(allUnreadQuery, [userId]);
      const allUnreadCount = parseInt(
        allUnreadResult.rows[0].all_unread_count,
        10
      );
      console.log(`All unread messages for user ${userId}: ${allUnreadCount}`);

      // Now check specifically for unread messages based on from/to relationships, not direction
      const query = `
        WITH user_numbers AS (
          SELECT twilio_number FROM twilio_number_mapping WHERE user_id = $1
        )
        SELECT 
          COUNT(*) as unread_count,
          COALESCE(array_agg(distinct from_number) FILTER (WHERE from_number IS NOT NULL), ARRAY[]::text[]) as from_numbers,
          COALESCE(json_agg(
            json_build_object(
              'id', id,
              'message_sid', message_sid,
              'from_number', from_number,
              'to_number', to_number,
              'body', body,
              'status', status,
              'direction', direction,
              'created_at', created_at
            )
          ) FILTER (WHERE id IS NOT NULL), '[]'::json) as message_details
        FROM message_logs ml
        WHERE ml.user_id = $1 
          AND ml.read_at IS NULL
          AND ml.to_number IN (SELECT twilio_number FROM user_numbers)
          AND ml.from_number NOT IN (SELECT twilio_number FROM user_numbers)
      `;

      const result = await client.query(query, [userId]);
      console.log(`Unread messages query result:`, result.rows[0]);
      const unreadCount = parseInt(result.rows[0].unread_count, 10);
      const fromNumbers = result.rows[0].from_numbers || [];
      const messageDetails = result.rows[0].message_details || [];

      // Debug info for user's phone numbers
      const userNumbersQuery = `
        SELECT twilio_number, friendly_name 
        FROM twilio_number_mapping 
        WHERE user_id = $1
      `;
      const userNumbersResult = await client.query(userNumbersQuery, [userId]);
      console.log(`Numbers owned by user ${userId}:`, userNumbersResult.rows);

      // Get details about senders by grouping messages
      const groupedMessagesQuery = `
        WITH user_numbers AS (
          SELECT twilio_number FROM twilio_number_mapping WHERE user_id = $1
        )
        SELECT 
          from_number, 
          COUNT(*) as message_count,
          MIN(created_at) as first_message_time,
          MAX(created_at) as latest_message_time,
          json_agg(
            json_build_object(
              'id', id,
              'message_sid', message_sid,
              'body', body, 
              'created_at', created_at,
              'status', status,
              'direction', direction,
              'from_number', from_number,
              'to_number', to_number
            ) ORDER BY created_at DESC
          ) as messages
        FROM message_logs ml
        WHERE ml.user_id = $1 
          AND ml.read_at IS NULL
          AND ml.to_number IN (SELECT twilio_number FROM twilio_number_mapping)
          AND ml.from_number NOT IN (SELECT twilio_number FROM twilio_number_mapping)
        GROUP BY from_number
        ORDER BY latest_message_time DESC
      `;

      const groupedResult = await client.query(groupedMessagesQuery, [userId]);
      const messageBySender = groupedResult.rows;

      // Debug the actual data in the table
      const debugQuery = `
        SELECT id, message_sid, from_number, to_number, direction, read_at, user_id, status, created_at, body
        FROM message_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `;

      const debugResult = await client.query(debugQuery, [userId]);
      console.log(
        `Debug - Sample messages for user ${userId}:`,
        debugResult.rows
      );

      // Try to attach friendly names to the senders
      const lookupNumbersQuery = `
        SELECT twilio_number, friendly_name
        FROM twilio_number_mapping
        WHERE twilio_number = ANY($1)
      `;

      const lookupResult = await client.query(lookupNumbersQuery, [
        fromNumbers,
      ]);
      const friendlyNames = {};

      // Create a map of phone numbers to friendly names
      lookupResult.rows.forEach((row) => {
        friendlyNames[row.twilio_number] =
          row.friendly_name || row.twilio_number;
      });

      // Add friendly names to the grouped message data
      messageBySender.forEach((sender) => {
        sender.friendly_name =
          friendlyNames[sender.from_number] || sender.from_number;
        // Add a preview of the latest message
        if (sender.messages && sender.messages.length > 0) {
          sender.latest_message = sender.messages[0].body;
          sender.latest_timestamp = sender.messages[0].created_at;
        }
      });

      // Return both inbound unread count and total unread count with detailed message information
      return res.status(200).json({
        success: true,
        unreadCount: unreadCount, // This is just inbound unread messages
        totalUnreadCount: allUnreadCount, // This is ALL unread messages regardless of direction
        hasUnread: allUnreadCount > 0, // Change to use total unread count
        fromNumbers: fromNumbers, // Always return the array, even if empty
        messageDetails: messageDetails, // Include detailed message information
        messageBySender: messageBySender, // Messages grouped by sender with counts and timestamps
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error checking unread messages:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to check unread messages: " + error.message,
    });
  }
});

// Endpoint to mark messages as read
app.post("/message/mark-read", async (req, res) => {
  const { messageIds, userId, fromNumber, messageId } = req.body;

  try {
    const client = await pool.connect();
    try {
      let updateResult;

      console.log(`Marking messages as read with params:`, req.body);

      if (messageId) {
        // Mark a single message as read by its database ID (not SID)
        updateResult = await client.query(
          `UPDATE message_logs
           SET read_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND read_at IS NULL
           RETURNING id, message_sid, from_number, to_number`,
          [messageId]
        );
        console.log(`Marked message ${messageId} as read`);
      } else if (messageIds && messageIds.length > 0) {
        // Mark specific messages as read by SID
        updateResult = await client.query(
          `UPDATE message_logs
           SET read_at = NOW(), updated_at = NOW()
           WHERE message_sid = ANY($1) AND read_at IS NULL
           RETURNING id, message_sid, from_number, to_number`,
          [messageIds]
        );
        console.log(
          `Marked ${updateResult.rows.length} messages as read by SID`
        );
      } else if (userId && fromNumber) {
        // Mark all messages from a specific number to this user as read
        updateResult = await client.query(
          `WITH user_numbers AS (
             SELECT twilio_number FROM twilio_number_mapping WHERE user_id = $1
           )
           UPDATE message_logs
           SET read_at = NOW(), updated_at = NOW()
           WHERE user_id = $1 
             AND from_number = $2 
             AND read_at IS NULL
             AND to_number IN (SELECT twilio_number FROM user_numbers)
             AND from_number NOT IN (SELECT twilio_number FROM user_numbers)
           RETURNING id, message_sid, from_number, to_number`,
          [userId, fromNumber]
        );
        console.log(
          `Marked ${updateResult.rows.length} messages from ${fromNumber} as read for user ${userId}`
        );
      } else if (userId) {
        // Mark all messages for this user as read
        updateResult = await client.query(
          `WITH user_numbers AS (
             SELECT twilio_number FROM twilio_number_mapping WHERE user_id = $1
           )
           UPDATE message_logs
           SET read_at = NOW(), updated_at = NOW()
           WHERE user_id = $1 
             AND read_at IS NULL
             AND to_number IN (SELECT twilio_number FROM user_numbers)
             AND from_number NOT IN (SELECT twilio_number FROM user_numbers)
           RETURNING id, message_sid, from_number, to_number`,
          [userId]
        );
        console.log(
          `Marked all ${updateResult.rows.length} unread messages as read for user ${userId}`
        );
      } else {
        return res.status(400).json({
          success: false,
          error:
            "Missing required parameters: either messageId, messageIds, userId, or both userId and fromNumber are required",
        });
      }

      // Get the remaining unread count after marking messages as read
      let remainingUnreadCount = 0;
      if (userId) {
        const countResult = await client.query(
          `WITH user_numbers AS (
             SELECT twilio_number FROM twilio_number_mapping WHERE user_id = $1
           )
           SELECT COUNT(*) as count FROM message_logs 
           WHERE user_id = $1 
             AND read_at IS NULL
             AND to_number IN (SELECT twilio_number FROM user_numbers)
             AND from_number NOT IN (SELECT twilio_number FROM user_numbers)`,
          [userId]
        );
        remainingUnreadCount = parseInt(countResult.rows[0].count, 10);
      }

      return res.status(200).json({
        success: true,
        markedCount: updateResult.rows.length,
        markedMessages: updateResult.rows,
        remainingUnreadCount: remainingUnreadCount,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error marking messages as read:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to mark messages as read: " + error.message,
    });
  }
});

// Endpoint to get message status updates
app.post("/message/status", async (req, res) => {
  try {
    console.log(
      "Message status update webhook received:",
      JSON.stringify(req.body, null, 2)
    );

    const messageSid = req.body.MessageSid;
    const messageStatus = req.body.MessageStatus;
    const errorCode = req.body.ErrorCode;
    const errorMessage = req.body.ErrorMessage;

    if (!messageSid || !messageStatus) {
      return res.status(400).send("Missing MessageSid or MessageStatus");
    }

    // Log detailed information about the status update
    console.log(
      `STATUS UPDATE: Message ${messageSid} status changed to ${messageStatus}`
    );
    if (errorCode) {
      console.log(
        `ERROR DETAILS: Code: ${errorCode}, Message: ${errorMessage}`
      );
    }

    try {
      const client = await pool.connect();
      try {
        // Check if the message_logs table has the error columns
        try {
          // Check if error_code and error_message columns exist, add them if they don't
          const checkColumnsQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'message_logs' AND column_name IN ('error_code', 'error_message')
          `;

          const columnsResult = await client.query(checkColumnsQuery);
          const existingColumns = columnsResult.rows.map(
            (row) => row.column_name
          );

          if (!existingColumns.includes("error_code")) {
            console.log("Adding error_code column to message_logs table");
            await client.query(
              `ALTER TABLE message_logs ADD COLUMN error_code VARCHAR(50)`
            );
          }

          if (!existingColumns.includes("error_message")) {
            console.log("Adding error_message column to message_logs table");
            await client.query(
              `ALTER TABLE message_logs ADD COLUMN error_message TEXT`
            );
          }
        } catch (alterError) {
          console.error("Error checking or adding columns:", alterError);
          // Continue anyway - we'll try to update without the columns if needed
        }

        // Get current status for comparison
        const currentStatusResult = await client.query(
          `SELECT status FROM message_logs WHERE message_sid = $1`,
          [messageSid]
        );

        const currentStatus =
          currentStatusResult.rows.length > 0
            ? currentStatusResult.rows[0].status
            : "unknown";

        // Update message status in the database
        const updateResult = await client.query(
          `UPDATE message_logs
           SET status = $1, 
               updated_at = NOW(), 
               delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
               error_code = $3,
               error_message = $4
           WHERE message_sid = $2
           RETURNING *`,
          [messageStatus, messageSid, errorCode || null, errorMessage || null]
        );

        if (updateResult.rows.length > 0) {
          console.log(
            `Updated status of message ${messageSid} from ${currentStatus} to ${messageStatus}`
          );

          // If there's an error message, log it clearly
          if (errorCode) {
            console.log(
              `Error details saved: Code ${errorCode}: ${errorMessage}`
            );
          }
        } else {
          console.log(`No message found with SID ${messageSid} in database`);
        }
      } finally {
        client.release();
      }
    } catch (dbError) {
      console.error("Database error updating message status:", dbError);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error handling message status webhook:", error);
    res.status(500).send("Error");
  }
});

// =============================================
// End of SMS Messaging API Endpoints
// =============================================

app.all("/*", (req, res, next) => {
  // Check if this is a Twilio request by looking for common Twilio parameters
  const isTwilioRequest =
    (req.body &&
      (req.body.CallSid || req.body.MessageSid || req.body.AccountSid)) ||
    (req.query &&
      (req.query.CallSid || req.query.MessageSid || req.query.AccountSid));

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
