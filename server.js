const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
const path = require("path");
const twilio = require("twilio");

// const pool = require("././app/config/dbconfig")
dotenv.config();

const {
  jwt: { AccessToken },
  twiml,
} = require("twilio");

const app = express();
const port = 3009;

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
    origin: true, // Allow any origin requesting the resource (automatically reflects request origin)
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
const backend_url = process.env.BACKEND_URL || "http://localhost:3009";

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
app.post("/call/incoming", (req, res) => {
  console.log("Incoming call webhook received:", req.body);

  const voiceResponse = new twiml.VoiceResponse();

  try {
    // Get the To parameter from the request
    const to = req.body.To;
    const from = req.body.From;
    const callSid = req.body.CallSid;

    // Extract any custom parameters
    const appOpened = req.body.appOpened;

    console.log(`Incoming call ${callSid} from ${from} to ${to}`);

    // If this is a client-to-client call, connect to the client
    if (to && to.indexOf("client:") === 0) {
      const client = to.split(":")[1];
      const dial = voiceResponse.dial({
        callerId: from || callerId,
        timeout: 30, // Give the app time to open and accept the call
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client(client);
      console.log(`Routing call to client: ${client}`);
    } else {
      // Default handling if no specific client is targeted
      // For React Native app scenario
      voiceResponse.say(
        "Thanks for calling. Please wait while we connect you."
      );
      const dial = voiceResponse.dial({
        callerId,
        timeout: 30, // Give the app time to open and accept the call
        action: `${backend_url}/call-action-result`,
        method: "POST",
      });
      dial.client("user");
      console.log("Routing call to default user client");
    }
  } catch (error) {
    console.error("Error in call/incoming:", error);
    voiceResponse.say(
      "Sorry, an error occurred while processing your call. Please try again later."
    );
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
    // const voiceResponse = new twiml.VoiceResponse();
    // voiceResponse.say("Hello. This is a test call from Numee.");

    const voiceResponse = new twiml.VoiceResponse();

    // First message
    voiceResponse.say(
      { voice: "alice" },
      "Hello. This is a test call from Numee."
    );

    // Add a pause to give a break
    voiceResponse.pause({ length: 2 });

    // Add a follow-up message
    voiceResponse.say(
      { voice: "alice" },
      "Please press any key to continue or stay on the line."
    );

    // Add gather to make the call interactive and keep it active
    const gather = voiceResponse.gather({
      input: "dtmf speech",
      timeout: 10,
      action: `https://${req.get("host")}/call-action`,
      method: "POST",
    });
    gather.say("Your response is important to us.");

    // If no input after gather timeout, play another message
    voiceResponse.say(
      "We didn't receive any input. The call will now end. Thank you for your time."
    );

    // Explicitly end the call
    voiceResponse.hangup();

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
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN // You need to add this to your .env file
);

// Alternative method using API Key (if you prefer):
// const twilioClient = twilio(accountSid, apiKey, apiSecret, { accountSid });

app.post("/call/make", async (req, res) => {
  const { to } = req.body;

  if (!to) {
    console.log("Missing 'to' parameter.");
    return res.status(400).json({ error: "Missing 'to' parameter." });
  }

  try {
    // Get the current host from the request for dynamic webhook URLs
    const host = req.get("host");
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    // Create TwiML URL with proper query parameters
    const twimlUrl = `${baseUrl}/twiml`;
    console.log("Using TwiML URL:", twimlUrl);

    // Add status callback to track call progress
    const statusCallback = `${backend_url}/call-status`;
    console.log("Using status callback URL:", statusCallback);

    const call = await twilioClient.calls.create({
      url: `${backend_url}/twiml`,
      to: to,
      from: callerId,
      statusCallback: statusCallback,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
