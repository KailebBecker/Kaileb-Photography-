"use strict";
// Keeps server/deploy/ templates consistent with the code and with each other
// (nginx/systemd can't be run here; these are static checks).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadConfig, assertProductionReady } = require("../src/config");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const env = Object.fromEntries(
  read("deploy/env.example")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const unit = read("deploy/kaileb-inquiry.service");
const backupUnit = read("deploy/kaileb-inquiry-backup.service");
const nginx = read("deploy/nginx.conf.example");
const cliWrapper = read("deploy/kaileb-inquiries");
const unitValue = (text, key) => (text.match(new RegExp(`^${key}=(.*)$`, "m")) || [])[1];

test("env.example contains no secrets and starts in production as shipped", () => {
  assert.equal(env.RESEND_API_KEY, "");
  assert.equal(env.TURNSTILE_SECRET, "");
  assert.equal(env.NODE_ENV, "production");
  assert.doesNotThrow(() => assertProductionReady(loadConfig(env)));
});

test("every environment variable the code reads is documented, and nothing undocumented is templated", () => {
  const used = new Set();
  for (const f of fs.readdirSync(path.join(root, "src"))) {
    for (const m of read(`src/${f}`).matchAll(/\benv\.([A-Z][A-Z_]+)/g)) used.add(m[1]);
  }
  const readme = read("README.md");
  for (const name of used) assert.ok(readme.includes("`" + name + "`"), `${name} missing from README env table`);
  for (const name of Object.keys(env)) assert.ok(used.has(name), `${name} in env.example is not read by the code`);
});

test("systemd, nginx, env and CLI wrapper agree on user, paths and port", () => {
  for (const u of [unit, backupUnit]) {
    assert.equal(unitValue(u, "User"), "kaileb-inquiry");
    assert.equal(unitValue(u, "EnvironmentFile"), "/etc/kaileb-inquiry/env");
    assert.equal(unitValue(u, "WorkingDirectory"), "/opt/kaileb-inquiry/app/server");
    assert.ok(unitValue(u, "ReadWritePaths").split(" ").includes(path.posix.dirname(env.DB_PATH)));
  }
  assert.match(cliWrapper, /sudo -u kaileb-inquiry/);
  assert.ok(cliWrapper.includes(`DB_PATH=${env.DB_PATH}`));
  assert.ok(cliWrapper.includes(unitValue(unit, "WorkingDirectory")));
  assert.equal(env.HOST, "127.0.0.1");
  const upstreams = [...nginx.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1]);
  assert.ok(upstreams.length >= 1);
  for (const u of upstreams) assert.equal(u, `http://127.0.0.1:${env.PORT}`);
});

test("nginx exposes only the inquiry endpoint publicly and works on Ubuntu's nginx", () => {
  assert.doesNotMatch(nginx, /^\s*http2 on;/m); // needs nginx >= 1.25.1; Ubuntu ships 1.18/1.24
  assert.match(nginx, /location = \/api\/inquiries \{[^}]*limit_except POST OPTIONS/);
  assert.match(nginx, /location = \/health \{[^}]*allow 127\.0\.0\.1;[^}]*deny all;/);
  assert.match(nginx, /location \/ \{\s*return 404;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/); // overwrite, never append
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
  assert.match(nginx, /client_max_body_size 16k;/);
  assert.match(nginx, /server_name __API_HOSTNAME__;/);
});
