"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, payload, ORIGIN } = require("./helpers");
const { createCalendarSync } = require("../src/availability/sync");

// Test clock (helpers.NOW): Wednesday 2026-10-14, 11:00 in Arizona. 2026-11-14 is a Saturday.
const get = (t, url, headers = { origin: ORIGIN }) => t.app.inject({ method: "GET", url, headers });
const GOOGLE_ENV = { CALENDAR_PROVIDER: "google", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_REFRESH_TOKEN: "c" };
const NOW = new Date("2026-10-14T18:00:00Z");

test("month view: exact shape, one entry per day, nothing else", async () => {
  const t = setup();
  const res = await get(t, "/api/availability?month=2026-11");
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["days", "month", "ok", "verified"]);
  assert.deepEqual({ ok: body.ok, month: body.month, verified: body.verified }, { ok: true, month: "2026-11", verified: true });
  assert.equal(body.days.length, 30);
  for (const d of body.days) assert.deepEqual(Object.keys(d).sort(), ["available", "date"]);
  assert.equal(body.days.find((d) => d.date === "2026-11-14").available, true);
  t.availability.addBlock({ from: "2026-11-14", to: "2026-11-14", label: "SECRET-LABEL" });
  const after = (await get(t, "/api/availability?month=2026-11")).json();
  assert.equal(after.days.find((d) => d.date === "2026-11-14").available, false);
  assert.ok(!JSON.stringify(after).includes("SECRET-LABEL"));
});

test("single-date view", async () => {
  const t = setup();
  assert.deepEqual((await get(t, "/api/availability?date=2026-11-14")).json(), { ok: true, verified: true, date: "2026-11-14", available: true });
  t.availability.addBlock({ from: "2026-11-14", to: "2026-11-14" });
  assert.equal((await get(t, "/api/availability?date=2026-11-14")).json().available, false);
});

test("strict query validation: anything unexpected is a plain 400", async () => {
  const t = setup();
  const bad = [
    "/api/availability", "/api/availability?month=2026-11&date=2026-11-14", "/api/availability?month=2026-11&x=1", "/api/availability?x=1",
    "/api/availability?month=2026-13", "/api/availability?month=2026-1", "/api/availability?month=nope", "/api/availability?month=2026-09", // past month
    "/api/availability?month=2027-06", // beyond six months
    "/api/availability?month=2026-11&month=2026-12", "/api/availability?month[]=2026-11",
    "/api/availability?date=2026-02-30", "/api/availability?date=2026-10-13", "/api/availability?date=2030-01-01", "/api/availability?date=tomorrow",
    "/api/availability?month=" + "9".repeat(5000),
  ];
  for (const url of bad) {
    const res = await get(t, url);
    assert.equal(res.statusCode, 400, url.slice(0, 60));
    assert.deepEqual(res.json(), { ok: false, error: "validation" });
    assert.equal(res.headers["cache-control"], "no-store");
  }
  assert.equal((await get(t, "/api/availability?month=2026-10")).statusCode, 200); // current month is fine
  assert.equal((await get(t, "/api/availability?month=2027-04")).statusCode, 200); // six months ahead is fine
});

test("CORS: the configured website may read it; other origins are refused", async () => {
  const t = setup();
  const ok = await get(t, "/api/availability?month=2026-11");
  assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
  const evil = await get(t, "/api/availability?month=2026-11", { origin: "https://evil.example" });
  assert.equal(evil.statusCode, 403);
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
  assert.equal((await get(t, "/api/availability?month=2026-11", {})).statusCode, 200); // no Origin (curl, server-side): public data anyway
});

test("only GET is allowed, and the inquiry form is untouched", async () => {
  const t = setup();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.ok([404, 405].includes((await t.app.inject({ method, url: "/api/availability?month=2026-11", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: "{}" })).statusCode), method);
  assert.equal((await t.post(payload())).statusCode, 201);
});

test("caching: verified answers may be cached for a minute, unverified and error answers never", async () => {
  const t = setup();
  assert.equal((await get(t, "/api/availability?month=2026-11")).headers["cache-control"], "public, max-age=60");
  const g = setup({ env: GOOGLE_ENV }); // never synced => unverified
  assert.equal((await get(g, "/api/availability?month=2026-11")).headers["cache-control"], "no-store");
});

test("rate limited per visitor", async () => {
  const t = setup();
  let last;
  for (let i = 0; i < 62; i++) last = await get(t, "/api/availability?date=2026-11-14");
  assert.equal(last.statusCode, 429);
  assert.deepEqual(last.json(), { ok: false, error: "rate_limited" });
});

test("FAIL SAFE: with a required calendar that is not verified, every date is unavailable and the answer says it is unverified", async () => {
  const t = setup({ env: GOOGLE_ENV });
  const month = (await get(t, "/api/availability?month=2026-11")).json();
  assert.equal(month.verified, false);
  assert.ok(month.days.every((d) => d.available === false));
  assert.deepEqual((await get(t, "/api/availability?date=2026-11-14")).json(), { ok: true, verified: false, date: "2026-11-14", available: false });

  // A successful sync turns verification on and real answers come back.
  const sync = createCalendarSync({ db: t.db, source: { getBusy: async () => [] }, now: () => NOW });
  await sync.refresh();
  const ok = (await get(t, "/api/availability?month=2026-11")).json();
  assert.equal(ok.verified, true);
  assert.equal(ok.days.find((d) => d.date === "2026-11-14").available, true);

});

test("a failing calendar never blocks inquiries, and /health reports its state locally", async () => {
  const t = setup({ env: GOOGLE_ENV });
  assert.equal((await t.post(payload())).statusCode, 201);
  const health = (await t.app.inject({ method: "GET", url: "/health" })).json();
  assert.equal(health.ok, true);
  assert.equal(health.calendar, "unverified:never_synced");
  assert.equal((await setup().app.inject({ method: "GET", url: "/health" })).json().calendar, "off");
});
