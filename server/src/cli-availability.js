"use strict";
// Owner CLI commands for availability (called from cli.js). Output is for the owner only and may show
// block labels; it never shows Google event details because none are ever fetched or stored.
//
//   block add --date D | --from D --to D | --dates D1,D2,... [--start HH:MM --end HH:MM] [--label "text"]
//   block list [--all]            block remove <id>
//   availability check <date>     availability month <YYYY-MM>
//   rules show                    rules set <days> <windows|closed>   (e.g. rules set mon-fri 17:30-24:00)
//   rules reset                   setting show | setting set <buffer_minutes|min_session_minutes|lead_days> <n>
//   calendar status               calendar clear --yes   (forget the cached busy time and sync status)

const { LifecycleError } = require("./lifecycle");
const { createAvailability, DAY_NAMES } = require("./availability/engine");
const { createCalendarSync } = require("./availability/sync");
const T = require("./availability/time");

const HANDLED = new Set(["block", "availability", "rules", "setting", "calendar"]);
const WRITES = { block: ["add", "remove"], rules: ["set", "reset"], setting: ["set"], calendar: ["clear"] };

/** True when this command needs a writable database. */
const needsWrite = (cmd, sub) => (WRITES[cmd] || []).includes(sub);

function parseDays(text) {
  const out = new Set();
  for (const part of String(text || "").toLowerCase().split(",")) {
    const range = /^([a-z]{3})-([a-z]{3})$/.exec(part.trim());
    if (range) {
      let i = DAY_NAMES.indexOf(range[1]);
      const end = DAY_NAMES.indexOf(range[2]);
      if (i < 0 || end < 0) throw new LifecycleError("bad_days", `Unknown day in "${part}". Use sun, mon, tue, wed, thu, fri, sat.`);
      for (let n = 0; n < 7; n++, i = (i + 1) % 7) {
        out.add(i);
        if (i === end) break;
      }
    } else if (DAY_NAMES.includes(part.trim())) out.add(DAY_NAMES.indexOf(part.trim()));
    else throw new LifecycleError("bad_days", `Unknown day "${part}". Use sun, mon, tue, wed, thu, fri, sat, a list (sat,sun) or a range (mon-fri).`);
  }
  return [...out];
}

function parseWindows(text) {
  if (String(text).toLowerCase() === "closed") return [];
  return String(text)
    .split(",")
    .map((w) => {
      const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(w.trim());
      const a = m && T.parseClock(m[1]);
      const b = m && T.parseClock(m[2], { allowEnd: true });
      if (a === null || b === null || a === undefined || b === undefined || a >= b) throw new LifecycleError("bad_rules", `"${w}" is not a window like 17:30-24:00 (24-hour, start before end).`);
      return [a, b];
    });
}

const showRules = (rules) =>
  DAY_NAMES.map((name, d) => `${name}: ${(rules[d] || []).length ? rules[d].map(([a, b]) => `${T.formatClock(a)}-${T.formatClock(b)}`).join(", ") : "closed"}`).join("\n");

function formatBlock(b) {
  const when = b.start_date === b.end_date ? b.start_date : `${b.start_date} to ${b.end_date}`;
  const time = b.start_min === null ? "all day" : `${T.formatClock(b.start_min)}-${T.formatClock(b.end_min)}`;
  return `#${b.id}  ${when}  ${time}${b.label ? `  "${b.label}"` : ""}`;
}

/** Returns true if the command was an availability command (and has been handled). */
function handleAvailabilityCommand({ cmd, positional, flags, db, config, log = console.log }) {
  if (!HANDLED.has(cmd)) return false;
  const sub = positional[0];
  const av = createAvailability({ db, config, adoptServiceConfig: true }); // follow the running service's calendar mode
  const usageError = (text) => {
    throw new LifecycleError("usage", text);
  };

  if (cmd === "block" && sub === "add") {
    const dates = flags.dates && flags.dates !== true ? String(flags.dates).split(",").map((d) => d.trim()) : null;
    const ranges = dates ? dates.map((d) => ({ from: d, to: d })) : flags.date && flags.date !== true ? [{ from: flags.date, to: flags.date }] : flags.from && flags.to ? [{ from: flags.from, to: flags.to }] : null;
    if (!ranges) usageError('Use --date D, --dates D1,D2 or --from D --to D (optionally --start HH:MM --end HH:MM, --label "text").');
    const time = flags.start || flags.end ? { start: flags.start, end: flags.end } : {};
    const ids = db.transaction(() => ranges.map((r) => av.addBlock({ ...r, ...time, label: flags.label === true ? undefined : flags.label })))();
    log(`Added ${ids.length === 1 ? "block" : "blocks"} ${ids.map((i) => "#" + i).join(", ")}. Those dates are now unavailable to customers.`);
  } else if (cmd === "block" && sub === "list") {
    const rows = av.listBlocks({ fromDate: flags.all ? "0000-01-01" : undefined });
    log(rows.length ? rows.map(formatBlock).join("\n") : "No blocks.");
  } else if (cmd === "block" && sub === "remove" && positional[1]) {
    av.removeBlock(positional[1]);
    log(`Removed block #${Number(positional[1])}.`);
  } else if (cmd === "availability" && sub === "check" && positional[1]) {
    if (!T.isRealDate(positional[1])) usageError("Give a real date as YYYY-MM-DD.");
    const r = av.evaluateDay(positional[1]);
    const d = r.detail || { blocks: [], sessions: [], busy: 0 };
    log(`${r.date}: ${r.available ? "AVAILABLE" : "unavailable"}  (${r.reason}${r.verified ? "" : ", calendar NOT verified"})`);
    log(`  blocks: ${d.blocks.length ? d.blocks.map((i) => "#" + i).join(", ") : "none"} | confirmed sessions nearby: ${d.sessions.length ? d.sessions.join(", ") : "none"} | calendar busy intervals: ${d.busy}`);
  } else if (cmd === "availability" && sub === "month" && positional[1]) {
    if (!T.isRealMonth(positional[1])) usageError("Give a month as YYYY-MM.");
    const m = av.month(positional[1]);
    log(m.days.map((d) => `${d.date.slice(8)}${d.available ? "+" : "-"}`).join(" "));
    log(`("+" available, "-" unavailable)${m.verified ? "" : "  Calendar is NOT verified: every date shows unavailable."}`);
  } else if (cmd === "rules" && sub === "show") {
    log(showRules(av.rules()));
    log("(weekly windows customers can request; hours outside them are unavailable. Placeholders until you set them.)");
  } else if (cmd === "rules" && sub === "set" && positional[1] && positional[2]) {
    av.setRules(parseDays(positional[1]), parseWindows(positional[2]));
    log("Updated.\n" + showRules(av.rules()));
  } else if (cmd === "rules" && sub === "reset") {
    av.resetRules();
    log("Weekly rules reset to the built-in placeholders.\n" + showRules(av.rules()));
  } else if (cmd === "setting" && sub === "show") {
    const s = av.settings();
    log(Object.entries(s).map(([k, v]) => `${k} = ${v}`).join("\n"));
  } else if (cmd === "setting" && sub === "set" && positional[1] && positional[2] !== undefined) {
    av.setSetting(positional[1], positional[2]);
    log(`${positional[1]} = ${av.settings()[positional[1]]}`);
  } else if (cmd === "calendar" && sub === "status") {
    const ext = av.externalStatus();
    if (!ext.required) log("External calendar: OFF (availability uses weekly rules, blocks and confirmed sessions only).");
    else {
      const st = ext.state || db.prepare("SELECT * FROM availability_state WHERE id = 1").get() || {};
      log(`External calendar: google -> ${ext.verified ? "VERIFIED" : "NOT VERIFIED (" + ext.reason + ")"}`);
      log(`  last successful sync: ${st.last_success_at || "never"} | last attempt: ${st.last_attempt_at || "never"} | last error: ${st.last_error || "none"} | failures in a row: ${st.failures || 0}`);
      log(`  cached busy intervals: ${db.prepare("SELECT COUNT(*) n FROM busy_cache").get().n} (times only, no event details)`);
      if (!ext.verified) log("  Public availability shows every date as unavailable and confirming a session is refused until this is fixed (or --ignore-calendar).");
    }
  } else if (cmd === "calendar" && sub === "clear") {
    if (!flags.yes) log("This deletes the cached busy time and sync status. Availability becomes 'unverified' until the next sync. Re-run with --yes.");
    else {
      createCalendarSync({ db, source: null }).forget();
      log("Cleared.");
    }
  } else {
    usageError(`Unknown ${cmd} command. See the header of src/cli-availability.js.`);
  }
  return true;
}

module.exports = { handleAvailabilityCommand, needsWrite, HANDLED, parseDays, parseWindows };
