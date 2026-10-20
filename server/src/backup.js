"use strict";
// Consistent online backup of the SQLite database (safe while the service runs).
//   BACKUP_DIR=/var/backups/kaileb-inquiry node src/backup.js
//   node src/backup.js --verify <file>     check an existing backup (restore drill)
// Every new backup is verified (integrity check + row count) before old ones are pruned.
// Keeps the newest 30 backups. Copy BACKUP_DIR off the server for real safety.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { loadConfig } = require("./config");

function verify(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (integrity !== "ok") throw new Error(`backup failed integrity check: ${file}`);
    const inquiries = db.prepare("SELECT COUNT(*) AS n FROM inquiries").get().n;
    const schema = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
    return { inquiries, schema };
  } finally {
    db.close();
  }
}

(async () => {
  if (process.argv[2] === "--verify") {
    const file = process.argv[3];
    if (!file) throw new Error("usage: node src/backup.js --verify <file>");
    const { inquiries, schema } = verify(file);
    console.log(`verified ${file}: integrity ok, ${inquiries} inquiries, schema version ${schema}`);
    return;
  }
  const config = loadConfig();
  const dir = process.env.BACKUP_DIR || "./backups";
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `inquiries-${stamp}.db`);
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  await db.backup(target);
  db.close();
  // Make the copy a self-contained single file (no -wal/-shm beside it); the service
  // switches a restored file back to WAL when it opens it.
  const copy = new Database(target);
  copy.pragma("journal_mode = DELETE");
  copy.close();
  const { inquiries } = verify(target); // throws (non-zero exit, nothing pruned) on a bad copy
  const all = fs.readdirSync(dir).filter((f) => /^inquiries-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.unlinkSync(path.join(dir, old));
  console.log(`backup written and verified: ${target} (${inquiries} inquiries)`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
