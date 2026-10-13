"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, payload, NOW } = require("./helpers");
const { createLifecycle, LifecycleError } = require("../src/lifecycle");
const { openDatabase } = require("../src/db");

async function seeded(n = 1) {
  const t = setup();
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await t.post(payload({ email: `c${i}@example.com` }))).json().id);
  await t.service.drain();
  let clock = NOW.getTime();
  const life = createLifecycle({ db: t.db, now: () => new Date((clock += 1000)) });
  return { ...t, ids, life };
}

const status = (t, id) => t.db.prepare("SELECT status FROM inquiries WHERE id = ?").get(id).status;
const session = (over = {}) => ({ date: "2026-12-20", start: "16:00", minutes: 90, ...over });

test("happy path new -> accepted -> confirmed -> completed with an audit trail", async () => {
  const t = await seeded();
  const [id] = t.ids;
  t.life.transition(id, "accepted", { note: "Replied by email" });
  t.life.transition(id, "confirmed", { session: session(), note: "Deposit received" });
  const row = t.db.prepare("SELECT * FROM inquiries WHERE id = ?").get(id);
  assert.equal(row.status, "confirmed");
  assert.equal(row.session_date, "2026-12-20");
  assert.equal(row.session_start_min, 16 * 60);
  assert.equal(row.session_minutes, 90);
  t.life.transition(id, "completed");
  const h = t.life.history(id);
  assert.deepEqual(h.map((e) => `${e.from_status}>${e.to_status}`), ["new>accepted", "accepted>confirmed", "confirmed>completed"]);
  assert.equal(h[0].note, "Replied by email");
});

test("illegal transitions are refused and change nothing", async () => {
  const t = await seeded();
  const [id] = t.ids;
  for (const to of ["confirmed", "completed"]) assert.throws(() => t.life.transition(id, to, { session: session() }), (e) => e.code === "bad_transition");
  t.life.transition(id, "declined");
  for (const to of ["accepted", "new", "confirmed", "cancelled"]) assert.throws(() => t.life.transition(id, to, { session: session() }), (e) => e.code === "bad_transition");
  assert.equal(status(t, id), "declined");
  assert.throws(() => t.life.transition("NOSUCHID01", "accepted"), (e) => e.code === "not_found");
  assert.throws(() => t.life.transition(id, "bogus"), (e) => e.code === "bad_transition");
});

test("confirming requires an explicit, valid session (no invented defaults)", async () => {
  const t = await seeded();
  const [id] = t.ids;
  t.life.transition(id, "accepted");
  assert.throws(() => t.life.transition(id, "confirmed"), (e) => e.code === "session_required");
  assert.throws(() => t.life.transition(id, "confirmed", { session: session({ date: "2026-02-30" }) }), (e) => e.code === "bad_date");
  assert.throws(() => t.life.transition(id, "confirmed", { session: session({ start: "25:00" }) }), (e) => e.code === "bad_start");
  assert.throws(() => t.life.transition(id, "confirmed", { session: session({ minutes: 5 }) }), (e) => e.code === "bad_minutes");
  assert.throws(() => t.life.transition(id, "confirmed", { session: session({ start: "23:00", minutes: 120 }) }), (e) => e.code === "bad_minutes");
  assert.equal(status(t, id), "accepted");
});

test("double-booking guard: overlapping confirmed sessions are refused; adjacent and other days are fine; cancelling frees the slot", async () => {
  const t = await seeded(4);
  const [a, b, c, d] = t.ids;
  for (const id of t.ids) t.life.transition(id, "accepted");
  t.life.transition(a, "confirmed", { session: session({ start: "16:00", minutes: 90 }) }); // 16:00-17:30
  assert.throws(() => t.life.transition(b, "confirmed", { session: session({ start: "17:00", minutes: 60 }) }), (e) => e.code === "conflict");
  assert.throws(() => t.life.transition(b, "confirmed", { session: session({ start: "15:00", minutes: 90 }) }), (e) => e.code === "conflict");
  assert.throws(() => t.life.transition(b, "confirmed", { session: session({ start: "16:30", minutes: 15 }) }), (e) => e.code === "conflict");
  t.life.transition(b, "confirmed", { session: session({ start: "17:30", minutes: 60 }) }); // touches, doesn't overlap
  t.life.transition(c, "confirmed", { session: session({ date: "2026-12-21", start: "16:00" }) });
  t.life.transition(a, "cancelled", { note: "Client rescheduled" });
  t.life.transition(d, "confirmed", { session: session({ start: "16:00", minutes: 90 }) }); // slot freed
  assert.equal(t.db.prepare("SELECT session_date FROM inquiries WHERE id = ?").get(a).session_date, null);
});

test("a failed confirm leaves the inquiry untouched and records no event", async () => {
  const t = await seeded(2);
  const [a, b] = t.ids;
  t.life.transition(a, "accepted");
  t.life.transition(b, "accepted");
  t.life.transition(a, "confirmed", { session: session() });
  const before = t.life.history(b).length;
  assert.throws(() => t.life.transition(b, "confirmed", { session: session() }));
  assert.equal(t.life.history(b).length, before);
  assert.equal(status(t, b), "accepted");
});

test("notes: sanitised, stored as events, empty notes refused", async () => {
  const t = await seeded();
  const [id] = t.ids;
  t.life.addNote(id, "Called\u0000 client\u0007; prefers evenings");
  assert.equal(t.life.history(id).at(-1).note, "Called client; prefers evenings");
  assert.throws(() => t.life.addNote(id, "   "), (e) => e.code === "empty_note");
});

test("delete removes the inquiry and its history; unknown ids error", async () => {
  const t = await seeded();
  const [id] = t.ids;
  t.life.transition(id, "accepted", { note: "x" });
  t.life.remove(id);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM inquiries").get().n, 0);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM inquiry_events").get().n, 0);
  assert.throws(() => t.life.remove(id), (e) => e.code === "not_found");
});

test("purge: explicit args required, dry-run by default, never touches accepted/confirmed", async () => {
  const t = await seeded(4);
  const [a, b, c, d] = t.ids;
  t.life.transition(a, "declined");
  t.life.transition(b, "spam");
  t.life.transition(c, "accepted");
  t.life.transition(d, "accepted");
  t.life.transition(d, "confirmed", { session: session() });
  assert.throws(() => t.life.purge({}), (e) => e.code === "bad_days");
  assert.throws(() => t.life.purge({ olderThanDays: 30, statuses: ["confirmed"] }), (e) => e.code === "bad_statuses");
  assert.throws(() => t.life.purge({ olderThanDays: 30, statuses: ["accepted"] }), (e) => e.code === "bad_statuses");
  // Everything is "recent" relative to the fake clock, so nothing matches yet.
  assert.equal(t.life.purge({ olderThanDays: 30, statuses: ["declined", "spam"] }).count, 0);
  t.db.prepare("UPDATE inquiries SET updated_at = '2020-01-01T00:00:00Z'").run();
  const dry = t.life.purge({ olderThanDays: 30, statuses: ["declined", "spam"] });
  assert.equal(dry.count, 2);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM inquiries").get().n, 4); // dry run deleted nothing
  assert.equal(t.life.purge({ olderThanDays: 30, statuses: ["declined", "spam"], dryRun: false }).count, 2);
  assert.deepEqual(t.db.prepare("SELECT status FROM inquiries ORDER BY status").all().map((r) => r.status), ["accepted", "confirmed"]);
});

test("migration 2 upgrades an existing v1 database without losing inquiries", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const Database = require("better-sqlite3");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mig-")), "old.db");
  // Build a v1-only database by hand, insert a row, then open with the current code.
  const raw = new Database(file);
  raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE inquiries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, session_type TEXT NOT NULL, preferred_date TEXT, location TEXT, message TEXT NOT NULL, discount_code TEXT, idempotency_key TEXT NOT NULL UNIQUE, source_origin TEXT, notify_status TEXT NOT NULL DEFAULT 'pending', notify_attempts INTEGER NOT NULL DEFAULT 0, notify_last_attempt_at TEXT, notify_last_error TEXT, notified_at TEXT);
    INSERT INTO schema_migrations VALUES (1, 'x');
    INSERT INTO inquiries (id, created_at, name, email, session_type, message, idempotency_key) VALUES ('OLD0000001', 't', 'Old', 'o@example.com', 'Cars', 'm', 'k0123456789abcdef');`);
  raw.close();
  const db = openDatabase(file);
  assert.equal(db.prepare("SELECT name FROM inquiries").get().name, "Old");
  assert.ok(db.prepare("PRAGMA table_info(inquiries)").all().some((c) => c.name === "session_date"));
  assert.equal(db.prepare("SELECT MAX(version) v FROM schema_migrations").get().v, 2);
  db.close();
});

test("CLI drives the lifecycle end-to-end against a real database file", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { execFileSync, spawnSync } = require("child_process");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "cli.db");
  const t = setup({ db: openDatabase(file) });
  const a = (await t.post(payload({ email: "a@example.com" }))).json().id;
  const b = (await t.post(payload({ email: "b@example.com" }))).json().id;
  await t.service.drain();
  t.db.close();
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, "..", "src", "cli.js"), ...args], { env: { ...process.env, DB_PATH: file }, encoding: "utf8" });
  assert.match(cli("accept", a).stdout, /is now accepted/);
  assert.match(cli("accept", b).stdout, /is now accepted/);
  assert.match(cli("confirm", a, "--date", "2026-12-20", "--start", "16:00", "--minutes", "90").stdout, /is now confirmed. Session 2026-12-20 16:00 for 90 min/);
  const clash = cli("confirm", b, "--date", "2026-12-20", "--start", "17:00", "--minutes", "60");
  assert.equal(clash.status, 2);
  assert.match(clash.stderr, /Overlaps confirmed session/);
  assert.match(cli("confirm", b).stderr, /Refused/);
  assert.match(cli("delete", b).stdout, /--yes/);
  assert.match(cli("purge", "--days", "30", "--status", "declined").stdout, /Dry run: 0/);
  assert.match(cli("list", "--status", "confirmed").stdout, new RegExp(a));
  assert.match(cli("cancel", a, "--note", "client moved").stdout, /is now cancelled/);
  assert.match(cli("show", a).stdout, /client moved/);
});
