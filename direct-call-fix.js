// Test endpoint for the Twilio duplicate call fix
app.get("/test-fix-duplicate-calls", (req, res) => {
  // Explain the fixes implemented to resolve the duplicate call issue
  res.send(`
    <html>
      <head>
        <title>Duplicate Call Fix Test</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.6; }
          pre { background: #f4f4f4; padding: 15px; border-radius: 5px; }
          .info { background: #e8f4f8; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
          h2 { color: #333; }
        </style>
      </head>
      <body>
        <h1>Twilio Duplicate Call Fix Test</h1>
        
        <div class="info">
          <p>This page explains the fixes implemented to resolve the duplicate call issue:</p>
          <ul>
            <li>The main issue was that Twilio's <code>&lt;Dial&gt;</code> verb creates a second outbound call</li>
            <li>We've implemented multiple layers of deduplication to prevent duplicate calls</li>
            <li>Added unique call IDs passed through the request flow</li>
            <li>Enhanced diagnostics to identify parent/child call relationships</li>
            <li>Removed introductory messages that made it feel like a second call</li>
            <li>Added record="do-not-record" parameter to dial verbs to reduce resource usage</li>
          </ul>
        </div>
        
        <h2>Current TwiML Implementation</h2>
        <pre>
// For client calls
const dial = voiceResponse.dial({
  callerId: from,
  timeout: 30,
  action: '${backend_url}/call-action-result',
  method: "POST",
  record: "do-not-record"  // Prevents recording, reduces second call feeling
});
dial.client(clientId);

// For regular phone numbers
const dial = voiceResponse.dial({
  callerId: from,
  timeout: 30,
  action: '${backend_url}/call-action-result',
  method: "POST",
  record: "do-not-record"  // Prevents recording, reduces second call feeling
});
dial.number(to);
        </pre>
        
        <p>With Twilio, the <code>&lt;Dial&gt;</code> verb will always create a child call - this is unavoidable when calling external numbers.</p>
        <p>Our solution minimizes the impact by using proper deduplication and removing any messages that make it feel like a second call.</p>
      </body>
    </html>
  `);
});

// Add the enhanced "Direct Call" endpoint for use in production
app.post("/call/make-direct", async (req, res) => {
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

    // Generate a unique identifier for this call attempt to prevent duplication
    const callUniqueId = `${from}-${to}-${Date.now()}`;
    console.log(`Generated unique call ID: ${callUniqueId}`);

    // Use the backend_url from environment variable as the base for all webhook URLs
    const statusCallback = `${backend_url}/call-status`;

    // Different approach based on destination type
    if (to.indexOf("client:") === 0) {
      // This is a call to another app user - client connection
      const clientId = to.split(":")[1];

      // For client-to-client calls, use a specialized TwiML endpoint
      const twimlUrl = `${backend_url}/twiml-direct-client?callUniqueId=${encodeURIComponent(
        callUniqueId
      )}&clientId=${encodeURIComponent(clientId)}`;

      console.log(`Using direct client TwiML URL: ${twimlUrl}`);

      const call = await twilioClient.calls.create({
        url: twimlUrl,
        to: to,
        from: from,
        statusCallback: statusCallback,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      });

      // Track the call in the store
      callStore.trackCall(call.sid, {
        from,
        to,
        fromIdentity: fromIdentity || null,
        toIdentity: clientId,
        direction: "outbound",
        callType: "direct-client",
        callUniqueId,
      });

      console.log(`Direct client call initiated: ${call.sid}`);
      return res.status(200).json({
        success: true,
        sid: call.sid,
        message: "Direct client call initiated successfully",
      });
    } else {
      // This is a call to a regular phone number - PSTN call
      // For PSTN calls, we still need to use <Dial>
      const twimlUrl = `${backend_url}/twiml-direct-number?callUniqueId=${encodeURIComponent(
        callUniqueId
      )}&to=${encodeURIComponent(to)}`;

      console.log(`Using direct number TwiML URL: ${twimlUrl}`);

      const call = await twilioClient.calls.create({
        url: twimlUrl,
        to: from, // Call the caller first
        from: from, // Use same number as from
        statusCallback: statusCallback,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      });

      // Track the call in the store
      callStore.trackCall(call.sid, {
        from,
        to,
        fromIdentity: fromIdentity || null,
        direction: "outbound",
        callType: "direct-number",
        callUniqueId,
      });

      console.log(`Direct number call initiated: ${call.sid}`);
      return res.status(200).json({
        success: true,
        sid: call.sid,
        message: "Direct number call initiated successfully",
      });
    }
  } catch (error) {
    console.error("Twilio error in direct call:", error.message);
    let message = error.message;
    if (error.code) {
      switch (error.code) {
        case 21211:
          message = "Invalid phone number format";
          break;
        case 21214:
          message = "Phone number is not valid or verified";
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

// Add TwiML endpoints for direct connections
app.all("/twiml-direct-client", (req, res) => {
  console.log("Direct client TwiML endpoint called:", req.query || req.body);

  try {
    const voiceResponse = new twiml.VoiceResponse();
    const clientId = req.query.clientId || req.body.clientId;

    if (!clientId) {
      voiceResponse.say("Missing client ID parameter. Cannot complete call.");
      voiceResponse.hangup();
    } else {
      // No introductory message - direct connection
      const dial = voiceResponse.dial({
        timeout: 30,
        record: "do-not-record", // Important: don't create a recording
      });
      dial.client(clientId);
    }

    console.log("Generated direct client TwiML:", voiceResponse.toString());
    res.type("text/xml");
    res.send(voiceResponse.toString());
  } catch (error) {
    console.error("Error in twiml-direct-client:", error);
    const errorResponse = new twiml.VoiceResponse();
    errorResponse.say(
      "Sorry, there was a technical problem. Please try again later."
    );
    res.type("text/xml");
    res.status(500).send(errorResponse.toString());
  }
});

app.all("/twiml-direct-number", (req, res) => {
  console.log("Direct number TwiML endpoint called:", req.query || req.body);

  try {
    const voiceResponse = new twiml.VoiceResponse();
    const to = req.query.to || req.body.to;

    if (!to) {
      voiceResponse.say("Missing destination number. Cannot complete call.");
      voiceResponse.hangup();
    } else {
      // No introductory message - direct connection
      const dial = voiceResponse.dial({
        timeout: 30,
        record: "do-not-record", // Important: don't create a recording
      });
      dial.number(to);
    }

    console.log("Generated direct number TwiML:", voiceResponse.toString());
    res.type("text/xml");
    res.send(voiceResponse.toString());
  } catch (error) {
    console.error("Error in twiml-direct-number:", error);
    const errorResponse = new twiml.VoiceResponse();
    errorResponse.say(
      "Sorry, there was a technical problem. Please try again later."
    );
    res.type("text/xml");
    res.status(500).send(errorResponse.toString());
  }
});
