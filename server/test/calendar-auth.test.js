"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { authorize, buildAuthUrl, pkcePair, startLoopback, exchangeCode } = require("../src/availability/oauth");
const { SCOPE, TOKEN_URL, FREEBUSY_URL } = require("../src/availability/google");

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("PKCE challenge is the base64url SHA-256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && /^[A-Za-z0-9_-]+$/.test(verifier));
  assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(pkcePair().verifier, verifier);
});

test("sign-in link asks for exactly the free/busy scope, offline access, PKCE and a state", () => {
  const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555", state: "st", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = Object.fromEntries(url.searchParams);
  assert.deepEqual(p, { client_id: "cid", redirect_uri: "http://127.0.0.1:5555", response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state: "st", code_challenge: "ch", code_challenge_method: "S256" });
  assert.equal(SCOPE, "https://www.googleapis.com/auth/calendar.freebusy");
});

test("the loopback listener accepts only the matching state and ignores strangers", async () => {
  const loop = startLoopback({ state: "good-state", timeoutMs: 5000 });
  const base = await loop.ready;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${base}/?code=evil&state=wrong`)).status, 400);
  assert.equal((await fetch(`${base}/other?code=x&state=good-state`)).status, 404);
  assert.equal((await fetch(`${base}/?state=good-state`)).status, 400); // no code
  assert.equal((await fetch(`${base}/?code=the-code&state=good-state`)).status, 200);
  assert.equal(await loop.codePromise, "the-code");
  loop.close();
});

test("a denied consent screen and a timeout both end the flow cleanly", async () => {
  const denied = startLoopback({ state: "s", timeoutMs: 5000 });
  const base = await denied.ready;
  const settled = denied.codePromise.then(() => "resolved", (e) => e.message);
  await fetch(`${base}/?error=access_denied&state=s`);
  assert.equal(await settled, "authorization_denied");
  denied.close();
  const slow = startLoopback({ state: "s", timeoutMs: 30 });
  await slow.ready;
  await assert.rejects(slow.codePromise, { message: "timed_out" });
  slow.close();
});

test("token exchange refuses broader scopes and missing refresh tokens, and surfaces no secrets", async () => {
  const args = { clientId: "cid", clientSecret: "CLIENT-SECRET", code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1" };
  const ok = { access_token: "a", refresh_token: "REFRESH-TOKEN", scope: SCOPE };
  assert.deepEqual(await exchangeCode(args, async () => json(200, ok)), { refreshToken: "REFRESH-TOKEN" });
  await assert.rejects(exchangeCode(args, async () => json(200, { ...ok, scope: `${SCOPE} https://www.googleapis.com/auth/calendar.readonly` })), { message: "unexpected_scope" });
  await assert.rejects(exchangeCode(args, async () => json(200, { ...ok, scope: "https://www.googleapis.com/auth/calendar" })), { message: "unexpected_scope" });
  await assert.rejects(exchangeCode(args, async () => json(200, { ...ok, refresh_token: undefined })), { message: "no_refresh_token" });
  const failure = await exchangeCode(args, async () => json(400, { error: "invalid_grant", error_description: "SECRET-DETAIL" })).catch((e) => e.message);
  assert.equal(failure, "token_exchange_failed:invalid_grant");
});

test("the code exchange sends the PKCE verifier and the exact redirect, and the whole flow yields a token plus a free/busy test", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: String(init.body) });
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init.body));
      return form.get("grant_type") === "authorization_code" ? json(200, { access_token: "ACCESS", refresh_token: "NEW-REFRESH-TOKEN", scope: SCOPE, expires_in: 3600 }) : json(200, { access_token: "ACCESS2", expires_in: 3600 });
    }
    if (url === FREEBUSY_URL) return json(200, { calendars: { primary: { busy: [{ start: "2026-11-14T17:00:00Z", end: "2026-11-14T18:00:00Z", summary: "SECRET-TITLE" }] } } });
    throw new Error("unexpected " + url);
  };
  let signInUrl;
  const result = await authorize({
    clientId: "cid", clientSecret: "csecret", fetchImpl, timeoutMs: 5000,
    onUrl: (u) => {
      signInUrl = new URL(u);
      // The "browser": Google redirects back to the loopback with the state we generated.
      setTimeout(() => fetch(`${signInUrl.searchParams.get("redirect_uri")}/?code=AUTH-CODE&state=${signInUrl.searchParams.get("state")}`), 20);
    },
  });
  assert.deepEqual(result, { refreshToken: "NEW-REFRESH-TOKEN", busyIntervals: 1 });
  const exchange = Object.fromEntries(new URLSearchParams(seen[0].body));
  assert.equal(exchange.code, "AUTH-CODE");
  assert.equal(exchange.redirect_uri, signInUrl.searchParams.get("redirect_uri"));
  assert.equal(crypto.createHash("sha256").update(exchange.code_verifier).digest("base64url"), signInUrl.searchParams.get("code_challenge"));
  assert.ok(!JSON.stringify(result).includes("SECRET-TITLE")); // only a count comes back from the live check
});
