"use strict";
// Owner/operator read tool (this slice has no admin UI):
//   node src/cli.js list [--all]     recent inquiries (default: 20 newest)
//   node src/cli.js show <id>        one inquiry in full
// Reads the same DB as the service; run on the server as the service user. Output contains PII.
const Database = require("better-sqlite3");
const { loadConfig } = require("./config");

const config = loadConfig();
const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
const [cmd, arg] = process.argv.slice(2);

if (cmd === "list") {
  const rows = db
    .prepare(`SELECT id, created_at, status, session_type, preferred_date, name, email, notify_status, notify_attempts, notify_last_error FROM inquiries ORDER BY created_at DESC ${arg === "--all" ? "" : "LIMIT 20"}`)
    .all();
  if (!rows.length) console.log("No inquiries yet.");
  console.table(rows);
  const backlog = db.prepare("SELECT COUNT(*) n FROM inquiries WHERE notify_status != 'sent'").get().n;
  if (backlog) console.log(`\n${backlog} inquiry/inquiries have not been successfully emailed to the owner yet.`);
} else if (cmd === "show" && arg) {
  const row = db.prepare("SELECT * FROM inquiries WHERE id = ?").get(arg.toUpperCase());
  console.log(row || "Not found.");
} else {
  console.log("Usage: node src/cli.js list [--all] | show <id>");
  process.exitCode = 1;
}
