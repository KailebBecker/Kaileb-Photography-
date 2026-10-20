"use strict";
// Half-open [start, end) interval helpers (numbers: UTC milliseconds, or minutes within a day).

/** Sorts and merges overlapping or touching intervals. */
function merge(list) {
  const sorted = list.filter((i) => i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

/** Parts of `windows` not covered by `blockers`. */
function subtract(windows, blockers) {
  const cut = merge(blockers);
  const out = [];
  for (const w of merge(windows)) {
    let cursor = w.start;
    for (const b of cut) {
      if (b.end <= cursor || b.start >= w.end) continue;
      if (b.start > cursor) out.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

module.exports = { merge, subtract, overlaps };
