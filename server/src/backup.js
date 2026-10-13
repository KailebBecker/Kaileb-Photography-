"use strict";
// Consistent online backup of the SQLite database (safe while the service runs).
//   BACKUP_DIR=/var/backups/kaileb-inquiry node src/backup.js
// Keeps the newest 30 backups. Copy BACKUP_DIR off the server (e.g. to S3) for real safety.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { loadConfig } = require("./config");

(async () => {
  const config = loadConfig();
  const dir = process.env.BACKUP_DIR || "./backups";
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `inquiries-${stamp}.db`);
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  await db.backup(target);
  db.close();
  const all = fs.readdirSync(dir).filter((f) => /^inquiries-.*\.db$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.unlinkSync(path.join(dir, old));
  console.log(`backup written: ${target}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
