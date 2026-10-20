"use strict";
// One-time Google Calendar free/busy authorisation. Run on a computer with a web browser (not on the
// headless server), as the calendar's owner:
//
//   cd server && npm ci --omit=dev
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node src/calendar-auth.js [--port 53682] [--calendar-id primary]
//
// It prints a sign-in link, waits for Google to redirect back to http://127.0.0.1:<port>, then prints a
// REFRESH TOKEN once. Put that token in the server's /etc/kaileb-inquiry/env as GOOGLE_REFRESH_TOKEN.
// Nothing is saved to disk or Git by this tool. Scope requested: calendar.freebusy (busy times only).

const { authorize } = require("./availability/oauth");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};

(async () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the Desktop-app OAuth client from Google Cloud) in this shell first. See server/README.md.");
    process.exit(1);
  }
  const port = arg("--port") ? Number(arg("--port")) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("--port must be a number between 1 and 65535.");
    process.exit(1);
  }
  const result = await authorize({
    clientId,
    clientSecret,
    calendarId: arg("--calendar-id") || "primary",
    port,
    onUrl: (url) => {
      console.log("\n1. Open this link in a browser and sign in with the Google account that owns the calendar:\n");
      console.log(url);
      console.log("\n   Google will warn that the app is not verified (it is your own private app): choose Advanced > continue.");
      console.log("   It asks only to \"see your availability\" (busy/free times), never event titles or details.");
      console.log("\n2. Waiting for Google to send you back to this computer (5 minutes)...");
    },
  });
  console.log(`\nConnected. A test free/busy request succeeded (${result.busyIntervals} busy interval(s) in the next 30 days).`);
  console.log("\nGOOGLE_REFRESH_TOKEN (copy it now; it is shown only once and is a secret):\n");
  console.log(result.refreshToken);
  console.log("\nPut it in /etc/kaileb-inquiry/env on the server (never in Git, chat or email), set CALENDAR_PROVIDER=google, then restart the service.");
})().catch((err) => {
  const hints = {
    authorization_denied: "Authorization was cancelled in the browser.",
    timed_out: "No response within 5 minutes.",
    unexpected_scope: "Google granted a different scope than calendar.freebusy. Nothing was saved. Check the consent screen's scopes.",
    "token_ok_but_freebusy_failed:calendar_not_found": "Sign-in worked but Google could not find that calendar. Re-run with --calendar-id <the calendar's full Gmail address> (the nickname \"primary\" is rejected under this narrow scope), and make sure that account has opened Google Calendar at least once.",
    no_refresh_token: "Google did not issue a refresh token. Remove this app at https://myaccount.google.com/permissions and run the command again.",
  };
  console.error(`\nFailed: ${hints[err.message] || err.message}`);
  process.exit(1);
});
