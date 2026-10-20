"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, payload, ORIGIN } = require("./helpers");
const { openDatabase } = require("../src/db");
const { createNotifier, buildEmail } = require("../src/notify");
const { loadConfig, assertProductionReady } = require("../src/config");

const rows = (db) => db.prepare("SELECT * FROM inquiries").all();

test("valid inquiry is stored, owner is notified, client gets 201 with an id", async () => {
  const t = setup();
  const res = await t.post(payload());
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.match(body.id, /^[0-9A-Z]{10}$/);
  await t.service.drain();
  const [row] = rows(t.db);
  assert.equal(row.id, body.id);
  assert.equal(row.status, "new");
  assert.equal(row.email, "jamie@example.com");
  assert.equal(row.notify_status, "sent");
  assert.equal(t.sent.length, 1);
  assert.ok(row.created_at.endsWith("Z"));
});

test("minimal inquiry (optional fields omitted) is accepted", async () => {
  const t = setup();
  const p = payload();
  delete p.phone; delete p.preferredDate; delete p.location; delete p.discountCode; delete p.website;
  assert.equal((await t.post(p)).statusCode, 201);
  assert.equal(rows(t.db).length, 1);
});

test("required fields are enforced and nothing is stored", async () => {
  const t = setup();
  for (const field of ["name", "email", "sessionType", "message", "idempotencyKey"]) {
    const p = payload();
    delete p[field];
    const res = await t.post(p);
    assert.equal(res.statusCode, 400, field);
    assert.ok(res.json().fields[field], field);
  }
  const blank = await t.post(payload({ name: "   ", message: "\n\t " }));
  assert.equal(blank.statusCode, 400);
  assert.equal(rows(t.db).length, 0);
});

test("malformed values are rejected (types, email, phone, session type, unknown fields, non-object)", async () => {
  const t = setup();
  const bad = [
    { email: "not-an-email" }, { email: "a@b" }, { email: "a b@c.com" }, { email: "x@y.com\r\nBcc: evil@z.com" },
    { phone: "call me maybe" }, { phone: "123" },
    { sessionType: "Birthdays" }, { sessionType: "graduations" },
    { name: 123 }, { name: { $ne: 1 } }, { message: ["a"] }, { location: true },
    { extra: "field" }, { idempotencyKey: "short" }, { idempotencyKey: "has spaces in it 1234567890" },
  ];
  for (const override of bad) {
    const res = await t.post(payload(override));
    assert.equal(res.statusCode, 400, JSON.stringify(override));
  }
  for (const body of ["[]", "null", "42", '"str"']) assert.equal((await t.post(body)).statusCode, 400, body);
  assert.equal((await t.post("{not json")).statusCode, 400);
  assert.equal(rows(t.db).length, 0);
});

test("field length limits are enforced at the boundary", async () => {
  const t = setup();
  assert.equal((await t.post(payload({ name: "n".repeat(100) }))).statusCode, 201);
  assert.equal((await t.post(payload({ name: "n".repeat(101) }))).statusCode, 400);
  assert.equal((await t.post(payload({ email: "e".repeat(250) + "@x.com" }))).statusCode, 400);
  assert.equal((await t.post(payload({ message: "m".repeat(5000), email: "two@example.com" }))).statusCode, 201);
  assert.equal((await t.post(payload({ message: "m".repeat(5001) }))).statusCode, 400);
  assert.equal((await t.post(payload({ location: "l".repeat(201) }))).statusCode, 400);
  assert.equal((await t.post(payload({ discountCode: "d".repeat(51) }))).statusCode, 400);
  assert.equal((await t.post(payload({ phone: "1".repeat(31) }))).statusCode, 400);
});

test("oversized request bodies get 413 and are not stored", async () => {
  const t = setup();
  const res = await t.post(payload({ message: "x".repeat(20000) }));
  assert.equal(res.statusCode, 413);
  assert.equal(rows(t.db).length, 0);
});

test("non-JSON content type is rejected", async () => {
  const t = setup();
  const res = await t.post("name=a", { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(res.statusCode, 415);
});

test("dates: past, impossible, malformed and far-future are rejected; today and valid future accepted", async () => {
  const t = setup(); // 'now' is 2026-10-14 in Arizona
  for (const d of ["2020-01-01", "2026-10-13", "2026-02-30", "2026-13-01", "10/20/2026", "2026-1-5", "tomorrow", "2029-01-01"]) {
    const res = await t.post(payload({ preferredDate: d }));
    assert.equal(res.statusCode, 400, d);
    assert.ok(res.json().fields.preferredDate, d);
  }
  assert.equal((await t.post(payload({ preferredDate: "2026-10-14", email: "a@example.com" }))).statusCode, 201);
  assert.equal((await t.post(payload({ preferredDate: "2027-06-01", email: "b@example.com" }))).statusCode, 201);
});

test("lead-time placeholder is NOT enforced server-side (only past dates are rejected)", async () => {
  const t = setup();
  assert.equal((await t.post(payload({ preferredDate: "2026-10-15" }))).statusCode, 201);
});

test("retry with the same idempotency key returns the original and stores/notifies once", async () => {
  const t = setup();
  const p = payload();
  const first = await t.post(p);
  const second = await t.post(p);
  const third = await t.post(p);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
  assert.equal(second.json().id, first.json().id);
  assert.equal(third.json().id, first.json().id);
  await t.service.drain();
  assert.equal(rows(t.db).length, 1);
  assert.equal(t.sent.length, 1);
});

test("simultaneous double-submit creates exactly one inquiry", async () => {
  const t = setup();
  const p = payload();
  const results = await Promise.all([t.post(p), t.post(p), t.post(p)]);
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(rows(t.db).length, 1);
});

test("storage failure => 500, no success, no notification", async () => {
  const t = setup();
  t.db.exec("DROP TABLE inquiries"); // simulate broken/locked storage
  const res = await t.post(payload());
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().error, "server");
  assert.equal(t.sent.length, 0);
});

test("notification failure keeps the inquiry, still reports success, is observable, and is retried once", async () => {
  let fail = true;
  const delivered = [];
  const notifier = {
    async send(row) {
      if (fail) { const e = new Error("boom"); e.code = "http_503"; throw e; }
      delivered.push(row.id);
    },
  };
  const t = setup({ notifier });
  const res = await t.post(payload());
  assert.equal(res.statusCode, 201); // stored => truthful success
  await t.service.drain();
  let [row] = rows(t.db);
  assert.equal(row.notify_status, "failed");
  assert.equal(row.notify_last_error, "http_503");
  assert.equal(row.notify_attempts, 1);
  const health = await t.app.inject({ method: "GET", url: "/health" });
  assert.equal(health.json().notifyBacklog, 1);
  // Provider recovers; sweeper (with backoff elapsed) delivers exactly once.
  fail = false;
  t.db.prepare("UPDATE inquiries SET notify_last_attempt_at = '2000-01-01T00:00:00Z'").run();
  assert.equal(await t.service.retryPending(), 1);
  assert.equal(await t.service.retryPending(), 0); // already sent
  [row] = rows(t.db);
  assert.equal(row.notify_status, "sent");
  assert.equal(delivered.length, 1);
  assert.equal((await t.app.inject({ method: "GET", url: "/health" })).json().notifyBacklog, 0);
});

test("with no email provider configured, inquiries are stored and stay pending-visible", async () => {
  const t = setup({ notifier: createNotifier(loadConfig({ NOTIFY_PROVIDER: "none" })) });
  assert.equal((await t.post(payload())).statusCode, 201);
  await t.service.drain();
  const [row] = rows(t.db);
  assert.equal(row.notify_status, "failed");
  assert.equal(row.notify_last_error, "not_configured");
});

test("retries stop after the maximum number of attempts", async () => {
  const notifier = { async send() { throw Object.assign(new Error("x"), { code: "network" }); } };
  const t = setup({ notifier });
  await t.post(payload());
  await t.service.drain();
  t.db.prepare("UPDATE inquiries SET notify_attempts = 10").run();
  assert.equal(await t.service.retryPending(), 0);
});

test("Resend notifier: sends plain text with reply-to, never leaks the key into errors", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const config = loadConfig({ NOTIFY_PROVIDER: "resend", RESEND_API_KEY: "re_test_secret", NOTIFY_TO: "owner@example.com", NOTIFY_FROM: "inquiries@example.com" });
  const t = setup({ notifier: createNotifier(config, fetchImpl) });
  await t.post(payload({ name: "Evil\r\nBcc: x@y.z", message: "<script>alert(1)</script> hello" }));
  await t.service.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ["owner@example.com"]);
  assert.equal(body.reply_to, "jamie@example.com");
  assert.ok(!("html" in body));
  assert.ok(!/[\r\n]/.test(body.subject));
  assert.ok(body.text.includes("<script>alert(1)</script> hello")); // plain text: inert in mail
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_secret");

  const failing = createNotifier(config, async () => ({ ok: false, status: 403 }));
  await assert.rejects(() => failing.send({ id: "A", created_at: "", name: "n", email: "e", session_type: "Cars", message: "m" }), (e) => e.code === "http_403" && !String(e.message).includes("re_test"));
});

test("buildEmail neutralises header-injection attempts in the subject", () => {
  const { subject } = buildEmail({ id: "A", created_at: "t", name: "A\r\nBcc: x", email: "e@e.co", session_type: "Cars", message: "m" });
  assert.ok(!/[\r\n]/.test(subject));
});

test("honeypot: filled hidden field gets a fake success but nothing is stored or sent", async () => {
  const t = setup();
  const res = await t.post(payload({ website: "http://spam.example" }));
  assert.equal(res.statusCode, 201);
  await t.service.drain();
  assert.equal(rows(t.db).length, 0);
  assert.equal(t.sent.length, 0);
});

test("rate limit: more than 5 posts per window from one IP get 429", async () => {
  const t = setup({ env: { RATE_LIMIT_MAX: "5" } });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await t.post(payload({ email: `u${i}@example.com` }))).statusCode);
  assert.deepEqual(codes.slice(0, 5), [201, 201, 201, 201, 201]);
  assert.deepEqual(codes.slice(5), [429, 429]);
});

test("per-email daily cap: a 6th inquiry from the same email in 24h is refused", async () => {
  const t = setup();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await t.post(payload())).statusCode);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
});

test("CORS: allowed origin gets headers; other origins are blocked; no-origin clients still validated", async () => {
  const t = setup();
  const ok = await t.post(payload());
  assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
  const evil = await t.post(payload(), { origin: "https://evil.example" });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
  const lookalike = await t.post(payload(), { origin: ORIGIN + ".evil.example" });
  assert.equal(lookalike.statusCode, 403);
  const none = await t.app.inject({ method: "POST", url: "/api/inquiries", headers: { "content-type": "application/json" }, payload: JSON.stringify(payload()) });
  assert.equal(none.statusCode, 201);
  assert.equal(rows(t.db).length, 2);
  const pre = await t.app.inject({ method: "OPTIONS", url: "/api/inquiries", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
  assert.match(pre.headers["access-control-allow-methods"], /POST/);
  assert.equal(pre.headers["access-control-allow-credentials"], undefined);
});

test("Turnstile (when configured): missing/failed tokens rejected, valid accepted, outage fails closed", async () => {
  let verdict = { success: true, hostname: "kailebbecker.github.io" };
  let down = false;
  const fetchImpl = async () => { if (down) throw new Error("net"); return { ok: true, json: async () => verdict }; };
  const t = setup({ env: { TURNSTILE_SECRET: "secret", RATE_LIMIT_MAX: "100" }, fetchImpl });
  assert.equal((await t.post(payload())).statusCode, 400); // no token
  verdict = { success: false };
  assert.equal((await t.post(payload({ turnstileToken: "bad" }))).statusCode, 400);
  verdict = { success: true, hostname: "kailebbecker.github.io" };
  assert.equal((await t.post(payload({ turnstileToken: "good" }))).statusCode, 201);
  down = true;
  assert.equal((await t.post(payload({ turnstileToken: "good" }))).statusCode, 503);
  assert.equal(rows(t.db).length, 1);
});

test("XSS-looking content is stored verbatim as inert text and never echoed back as HTML", async () => {
  const t = setup();
  const res = await t.post(payload({ name: '<img src=x onerror=alert(1)>', message: "<script>alert('x')</script>" }));
  assert.equal(res.statusCode, 201);
  assert.ok(!res.body.includes("<script"));
  assert.ok(res.headers["content-type"].startsWith("application/json"));
  assert.equal(rows(t.db)[0].message, "<script>alert('x')</script>"); // any future UI must escape on output
});

test("SQL-injection-looking input is treated as data", async () => {
  const t = setup();
  const res = await t.post(payload({ name: "Robert'); DROP TABLE inquiries;--", message: "' OR '1'='1" }));
  assert.equal(res.statusCode, 201);
  assert.equal(rows(t.db).length, 1);
});

test("control characters are stripped; unicode is normalised", async () => {
  const t = setup();
  await t.post(payload({ name: "Jos\u0000e\u0007 Garćia", message: "line1\nline2\u0001" }));
  const [row] = rows(t.db);
  assert.equal(row.name, "Jose Garcia".replace("c", "ć").normalize("NFC"));
  assert.equal(row.message, "line1\nline2");
});

test("logs never contain inquiry content or PII", async () => {
  const t = setup();
  await t.post(payload({ name: "Secretname Person", message: "Very private message text", email: "private.person@example.com" }));
  await t.service.drain();
  const all = t.logs.join("\n");
  assert.ok(all.length > 0);
  for (const needle of ["Secretname", "Very private", "private.person@example.com"]) assert.ok(!all.includes(needle), needle);
});

test("error responses are generic (no stack traces / internals)", async () => {
  const t = setup();
  t.db.exec("DROP TABLE inquiries");
  const res = await t.post(payload());
  assert.deepEqual(res.json(), { ok: false, error: "server" });
  const nf = await t.app.inject({ method: "GET", url: "/nope" });
  assert.equal(nf.statusCode, 404);
});

test("data survives a restart (durable file database)", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inq-")), "t.db");
  const a = setup({ db: openDatabase(file) });
  const id = (await a.post(payload())).json().id;
  await a.service.drain();
  a.db.close();
  const reopened = openDatabase(file);
  assert.equal(reopened.prepare("SELECT id FROM inquiries").get().id, id);
  reopened.close();
});

test("production config refuses wildcard/http origins and the dev notifier", () => {
  const DB = { DB_PATH: "/var/lib/kaileb-inquiry/inquiries.db" };
  const bad = (env) => assert.throws(() => assertProductionReady(loadConfig({ NODE_ENV: "production", ...DB, ...env })));
  bad({});
  bad({ ALLOWED_ORIGINS: "*" });
  bad({ ALLOWED_ORIGINS: "http://example.com" });
  bad({ ALLOWED_ORIGINS: "https://a.example", NOTIFY_PROVIDER: "dev" });
  bad({ ALLOWED_ORIGINS: "https://a.example", NOTIFY_PROVIDER: "resend" });
  bad({ ALLOWED_ORIGINS: "https://kailebbecker.github.io/Kaileb-Photography-/" }); // a page URL, not an origin
  bad({ ALLOWED_ORIGINS: "https://a.example", TRUST_PROXY: "true", HOST: "0.0.0.0" }); // spoofable client IP
  bad({ ALLOWED_ORIGINS: "https://a.example", HOST: "0.0.0.0" }); // Node must not be publicly reachable
  bad({ ALLOWED_ORIGINS: "https://a.example", PORT: "abc" });
  bad({ ALLOWED_ORIGINS: "https://a.example", DB_PATH: "./data/inquiries.db" }); // relative, inside the checkout
  bad({ ALLOWED_ORIGINS: "https://a.example", DB_PATH: require("path").join(__dirname, "..", "data", "x.db") }); // inside the checkout
  assert.doesNotThrow(() => assertProductionReady(loadConfig({ NODE_ENV: "production", ...DB, ALLOWED_ORIGINS: "https://a.example", NOTIFY_PROVIDER: "resend", RESEND_API_KEY: "k", NOTIFY_TO: "o@e.co", NOTIFY_FROM: "f@e.co" })));
  // Interim deployment before the Resend key exists: stores inquiries, emails nobody.
  assert.doesNotThrow(() => assertProductionReady(loadConfig({ NODE_ENV: "production", ...DB, ALLOWED_ORIGINS: "https://a.example/,https://b.example", TRUST_PROXY: "true", NOTIFY_PROVIDER: "none" })));
});
