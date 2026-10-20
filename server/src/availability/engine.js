"use strict";
// Availability engine (V1-SPEC "Availability model"). A date is available only if, inside the owner's
// weekly rules, at least one free stretch of min_session_minutes remains after removing the UNION of:
//   - manual blocks (owner-set, optional time range, private label never leaves the owner CLI),
//   - confirmed sessions (+ buffer),
//   - external calendar busy time (+ buffer), when an external source is configured.
// Any source blocking => unavailable. If a configured (required) external source cannot be verified
// the answer is "unavailable, unverified": a date is NEVER reported available on unverified data.
//
// Public callers get only { date, available } (+ one overall `verified` flag). Reasons, labels and
// intervals are for the owner CLI only.

const { UNSAFE_TEXT } = require("../validate");
const { LifecycleError } = require("../lifecycle");
const { merge, subtract, overlaps } = require("./intervals");
const { PERMANENT } = require("./google");
const T = require("./time");

const HORIZON_DAYS = 180; // public availability looks at most ~6 months ahead (ARCHITECTURE.md)
const SYNC_BEHIND_DAYS = 1;
const SYNC_AHEAD_DAYS = HORIZON_DAYS + 10; // slack so the edge of the horizon stays covered between syncs

// OWNER-DECISION (G8): placeholder values from STATE.md until the owner sets real ones with the CLI.
// Weekdays from 17:30, weekends all day; 60 min minimum session; 60 min buffer; no lead time on the server.
const WEEKDAY_EVENING = [[17 * 60 + 30, 1440]];
const DEFAULT_RULES = { 0: [[0, 1440]], 1: WEEKDAY_EVENING, 2: WEEKDAY_EVENING, 3: WEEKDAY_EVENING, 4: WEEKDAY_EVENING, 5: WEEKDAY_EVENING, 6: [[0, 1440]] };
const DEFAULT_SETTINGS = { buffer_minutes: 60, min_session_minutes: 60, lead_days: 0 };
const SETTING_LIMITS = { buffer_minutes: [0, 480], min_session_minutes: [15, 960], lead_days: [0, 365] };

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * adoptServiceConfig: for the owner CLI, which runs without the service's environment file. The running
 * service records its (non-secret) calendar mode in the database at start-up, and the CLI follows it, so
 * confirming a session can never skip a calendar check the public site is relying on.
 */
function createAvailability({ db, config, now = () => new Date(), adoptServiceConfig = false }) {
  const recorded = (key) => {
    const row = adoptServiceConfig ? db.prepare("SELECT value FROM availability_settings WHERE key = ?").get(key) : null;
    return row ? row.value : null;
  };
  const providerNow = () => (config.calendar.provider !== "none" ? config.calendar.provider : recorded("calendar_provider") === "google" ? "google" : "none");
  const maxStaleMsNow = () => (config.calendar.provider === "none" && Number(recorded("calendar_max_stale_minutes")) >= 15 ? Number(recorded("calendar_max_stale_minutes")) : config.calendar.maxStaleMinutes) * 60000;

  const q = {
    blocksOn: db.prepare("SELECT id, start_min, end_min FROM availability_blocks WHERE start_date <= ? AND end_date >= ?"),
    sessionsNear: db.prepare("SELECT id, session_date, session_start_min, session_minutes FROM inquiries WHERE status = 'confirmed' AND session_date BETWEEN ? AND ?"),
    busyNear: db.prepare("SELECT start_utc AS start, end_utc AS end FROM busy_cache WHERE end_utc > ? AND start_utc < ? ORDER BY start_utc"),
    state: db.prepare("SELECT * FROM availability_state WHERE id = 1"),
    setting: db.prepare("SELECT value FROM availability_settings WHERE key = ?"),
    putSetting: db.prepare("INSERT INTO availability_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    delSetting: db.prepare("DELETE FROM availability_settings WHERE key = ?"),
    addBlock: db.prepare("INSERT INTO availability_blocks (start_date, end_date, start_min, end_min, label, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    delBlock: db.prepare("DELETE FROM availability_blocks WHERE id = ?"),
    listBlocks: db.prepare("SELECT * FROM availability_blocks WHERE end_date >= ? ORDER BY start_date, id"),
  };

  // ---- settings and weekly rules (owner-set via the CLI; defaults are the flagged placeholders) ----
  function settings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const row = q.setting.get(key);
      if (row && Number.isInteger(Number(row.value))) out[key] = Number(row.value);
    }
    return out;
  }

  function setSetting(key, value) {
    const limits = SETTING_LIMITS[key];
    if (!limits) throw new LifecycleError("bad_setting", `Unknown setting. Choose one of: ${Object.keys(SETTING_LIMITS).join(", ")}.`);
    const n = Number(value);
    if (!Number.isInteger(n) || n < limits[0] || n > limits[1]) throw new LifecycleError("bad_setting", `${key} must be a whole number from ${limits[0]} to ${limits[1]}.`);
    q.putSetting.run(key, String(n));
  }

  function rules() {
    const row = q.setting.get("weekly_rules");
    if (!row) return DEFAULT_RULES;
    try {
      const parsed = JSON.parse(row.value);
      const out = {};
      for (let d = 0; d < 7; d++) out[d] = Array.isArray(parsed[d]) ? parsed[d] : [];
      return out;
    } catch {
      return {}; // unreadable rules: nothing is bookable (fail closed)
    }
  }

  /** windowsByDay: { 0..6: [[startMin,endMin], ...] }. Replaces the weekly rules for the listed days only. */
  function setRules(days, windows) {
    const current = { ...rules() };
    for (const [start, end] of windows) if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 1440 && start < end)) throw new LifecycleError("bad_rules", "Each window must run from 00:00 to 24:00 with the start before the end.");
    const clean = merge(windows.map(([start, end]) => ({ start, end }))).map((w) => [w.start, w.end]);
    for (const d of days) current[d] = clean;
    q.putSetting.run("weekly_rules", JSON.stringify(current));
  }

  const resetRules = () => q.delSetting.run("weekly_rules");

  // ---- manual blocks ----
  function addBlock({ from, to, start, end, label }) {
    if (!T.isRealDate(from) || !T.isRealDate(to)) throw new LifecycleError("bad_date", "Dates must be real YYYY-MM-DD dates.");
    if (to < from) throw new LifecycleError("bad_range", "The end date is before the start date.");
    if (T.daysBetween(from, to) > 366) throw new LifecycleError("bad_range", "A block can span at most one year.");
    let startMin = null;
    let endMin = null;
    if (start !== undefined || end !== undefined) {
      startMin = T.parseClock(start);
      endMin = T.parseClock(end, { allowEnd: true });
      if (startMin === null || endMin === null || startMin >= endMin) throw new LifecycleError("bad_time", "Give both a start and an end time (HH:MM, 24-hour) with the start before the end.");
    }
    const cleanLabel = label ? String(label).replace(UNSAFE_TEXT, "").trim().slice(0, 200) || null : null;
    const info = q.addBlock.run(from, to, startMin, endMin, cleanLabel, now().toISOString());
    return Number(info.lastInsertRowid);
  }

  function removeBlock(id) {
    if (!q.delBlock.run(Number(id)).changes) throw new LifecycleError("not_found", "No such block.");
  }

  const listBlocks = ({ fromDate } = {}) => q.listBlocks.all(fromDate || T.localDate(now().getTime()));

  // ---- external calendar status ----
  function externalStatus() {
    if (providerNow() === "none") return { required: false, verified: true, reason: "off" };
    const st = q.state.get();
    if (!st || !st.last_success_at) return { required: true, verified: false, reason: st && st.last_error ? st.last_error : "never_synced" };
    // A revoked/misconfigured connection is a known-bad state: unverified immediately, not after the stale timer.
    if (st.last_error && PERMANENT.has(st.last_error)) {
      return { required: true, verified: false, reason: st.last_error, state: st };
    }
    const age = now().getTime() - Date.parse(st.last_success_at);
    if (!(age <= maxStaleMsNow())) return { required: true, verified: false, reason: "stale", state: st };
    return { required: true, verified: true, reason: "ok", ageMinutes: Math.floor(age / 60000), state: st };
  }

  const covers = (ext, fromMs, toMs) => !ext.required || (ext.verified && ext.state.window_from <= fromMs && toMs <= ext.state.window_to);

  // ---- evaluation ----
  /** Detailed answer for one local date. `detail` is for the owner CLI only. */
  function evaluateDay(date, ext = externalStatus()) {
    const s = settings();
    const nowMs = now().getTime();
    const today = T.localDate(nowMs);
    const result = (available, reason, extra = {}) => ({ date, available, verified: !ext.required || ext.verified, reason, ...extra });

    if (date < T.addDays(today, s.lead_days)) return result(false, s.lead_days > 0 && date >= today ? "too_soon" : "past");
    if (date > T.addDays(today, HORIZON_DAYS)) return result(false, "beyond_horizon");

    const dayStart = T.dayStart(date);
    const dayEnd = dayStart + T.DAY_MS;
    const windows = rules()[T.weekdayOf(date)] || [];
    if (!windows.length) return result(false, "closed_by_rules");

    const bufferMs = s.buffer_minutes * T.MINUTE_MS;
    const blockers = [];
    const detail = { blocks: [], sessions: [], busy: 0 };
    if (date === today) blockers.push({ start: dayStart, end: nowMs }); // time that has already passed can't be booked

    for (const b of q.blocksOn.all(date, date)) {
      detail.blocks.push(b.id);
      blockers.push({ start: dayStart + (b.start_min === null ? 0 : b.start_min * T.MINUTE_MS), end: dayStart + (b.end_min === null ? 1440 : b.end_min) * T.MINUTE_MS });
    }
    for (const x of q.sessionsNear.all(T.addDays(date, -1), T.addDays(date, 1))) {
      const start = T.dayStart(x.session_date) + x.session_start_min * T.MINUTE_MS;
      const end = start + x.session_minutes * T.MINUTE_MS;
      if (overlaps(start - bufferMs, end + bufferMs, dayStart, dayEnd)) detail.sessions.push(x.id);
      blockers.push({ start: start - bufferMs, end: end + bufferMs });
    }

    if (ext.required) {
      // Required external source: must be fresh AND cover this whole day, otherwise we cannot know.
      if (!covers(ext, dayStart - bufferMs, dayEnd + bufferMs)) return result(false, "unverified", { detail, verified: false });
      for (const b of q.busyNear.all(dayStart - bufferMs, dayEnd + bufferMs)) {
        detail.busy++;
        blockers.push({ start: b.start - bufferMs, end: b.end + bufferMs });
      }
    }

    const free = subtract(
      windows.map(([a, b]) => ({ start: dayStart + a * T.MINUTE_MS, end: dayStart + b * T.MINUTE_MS })),
      blockers
    );
    const fits = free.some((seg) => seg.end - seg.start >= s.min_session_minutes * T.MINUTE_MS);
    return result(fits, fits ? "ok" : detail.blocks.length ? "blocked" : detail.sessions.length ? "booked" : detail.busy ? "busy" : "no_room", { detail, free });
  }

  /** Public month view: [{ date, available }] plus one overall verification flag. Nothing else. */
  function month(monthText) {
    const ext = externalStatus();
    const results = T.datesOfMonth(monthText).map((date) => evaluateDay(date, ext));
    return { verified: results.every((r) => r.verified), days: results.map((r) => ({ date: r.date, available: r.available })) };
  }

  function day(date) {
    const ext = externalStatus();
    const r = evaluateDay(date, ext);
    return { verified: r.verified, date, available: r.available };
  }

  // ---- confirm-time guard (called inside the lifecycle transaction) ----
  /**
   * Refuses to confirm a session that overlaps a manual block or external busy time. Confirmed-session
   * overlap is checked by the lifecycle itself. The owner may pass ignoreExternal after checking the
   * calendar by hand; manual blocks have no override (remove the block first).
   */
  function assertSessionFree({ date, startMin, minutes }, { ignoreExternal = false } = {}) {
    const dayStart = T.dayStart(date);
    const start = dayStart + startMin * T.MINUTE_MS;
    const end = start + minutes * T.MINUTE_MS;
    for (const b of q.blocksOn.all(date, date)) {
      const bs = dayStart + (b.start_min === null ? 0 : b.start_min * T.MINUTE_MS);
      const be = dayStart + (b.end_min === null ? 1440 : b.end_min) * T.MINUTE_MS;
      if (overlaps(start, end, bs, be)) throw new LifecycleError("blocked", `That time overlaps availability block #${b.id}. Remove or change the block first (block remove ${b.id}).`);
    }
    const ext = externalStatus();
    if (!ext.required || ignoreExternal) return { externalChecked: ext.required && ext.verified && covers(ext, start, end) };
    if (!covers(ext, start, end)) {
      throw new LifecycleError(
        "calendar_unverified",
        `Can't verify your Google Calendar right now (${ext.reason}), so I won't confirm blindly. Check "calendar status", wait for the next sync (every 15 minutes), or add --ignore-calendar if you have checked your calendar yourself.`
      );
    }
    if (q.busyNear.all(start, end).length) {
      throw new LifecycleError("calendar_busy", "Your Google Calendar shows busy time during that session. Choose another time, or add --ignore-calendar if you know it is fine.");
    }
    return { externalChecked: true };
  }

  /** Called by the running service at start-up so the owner CLI can follow the same calendar mode. */
  function recordConfiguration() {
    q.putSetting.run("calendar_provider", config.calendar.provider);
    q.putSetting.run("calendar_max_stale_minutes", String(config.calendar.maxStaleMinutes));
  }

  function healthSummary() {
    const ext = externalStatus();
    if (!ext.required) return "off";
    return ext.verified ? "ok" : `unverified:${ext.reason}`;
  }

  return { evaluateDay, month, day, assertSessionFree, externalStatus, healthSummary, recordConfiguration, settings, setSetting, rules, setRules, resetRules, addBlock, removeBlock, listBlocks, HORIZON_DAYS };
}

module.exports = { createAvailability, DEFAULT_RULES, DEFAULT_SETTINGS, DAY_NAMES, HORIZON_DAYS, SYNC_BEHIND_DAYS, SYNC_AHEAD_DAYS };
