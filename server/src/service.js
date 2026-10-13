"use strict";
const crypto = require("crypto");

const MAX_NOTIFY_ATTEMPTS = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I L O U

class RateLimitedError extends Error {}

function newId() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

function createService({ db, notifier, now = () => new Date(), perEmailDailyCap = 5 }) {
  const byKey = db.prepare("SELECT id FROM inquiries WHERE idempotency_key = ?");
  const emailCount = db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE email = ? AND created_at > ?");
  const insert = db.prepare(`
    INSERT INTO inquiries (id, created_at, name, email, phone, session_type, preferred_date, location, message, discount_code, idempotency_key, source_origin)
    VALUES (@id, @created_at, @name, @email, @phone, @session_type, @preferred_date, @location, @message, @discount_code, @idempotency_key, @source_origin)`);
  const getRow = db.prepare("SELECT * FROM inquiries WHERE id = ?");
  const markSent = db.prepare("UPDATE inquiries SET notify_status='sent', notify_attempts=notify_attempts+1, notify_last_attempt_at=?, notified_at=?, notify_last_error=NULL WHERE id=?");
  const markFailed = db.prepare("UPDATE inquiries SET notify_status='failed', notify_attempts=notify_attempts+1, notify_last_attempt_at=?, notify_last_error=? WHERE id=?");
  const due = db.prepare("SELECT id, notify_attempts, notify_last_attempt_at FROM inquiries WHERE notify_status != 'sent' AND notify_attempts < ? ORDER BY created_at");
  const backlog = db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE notify_status != 'sent'");

  const inFlight = new Map(); // id -> promise, so one process never double-sends

  /** Durably stores the inquiry (single transaction) or returns the earlier one for a repeated key. */
  function create(value, sourceOrigin) {
    const run = db.transaction(() => {
      const existing = byKey.get(value.idempotencyKey);
      if (existing) return { id: existing.id, duplicate: true };
      const since = new Date(now().getTime() - 24 * 3600 * 1000).toISOString();
      if (emailCount.get(value.email, since).n >= perEmailDailyCap) throw new RateLimitedError("email_cap");
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = newId();
        try {
          insert.run({
            id,
            created_at: now().toISOString(),
            name: value.name,
            email: value.email,
            phone: value.phone || null,
            session_type: value.sessionType,
            preferred_date: value.preferredDate || null,
            location: value.location || null,
            message: value.message,
            discount_code: value.discountCode || null,
            idempotency_key: value.idempotencyKey,
            source_origin: sourceOrigin || null,
          });
          return { id, duplicate: false };
        } catch (err) {
          if (!(err && /UNIQUE.*inquiries\.id|PRIMARY KEY/.test(String(err.message)))) throw err; // only retry id collisions
        }
      }
      throw new Error("could not allocate inquiry id");
    });
    return run(); // throws if the write fails: callers must NOT report success
  }

  /** Attempts the owner notification once; records the outcome; never throws. */
  function notify(id) {
    if (inFlight.has(id)) return inFlight.get(id);
    const p = (async () => {
      const row = getRow.get(id);
      if (!row || row.notify_status === "sent") return;
      try {
        await notifier.send(row);
        const t = now().toISOString();
        markSent.run(t, t, id);
      } catch (err) {
        markFailed.run(now().toISOString(), (err && err.code) || "error", id);
      }
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  /** Retries unsent notifications with backoff (min(attempts^2, 60) minutes). */
  async function retryPending() {
    const t = now().getTime();
    const ids = due
      .all(MAX_NOTIFY_ATTEMPTS)
      .filter((r) => {
        if (!r.notify_last_attempt_at) return true;
        const waitMs = Math.min(r.notify_attempts ** 2, 60) * 60 * 1000;
        return t - new Date(r.notify_last_attempt_at).getTime() >= waitMs;
      })
      .map((r) => r.id);
    await Promise.all(ids.map(notify));
    return ids.length;
  }

  return {
    create,
    notify,
    retryPending,
    drain: () => Promise.all([...inFlight.values()]),
    notifyBacklog: () => backlog.get().n,
  };
}

module.exports = { createService, RateLimitedError, MAX_NOTIFY_ATTEMPTS };
