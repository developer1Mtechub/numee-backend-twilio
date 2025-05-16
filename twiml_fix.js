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
    const direction = req.body.Direction || "";
    const callStatus = req.body.CallStatus || "";

    // Add debug logs to trace call flow
    console.log(`Call from ${from} to ${to} with SID ${callSid}`);
    console.log(`Call direction: ${direction}, status: ${callStatus}`);
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

    // This is the key change: Instead of using <Dial> which creates a second outbound call,
    // we use direct connection without dialing again

    // Check if we're calling a client (app user) or regular number
    if (to.indexOf("client:") === 0) {
      // This is a call to another app user
      const clientId = to.split(":")[1];

      // For client calls, we simply connect directly without a message
      // Removed use of the <Dial> verb as it creates a second call
      voiceResponse.say({ voice: "woman" }, "Connecting your call now.");

      // Use Twilio's Voice SDK capabilities - instead of <Dial> which creates a second call
      // The client should be already connected at this point through the API call
      console.log(`Directly handling client connection: ${clientId}`);
    } else {
      // This is a call to a regular phone number
      // For PSTN calls we must use dial, but we'll skip any introductory messages
      // to make it feel like a direct connection
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
