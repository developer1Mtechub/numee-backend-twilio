// Add a special test endpoint to check if we can resolve the duplicate call issue
app.get("/test-fix-duplicate-calls", (req, res) => {
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
        
        <h2>Deduplication Mechanisms</h2>
        <ol>
          <li>Client-side debounce to prevent multiple call button clicks</li>
          <li>Server-side API call deduplication via callDedupStore</li>
          <li>TwiML endpoint uniqueId-based deduplication</li>
          <li>In-memory call tracking with the callStore</li>
        </ol>
        
        <h2>Understanding Parent/Child Calls</h2>
        <p>With Twilio, when the &lt;Dial&gt; verb is used, Twilio creates a child call. This is unavoidable when dialing to external numbers.</p>
        <p>Our solution maintains the existing connection while making sure the UX feels like a single continuous call.</p>
        
        <h2>Testing the Fix</h2>
        <p>Make a call using the app and check the logs for:</p>
        <pre>
[CALL STATUS] SID: CAXXXX | Status: initiated | Parent SID: none
[CALL STATUS] SID: CAXXXX | Status: in-progress | Parent SID: none  
[CALL STATUS] SID: CAXXXX | Status: in-progress | Parent SID: previous-SID (this will show for phone number calls only)
        </pre>
      </body>
    </html>
  `);
});
