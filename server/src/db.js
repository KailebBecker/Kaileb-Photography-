"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// Versioned, append-only migrations. Never edit an applied migration; add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE inquiries (
    id               TEXT PRIMARY KEY,
    created_at       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','accepted','declined','confirmed','cancelled','completed','spam')),
    name             TEXT NOT NULL,
    email            TEXT NOT NULL,
    phone            TEXT,
    session_type     TEXT NOT NULL,
    preferred_date   TEXT,
    location         TEXT,
    message          TEXT NOT NULL,
    discount_code    TEXT,
    idempotency_key  TEXT NOT NULL UNIQUE,
    source_origin    TEXT,
    notify_status    TEXT NOT NULL DEFAULT 'pending' CHECK (notify_status IN ('pending','sent','failed')),
    notify_attempts  INTEGER NOT NULL DEFAULT 0,
    notify_last_attempt_at TEXT,
    notify_last_error TEXT,
    notified_at      TEXT
  );
  CREATE INDEX inquiries_email_created ON inquiries (email, created_at);
  CREATE INDEX inquiries_notify ON inquiries (notify_status, notify_attempts);
  `,
];

function openDatabase(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  // Durability over speed: this is a low-volume table where losing an inquiry is the worst failure.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
    })();
  });
}

module.exports = { openDatabase };
