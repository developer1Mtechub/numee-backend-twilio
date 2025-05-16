// This file provides a test endpoint to demonstrate and debug the duplicate call fix implementation
const express = require("express");
const router = express.Router();

/**
 * Test GET endpoint to show information about the duplicate call fix and how to test it
 */
router.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Twilio Duplicate Call Fix - Test Page</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; line-height: 1.6; }
          h1, h2 { color: #333; }
          code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
          pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
          .test-btn { padding: 10px 15px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; }
          .test-btn:hover { background: #45a049; }
          .section { border: 1px solid #ddd; padding: 15px; margin: 20px 0; border-radius: 5px; }
          .note { background: #fff8dc; padding: 10px; border-left: 4px solid #ffeb3b; }
        </style>
      </head>
      <body>
        <h1>Twilio Duplicate Call Fix - Testing</h1>
        
        <div class="note">
          <strong>Note:</strong> This page explains how to test the fixes for the duplicate call issue in the Twilio voice application.
        </div>
        
        <div class="section">
          <h2>The Problem</h2>
          <p>When initiating a call via the <code>/call/make</code> endpoint, Twilio sometimes dials the same number twice:</p>
          <ol>
            <li>The first call is the initial outbound call</li>
            <li>The second call happens when the <code>&lt;Dial&gt;</code> verb creates another outbound call</li>
          </ol>
        </div>
        
        <div class="section">
          <h2>The Solution</h2>
          <p>We've implemented several fixes:</p>
          <ol>
            <li>Enhanced deduplication with unique call IDs</li>
            <li>Improved <code>record="do-not-record"</code> parameter on dial verbs</li>
            <li>Improved call flow with no interruptions between call legs</li>
            <li>Enhanced logging to diagnose parent/child call relationships</li>
          </ol>
        </div>
        
        <div class="section">
          <h2>Testing the Fix</h2>
          <p>There are two options to test:</p>
          
          <h3>Option 1: Enhanced Standard Endpoint</h3>
          <p>Use the improved <code>/call/make</code> endpoint which now includes unique call IDs and enhanced TwiML.</p>
          <pre>
// Example API call
fetch('/call/make', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: '+1234567890',
    to: '+1987654321' 
  })
})</pre>
          
          <h3>Option 2: New Direct Call API</h3>
          <p>We've created a specialized endpoint that handles client and number calls differently:</p>
          <pre>
// Example API call
fetch('/call/make-direct', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: '+1234567890',
    to: '+1987654321' 
  })
})</pre>
        </div>
        
        <div class="section">
          <h2>Monitoring Results</h2>
          <p>Check the server logs for these patterns:</p>
          <pre>
// For client calls (app-to-app):
[CALL STATUS] SID: CAXXXX | Status: initiated | Parent SID: none
[CALL STATUS] SID: CAXXXX | Status: in-progress | Parent SID: none

// For phone number calls:
[CALL STATUS] SID: CAXXXX | Status: initiated | Parent SID: none
[CALL STATUS] SID: CAXXXX | Status: in-progress | Parent SID: none  
[CALL STATUS] SID: CAXXXX | Status: in-progress | Parent SID: previous-SID</pre>
          
          <p>For phone number calls, you'll still see a child call (with a Parent SID), but the user experience will be seamless.</p>
        </div>
      </body>
    </html>
  `);
});

/**
 * Test POST endpoint to simulate a call with the fixed implementation
 */
router.post("/test-call", async (req, res) => {
  const { to, from } = req.body;

  if (!to || !from) {
    return res.status(400).json({
      success: false,
      error: "Missing 'to' or 'from' parameters",
    });
  }

  try {
    // Forward to our enhanced endpoint
    const response = await fetch(
      `${process.env.BACKEND_URL || "http://localhost:3091"}/call/make-direct`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, from }),
      }
    );

    const data = await response.json();
    return res.json({
      success: true,
      message: "Test call initiated using fixed implementation",
      callData: data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: `Test call failed: ${error.message}`,
    });
  }
});

module.exports = router;
