"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { setup, payload } = require("./helpers");
const { openDatabase } = require("../src/db");

test("backup produces a consistent copy that restores and contains the inquiries (restore drill)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  const file = path.join(dir, "live.db");
  const t = setup({ db: openDatabase(file) });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await t.post(payload({ email: `bk${i}@example.com` }))).json().id);
  await t.service.drain();
  // Backup while the live DB is still open (as it would be in production).
  const run = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "backup.js")], { env: { ...process.env, DB_PATH: file, BACKUP_DIR: path.join(dir, "bk") }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /verified.*\(3 inquiries\)/);
  const [copy, ...stray] = fs.readdirSync(path.join(dir, "bk"));
  assert.deepEqual(stray, [], "backup must be a single self-contained file");
  const check = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "backup.js"), "--verify", path.join(dir, "bk", copy)], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /integrity ok, 3 inquiries/);
  fs.writeFileSync(path.join(dir, "junk.db"), "not a database");
  assert.notEqual(spawnSync(process.execPath, [path.join(__dirname, "..", "src", "backup.js"), "--verify", path.join(dir, "junk.db")]).status, 0);
  t.db.close();
  // "Restore": open the backup as a database and check the data.
  const restored = openDatabase(path.join(dir, "bk", copy));
  assert.deepEqual(restored.prepare("SELECT id FROM inquiries ORDER BY id").all().map((r) => r.id), [...ids].sort());
  assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  restored.close();
});
