"use strict";
// One-time Google authorisation for the free/busy connection: OAuth 2.0 authorization-code flow for
// "Desktop app" clients using a loopback redirect (http://127.0.0.1:<port>) with PKCE (S256) and a
// random `state`. Run by the owner/administrator on a machine with a browser (src/calendar-auth.js);
// the server itself only ever uses the resulting refresh token. The owner's Google password is never
// seen by this code: the owner signs in on accounts.google.com.
//
// Nothing here writes to disk or logs. The caller prints the refresh token once.

const http = require("http");
const crypto = require("crypto");
const { SCOPE, TOKEN_URL, createGoogleSource, CalendarError } = require("./google");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const b64url = (buf) => buf.toString("base64url");

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE, // the single, narrowest scope this app needs
    access_type: "offline", // needed to receive a refresh token
    prompt: "consent", // always issue a (new) refresh token
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

/** Local one-shot listener that receives Google's redirect. Only a matching `state` is accepted. */
function startLoopback({ state, port = 0, timeoutMs = 5 * 60000 }) {
  let settle;
  const codePromise = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const reply = (status, text) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(text);
    };
    if (url.pathname !== "/" || req.method !== "GET") return reply(404, "Not found");
    if (url.searchParams.get("state") !== state) return reply(400, "Unexpected request (state mismatch). You can close this tab.");
    if (url.searchParams.get("error")) {
      reply(200, "Authorization was not completed. You can close this tab and re-run the command.");
      return settle.reject(new Error("authorization_denied"));
    }
    const code = url.searchParams.get("code");
    if (!code) return reply(400, "Missing authorization code.");
    reply(200, "Google Calendar free/busy access authorized. You can close this tab and return to the terminal.");
    settle.resolve(code);
  });
  const timer = setTimeout(() => settle.reject(new Error("timed_out")), timeoutMs);
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  return { ready, codePromise, close };
}

/** Exchanges the authorization code (+ PKCE verifier) for tokens. Returns only what we keep. */
async function exchangeCode({ clientId, clientSecret, code, verifier, redirectUri }, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data) throw new Error(data && typeof data.error === "string" ? `token_exchange_failed:${data.error}` : "token_exchange_failed");
  // Refuse anything broader than free/busy, even if the consent screen were edited to ask for more.
  const granted = String(data.scope || "").split(/\s+/).filter(Boolean);
  if (granted.length !== 1 || granted[0] !== SCOPE) throw new Error("unexpected_scope");
  if (typeof data.refresh_token !== "string" || !data.refresh_token) throw new Error("no_refresh_token");
  return { refreshToken: data.refresh_token };
}

/**
 * Full flow. `onUrl(url)` is called with the sign-in link to open in a browser. Resolves with
 * { refreshToken, busyIntervals } where busyIntervals is just a count from a live free/busy test call.
 */
async function authorize({ clientId, clientSecret, calendarId = "primary", port = 0, onUrl, fetchImpl = globalThis.fetch, timeoutMs }) {
  const state = b64url(crypto.randomBytes(16));
  const { verifier, challenge } = pkcePair();
  const loop = startLoopback({ state, port, timeoutMs });
  try {
    const redirectUri = await loop.ready;
    onUrl(buildAuthUrl({ clientId, redirectUri, state, challenge }));
    const code = await loop.codePromise;
    const { refreshToken } = await exchangeCode({ clientId, clientSecret, code, verifier, redirectUri }, fetchImpl);
    // Prove the connection works (free/busy only) without showing or keeping anything but a count.
    const now = Date.now();
    let count;
    try {
      count = (await createGoogleSource({ clientId, clientSecret, refreshToken, calendarId }, fetchImpl).getBusy(now, now + 30 * 86400000)).length;
    } catch (err) {
      throw new Error(`token_ok_but_freebusy_failed:${err instanceof CalendarError ? err.code : "error"}`);
    }
    return { refreshToken, busyIntervals: count };
  } finally {
    loop.close();
  }
}

module.exports = { authorize, buildAuthUrl, pkcePair, startLoopback, exchangeCode, AUTH_URL };
