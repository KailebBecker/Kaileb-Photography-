"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { createAvailability } = require("../src/availability/engine");
const { createCalendarSync } = require("../src/availability/sync");
const { createGoogleSource, createSource, CalendarError, SCOPE, TOKEN_URL, FREEBUSY_URL } = require("../src/availability/google");
const { handleAvailabilityCommand } = require("../src/cli-availability");
const { buildApp } = require("../src/app");
const { createService } = require("../src/service");
const { ORIGIN } = require("./helpers");
const T = require("../src/availability/time");

const CREDS = { clientId: "client-id-123", clientSecret: "CLIENT-SECRET-VALUE", refreshToken: "REFRESH-TOKEN-VALUE", calendarId: "primary" };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Scripted fake of Google's two endpoints that records every request. */
function fakeGoogle({ busy = [], tokenReply, freebusyReply, raw } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: String(init.body) });
    if (url === TOKEN_URL) return tokenReply ? tokenReply(calls) : json(200, { access_token: "ACCESS-TOKEN-SECRET", expires_in: 3600, token_type: "Bearer", scope: SCOPE });
    if (url === FREEBUSY_URL) return freebusyReply ? freebusyReply(calls) : json(200, raw || { kind: "calendar#freeBusy", calendars: { primary: { busy } } });
    throw new Error("unexpected url " + url);
  };
  return { fetchImpl, calls };
}

const iso = (ms) => new Date(ms).toISOString();

test("source asks only for free/busy: one calendar id and a time range, with the narrow scope's token", async () => {
  const g = fakeGoogle({ busy: [{ start: "2026-11-14T17:00:00Z", end: "2026-11-14T19:00:00Z" }] });
  const source = createGoogleSource(CREDS, g.fetchImpl);
  const from = Date.parse("2026-11-01T00:00:00Z");
  const got = await source.getBusy(from, from + 10 * 86400000);
  assert.deepEqual(got, [{ start: Date.parse("2026-11-14T17:00:00Z"), end: Date.parse("2026-11-14T19:00:00Z") }]);
  const [token, query] = g.calls;
  assert.equal(token.url, TOKEN_URL);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body)), { client_id: CREDS.clientId, client_secret: CREDS.clientSecret, refresh_token: CREDS.refreshToken, grant_type: "refresh_token" });
  assert.equal(query.url, FREEBUSY_URL);
  assert.equal(query.method, "POST");
  assert.equal(query.headers.Authorization, "Bearer ACCESS-TOKEN-SECRET");
  assert.deepEqual(Object.keys(JSON.parse(query.body)).sort(), ["items", "timeMax", "timeMin", "timeZone"]);
  assert.deepEqual(JSON.parse(query.body).items, [{ id: "primary" }]);
  assert.equal(SCOPE, "https://www.googleapis.com/auth/calendar.freebusy");
  assert.ok(!g.calls.some((c) => /\/events|calendarList|userinfo/.test(c.url))); // never touches event or account endpoints
});

test("only start/end are read from busy ranges; extra fields are discarded", async () => {
  const g = fakeGoogle({ busy: [{ start: "2026-11-14T17:00:00Z", end: "2026-11-14T18:00:00Z", summary: "SECRET-TITLE", attendees: [{ email: "x@y.z" }], location: "SECRET-PLACE" }] });
  const got = await createGoogleSource(CREDS, g.fetchImpl).getBusy(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"));
  assert.deepEqual(Object.keys(got[0]).sort(), ["end", "start"]);
  assert.ok(!JSON.stringify(got).includes("SECRET"));
});

test("a 180-day window is requested in 90-day chunks, and the access token is reused", async () => {
  const g = fakeGoogle();
  const source = createGoogleSource(CREDS, g.fetchImpl);
  const from = Date.parse("2026-11-01T00:00:00Z");
  await source.getBusy(from, from + 190 * 86400000);
  const queries = g.calls.filter((c) => c.url === FREEBUSY_URL).map((c) => JSON.parse(c.body));
  assert.equal(queries.length, 3);
  assert.equal(queries[0].timeMin, iso(from));
  assert.equal(queries[1].timeMin, queries[0].timeMax); // contiguous, no gaps
  assert.equal(queries[2].timeMax, iso(from + 190 * 86400000));
  assert.equal(g.calls.filter((c) => c.url === TOKEN_URL).length, 1);
});

test("the primary calendar may be keyed by the account address in Google's answer", async () => {
  const g = fakeGoogle({ raw: { calendars: { "owner@example.com": { busy: [{ start: "2026-11-14T17:00:00Z", end: "2026-11-14T18:00:00Z" }] } } } });
  assert.equal((await createGoogleSource(CREDS, g.fetchImpl).getBusy(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-11-10T00:00:00Z"))).length, 1);
});

test("every failure maps to a short code, and no secret or provider text appears in the error", async () => {
  const run = async (opts, creds = CREDS) => createGoogleSource(creds, fakeGoogle(opts).fetchImpl).getBusy(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-11-10T00:00:00Z")).then(() => "ok", (e) => e);
  const cases = [
    [{ tokenReply: () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked. SECRET-DETAIL" }) }, "auth_revoked"],
    [{ tokenReply: () => json(401, { error: "invalid_client" }) }, "auth_config"],
    [{ tokenReply: () => json(503, {}) }, "provider_unavailable"],
    [{ tokenReply: () => json(400, { error: "something_else" }) }, "auth_failed"],
    [{ tokenReply: () => json(200, { nope: true }) }, "bad_response"],
    [{ freebusyReply: () => json(401, {}) }, "auth_failed"],
    [{ freebusyReply: () => json(403, { error: { message: "Calendar API has not been used in project SECRET-DETAIL" } }) }, "forbidden"],
    [{ freebusyReply: () => json(404, {}) }, "calendar_not_found"],
    [{ freebusyReply: () => json(429, {}) }, "provider_unavailable"],
    [{ freebusyReply: () => json(500, {}) }, "provider_unavailable"],
    [{ raw: { calendars: { primary: { errors: [{ domain: "global", reason: "notFound" }], busy: [] } } } }, "calendar_not_found"],
    [{ raw: { calendars: { primary: { errors: [{ reason: "internalError" }] } } } }, "provider_error"],
    [{ raw: {} }, "bad_response"],
    [{ raw: { calendars: { primary: {} } } }, "bad_response"],
    [{ raw: { calendars: { primary: { busy: [{ start: "garbage", end: "2026-11-14T18:00:00Z" }] } } } }, "bad_response"],
    [{ raw: { calendars: { primary: { busy: [{ start: "2026-11-14T18:00:00Z", end: "2026-11-14T17:00:00Z" }] } } } }, "bad_response"],
  ];
  for (const [opts, code] of cases) {
    const err = await run(opts);
    assert.ok(err instanceof CalendarError, code);
    assert.equal(err.code, code);
    assert.equal(err.message, code); // the message is the code and nothing else
    assert.ok(!/SECRET|REFRESH|ACCESS-TOKEN/.test(err.message + (err.stack || "").split("\n")[0]));
  }
  assert.equal((await run({}, { ...CREDS, refreshToken: "" })).code, "not_configured");
});

test("network failures and timeouts become codes", async () => {
  const code = async (err) => createGoogleSource(CREDS, async () => { throw err; }).getBusy(0, 1000).then(() => null, (e) => e.code);
  assert.equal(await code(new Error("connect ECONNREFUSED SECRET-DETAIL")), "network");
  assert.equal(await code(Object.assign(new Error("slow"), { name: "TimeoutError" })), "timeout");
});

test("a rejected access token is dropped so the next call gets a fresh one", async () => {
  let freebusyStatus = 401;
  const g = fakeGoogle({ freebusyReply: () => (freebusyStatus === 401 ? json(401, {}) : json(200, { calendars: { primary: { busy: [] } } })) });
  const source = createGoogleSource(CREDS, g.fetchImpl);
  await assert.rejects(source.getBusy(0, 1000), { code: "auth_failed" });
  freebusyStatus = 200;
  await source.getBusy(0, 1000);
  assert.equal(g.calls.filter((c) => c.url === TOKEN_URL).length, 2);
});

test("createSource: off by default, Google only when configured", () => {
  assert.equal(createSource(loadConfig({})), null);
  assert.equal(createSource(loadConfig({ CALENDAR_PROVIDER: "google" })).name, "google");
});

// ---------------------------------------------------------------------------------------------
// Privacy: seed events with distinctive private strings and prove they appear NOWHERE
// ---------------------------------------------------------------------------------------------

test("PRIVACY: event titles, descriptions, attendees, locations and tokens never reach the database, API, CLI output or logs", async () => {
  const NOW = new Date("2026-10-14T18:00:00Z");
  const PRIVATE = ["SECRET-EVENT-TITLE", "SECRET-DESCRIPTION", "secret.attendee@example.com", "SECRET-PLACE", "SECRET-ORGANIZER"];
  const g = fakeGoogle({
    raw: {
      kind: "calendar#freeBusy",
      calendars: {
        primary: {
          busy: [
            { start: "2026-11-14T17:00:00Z", end: "2026-11-14T19:00:00Z", summary: PRIVATE[0], description: PRIVATE[1], attendees: [{ email: PRIVATE[2] }], location: PRIVATE[3], organizer: { displayName: PRIVATE[4] } },
          ],
          summary: PRIVATE[0],
          note: PRIVATE[1],
        },
      },
    },
  });
  const config = loadConfig({ CALENDAR_PROVIDER: "google", ALLOWED_ORIGINS: ORIGIN, NODE_ENV: "test", GOOGLE_CLIENT_ID: CREDS.clientId, GOOGLE_CLIENT_SECRET: CREDS.clientSecret, GOOGLE_REFRESH_TOKEN: CREDS.refreshToken });
  const db = openDatabase(":memory:");
  const availability = createAvailability({ db, config, now: () => NOW });
  const sync = createCalendarSync({ db, source: createSource(config, g.fetchImpl), now: () => NOW });
  const logs = [];
  const app = buildApp({ config, service: createService({ db, notifier: { send: async () => {} }, now: () => NOW }), availability, now: () => NOW, logger: { level: "info", stream: { write: (l) => logs.push(l) } } });

  assert.equal((await sync.refresh()).ok, true);

  const outputs = [];
  outputs.push((await app.inject({ method: "GET", url: "/api/availability?month=2026-11", headers: { origin: ORIGIN } })).body);
  outputs.push((await app.inject({ method: "GET", url: "/api/availability?date=2026-11-14", headers: { origin: ORIGIN } })).body);
  outputs.push((await app.inject({ method: "GET", url: "/health" })).body);
  for (const sub of [["calendar", "status"], ["availability", "check", "2026-11-14"], ["availability", "month", "2026-11"]]) {
    handleAvailabilityCommand({ cmd: sub[0], positional: sub.slice(1), flags: {}, db, config, log: (s) => outputs.push(String(s)) });
  }
  const dump = db.serialize().toString("latin1"); // the whole SQLite file, byte for byte
  const secretsEverywhere = [...PRIVATE, CREDS.clientSecret, CREDS.refreshToken, "ACCESS-TOKEN-SECRET"];
  for (const needle of secretsEverywhere) {
    assert.ok(!dump.includes(needle), `database contains ${needle}`);
    assert.ok(!logs.join("\n").includes(needle), `logs contain ${needle}`);
    for (const out of outputs) assert.ok(!out.includes(needle), `output contains ${needle}`);
  }
  // Positive control: the busy time itself did arrive and affects availability (Saturday 10:00-12:00 Phoenix).
  assert.equal(db.prepare("SELECT COUNT(*) n FROM busy_cache").get().n, 1);
  const cache = db.prepare("SELECT * FROM busy_cache").get();
  assert.deepEqual(Object.keys(cache).sort(), ["end_utc", "start_utc"]);
  assert.equal(cache.start_utc, Date.parse("2026-11-14T17:00:00Z"));
  // And the schema has no column that could hold event details.
  const columns = db.prepare("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN ('busy_cache','availability_state')").all();
  assert.deepEqual(columns.map((c) => c.col).sort(), ["end_utc", "failures", "id", "last_attempt_at", "last_error", "last_success_at", "start_utc", "window_from", "window_to"]);
});

test("PRIVACY: the public API never exposes intervals, reasons, sources or counts, in either mode", async () => {
  const NOW = new Date("2026-10-14T18:00:00Z");
  const config = loadConfig({ CALENDAR_PROVIDER: "google", ALLOWED_ORIGINS: ORIGIN, NODE_ENV: "test", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_REFRESH_TOKEN: "c" });
  const db = openDatabase(":memory:");
  const availability = createAvailability({ db, config, now: () => NOW });
  availability.addBlock({ from: "2026-11-14", to: "2026-11-14", label: "PRIVATE-BLOCK-LABEL" });
  const app = buildApp({ config, service: createService({ db, notifier: { send: async () => {} }, now: () => NOW }), availability, now: () => NOW, logger: false });
  const month = (await app.inject({ method: "GET", url: "/api/availability?month=2026-11" })).json(); // unverified: never synced
  assert.deepEqual(Object.keys(month).sort(), ["days", "month", "ok", "verified"]);
  assert.equal(month.verified, false);
  assert.ok(month.days.every((d) => d.available === false && Object.keys(d).sort().join() === "available,date"));
  const text = JSON.stringify(month);
  for (const word of ["PRIVATE-BLOCK-LABEL", "busy", "block", "google", "reason", "source", "stale", "never_synced"]) assert.ok(!text.toLowerCase().includes(word.toLowerCase()), word);
});

test("T helper sanity: the Phoenix day boundary used by the tests", () => {
  assert.equal(new Date(T.dayStart("2026-11-14")).toISOString(), "2026-11-14T07:00:00.000Z");
});

test("several calendars are queried together and their busy time is combined; one failing calendar fails the whole read", async () => {
  const ids = "primary, work@group.calendar.google.com";
  const reply = { calendars: { primary: { busy: [{ start: "2026-11-14T17:00:00Z", end: "2026-11-14T18:00:00Z" }] }, "work@group.calendar.google.com": { busy: [{ start: "2026-11-15T17:00:00Z", end: "2026-11-15T18:00:00Z" }] } } };
  const g = fakeGoogle({ raw: reply });
  const got = await createGoogleSource({ ...CREDS, calendarId: ids }, g.fetchImpl).getBusy(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-11-30T00:00:00Z"));
  assert.equal(got.length, 2);
  assert.deepEqual(JSON.parse(g.calls.find((c) => c.url === FREEBUSY_URL).body).items, [{ id: "primary" }, { id: "work@group.calendar.google.com" }]);
  // One calendar missing from the answer, or reporting an error, means we cannot vouch for the union.
  const missing = fakeGoogle({ raw: { calendars: { primary: { busy: [] } } } });
  await assert.rejects(createGoogleSource({ ...CREDS, calendarId: ids }, missing.fetchImpl).getBusy(0, 1000), { code: "bad_response" });
  const errored = fakeGoogle({ raw: { calendars: { primary: { busy: [] }, "work@group.calendar.google.com": { errors: [{ reason: "notFound" }] } } } });
  await assert.rejects(createGoogleSource({ ...CREDS, calendarId: ids }, errored.fetchImpl).getBusy(0, 1000), { code: "calendar_not_found" });
});
