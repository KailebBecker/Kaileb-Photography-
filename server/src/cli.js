"use strict";
// Owner/operator tool (there is no admin UI yet). Run on the server as the service user:
//   node src/cli.js list [--status new,accepted] [--all]
//   node src/cli.js show <id>
//   node src/cli.js accept|decline|cancel|complete|spam <id> [--note "text"]
//   node src/cli.js confirm <id> --date YYYY-MM-DD --start HH:MM --minutes N [--note "text"]
//   node src/cli.js note <id> "text"
//   node src/cli.js delete <id> --yes
//   node src/cli.js purge --days N --status declined,cancelled,spam [--yes]   (dry run without --yes)
// Output contains personal information. These commands do NOT email the client: reply from your inbox.
const Database = require("better-sqlite3");
const { loadConfig } = require("./config");
const { createLifecycle, LifecycleError } = require("./lifecycle");

const args = process.argv.slice(2);
const cmd = args.shift();
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  } else positional.push(args[i]);
}

function usage() {
  console.log(require("fs").readFileSync(__filename, "utf8").split("\n").slice(1, 11).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exitCode = 1;
}

const MUTATING = ["accept", "decline", "cancel", "complete", "spam", "confirm", "note", "delete", "purge"];
const TARGET = { accept: "accepted", decline: "declined", cancel: "cancelled", complete: "completed", spam: "spam", confirm: "confirmed" };

function main() {
  const config = loadConfig();
  const db = new Database(config.dbPath, { readonly: !MUTATING.includes(cmd), fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const life = createLifecycle({ db });

  if (cmd === "list") {
    const where = flags.status && flags.status !== true ? `WHERE status IN (${String(flags.status).split(",").map(() => "?").join(",")})` : "";
    const rows = db
      .prepare(`SELECT id, created_at, status, session_type, preferred_date, session_date, name, email, notify_status, notify_last_error FROM inquiries ${where} ORDER BY created_at DESC ${flags.all ? "" : "LIMIT 20"}`)
      .all(...(where ? String(flags.status).split(",") : []));
    if (!rows.length) console.log("No inquiries.");
    else console.table(rows);
    const backlog = db.prepare("SELECT COUNT(*) n FROM inquiries WHERE notify_status != 'sent'").get().n;
    if (backlog) console.log(`\n${backlog} inquiry/inquiries have not been successfully emailed to you yet (see notify_last_error).`);
  } else if (cmd === "show" && positional[0]) {
    const row = db.prepare("SELECT * FROM inquiries WHERE id = ?").get(positional[0].toUpperCase());
    if (!row) return console.log("Not found.");
    console.log(row);
    console.log("History:");
    console.table(life.history(row.id));
  } else if (TARGET[cmd] && positional[0]) {
    const session = cmd === "confirm" ? { date: flags.date, start: flags.start, minutes: flags.minutes } : undefined;
    const row = life.transition(positional[0], TARGET[cmd], { note: flags.note === true ? undefined : flags.note, session });
    console.log(`${row.id} is now ${row.status}.${cmd === "confirm" ? ` Session ${row.session_date} ${String(Math.floor(row.session_start_min / 60)).padStart(2, "0")}:${String(row.session_start_min % 60).padStart(2, "0")} for ${row.session_minutes} min.` : ""}`);
    console.log(`No email was sent to ${row.email}; reply from your inbox.`);
  } else if (cmd === "note" && positional[0] && positional[1]) {
    life.addNote(positional[0], positional.slice(1).join(" "));
    console.log("Note added.");
  } else if (cmd === "delete" && positional[0]) {
    if (!flags.yes) return console.log("This permanently deletes the inquiry and its history. Re-run with --yes to confirm.");
    life.remove(positional[0]);
    console.log("Deleted.");
  } else if (cmd === "purge") {
    const result = life.purge({ olderThanDays: Number(flags.days), statuses: String(flags.status || "").split(",").filter(Boolean), dryRun: !flags.yes });
    console.log(result.dryRun ? `Dry run: ${result.count} inquiry/inquiries would be deleted. Re-run with --yes to delete.` : `Deleted ${result.count}.`);
    if (result.count) console.log(result.ids.join(", "));
  } else {
    usage();
  }
}

try {
  main();
} catch (err) {
  if (err instanceof LifecycleError) {
    console.error(`Refused: ${err.message}`);
    process.exitCode = 2;
  } else {
    console.error(err.message);
    process.exitCode = 1;
  }
}
