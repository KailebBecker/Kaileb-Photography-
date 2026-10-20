"use strict";
// Date/time helpers for availability. America/Phoenix has no daylight saving time (fixed UTC-7), so
// converting between local calendar dates and UTC instants is a constant offset. Everything else in
// the availability code works in UTC milliseconds ("instants") or local YYYY-MM-DD dates.

const PHOENIX_OFFSET_MS = -7 * 3600000;
const MINUTE_MS = 60000;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isRealDate(iso) {
  if (typeof iso !== "string" || !DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Local (Phoenix) calendar date of a UTC instant. */
const localDate = (ms) => new Date(ms + PHOENIX_OFFSET_MS).toISOString().slice(0, 10);

/** UTC instant of local midnight at the start of a local date. */
function dayStart(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - PHOENIX_OFFSET_MS;
}

/** Pure calendar arithmetic on YYYY-MM-DD strings. */
function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const weekdayOf = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
};

const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY_MS);

function isRealMonth(s) {
  return typeof s === "string" && MONTH_RE.test(s) && Number(s.slice(5)) >= 1 && Number(s.slice(5)) <= 12;
}

/** All local dates of a YYYY-MM month. */
function datesOfMonth(month) {
  const first = `${month}-01`;
  const out = [];
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "HH:MM" (24:00 allowed as an end) -> minutes after midnight, or null. */
function parseClock(text, { allowEnd = false } = {}) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(text || "").trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins === 1440) return allowEnd ? 1440 : null;
  return Number(m[1]) <= 23 ? mins : null;
}

const formatClock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

module.exports = { PHOENIX_OFFSET_MS, MINUTE_MS, DAY_MS, isRealDate, isRealMonth, localDate, dayStart, addDays, weekdayOf, daysBetween, datesOfMonth, parseClock, formatClock };
