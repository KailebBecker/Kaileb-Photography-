"use strict";
// Keeps the external-calendar cache fresh. The cache holds ONLY merged busy intervals (UTC ms) and a
// small status row; it is replaced atomically and only after a fully successful provider response, so
// a failed refresh can never leave a half-updated view. Staleness (engine.externalStatus) is what turns
// a failing source into "unverified" for the public.

const { merge } = require("./intervals");
const { PERMANENT } = require("./google");
const { SYNC_BEHIND_DAYS, SYNC_AHEAD_DAYS } = require("./engine");
const T = require("./time");

function createCalendarSync({ db, source, now = () => new Date() }) {
  const clear = db.prepare("DELETE FROM busy_cache");
  const insert = db.prepare("INSERT INTO busy_cache (start_utc, end_utc) VALUES (?, ?)");
  const markOk = db.prepare(`
    INSERT INTO availability_state (id, last_attempt_at, last_success_at, window_from, window_to, last_error, failures)
    VALUES (1, @at, @at, @from, @to, NULL, 0)
    ON CONFLICT(id) DO UPDATE SET last_attempt_at = @at, last_success_at = @at, window_from = @from, window_to = @to, last_error = NULL, failures = 0`);
  const markFail = db.prepare(`
    INSERT INTO availability_state (id, last_attempt_at, last_error, failures) VALUES (1, @at, @code, 1)
    ON CONFLICT(id) DO UPDATE SET last_attempt_at = @at, last_error = @code, failures = failures + 1`);

  /** One refresh attempt. Never throws; returns { ok, count } or { ok: false, code } (a short fixed code). */
  async function refresh() {
    const at = now().toISOString();
    const today = T.localDate(now().getTime());
    const from = T.dayStart(T.addDays(today, -SYNC_BEHIND_DAYS));
    const to = T.dayStart(T.addDays(today, SYNC_AHEAD_DAYS));
    let intervals;
    try {
      intervals = merge(await source.getBusy(from, to));
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "error";
      markFail.run({ at, code });
      return { ok: false, code };
    }
    db.transaction(() => {
      clear.run();
      for (const i of intervals) insert.run(Math.max(i.start, from), Math.min(i.end, to));
      markOk.run({ at, from, to });
    })();
    return { ok: true, count: intervals.length };
  }

  /** Runs refresh() now and then on a timer: every `intervalMs`, sooner after a transient failure. */
  function start({ intervalMs = 15 * 60000, retryMs = 3 * 60000, onResult = () => {} } = {}) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      const r = await refresh();
      onResult(r);
      if (stopped) return;
      timer = setTimeout(tick, r.ok || PERMANENT.has(r.code) ? intervalMs : retryMs);
      timer.unref();
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  /** Forget the cache and status (used when disconnecting the calendar). */
  const forget = () => db.transaction(() => {
    clear.run();
    db.prepare("DELETE FROM availability_state").run();
  })();

  return { refresh, start, forget };
}

module.exports = { createCalendarSync };
