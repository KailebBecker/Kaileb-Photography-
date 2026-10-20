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
  // 2: owner lifecycle (accept/decline/confirm/...). Confirmed sessions carry an explicit
  // date + start + length chosen by the owner (no defaults are assumed anywhere).
  `
  ALTER TABLE inquiries ADD COLUMN updated_at TEXT;
  ALTER TABLE inquiries ADD COLUMN session_date TEXT;
  ALTER TABLE inquiries ADD COLUMN session_start_min INTEGER;
  ALTER TABLE inquiries ADD COLUMN session_minutes INTEGER;
  CREATE TABLE inquiry_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    inquiry_id  TEXT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    at          TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    note        TEXT
  );
  CREATE INDEX inquiry_events_inquiry ON inquiry_events (inquiry_id, id);
  CREATE INDEX inquiries_session ON inquiries (session_date) WHERE status = 'confirmed';
  `,
  // 3: availability. Manual blocks (owner-only private label), owner-set rules/settings, and the
  // external-calendar cache: ONLY merged busy intervals (UTC ms) and sync status. No event titles,
  // descriptions, attendees or locations are ever stored.
  `
  CREATE TABLE availability_blocks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT NOT NULL,
    end_date   TEXT NOT NULL,
    start_min  INTEGER,
    end_min    INTEGER,
    label      TEXT,
    created_at TEXT NOT NULL,
    CHECK (end_date >= start_date),
    CHECK ((start_min IS NULL AND end_min IS NULL)
        OR (start_min IS NOT NULL AND end_min IS NOT NULL AND start_min >= 0 AND end_min <= 1440 AND start_min < end_min))
  );
  CREATE INDEX availability_blocks_dates ON availability_blocks (start_date, end_date);
  CREATE TABLE availability_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE busy_cache (start_utc INTEGER NOT NULL, end_utc INTEGER NOT NULL);
  CREATE INDEX busy_cache_start ON busy_cache (start_utc);
  CREATE TABLE availability_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_attempt_at TEXT,
    last_success_at TEXT,
    window_from     INTEGER,
    window_to       INTEGER,
    last_error      TEXT,
    failures        INTEGER NOT NULL DEFAULT 0
  );
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
