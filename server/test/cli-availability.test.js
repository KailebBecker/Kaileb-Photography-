"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { openDatabase } = require("../src/db");
const T = require("../src/availability/time");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const future = (days) => T.addDays(T.localDate(Date.now()), days);

function fixture(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-av-"));
  const dbFile = path.join(dir, "t.db");
  openDatabase(dbFile).close(); // create and migrate
  let n = 0;
  const addInquiry = (db, status = "accepted") => {
    const id = `C${String(++n).padStart(9, "0")}`;
    db.prepare("INSERT INTO inquiries (id, created_at, status, name, email, session_type, message, idempotency_key) VALUES (?, ?, ?, 'N', 'n@example.com', 'Cars', 'm', ?)").run(id, new Date().toISOString(), status, `key-${id}-padding-padding`);
    return id;
  };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, DB_PATH: dbFile, ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const seed = (fn) => { const d = openDatabase(dbFile); const v = fn(d, (status) => addInquiry(d, status)); d.close(); return v; };
  return { cli, seed, dbFile };
}

test("block add / list / remove, with a private label and optional hours", () => {
  const f = fixture();
  const day = future(30);
  assert.match(f.cli("block", "add", "--date", day, "--label", "Family trip").out, /Added block #1/);
  assert.match(f.cli("block", "add", "--from", future(40), "--to", future(42), "--start", "09:00", "--end", "12:00").out, /Added block #2/);
  assert.match(f.cli("block", "add", "--dates", `${future(50)},${future(51)}`).out, /#3, #4/);
  const list = f.cli("block", "list").out;
  assert.match(list, new RegExp(`#1  ${day}  all day  "Family trip"`));
  assert.match(list, /09:00-12:00/);
  assert.match(f.cli("availability", "check", day).out, /unavailable\s+\(blocked\)/);
  assert.match(f.cli("block", "remove", "1").out, /Removed block #1/);
  assert.doesNotMatch(f.cli("block", "list").out, /Family trip/);
  assert.equal(f.cli("block", "remove", "99").code, 2);
});

test("bad block input is refused with a clear message and changes nothing", () => {
  const f = fixture();
  for (const args of [["block", "add"], ["block", "add", "--date", "2026-02-30"], ["block", "add", "--from", future(5), "--to", future(2)], ["block", "add", "--date", future(5), "--start", "10:00"], ["block", "add", "--date", future(5), "--start", "12:00", "--end", "10:00"]]) {
    const r = f.cli(...args);
    assert.notEqual(r.code, 0, args.join(" "));
    assert.match(r.out + r.err, /Refused|Use --date/);
  }
  assert.match(f.cli("block", "list").out, /No blocks/);
});

test("rules and settings can be shown, changed and reset", () => {
  const f = fixture();
  assert.match(f.cli("rules", "show").out, /sat: 00:00-24:00/);
  assert.match(f.cli("rules", "set", "mon-fri", "18:00-21:00,22:00-23:00").out, /mon: 18:00-21:00, 22:00-23:00/);
  assert.match(f.cli("rules", "set", "sun", "closed").out, /sun: closed/);
  assert.notEqual(f.cli("rules", "set", "funday", "09:00-10:00").code, 0);
  assert.notEqual(f.cli("rules", "set", "mon", "10:00-09:00").code, 0);
  assert.match(f.cli("rules", "reset").out, /mon: 17:30-24:00/);
  assert.match(f.cli("setting", "set", "buffer_minutes", "30").out, /buffer_minutes = 30/);
  assert.match(f.cli("setting", "show").out, /buffer_minutes = 30/);
  assert.notEqual(f.cli("setting", "set", "buffer_minutes", "-5").code, 0);
  assert.notEqual(f.cli("setting", "set", "colour", "1").code, 0);
});

test("confirm refuses a time inside a manual block and accepts it once the block is removed", () => {
  const f = fixture();
  const day = future(30);
  const id = f.seed((d, add) => add());
  f.cli("block", "add", "--date", day, "--start", "10:00", "--end", "12:00", "--label", "Dentist");
  const refused = f.cli("confirm", id, "--date", day, "--start", "11:00", "--minutes", "60");
  assert.equal(refused.code, 2);
  assert.match(refused.err, /overlaps availability block #1/);
  assert.doesNotMatch(refused.err, /Dentist/); // not echoed back needlessly
  assert.equal(f.cli("confirm", id, "--date", day, "--start", "11:00", "--minutes", "60", "--ignore-calendar").code, 2); // no override for blocks
  f.cli("block", "remove", "1");
  assert.match(f.cli("confirm", id, "--date", day, "--start", "11:00", "--minutes", "60").out, /is now confirmed/);
});

test("with the Google calendar enabled but unverified, confirming is refused until the owner overrides explicitly", () => {
  const f = fixture({ CALENDAR_PROVIDER: "google" });
  const id = f.seed((d, add) => add());
  const day = future(30);
  const status = f.cli("calendar", "status").out;
  assert.match(status, /NOT VERIFIED \(never_synced\)/);
  assert.match(status, /every date as unavailable/);
  assert.match(f.cli("availability", "check", day).out, /unavailable\s+\(unverified, calendar NOT verified\)/);
  const refused = f.cli("confirm", id, "--date", day, "--start", "15:00", "--minutes", "60");
  assert.equal(refused.code, 2);
  assert.match(refused.err, /Can't verify your Google Calendar/);
  assert.match(f.cli("confirm", id, "--date", day, "--start", "15:00", "--minutes", "60", "--ignore-calendar").out, /is now confirmed/);
  assert.match(f.cli("show", id).out, /--ignore-calendar/); // the override is in the audit history
});

test("calendar status with no calendar, and clearing the cache", () => {
  const f = fixture();
  assert.match(f.cli("calendar", "status").out, /External calendar: OFF/);
  f.seed((d) => {
    d.prepare("INSERT INTO busy_cache VALUES (1, 2)").run();
    d.prepare("INSERT INTO availability_state (id, last_success_at, failures) VALUES (1, 'x', 0)").run();
  });
  assert.match(f.cli("calendar", "clear").out, /Re-run with --yes/);
  assert.match(f.cli("calendar", "clear", "--yes").out, /Cleared/);
  f.seed((d) => assert.equal(d.prepare("SELECT COUNT(*) n FROM busy_cache").get().n + d.prepare("SELECT COUNT(*) n FROM availability_state").get().n, 0));
});

test("read-only commands never write, and an un-upgraded database gets a helpful message", () => {
  const f = fixture();
  const before = fs.statSync(f.dbFile).mtimeMs;
  f.cli("block", "list");
  f.cli("availability", "month", future(10).slice(0, 7));
  f.cli("rules", "show");
  f.cli("calendar", "status");
  assert.equal(fs.statSync(f.dbFile).mtimeMs, before);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-old-"));
  const Database = require("better-sqlite3");
  const old = new Database(path.join(dir, "old.db"));
  old.exec("CREATE TABLE inquiries (id TEXT)");
  old.close();
  const r = spawnSync(process.execPath, [CLI, "block", "list"], { encoding: "utf8", env: { PATH: process.env.PATH, DB_PATH: path.join(dir, "old.db") } });
  assert.match(r.stderr, /restart the service/);
});

test("the CLI follows the calendar mode the running service recorded, even without the service's environment", () => {
  const f = fixture(); // CLI environment has NO calendar settings, like the real wrapper
  const id = f.seed((d, add) => {
    require("../src/availability/engine").createAvailability({ db: d, config: require("../src/config").loadConfig({ CALENDAR_PROVIDER: "google" }) }).recordConfiguration();
    return add();
  });
  assert.match(f.cli("calendar", "status").out, /NOT VERIFIED \(never_synced\)/);
  const refused = f.cli("confirm", id, "--date", future(30), "--start", "15:00", "--minutes", "60");
  assert.equal(refused.code, 2);
  assert.match(refused.err, /Can't verify your Google Calendar/);
  // And when the service later records "none", the CLI stops requiring it.
  f.seed((d) => require("../src/availability/engine").createAvailability({ db: d, config: require("../src/config").loadConfig({}) }).recordConfiguration());
  assert.match(f.cli("confirm", id, "--date", future(30), "--start", "15:00", "--minutes", "60").out, /is now confirmed/);
});
