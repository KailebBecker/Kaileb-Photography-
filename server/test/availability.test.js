"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { createAvailability } = require("../src/availability/engine");
const { createCalendarSync } = require("../src/availability/sync");
const { CalendarError } = require("../src/availability/google");
const { createLifecycle, LifecycleError } = require("../src/lifecycle");
const T = require("../src/availability/time");

// "Now" is Wednesday 2026-10-14, 11:00 in Arizona. 2026-11-14 is a Saturday, 2026-11-16 a Monday.
const NOW = new Date("2026-10-14T18:00:00Z");
const SAT = "2026-11-14";
const SUN = "2026-11-15";
const MON = "2026-11-16";
const FRI = "2026-11-13";
const H = 60; // minutes per hour, for readability

function setup({ provider = "none", env = {} } = {}) {
  const db = openDatabase(":memory:");
  const config = loadConfig({ CALENDAR_PROVIDER: provider, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh", ...env });
  let clock = NOW;
  const now = () => clock;
  const av = createAvailability({ db, config, now });
  let busy = [];
  let failWith = null;
  const source = {
    getBusy: async () => {
      if (failWith) throw new CalendarError(failWith);
      return busy;
    },
  };
  const sync = createCalendarSync({ db, source, now });
  return {
    db, av, sync, config,
    setBusy: (list) => (busy = list),
    failWith: (code) => (failWith = code),
    advance: (minutes) => (clock = new Date(clock.getTime() + minutes * 60000)),
    life: createLifecycle({ db, now, availability: av }),
  };
}

const avail = (t, date) => t.av.evaluateDay(date);
const range = (date, fromMin, toMin) => ({ start: T.dayStart(date) + fromMin * 60000, end: T.dayStart(date) + toMin * 60000 });

let seq = 0;
function insertInquiry(db, status = "accepted") {
  const id = `T${String(++seq).padStart(9, "0")}`;
  db.prepare("INSERT INTO inquiries (id, created_at, status, name, email, session_type, message, idempotency_key) VALUES (?, ?, ?, 'N', 'n@example.com', 'Cars', 'm', ?)").run(id, NOW.toISOString(), status, "key-" + id + "-padding");
  return id;
}

// ---------------------------------------------------------------------------------------------
// Rules, dates, lead time, horizon
// ---------------------------------------------------------------------------------------------

test("default weekly rules: weekday evenings and whole weekends are available; owner-set rules replace them", () => {
  const t = setup();
  assert.equal(avail(t, MON).available, true);
  assert.equal(avail(t, SAT).available, true);
  t.av.setRules([1], []); // Monday closed
  assert.deepEqual([avail(t, MON).available, avail(t, MON).reason], [false, "closed_by_rules"]);
  t.av.setRules([1], [[18 * H, 20 * H]]);
  assert.equal(avail(t, MON).available, true);
  t.av.resetRules();
  assert.equal(avail(t, MON).available, true);
  assert.throws(() => t.av.setRules([1], [[600, 600]]), LifecycleError);
  assert.throws(() => t.av.setRules([1], [[-5, 600]]), LifecycleError);
  assert.throws(() => t.av.setRules([1], [[0, 1441]]), LifecycleError);
});

test("past dates, lead time and the six-month horizon", () => {
  const t = setup();
  assert.deepEqual([avail(t, "2026-10-13").available, avail(t, "2026-10-13").reason], [false, "past"]);
  assert.equal(avail(t, "2026-10-14").available, true); // today, Wednesday evening window
  t.av.setSetting("lead_days", 7);
  assert.deepEqual([avail(t, "2026-10-20").available, avail(t, "2026-10-20").reason], [false, "too_soon"]);
  assert.equal(avail(t, "2026-10-21").available, true);
  const last = T.addDays("2026-10-14", t.av.HORIZON_DAYS);
  assert.equal(avail(t, T.addDays(last, 0)).reason === "beyond_horizon", false);
  assert.deepEqual([avail(t, T.addDays(last, 1)).available, avail(t, T.addDays(last, 1)).reason], [false, "beyond_horizon"]);
});

test("settings are validated", () => {
  const t = setup();
  for (const [k, v] of [["buffer_minutes", -1], ["buffer_minutes", "abc"], ["min_session_minutes", 5], ["lead_days", 1.5], ["nonsense", 1]]) assert.throws(() => t.av.setSetting(k, v), LifecycleError, `${k}=${v}`);
  t.av.setSetting("buffer_minutes", 15);
  assert.equal(t.av.settings().buffer_minutes, 15);
});

// ---------------------------------------------------------------------------------------------
// Manual blocks
// ---------------------------------------------------------------------------------------------

test("manual blocks: single dates, ranges and time ranges; label stays private and sanitised", () => {
  const t = setup();
  const id = t.av.addBlock({ from: SAT, to: SAT, label: "Family trip‮" });
  assert.deepEqual([avail(t, SAT).available, avail(t, SAT).reason], [false, "blocked"]);
  assert.equal(avail(t, SUN).available, true);
  assert.equal(t.av.listBlocks().find((b) => b.id === id).label, "Family trip"); // bidi override stripped
  t.av.removeBlock(id);
  assert.equal(avail(t, SAT).available, true);

  t.av.addBlock({ from: "2026-11-20", to: "2026-11-23" }); // range spanning Fri-Mon
  for (const d of ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"]) assert.equal(avail(t, d).available, false, d);
  assert.equal(avail(t, "2026-11-24").available, true);

  // Time-range blocks only remove those hours: Saturday window 09:00-12:00, minimum session 60 minutes.
  t.av.setRules([6], [[9 * H, 12 * H]]);
  const part = t.av.addBlock({ from: SAT, to: SAT, start: "10:00", end: "11:30" });
  assert.equal(avail(t, SAT).available, true); // 09:00-10:00 is still free for 60 minutes
  t.av.removeBlock(part);
  t.av.addBlock({ from: SAT, to: SAT, start: "09:30", end: "11:30" });
  assert.equal(avail(t, SAT).available, false); // leaves only two 30-minute gaps
});

test("block input is validated", () => {
  const t = setup();
  const bad = [
    { from: "2026-13-01", to: "2026-13-01" }, { from: SAT, to: "2026-11-01" }, { from: SAT, to: SAT, start: "10:00" },
    { from: SAT, to: SAT, start: "12:00", end: "10:00" }, { from: SAT, to: SAT, start: "10:00", end: "10:00" }, { from: SAT, to: SAT, start: "25:00", end: "26:00" },
    { from: "2026-01-01", to: "2028-01-01" },
  ];
  for (const b of bad) assert.throws(() => t.av.addBlock(b), LifecycleError, JSON.stringify(b));
  assert.throws(() => t.av.removeBlock(999), LifecycleError);
  assert.equal(t.av.listBlocks().length, 0);
});

// ---------------------------------------------------------------------------------------------
// Confirmed sessions and buffers
// ---------------------------------------------------------------------------------------------

test("confirmed sessions block their time plus the buffer, and cancelling frees it", () => {
  const t = setup();
  t.av.setRules([6], [[9 * H, 13 * H + 30]]); // Saturday 09:00-13:30
  const id = insertInquiry(t.db, "accepted");
  t.life.transition(id, "confirmed", { session: { date: SAT, start: "10:00", minutes: 120 } }); // 10:00-12:00, buffer -> 09:00-13:00
  assert.deepEqual([avail(t, SAT).available, avail(t, SAT).reason], [false, "booked"]); // only 13:00-13:30 left: shorter than the 60-minute minimum
  t.life.transition(id, "cancelled");
  assert.equal(avail(t, SAT).available, true);
});

test("a free gap shorter than the minimum session is not available; one that fits is", () => {
  const t = setup();
  t.av.setRules([6], [[9 * H, 15 * H]]);
  const id = insertInquiry(t.db);
  t.life.transition(id, "confirmed", { session: { date: SAT, start: "10:00", minutes: 60 } }); // buffer 09:00-12:00 -> free 12:00-15:00
  assert.equal(avail(t, SAT).available, true);
  t.av.setSetting("min_session_minutes", 240);
  assert.equal(avail(t, SAT).available, false);
  t.life.transition(id, "cancelled");
  assert.equal(avail(t, SAT).available, true);
});

test("buffer applies around sessions but not around manual blocks", () => {
  const t = setup();
  t.av.setRules([6], [[9 * H, 12 * H]]);
  t.av.addBlock({ from: SAT, to: SAT, start: "09:00", end: "10:00" });
  assert.equal(avail(t, SAT).available, true); // 10:00-12:00 stays free (no buffer after a block)
  const t2 = setup();
  t2.av.setRules([6], [[9 * H, 11 * H + 30]]);
  t2.life.transition(insertInquiry(t2.db), "confirmed", { session: { date: SAT, start: "09:00", minutes: 60 } });
  assert.equal(avail(t2, SAT).available, false); // the buffer pushes free time to 11:00-11:30, shorter than the minimum
});

// ---------------------------------------------------------------------------------------------
// External calendar (Google free/busy) behind the source interface
// ---------------------------------------------------------------------------------------------

test("with no external calendar everything works and nothing is 'unverified'", () => {
  const t = setup({ provider: "none" });
  assert.deepEqual(t.av.externalStatus(), { required: false, verified: true, reason: "off" });
  assert.equal(t.av.month("2026-11").verified, true);
  assert.equal(t.av.healthSummary(), "off");
});

test("FAIL SAFE: a required calendar that has never synced makes every date unavailable and unverified", () => {
  const t = setup({ provider: "google" });
  const m = t.av.month("2026-11");
  assert.equal(m.verified, false);
  assert.equal(m.days.length, 30);
  assert.ok(m.days.every((d) => d.available === false));
  assert.deepEqual([avail(t, SAT).available, avail(t, SAT).verified, avail(t, SAT).reason], [false, false, "unverified"]);
  assert.match(t.av.healthSummary(), /^unverified:never_synced$/);
});

test("busy time from the calendar blocks dates (union with blocks and sessions); other dates stay available", async () => {
  const t = setup({ provider: "google" });
  t.setBusy([range(SAT, 0, 24 * H)]); // all-day Saturday
  assert.equal((await t.sync.refresh()).ok, true);
  assert.equal(t.av.month("2026-11").verified, true);
  assert.deepEqual([avail(t, SAT).available, avail(t, SAT).reason], [false, "busy"]);
  assert.equal(avail(t, FRI).available, true); // 17:30-24:00 window; the buffer only trims 23:00-24:00
  assert.equal(avail(t, SUN).available, true); // buffer only trims 00:00-01:00
  assert.equal(avail(t, MON).available, true);
});

test("busy intervals are read as instants: an evening event in Arizona time blocks that evening only", async () => {
  const t = setup({ provider: "google" });
  t.av.setRules([1], [[17 * H + 30, 21 * H]]); // Monday 17:30-21:00
  t.setBusy([{ start: Date.parse("2026-11-17T00:00:00Z"), end: Date.parse("2026-11-17T03:00:00Z") }]); // = Mon 17:00-20:00 in Phoenix (UTC-7)
  await t.sync.refresh();
  assert.equal(avail(t, MON).available, false); // 17:30-21:00 minus 16:00-21:00 (with buffer) = nothing
  t.setBusy([{ start: Date.parse("2026-11-17T04:00:00Z"), end: Date.parse("2026-11-17T05:00:00Z") }]); // Mon 21:00-22:00 Phoenix
  await t.sync.refresh();
  assert.equal(avail(t, MON).available, true); // 17:30-20:00 stays free
});

test("buffer around external busy time decides whether the remaining gap is usable", async () => {
  const t = setup({ provider: "google" });
  t.av.setRules([6], [[9 * H, 11 * H + 30]]);
  t.setBusy([range(SAT, 9 * H, 10 * H)]);
  await t.sync.refresh();
  assert.equal(avail(t, SAT).available, false); // buffer -> free only 11:00-11:30
  t.av.setSetting("buffer_minutes", 0);
  assert.equal(avail(t, SAT).available, true); // 10:00-11:30 free
});

test("FAIL SAFE: a stale cache becomes unverified, and a fresh sync restores service", async () => {
  const t = setup({ provider: "google" });
  await t.sync.refresh();
  assert.equal(avail(t, SAT).available, true);
  t.advance(59);
  assert.equal(avail(t, SAT).available, true); // still within the freshness limit
  t.advance(2); // 61 minutes since the last successful sync
  assert.deepEqual([avail(t, SAT).available, avail(t, SAT).verified], [false, false]);
  assert.equal(t.av.externalStatus().reason, "stale");
  await t.sync.refresh();
  assert.equal(avail(t, SAT).available, true);
});

test("a transient failure keeps using the last good data until it goes stale, and records only a short code", async () => {
  const t = setup({ provider: "google" });
  await t.sync.refresh();
  t.failWith("provider_unavailable");
  t.advance(15);
  assert.deepEqual(await t.sync.refresh(), { ok: false, code: "provider_unavailable" });
  assert.equal(avail(t, SAT).available, true); // 15 minutes old: still verified
  const st = t.db.prepare("SELECT * FROM availability_state").get();
  assert.equal(st.last_error, "provider_unavailable");
  assert.equal(st.failures, 1);
  t.advance(50);
  assert.equal(avail(t, SAT).verified, false);
});

test("FAIL SAFE: revoked or misconfigured access is unverified immediately, not after the stale timer", async () => {
  for (const code of ["auth_revoked", "auth_config", "forbidden", "calendar_not_found"]) {
    const t = setup({ provider: "google" });
    await t.sync.refresh();
    assert.equal(avail(t, SAT).available, true);
    t.failWith(code);
    await t.sync.refresh();
    assert.deepEqual([avail(t, SAT).available, avail(t, SAT).verified], [false, false], code);
    assert.equal(t.av.externalStatus().reason, code);
  }
});

test("a failed refresh never leaves a half-updated cache", async () => {
  const t = setup({ provider: "google" });
  t.setBusy([range(SAT, 0, 24 * H)]);
  await t.sync.refresh();
  t.setBusy([]);
  t.failWith("network");
  await t.sync.refresh();
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM busy_cache").get().n, 1); // old data intact
  t.failWith(null);
  await t.sync.refresh();
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM busy_cache").get().n, 0); // replaced wholesale on success
});

test("dates outside the synced window are unverified rather than assumed free", async () => {
  const t = setup({ provider: "google" });
  await t.sync.refresh();
  const edge = T.addDays("2026-10-14", t.av.HORIZON_DAYS);
  assert.equal(avail(t, edge).verified, true); // inside the window (horizon + slack)
  t.db.prepare("UPDATE availability_state SET window_to = ?").run(T.dayStart(T.addDays("2026-10-14", 30)));
  assert.deepEqual([avail(t, T.addDays("2026-10-14", 60)).available, avail(t, T.addDays("2026-10-14", 60)).verified], [false, false]);
});

test("adjacent and overlapping calendar events are merged before they are stored", async () => {
  const t = setup({ provider: "google" });
  t.setBusy([range(SAT, 600, 660), range(SAT, 660, 720), range(SAT, 700, 800), range(SUN, 0, 60)]);
  assert.equal((await t.sync.refresh()).count, 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM busy_cache").get().n, 2);
});

// ---------------------------------------------------------------------------------------------
// Confirming a session: blocks, calendar, and the owner's explicit override
// ---------------------------------------------------------------------------------------------

test("confirming refuses sessions that overlap a manual block, and accepts adjacent times", () => {
  const t = setup();
  const block = t.av.addBlock({ from: SAT, to: SAT, start: "10:00", end: "12:00" });
  const id = insertInquiry(t.db);
  assert.throws(() => t.life.transition(id, "confirmed", { session: { date: SAT, start: "11:00", minutes: 60 } }), (e) => e instanceof LifecycleError && e.code === "blocked" && e.message.includes(`#${block}`));
  assert.throws(() => t.life.transition(id, "confirmed", { session: { date: SAT, start: "09:30", minutes: 60 } }), { code: "blocked" });
  assert.equal(t.db.prepare("SELECT status FROM inquiries WHERE id = ?").get(id).status, "accepted"); // nothing changed
  assert.equal(t.life.transition(id, "confirmed", { session: { date: SAT, start: "12:00", minutes: 60 } }).status, "confirmed");
  // There is deliberately no override for blocks: the owner removes the block first.
  const id2 = insertInquiry(t.db);
  assert.throws(() => t.life.transition(id2, "confirmed", { ignoreExternal: true, session: { date: SAT, start: "10:30", minutes: 60 } }), { code: "blocked" });
});

test("confirming refuses sessions that overlap calendar busy time, with a clear message", async () => {
  const t = setup({ provider: "google" });
  t.setBusy([range(SAT, 13 * H, 14 * H)]);
  await t.sync.refresh();
  const id = insertInquiry(t.db);
  assert.throws(() => t.life.transition(id, "confirmed", { session: { date: SAT, start: "13:30", minutes: 60 } }), (e) => e.code === "calendar_busy" && /Google Calendar shows busy/.test(e.message));
  assert.equal(t.life.transition(id, "confirmed", { session: { date: SAT, start: "14:00", minutes: 60 } }).status, "confirmed");
});

test("FAIL SAFE: confirming is refused when a required calendar cannot be verified; the owner can explicitly override, and it is recorded", async () => {
  const t = setup({ provider: "google" }); // never synced
  const id = insertInquiry(t.db);
  assert.throws(() => t.life.transition(id, "confirmed", { session: { date: SAT, start: "13:00", minutes: 60 } }), (e) => e.code === "calendar_unverified" && /--ignore-calendar/.test(e.message));
  assert.equal(t.db.prepare("SELECT status FROM inquiries WHERE id = ?").get(id).status, "accepted");
  const row = t.life.transition(id, "confirmed", { ignoreExternal: true, note: "checked my calendar", session: { date: SAT, start: "13:00", minutes: 60 } });
  assert.equal(row.status, "confirmed");
  const note = t.life.history(id).at(-1).note;
  assert.match(note, /checked my calendar/);
  assert.match(note, /--ignore-calendar/);
});

test("with no external calendar, --ignore-calendar changes nothing and leaves no extra note", () => {
  const t = setup();
  const id = insertInquiry(t.db);
  t.life.transition(id, "confirmed", { ignoreExternal: true, session: { date: SAT, start: "13:00", minutes: 60 } });
  assert.equal(t.life.history(id).at(-1).note, null);
});

test("double-booking between confirmed sessions is still refused", () => {
  const t = setup();
  t.life.transition(insertInquiry(t.db), "confirmed", { session: { date: SAT, start: "10:00", minutes: 120 } });
  assert.throws(() => t.life.transition(insertInquiry(t.db), "confirmed", { session: { date: SAT, start: "11:00", minutes: 60 } }), { code: "conflict" });
});

// ---------------------------------------------------------------------------------------------
// Public shapes expose nothing private
// ---------------------------------------------------------------------------------------------

test("public month/day results contain only date, available and one verified flag", async () => {
  const t = setup({ provider: "google" });
  t.av.addBlock({ from: SAT, to: SAT, label: "PRIVATE-LABEL-XYZ" });
  t.setBusy([range(MON, 0, 24 * H)]);
  await t.sync.refresh();
  const m = t.av.month("2026-11");
  assert.deepEqual(Object.keys(m).sort(), ["days", "verified"]);
  for (const d of m.days) assert.deepEqual(Object.keys(d).sort(), ["available", "date"]);
  assert.deepEqual(Object.keys(t.av.day(SAT)).sort(), ["available", "date", "verified"]);
  assert.ok(!JSON.stringify(m).includes("PRIVATE-LABEL-XYZ"));
});

test("today only counts the part of the day that is still ahead", () => {
  const t = setup(); // 11:00 on Wednesday 2026-10-14 in Arizona
  t.av.setRules([3], [[9 * H, 11 * H + 30]]);
  assert.equal(avail(t, "2026-10-14").available, false); // only 11:00-11:30 left
  t.av.setRules([3], [[9 * H, 12 * H]]);
  assert.equal(avail(t, "2026-10-14").available, true); // 11:00-12:00 left: exactly the minimum session
  assert.equal(avail(t, "2026-10-21").available, true); // next Wednesday is untouched
});
