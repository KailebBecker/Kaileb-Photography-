"use strict";
// Public-surface security behaviour of the inquiry API (hostile input, abuse limits, bot check,
// proxy/IP handling, log hygiene, start-up safety). Everything runs in-process or against a local
// child process with fake providers: nothing here touches the network or any real service.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { setup, payload, ORIGIN, key } = require("./helpers");
const { createNotifier } = require("../src/notify");
const { loadConfig } = require("../src/config");
const { UNSAFE_TEXT } = require("../src/validate");

const URL_PATH = "/api/inquiries";
const rows = (db) => db.prepare("SELECT * FROM inquiries ORDER BY created_at, id").all();
const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM inquiries").get().n;
const cp = (...codes) => String.fromCodePoint(...codes);
const hasUnsafe = (s) => new RegExp(UNSAFE_TEXT.source).test(s);

// ---------------------------------------------------------------------------------------------
// Malformed / hostile requests
// ---------------------------------------------------------------------------------------------

test("broken or hostile JSON bodies are refused cleanly and store nothing", async () => {
  const t = setup();
  const bodies = [
    "", "{", '{"name":', "{not json}", "null", "[]", '"x"', "12345", "true",
    '{"__proto__":{"admin":true},"name":"a"}',
    '{"constructor":{"prototype":{"polluted":1}}}',
    "[".repeat(5000) + "]".repeat(5000),
    JSON.stringify(payload()) + cp(0),
  ];
  for (const body of bodies) {
    const res = await t.post(body);
    assert.ok([400, 413].includes(res.statusCode), `${body.slice(0, 30)} -> ${res.statusCode}`);
    assert.equal(res.json().ok, false);
  }
  assert.equal(count(t.db), 0);
  assert.equal({}.polluted, undefined);
  assert.equal({}.admin, undefined);
});

test("only application/json bodies are accepted (charset parameter allowed)", async () => {
  const t = setup();
  for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/xml", "text/html"]) {
    assert.equal((await t.post(JSON.stringify(payload()), { "content-type": ct })).statusCode, 415, ct);
  }
  const noType = await t.app.inject({ method: "POST", url: URL_PATH, headers: { origin: ORIGIN }, payload: Buffer.from(JSON.stringify(payload())) });
  assert.ok([400, 415].includes(noType.statusCode));
  assert.equal(count(t.db), 0);
  assert.equal((await t.post(payload(), { "content-type": "application/json; charset=utf-8" })).statusCode, 201);
});

test("other HTTP methods and paths do nothing and reveal nothing", async () => {
  const t = setup();
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const res = await t.app.inject({ method, url: URL_PATH, headers: { origin: ORIGIN, "content-type": "application/json" }, payload: method === "GET" ? undefined : JSON.stringify(payload()) });
    assert.ok([404, 405].includes(res.statusCode), `${method} -> ${res.statusCode}`);
  }
  for (const [method, url] of [["POST", "/health"], ["POST", URL_PATH + "/"], ["POST", URL_PATH + "/x"], ["GET", "/admin"], ["GET", "/.env"], ["GET", "/inquiries.db"], ["GET", "/data/inquiries.db"], ["GET", "/../etc/passwd"], ["GET", "/"]]) {
    const res = await t.app.inject({ method, url, headers: { "content-type": "application/json" }, payload: method === "POST" ? "{}" : undefined });
    assert.ok([400, 404].includes(res.statusCode), `${method} ${url} -> ${res.statusCode}`);
    assert.doesNotMatch(res.body, /fastify|stack|node_modules|sqlite/i);
  }
  assert.equal(count(t.db), 0);
});

test("unexpected fields are rejected (no way to set status, ids, timestamps or notification state)", async () => {
  const t = setup();
  for (const extra of [{ status: "confirmed" }, { id: "ABCDEFGHJK" }, { created_at: "2020-01-01T00:00:00Z" }, { notify_status: "sent" }, { session_date: "2026-12-01" }, { isAdmin: true }, { source_origin: "https://x.example" }]) {
    const res = await t.post(payload(extra));
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
    assert.ok(res.json().fields[Object.keys(extra)[0]]);
  }
  assert.equal(count(t.db), 0);
});

test("each required field is enforced on its own", async () => {
  const t = setup();
  for (const field of ["name", "email", "sessionType", "message", "idempotencyKey"]) {
    const body = payload();
    delete body[field];
    const res = await t.post(body);
    assert.equal(res.statusCode, 400, field);
    assert.ok(res.json().fields[field], field);
  }
  assert.equal(count(t.db), 0);
});

test("API responses are never cacheable and do not identify the framework", async () => {
  const t = setup();
  const responses = [
    await t.post(payload()),
    await t.post({ name: "" }),
    await t.post(payload(), { origin: "https://evil.example" }),
    await t.app.inject({ method: "GET", url: "/nope" }),
  ];
  for (const res of responses) {
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-powered-by"], undefined);
    assert.equal(res.headers.server, undefined);
    assert.match(res.headers["content-type"], /^application\/json/);
  }
});

// ---------------------------------------------------------------------------------------------
// Origin / CORS
// ---------------------------------------------------------------------------------------------

test("only the exact configured origin is accepted (null, scheme/port/path variants, look-alikes)", async () => {
  const t = setup();
  for (const origin of ["null", "http://kailebbecker.github.io", "https://kailebbecker.github.io:8443", "https://kailebbecker.github.io/", "https://kailebbecker.github.io/Kaileb-Photography-/", "https://evilkailebbecker.github.io", "https://kailebbecker.github.io.evil.example", "*"]) {
    const res = await t.post(payload(), { origin });
    assert.equal(res.statusCode, 403, origin);
    assert.equal(res.headers["access-control-allow-origin"], undefined, origin);
  }
  const preflight = await t.app.inject({ method: "OPTIONS", url: URL_PATH, headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  assert.equal(count(t.db), 0);
});

// ---------------------------------------------------------------------------------------------
// Rate limiting, IP identity, per-email abuse, honeypot
// ---------------------------------------------------------------------------------------------

test("X-Forwarded-For is trusted only from the local proxy, so visitors cannot pick their own rate-limit identity", async () => {
  const send = (t, remoteAddress, xff, n) =>
    t.app.inject({ method: "POST", url: URL_PATH, remoteAddress, headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": xff }, payload: JSON.stringify(payload({ email: `u${n}@example.com` })) }).then((r) => r.statusCode);
  const run = async (t, remote, xffFor) => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await send(t, remote, xffFor(i), i));
    return codes;
  };

  // Behind nginx (request arrives from loopback): the forwarded address identifies the visitor.
  let t = setup({ env: { TRUST_PROXY: "true", RATE_LIMIT_MAX: "2" } });
  assert.deepEqual(await run(t, "127.0.0.1", () => "198.51.100.7"), [201, 201, 429, 429]);
  assert.equal(await send(t, "127.0.0.1", "198.51.100.8", 9), 201); // a different visitor is unaffected

  // Anything not coming from the local proxy cannot pose as another address by rotating the header.
  t = setup({ env: { TRUST_PROXY: "true", RATE_LIMIT_MAX: "2" } });
  assert.deepEqual(await run(t, "203.0.113.9", (i) => `10.0.0.${i}`), [201, 201, 429, 429]);

  // Proxy trust off: the header is ignored even from loopback.
  t = setup({ env: { RATE_LIMIT_MAX: "2" } });
  assert.deepEqual(await run(t, "127.0.0.1", (i) => `198.51.100.${i}`), [201, 201, 429, 429]);
});

test("IPv6 visitors are limited per /64 network, not per address", async () => {
  const t = setup({ env: { RATE_LIMIT_MAX: "2" } });
  const send = (remoteAddress, n) => t.app.inject({ method: "POST", url: URL_PATH, remoteAddress, headers: { "content-type": "application/json", origin: ORIGIN }, payload: JSON.stringify(payload({ email: `v${n}@example.com` })) }).then((r) => r.statusCode);
  assert.deepEqual([await send("2001:db8:1:2::1", 1), await send("2001:db8:1:2::2", 2), await send("2001:db8:1:2:abcd::9", 3)], [201, 201, 429]);
  assert.equal(await send("2001:db8:1:3::1", 4), 201); // a different /64
});

test("rate limiting is applied before validation work: rejected requests count, and floods cannot reach storage or the bot check", async () => {
  let providerCalls = 0;
  const t = setup({ env: { RATE_LIMIT_MAX: "3", TURNSTILE_SECRET: "s" }, fetchImpl: async () => { providerCalls++; return { ok: true, json: async () => ({ success: false }) }; } });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await t.post(payload({ turnstileToken: "t" + i }))).statusCode);
  assert.deepEqual(codes, [400, 400, 400, 429, 429, 429, 429, 429]);
  assert.equal(providerCalls, 3); // Cloudflare is not called for rate-limited requests
  assert.equal(count(t.db), 0);
});

test("per-email daily cap ignores letter case; other emails and the limit window are unaffected", async () => {
  const t = setup();
  const codes = [];
  for (const e of ["Jamie@Example.com", "JAMIE@example.com", "jamie@EXAMPLE.COM", "jamie@example.com", "jAmie@example.com", "jamie@example.com"]) codes.push((await t.post(payload({ email: e }))).statusCode);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
  assert.equal((await t.post(payload({ email: "someone.else@example.com" }))).statusCode, 201);
});

test("a double-tap or retry with the same key never creates a second inquiry or email, and cannot overwrite the first", async () => {
  const t = setup();
  const original = payload({ message: "Original message" });
  const first = (await t.post(original)).json();
  const retry = await t.post({ ...original, message: "Attacker-chosen replacement" });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), { ok: true, id: first.id, duplicate: true });
  await t.service.drain();
  assert.equal(count(t.db), 1);
  assert.equal(rows(t.db)[0].message, "Original message");
  assert.equal(t.sent.length, 1);
});

test("honeypot hits are pretend-successes: nothing stored or sent, no bot-check call, still rate limited", async () => {
  let providerCalls = 0;
  const t = setup({ env: { RATE_LIMIT_MAX: "2", TURNSTILE_SECRET: "s" }, fetchImpl: async () => { providerCalls++; return { ok: true, json: async () => ({ success: true }) }; } });
  const a = await t.post(payload({ website: "http://spam.example" }));
  const b = await t.post(payload({ website: " x " }));
  const c = await t.post(payload({ website: "http://spam.example" }));
  assert.deepEqual([a.statusCode, b.statusCode, c.statusCode], [201, 201, 429]);
  assert.equal(a.json().ok, true);
  await t.service.drain();
  assert.equal(count(t.db), 0);
  assert.equal(t.sent.length, 0);
  assert.equal(providerCalls, 0);
});

// ---------------------------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------------------------

const SECRET = "test-secret-DO-NOT-LOG";
const SITE_HOST = "kailebbecker.github.io";

/** Fake Cloudflare siteverify: knows one secret, accepts "good-*" tokens once, mimics its error codes. */
function fakeTurnstile() {
  const spent = new Set();
  const calls = [];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, init) => {
    const p = new URLSearchParams(init.body);
    const token = p.get("response");
    calls.push({ url, method: init.method, secret: p.get("secret"), response: token, remoteip: p.get("remoteip") });
    if (p.get("secret") !== SECRET) return reply({ success: false, "error-codes": ["invalid-input-secret"] });
    if (token === "provider-500") return { ok: false, status: 500, json: async () => ({}) };
    if (token === "provider-down") throw new Error("connect ECONNREFUSED");
    if (token === "internal") return reply({ success: false, "error-codes": ["internal-error"] });
    if (token === "other-host") return reply({ success: true, hostname: "evil.example" });
    if (token === "no-host") return reply({ success: true });
    if (token === "garbage") return { ok: true, status: 200, json: async () => "not an object" };
    if (!token.startsWith("good-")) return reply({ success: false, "error-codes": ["invalid-input-response"] });
    if (spent.has(token)) return reply({ success: false, "error-codes": ["timeout-or-duplicate"] });
    spent.add(token);
    return reply({ success: true, hostname: SITE_HOST });
  };
  return { fetchImpl, calls };
}

const withTurnstile = (env = {}) => {
  const ts = fakeTurnstile();
  return { ...setup({ env: { TURNSTILE_SECRET: SECRET, ...env }, fetchImpl: ts.fetchImpl }), ts };
};

test("Turnstile: missing, invalid, spent and wrong-site tokens are refused; a fresh token works exactly once", async () => {
  const t = withTurnstile();
  const noToken = await t.post(payload());
  assert.equal(noToken.statusCode, 400);
  assert.deepEqual(noToken.json(), { ok: false, error: "bot_check_failed" });
  assert.equal(t.ts.calls.length, 0); // nothing to verify, nothing sent to Cloudflare

  assert.equal((await t.post(payload({ turnstileToken: "forged" }))).statusCode, 400);
  assert.equal((await t.post(payload({ turnstileToken: "other-host" }))).statusCode, 400); // valid token, issued for another website
  assert.equal((await t.post(payload({ turnstileToken: "no-host" }))).statusCode, 400); // no hostname => cannot confirm it is ours
  assert.equal(count(t.db), 0);

  assert.equal((await t.post(payload({ turnstileToken: "good-one" }))).statusCode, 201);
  // Replaying the used token, with a new inquiry or the same one, is not a substitute for verification.
  assert.equal((await t.post(payload({ turnstileToken: "good-one", email: "other@example.com" }))).statusCode, 400);
  const dup = payload({ turnstileToken: "good-two" });
  assert.equal((await t.post(dup)).statusCode, 201);
  assert.equal((await t.post({ ...dup })).statusCode, 400); // same body + same (now spent) token
  assert.equal(count(t.db), 2);
});

test("Turnstile: provider trouble fails closed with a generic 503 and stores nothing", async () => {
  const t = withTurnstile();
  for (const token of ["provider-500", "provider-down", "internal", "garbage"]) {
    const res = await t.post(payload({ turnstileToken: token }));
    assert.equal(res.statusCode, 503, token);
    assert.deepEqual(res.json(), { ok: false, error: "bot_check_unavailable" });
  }
  assert.equal(count(t.db), 0);
});

test("Turnstile: only a well-formed token is ever sent to Cloudflare, with the secret and visitor IP, over HTTPS", async () => {
  const t = withTurnstile();
  assert.equal((await t.post(payload({ turnstileToken: "x".repeat(2049) }))).statusCode, 400);
  assert.equal((await t.post(payload({ turnstileToken: 12345 }))).statusCode, 400);
  assert.equal((await t.post({ name: "" })).statusCode, 400); // invalid form: not worth a verification call
  assert.equal(t.ts.calls.length, 0);
  assert.equal((await t.post(payload({ turnstileToken: "good-call" }))).statusCode, 201);
  assert.equal(t.ts.calls.length, 1);
  assert.deepEqual(t.ts.calls[0], { url: "https://challenges.cloudflare.com/turnstile/v0/siteverify", method: "POST", secret: SECRET, response: "good-call", remoteip: "127.0.0.1" });
});

test("Turnstile: a wrong server secret is diagnosable from the logs without leaking the secret or any token", async () => {
  const t = withTurnstile({ TURNSTILE_SECRET: "wrong-secret-VALUE" });
  const res = await t.post(payload({ turnstileToken: "good-TOKENVALUE" }));
  assert.equal(res.statusCode, 400);
  const logs = t.logs.join("\n");
  assert.match(logs, /invalid-input-secret/);
  for (const needle of ["wrong-secret-VALUE", "TOKENVALUE", SECRET]) assert.ok(!logs.includes(needle) && !res.body.includes(needle), needle);
});

test("Turnstile: with no secret configured the check is off, tokens are ignored and nothing is sent out", async () => {
  const ts = fakeTurnstile();
  const t = setup({ fetchImpl: ts.fetchImpl });
  assert.equal((await t.post(payload({ turnstileToken: "good-ignored" }))).statusCode, 201);
  assert.equal((await t.post(payload())).statusCode, 201);
  assert.equal(ts.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Injection / stored-content hygiene
// ---------------------------------------------------------------------------------------------

const HOSTILE = [
  "'; DROP TABLE inquiries;--",
  '" OR 1=1 --',
  "1; ATTACH DATABASE '/tmp/x.db' AS x;--",
  "%' UNION SELECT name FROM sqlite_master--",
  "<script>alert(document.cookie)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg/onload=alert(1)>",
  "javascript:alert(1)",
  "{{7*7}} ${7*7} #{7*7}",
  "$(reboot) `id` ; rm -rf /",
  "../../../../etc/passwd",
  "=cmd|' /C calc'!A0", // spreadsheet formula injection (matters if inquiries are ever exported to CSV)
  "%00%0d%0aBcc: evil@example.com",
];

test("hostile text is stored verbatim as inert data; schema, row count and other rows are untouched", async () => {
  const t = setup();
  const before = t.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
  let n = 0;
  for (const text of HOSTILE) {
    const res = await t.post(payload({ name: text, message: text, location: text, discountCode: text.slice(0, 50), email: `h${n++}@example.com` }));
    assert.equal(res.statusCode, 201, text);
    assert.ok(!res.body.includes(text.slice(0, 12)) || !text.includes("<")); // responses carry only an id
  }
  assert.deepEqual(t.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), before);
  assert.equal(count(t.db), HOSTILE.length);
  for (const [i, text] of HOSTILE.entries()) assert.equal(rows(t.db).find((r) => r.email === `h${i}@example.com`).message, text);
  assert.equal(t.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  // Fields that are validated against a pattern reject injection outright.
  for (const override of [{ idempotencyKey: "abc'; DROP TABLE inquiries;--" }, { email: "a'b@example.com\nBcc:x@y.z" }, { phone: "1' OR '1'='1" }, { preferredDate: "2026-12-01' OR 1=1" }, { sessionType: "Cars' OR '1'='1" }]) {
    assert.equal((await t.post(payload(override))).statusCode, 400, JSON.stringify(override));
  }
});

test("control, escape-sequence, bidi and separator characters are removed; emoji joiners and newlines survive", async () => {
  const t = setup();
  const ESC = cp(0x1b), C1_CSI = cp(0x9b), RLO = cp(0x202e), LRI = cp(0x2066), LS = cp(0x2028), PS = cp(0x2029), BOM = cp(0xfeff), NUL = cp(0), BEL = cp(7), DEL = cp(0x7f);
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const res = await t.post(
    payload({
      name: `Eve${ESC}[2J${C1_CSI}31m${RLO}live${LRI}${BOM}`,
      location: `Arena${LS}${PS}${NUL}${DEL}`,
      message: `Line 1${BEL}\nLine 2 ${family}\r\nLine 3${RLO}txt.exe`,
    })
  );
  assert.equal(res.statusCode, 201);
  const [row] = rows(t.db);
  for (const field of ["name", "location", "message"]) assert.ok(!hasUnsafe(row[field]), field);
  assert.equal(row.name, "Eve[2J31mlive");
  assert.equal(row.location, "Arena");
  assert.ok(row.message.includes(family));
  assert.equal(row.message.split("\n").length, 3);
});

test("owner email is plain text, goes only to the owner, and one-line fields cannot break out of their line", async () => {
  const sent = [];
  const config = loadConfig({ NOTIFY_PROVIDER: "resend", RESEND_API_KEY: "re_fake_key_for_test", NOTIFY_TO: "owner@example.com", NOTIFY_FROM: "Kaileb <noreply@example.com>" });
  const notifier = createNotifier(config, async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true };
  });
  const row = {
    id: "ABCDEFGHJK", created_at: "2026-10-14T18:00:00.000Z", status: "new", session_type: "Cars", preferred_date: null, discount_code: null, phone: null,
    name: `Mallory${cp(0x202e)}\r\nBcc: evil@example.com`, email: "attacker@example.com", location: `Lot\nSubject: spoofed`,
    message: "<script>alert(1)</script> <a href='http://phish.example'>click</a>",
  };
  await notifier.send(row);
  const [{ url, body }] = sent;
  assert.equal(url, "https://api.resend.com/emails");
  assert.deepEqual(Object.keys(body).sort(), ["from", "reply_to", "subject", "text", "to"]); // no html part
  assert.deepEqual(body.to, ["owner@example.com"]); // a visitor can never choose the recipient
  assert.equal(body.reply_to, "attacker@example.com");
  assert.doesNotMatch(body.subject, /[\r\n]/);
  assert.ok(!hasUnsafe(body.subject));
  const nameLine = body.text.split("\n").find((l) => l.startsWith("Name:"));
  assert.ok(!hasUnsafe(nameLine.replace(/\n/g, "")));
  assert.ok(!body.text.split("\n").some((l) => l.startsWith("Bcc:") || l.startsWith("Subject:")));
});

// ---------------------------------------------------------------------------------------------
// Errors and logs
// ---------------------------------------------------------------------------------------------

test("internal failures return a generic 500 and never leak the underlying error", async () => {
  const t = setup();
  t.service.create = () => {
    throw new Error("SECRET-INTERNAL-DETAIL at /opt/kaileb-inquiry/app/server/src/service.js:42");
  };
  const res = await t.post(payload());
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { ok: false, error: "server" });
  assert.ok(!res.body.includes("SECRET-INTERNAL-DETAIL"));
});

test("logs never contain inquiry content, bot-check tokens, the secret, or request headers, across success and every failure path", async () => {
  const ts = fakeTurnstile();
  const t = setup({ env: { TURNSTILE_SECRET: SECRET, RATE_LIMIT_MAX: "6" }, fetchImpl: ts.fetchImpl });
  const m = { name: "MARKERNAME", email: "marker.person@example.com", phone: "(480) 555-0199", message: "MARKERMESSAGE", loc: "MARKERLOCATION", token: "good-MARKERTOKEN", header: "Bearer MARKERHEADER" };
  const full = (extra = {}, headers = {}) => t.post(payload({ name: m.name, email: m.email, phone: m.phone, message: m.message, location: m.loc, turnstileToken: m.token, ...extra }), { authorization: m.header, "x-api-key": m.header, cookie: "session=" + m.header, ...headers });

  await full({ turnstileToken: "good-MARKERTOKEN-1" }); //                     201
  await full({ turnstileToken: "good-MARKERTOKEN-2", sessionType: "Nope" }); // 400 validation
  await full({ turnstileToken: "bad-MARKERTOKEN" }); //                        400 bot check (also logs provider error code)
  await full({ turnstileToken: "provider-500" }); //                           503
  await full({}, { origin: "https://evil.example" }); //                       403
  await t.post("x".repeat(20000) + m.message); //                              413
  await full({ website: "http://spam.example/MARKERHONEYPOT" }); //            honeypot
  t.service.create = () => { throw new Error("db exploded"); };
  await full({ turnstileToken: "good-MARKERTOKEN-3" }); //                     500
  await full({ turnstileToken: "good-MARKERTOKEN-4" }); //                     429 (limit of 6 reached)
  await t.service.drain();

  const logs = t.logs.join("\n");
  assert.ok(logs.length > 0);
  for (const needle of [...Object.values(m), SECRET, "MARKER", "spam.example"]) assert.ok(!logs.includes(needle), `log contains ${needle}`);
});

// ---------------------------------------------------------------------------------------------
// Real process: production start-up safety, loopback binding, no leaks on failure
// ---------------------------------------------------------------------------------------------

const INDEX = path.join(__dirname, "..", "src", "index.js");
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test("production start-up refuses unsafe configuration, before touching the database, without echoing secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  const dbFile = path.join(dir, "should-not-exist.db");
  const run = spawnSync(process.execPath, [INDEX], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, NODE_ENV: "production", HOST: "0.0.0.0", ALLOWED_ORIGINS: "*", DB_PATH: dbFile, NOTIFY_PROVIDER: "resend", RESEND_API_KEY: "re_SUPERSECRETVALUE", TURNSTILE_SECRET: "0xSECRETTURNSTILE" },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unsafe production config/);
  assert.match(run.stderr, /ALLOWED_ORIGINS/);
  assert.match(run.stderr, /HOST must be a loopback/);
  for (const secret of ["re_SUPERSECRETVALUE", "0xSECRETTURNSTILE"]) assert.ok(!run.stderr.includes(secret) && !run.stdout.includes(secret));
  assert.equal(fs.existsSync(dbFile), false);
});

test("a correctly configured production process starts on loopback, serves health, and logs no secrets or PII", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  const dbFile = path.join(dir, "inquiries.db");
  const port = await freePort();
  const child = spawn(process.execPath, [INDEX], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DB_PATH: dbFile, ALLOWED_ORIGINS: "https://kailebbecker.github.io", TRUST_PROXY: "true", NOTIFY_PROVIDER: "none", TURNSTILE_SECRET: "0xSECRETTURNSTILE" },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    let health = null;
    for (let i = 0; i < 50 && !health; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        health = await res.json();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.deepEqual(health, { ok: true, notifyBacklog: 0, calendar: "off" });
    // Hostile request against the real process: origin check + generic error, no secrets in output.
    const bad = await fetch(`http://127.0.0.1:${port}/api/inquiries`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get("cache-control"), "no-store");
    assert.ok(fs.existsSync(dbFile));
  } finally {
    child.kill();
  }
  await new Promise((r) => child.once("exit", r));
  assert.ok(!out.includes("0xSECRETTURNSTILE"));
  assert.match(out, /NOTIFY_PROVIDER=none/); // operator is told mail is off
});

test("the production env template is a safe starting point and mentions every setting only with placeholders", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "deploy", "env.example"), "utf8");
  assert.doesNotMatch(text, /re_[A-Za-z0-9]{16,}|0x4[A-Za-z0-9_-]{16,}|-----BEGIN/);
  assert.equal(key().length >= 16, true); // helper sanity: keys used in these tests satisfy the validator
});
