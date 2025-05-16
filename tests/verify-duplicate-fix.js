/**
 * Twilio Duplicate Call Fix Verification Script
 *
 * This script can be run to verify that the duplicate call fix is working correctly.
 * It will log the key information needed to understand parent/child call relationships.
 */

// Import required dependencies
const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const twilio = require("twilio");

// Load environment variables
dotenv.config();

// Create a simple Express app
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Twilio credentials (replace with your own or use environment variables)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

// Twilio webhook handling endpoint
app.post("/verify-webhook", (req, res) => {
  console.log("=== VERIFICATION WEBHOOK RECEIVED ===");
  console.log(`Call SID: ${req.body.CallSid}`);
  console.log(
    `Parent Call SID: ${
      req.body.ParentCallSid || "None (this is a parent call)"
    }`
  );
  console.log(`Call Status: ${req.body.CallStatus}`);
  console.log(`From: ${req.body.From}`);
  console.log(`To: ${req.body.To}`);
  console.log("========================================");

  const response = new twilio.twiml.VoiceResponse();
  response.say("Verification webhook received successfully.");

  res.type("text/xml");
  res.send(response.toString());
});

// Make a test call using improved implementation
app.get("/verify-test-call", async (req, res) => {
  try {
    const call = await twilioClient.calls.create({
      url: `${
        process.env.VERIFICATION_URL || "http://YOUR_NGROK_URL"
      }/verify-webhook`,
      to: process.env.TEST_TO_NUMBER || "+1234567890", // Replace with a real number
      from: process.env.TEST_FROM_NUMBER || "+10987654321", // Replace with your Twilio number
      statusCallback: `${
        process.env.VERIFICATION_URL || "http://YOUR_NGROK_URL"
      }/verify-webhook`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    res.json({
      success: true,
      message: "Verification test call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to make verification test call",
      error: error.message,
    });
  }
});

// Start the server
const port = process.env.VERIFICATION_PORT || 3999;
app.listen(port, () => {
  console.log(`Verification server running on port ${port}`);
  console.log(
    `Make sure to expose this server to the internet (e.g., with ngrok)`
  );
  console.log(`Set TEST_TO_NUMBER and TEST_FROM_NUMBER in .env file`);
  console.log(`To test, visit: http://localhost:${port}/verify-test-call`);
});

/*
 * HOW TO USE THIS SCRIPT:
 *
 * 1. Set up environment variables (or modify this script):
 *    - TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN
 *    - TEST_TO_NUMBER (the number to call)
 *    - TEST_FROM_NUMBER (your Twilio number)
 *    - VERIFICATION_URL (Your externally accessible URL, e.g., ngrok URL)
 *
 * 2. Run this script: node verification.js
 *
 * 3. Make a test call by visiting: http://localhost:3999/verify-test-call
 *
 * 4. Check the logs to see parent/child call relationships
 *
 * For normal calls to phone numbers, you'll see:
 * - A parent call (no ParentCallSid)
 * - Then a child call (with ParentCallSid matching the parent)
 *
 * But with our fix, the user experience remains seamless, with no perception of two calls.
 */
