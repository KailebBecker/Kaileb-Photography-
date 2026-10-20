"use strict";
// Owner-side request lifecycle (V1-SPEC "Booking / inquiry model"):
//   new -> accepted -> confirmed -> completed        (declined / cancelled / spam as exits)
// Pure data logic with no network exposure; the CLI (and later an authenticated admin UI)
// call into it. Invented business defaults are deliberately absent: confirming a session
// requires the owner to state the date, start time and length explicitly.

const { UNSAFE_TEXT } = require("./validate");

const TRANSITIONS = {
  new: ["accepted", "declined", "cancelled", "spam"],
  accepted: ["confirmed", "declined", "cancelled"],
  confirmed: ["completed", "cancelled"],
  declined: [],
  cancelled: [],
  completed: [],
  spam: [],
};

class LifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRealDate(iso) {
  if (!DATE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseSession({ date, start, minutes }) {
  if (!isRealDate(date)) throw new LifecycleError("bad_date", "Session date must be a real YYYY-MM-DD date.");
  const t = TIME.exec(start || "");
  if (!t) throw new LifecycleError("bad_start", "Start time must be HH:MM (24-hour).");
  const startMin = Number(t[1]) * 60 + Number(t[2]);
  const len = Number(minutes);
  if (!Number.isInteger(len) || len < 15 || len > 16 * 60) throw new LifecycleError("bad_minutes", "Session length must be 15 to 960 whole minutes.");
  if (startMin + len > 24 * 60) throw new LifecycleError("bad_minutes", "Session must end by midnight.");
  return { date, startMin, minutes: len };
}

function createLifecycle({ db, now = () => new Date(), availability = null }) {
  const get = db.prepare("SELECT * FROM inquiries WHERE id = ?");
  const setStatus = db.prepare("UPDATE inquiries SET status = ?, updated_at = ? WHERE id = ?");
  const setSession = db.prepare("UPDATE inquiries SET status = 'confirmed', updated_at = ?, session_date = ?, session_start_min = ?, session_minutes = ? WHERE id = ?");
  const clearSession = db.prepare("UPDATE inquiries SET session_date = NULL, session_start_min = NULL, session_minutes = NULL WHERE id = ?");
  const addEvent = db.prepare("INSERT INTO inquiry_events (inquiry_id, at, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)");
  const confirmedThatDay = db.prepare("SELECT id, session_start_min, session_minutes FROM inquiries WHERE status = 'confirmed' AND session_date = ? AND id != ?");
  const events = db.prepare("SELECT at, from_status, to_status, note FROM inquiry_events WHERE inquiry_id = ? ORDER BY id");
  const del = db.prepare("DELETE FROM inquiries WHERE id = ?");

  const clean = (note) => (note ? String(note).replace(UNSAFE_TEXT, "").trim().slice(0, 1000) || null : null); // eslint-disable-line no-control-regex

  /** Moves an inquiry to a new status inside one transaction. Throws LifecycleError on a bad move. */
  function transition(id, to, { note, session, ignoreExternal = false } = {}) {
    return db.transaction(() => {
      const row = get.get(String(id).toUpperCase());
      if (!row) throw new LifecycleError("not_found", "No such inquiry.");
      if (!TRANSITIONS[row.status] || !TRANSITIONS[row.status].includes(to)) {
        throw new LifecycleError("bad_transition", `Can't move an inquiry from "${row.status}" to "${to}".`);
      }
      const at = now().toISOString();
      if (to === "confirmed") {
        if (!session) throw new LifecycleError("session_required", "Confirming needs a session date, start time and length.");
        const s = parseSession(session);
        // Double-booking guard: refuse if it overlaps another confirmed session that day.
        for (const other of confirmedThatDay.all(s.date, row.id)) {
          if (s.startMin < other.session_start_min + other.session_minutes && other.session_start_min < s.startMin + s.minutes) {
            throw new LifecycleError("conflict", `Overlaps confirmed session ${other.id} on ${s.date}.`);
          }
        }
        // Manual blocks and (when configured) the external calendar. Runs in this transaction against the
        // cached busy intervals; fails safe when a required calendar can't be verified.
        if (availability) availability.assertSessionFree(s, { ignoreExternal });
        setSession.run(at, s.date, s.startMin, s.minutes, row.id);
        if (ignoreExternal && availability && availability.externalStatus().required) note = [note, "Confirmed with --ignore-calendar (external calendar check skipped by the owner)."].filter(Boolean).join(" ");
      } else {
        setStatus.run(to, at, row.id);
        if (to === "cancelled") clearSession.run(row.id); // frees the slot
      }
      addEvent.run(row.id, at, row.status, to, clean(note));
      return get.get(row.id);
    })();
  }

  function addNote(id, note) {
    const row = get.get(String(id).toUpperCase());
    if (!row) throw new LifecycleError("not_found", "No such inquiry.");
    if (!clean(note)) throw new LifecycleError("empty_note", "Note is empty.");
    addEvent.run(row.id, now().toISOString(), row.status, null, clean(note));
  }

  const history = (id) => events.all(String(id).toUpperCase());

  /** Permanently deletes one inquiry and its history (data-subject deletion). */
  function remove(id) {
    const changes = del.run(String(id).toUpperCase()).changes;
    if (!changes) throw new LifecycleError("not_found", "No such inquiry.");
  }

  /**
   * Retention purge with EXPLICIT arguments (no policy is assumed; the owner decides, STATE.md G8).
   * dryRun returns what would be deleted. Confirmed/accepted inquiries are never purge-able.
   */
  function purge({ olderThanDays, statuses, dryRun = true }) {
    if (!Number.isInteger(olderThanDays) || olderThanDays < 1) throw new LifecycleError("bad_days", "olderThanDays must be a positive integer.");
    const allowed = new Set(["declined", "cancelled", "completed", "spam", "new"]);
    if (!Array.isArray(statuses) || !statuses.length || statuses.some((s) => !allowed.has(s))) {
      throw new LifecycleError("bad_statuses", `statuses must be a non-empty subset of: ${[...allowed].join(", ")}`);
    }
    const cutoff = new Date(now().getTime() - olderThanDays * 86400000).toISOString();
    const marks = statuses.map(() => "?").join(",");
    const ids = db.prepare(`SELECT id FROM inquiries WHERE status IN (${marks}) AND COALESCE(updated_at, created_at) < ?`).all(...statuses, cutoff).map((r) => r.id);
    if (!dryRun) db.transaction(() => ids.forEach((id) => del.run(id)))();
    return { count: ids.length, ids, dryRun };
  }

  return { transition, addNote, history, remove, purge };
}

module.exports = { createLifecycle, LifecycleError, TRANSITIONS };
