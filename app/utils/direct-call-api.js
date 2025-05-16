// Add a direct control endpoint for fixing the duplicate call issue
module.exports = function(app, twiml, twilioClient, callDedupStore, callStore, backend_url) {
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
      
      // For client-to-client calls, we can use Twilio's Client API directly
      // which avoids the need for <Dial> in TwiML
      
      // Create a specialized TwiML URL for client-to-client connections
      const twimlUrl = `${backend_url}/twiml-direct-client?callUniqueId=${encodeURIComponent(callUniqueId)}&clientId=${encodeURIComponent(clientId)}`;
      
      console.log(`Using direct client TwiML URL: ${twimlUrl}`);
      
      const call = await twilioClient.calls.create({
        url: twimlUrl,
        to: to,
        from: from,
        statusCallback: statusCallback,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST"
      });
      
      // Track the call in the store
      callStore.trackCall(call.sid, {
        from,
        to,
        fromIdentity: fromIdentity || null,
        toIdentity: clientId,
        direction: "outbound",
        callType: "direct-client",
        callUniqueId
      });
      
      console.log(`Direct client call initiated: ${call.sid}`);
      return res.status(200).json({
        success: true,
        sid: call.sid,
        message: "Direct client call initiated successfully"
      });
      
    } else {
      // This is a call to a regular phone number - PSTN call
      // For PSTN calls, we must use <Dial> but we can use a special TwiML endpoint
      const twimlUrl = `${backend_url}/twiml-direct-number?callUniqueId=${encodeURIComponent(callUniqueId)}&to=${encodeURIComponent(to)}`;
      
      console.log(`Using direct number TwiML URL: ${twimlUrl}`);
      
      const call = await twilioClient.calls.create({
        url: twimlUrl,
        to: from, // Call the caller first
        from: from, // Use same number as from
        statusCallback: statusCallback,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST"
      });
      
      // Track the call in the store
      callStore.trackCall(call.sid, {
        from,
        to,
        fromIdentity: fromIdentity || null,
        direction: "outbound",
        callType: "direct-number",
        callUniqueId
      });
      
      console.log(`Direct number call initiated: ${call.sid}`);
      return res.status(200).json({
        success: true,
        sid: call.sid,
        message: "Direct number call initiated successfully"
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
        record: "do-not-record" // Important: don't create a recording
      });
      dial.client(clientId);
    }
    
    console.log("Generated direct client TwiML:", voiceResponse.toString());
    res.type("text/xml");
    res.send(voiceResponse.toString());
  } catch (error) {
    console.error("Error in twiml-direct-client:", error);
    const errorResponse = new twiml.VoiceResponse();
    errorResponse.say("Sorry, there was a technical problem. Please try again later.");
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
        record: "do-not-record" // Important: don't create a recording
      });
      dial.number(to);
    }
    
    console.log("Generated direct number TwiML:", voiceResponse.toString());
    res.type("text/xml");
    res.send(voiceResponse.toString());
  } catch (error) {
    console.error("Error in twiml-direct-number:", error);
    const errorResponse = new twiml.VoiceResponse();
    errorResponse.say("Sorry, there was a technical problem. Please try again later.");
    res.type("text/xml");
    res.status(500).send(errorResponse.toString());
  }
});
