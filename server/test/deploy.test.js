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

test("nginx template enforces method, content-type, size, rate and exposure limits", () => {
  const publicBlock = nginx.slice(nginx.indexOf("listen 443"));
  assert.match(nginx, /limit_req_zone\s+\$binary_remote_addr zone=kaileb_inquiry_req/);
  assert.match(publicBlock, /limit_req\s+zone=kaileb_inquiry_req burst=\d+ nodelay;/);
  assert.match(publicBlock, /limit_req_status 429;/);
  assert.match(publicBlock, /limit_conn\s+kaileb_inquiry_conn \d+;/);
  assert.match(nginx, /map "\$request_method:\$content_type" \$kaileb_bad_content_type/);
  assert.match(publicBlock, /if \(\$kaileb_bad_content_type\) \{ return 415; \}/);
  assert.match(publicBlock, /client_max_body_size 16k;/);
  for (const t of ["client_header_timeout", "client_body_timeout", "send_timeout", "proxy_read_timeout", "proxy_connect_timeout"]) assert.match(publicBlock, new RegExp(`${t} \\d+s;`));
  for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "Content-Security-Policy", "X-Robots-Tag"]) assert.match(publicBlock, new RegExp(`add_header ${h} `));
  assert.match(nginx, /server_tokens off;/);
  assert.match(publicBlock, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.match(publicBlock, /location ~ \/\\\. \{\s*return 404;/); // dotfiles
  // Nothing in this site can serve files from disk, and the port-80 redirect ignores the client's Host header.
  assert.doesNotMatch(publicBlock, /^\s*(root|alias|autoindex|try_files|index)\b/m);
  assert.match(nginx, /return 301 https:\/\/__API_HOSTNAME__\$request_uri;/);
  assert.doesNotMatch(nginx, /return 301 https:\/\/\$host/);
  // add_header inside a location would silently drop the server-level security headers there.
  const locations = publicBlock.slice(publicBlock.indexOf("location"));
  assert.doesNotMatch(locations, /add_header/);
  // Only the inquiry endpoint is proxied publicly; /health is loopback-only.
  assert.match(publicBlock, /location = \/health \{\s*allow 127\.0\.0\.1;\s*allow ::1;\s*deny all;/);
  assert.equal((publicBlock.match(/proxy_pass/g) || []).length, 2);
});

test(".gitignore keeps secrets, certificates and databases out of Git", () => {
  const ignore = fs.readFileSync(path.join(root, "..", ".gitignore"), "utf8").split(/\r?\n/);
  for (const pattern of [".env", ".env.*", "*.pem", "*.key", "*.db", "*.db-wal", "*.db-shm", "*.sqlite3", "server/data/", "server/backups/"]) assert.ok(ignore.includes(pattern), pattern);
});

test("no secrets, keys, databases or env files are tracked in Git", (t) => {
  const git = (...args) => require("child_process").spawnSync("git", args, { cwd: path.join(root, ".."), encoding: "utf8" });
  const listing = git("ls-files");
  if (listing.status !== 0) return t.skip("git not available");
  const files = listing.stdout.split("\n").filter(Boolean);
  assert.deepEqual(files.filter((f) => /(^|\/)\.env|\.(pem|key|p12|pfx|db|db-wal|db-shm|sqlite3?)$|id_(rsa|ed25519)|\.htpasswd/i.test(f)), []);
  // Well-known credential formats (Resend, AWS, Turnstile secrets, private keys, GitHub/Stripe/Slack tokens).
  const patterns = /re_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|0x4[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[bpa]-[A-Za-z0-9-]{10,}/;
  for (const f of files.filter((n) => /\.(js|json|md|html|css|yml|yaml|txt|service|timer|example|conf|svg)$|^[^.]+$/.test(n) && !/package-lock\.json$|^images\/|^fonts\//.test(n))) {
    const text = fs.readFileSync(path.join(root, "..", f), "utf8");
    assert.doesNotMatch(text, patterns, `${f} looks like it contains a credential`);
  }
});
