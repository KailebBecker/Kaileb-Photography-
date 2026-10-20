# Inquiry API — deployment and operations guide

This is the only document the server administrator needs. It covers installing, verifying, backing up
and updating the inquiry API for Kaileb Becker Photography. (Development notes are at the very end and
are not needed for deployment.)

**What it is:** a small Node.js service (Fastify + SQLite via better-sqlite3) that receives the website's
contact form, validates it, stores it durably, and emails the owner through Resend. One process, one
SQLite file, no other infrastructure. The website itself is static and hosted elsewhere (GitHub Pages
for staging); this server only hosts the API.

**Status: what has and has not been proven.** *Verified locally* (automated tests plus a local run of
nginx in front of the real app): input validation and hostile-input handling, rate limits, CORS,
Turnstile logic (against a fake Cloudflare), duplicate/retry protection, SQLite storage, backup/restore,
and the behaviour of the nginx template (syntax-checked with nginx 1.26 and exercised in front of the
real application). *Only provable after deployment, and not yet done:* the real chain GitHub Pages →
HTTPS with a real certificate → nginx on this server → Fastify → SQLite → Resend → the owner's inbox,
the real Turnstile service, and this server's firewall and file permissions. Sections 6 and 6b are that
verification. Do not treat the contact form as production-ready until they pass.

```text
Browser (GitHub Pages / production site)
   | HTTPS  POST /api/inquiries
   v
nginx :443  (TLS, only /api/inquiries is public)
   | http://127.0.0.1:8787  (loopback only)
   v
Node.js / Fastify  (systemd service, user kaileb-inquiry)
   |
   v
SQLite  /var/lib/kaileb-inquiry/inquiries.db   --daily-->  /var/backups/kaileb-inquiry/  --(admin)--> off-server copy
```

Placeholders used below — replace them, nothing else is server-specific:

| Placeholder | Meaning |
|---|---|
| `API_HOST` | the API hostname, e.g. `api.<domain>` (not decided yet; set it once with `export API_HOST=...` in your shell) |
| `<RELEASE_COMMIT>` | the Git commit to deploy (default: latest `main`) |
| `<OWNER_EMAIL>` | where inquiry notifications go (Kaileb provides) |

---

## 1. Requirements and network boundary

- Ubuntu 22.04 or 24.04, sudo access, nginx (Ubuntu package), certbot.
- **Node.js 22 or newer** (24 LTS recommended), installed system-wide at `/usr/bin/node`. Node 20 is
  not supported (the SQLite driver requires 22+).
- A static public IP (Elastic IP on EC2) and a DNS name pointing at it, for HTTPS.

| Direction | Port | Who | Why |
|---|---|---|---|
| Inbound | 443/tcp | Internet | the API (HTTPS) |
| Inbound | 80/tcp | Internet | redirect to HTTPS + Let's Encrypt HTTP-01 issue/renewal |
| Inbound | 22/tcp | administrator's choice | SSH policy is the administrator's responsibility |
| Inbound | **8787** | **nobody** | the app binds `127.0.0.1` only; do not open it in the security group/firewall |
| Outbound | 443/tcp | server | `api.resend.com` (email), `challenges.cloudflare.com` (only if Turnstile is enabled), npm registry + GitHub (installs/updates), Let's Encrypt |

SQLite is a file, never a network service. Nothing listens for it.
If you use ufw: `sudo ufw allow 'Nginx Full'` (80+443) plus your SSH rule; do not add 8787.

nginx must be the first thing the internet reaches (no load balancer or CDN in front). Rate limiting and
logs use the connecting address. If an AWS load balancer or CloudFront is ever added, tell the developer
first: the nginx template then needs the real-IP module configured, otherwise every visitor looks like the
load balancer and they all share one rate limit.

## 2. Filesystem layout

| Path | Owner : group | Mode | Contents |
|---|---|---|---|
| `/opt/kaileb-inquiry/app/` | root : root | 0755 | Git checkout of the repository; the service runs `server/` from here. Replaced by updates. The service user cannot write here. |
| `/etc/kaileb-inquiry/env` | root : root | 0600 (dir 0700) | configuration + secrets. Server only, never in Git. systemd reads it as root. |
| `/var/lib/kaileb-inquiry/` | kaileb-inquiry : kaileb-inquiry | 0700 | `inquiries.db` (+ `-wal`, `-shm`). The live database: the only path the service can write. |
| `/var/backups/kaileb-inquiry/` | kaileb-inquiry : kaileb-inquiry | 0700 | verified daily backups (newest 30 kept). Contains personal data. |
| `/etc/systemd/system/kaileb-inquiry*.{service,timer}` | root | 0644 | service + backup units (from `server/deploy/`) |
| `/etc/nginx/sites-available/kaileb-inquiry` | root | 0644 | nginx site (from `server/deploy/nginx.conf.example`) |
| `/usr/local/bin/kaileb-inquiries` | root | 0755 | owner CLI wrapper (from `server/deploy/kaileb-inquiries`) |
| logs | journald | — | `journalctl -u kaileb-inquiry`, `journalctl -u kaileb-inquiry-backup` |

The service runs as the dedicated system user `kaileb-inquiry` (no shell, no home, no login), never root.
Code, configuration, data and backups are in separate trees, so `git` and `npm` can never overwrite or
delete the database, the secrets or the backups.

## 3. Install

Run as an admin user with sudo. Each step is idempotent unless noted.

```bash
# 1. Prepare Ubuntu
sudo apt-get update && sudo apt-get install -y git curl ca-certificates

# 2. Node.js 24 LTS (skip if `node -v` already prints v22 or newer at /usr/bin/node)
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh && sudo apt-get install -y nodejs
node -v && which node            # expect v22+ (v24 recommended) and /usr/bin/node

# 3. nginx + certbot (skip what is already installed)
sudo apt-get install -y nginx certbot python3-certbot-nginx

# 4. Service user (no login, no home)
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin kaileb-inquiry

# 5. Directories
sudo install -d -o root -g root -m 0755 /opt/kaileb-inquiry
sudo install -d -o root -g root -m 0700 /etc/kaileb-inquiry
sudo install -d -o kaileb-inquiry -g kaileb-inquiry -m 0700 /var/lib/kaileb-inquiry
sudo install -d -o kaileb-inquiry -g kaileb-inquiry -m 0700 /var/backups/kaileb-inquiry

# 6. Application code (public repository; no credentials needed)
sudo git clone https://github.com/KailebBecker/Kaileb-Photography-.git /opt/kaileb-inquiry/app
sudo git -C /opt/kaileb-inquiry/app checkout --detach <RELEASE_COMMIT>   # or skip to stay on main

# 7. Production dependencies (exact versions from the lockfile)
cd /opt/kaileb-inquiry/app/server
sudo npm ci --omit=dev
node -e "require('better-sqlite3'); console.log('sqlite driver ok')"
#   If the driver had to compile and failed: sudo apt-get install -y build-essential python3, then repeat npm ci.

# 8. Server-only configuration (see section 4 for every variable)
sudo install -o root -g root -m 0600 deploy/env.example /etc/kaileb-inquiry/env
sudo nano /etc/kaileb-inquiry/env      # keep NOTIFY_PROVIDER=none until the Resend key exists (section 5)

# 9. systemd units + owner CLI
sudo install -m 0644 deploy/kaileb-inquiry.service deploy/kaileb-inquiry-backup.service deploy/kaileb-inquiry-backup.timer /etc/systemd/system/
sudo install -m 0755 deploy/kaileb-inquiries /usr/local/bin/
sudo systemctl daemon-reload
sudo systemctl enable --now kaileb-inquiry          # starts now and after every reboot
sudo systemctl enable --now kaileb-inquiry-backup.timer

# 10. Database: created and migrated automatically on first start. Verify:
systemctl is-active kaileb-inquiry                   # active
curl -s http://127.0.0.1:8787/health; echo           # {"ok":true,"notifyBacklog":0}
kaileb-inquiries list                                # No inquiries.
sudo ls -l /var/lib/kaileb-inquiry                   # inquiries.db owned by kaileb-inquiry, -rw-------
#   If it is not active: sudo journalctl -u kaileb-inquiry -n 30 --no-pager
#   ("Unsafe production config: ..." names the variable to fix in /etc/kaileb-inquiry/env).
```

**11. DNS and TLS (once the hostname is decided).** Create a DNS `A` record (and `AAAA` if the server has
IPv6) for `API_HOST` pointing at the server's static IP. When it resolves:

```bash
export API_HOST=api.example.com        # the real hostname
# Certificate (certbot's nginx plugin answers the challenge on port 80 temporarily; nothing else changes):
sudo certbot certonly --nginx -d "$API_HOST" --deploy-hook "systemctl reload nginx"
#   Alternative if you already use a different ACME flow: any method is fine as long as the
#   certificate ends up at /etc/letsencrypt/live/$API_HOST/{fullchain,privkey}.pem.
#   If certbot says it cannot find a server block for $API_HOST: install only the first server{} (port 80)
#   block of the template, `sudo nginx -t && sudo systemctl reload nginx`, then run
#   `sudo certbot certonly --webroot -w /var/www/html -d "$API_HOST"`, then install the full file below.

# nginx site
cd /opt/kaileb-inquiry/app/server
sed "s/__API_HOSTNAME__/$API_HOST/g" deploy/nginx.conf.example | sudo tee /etc/nginx/sites-available/kaileb-inquiry >/dev/null
sudo ln -sf /etc/nginx/sites-available/kaileb-inquiry /etc/nginx/sites-enabled/kaileb-inquiry
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run           # renewal works (Ubuntu's certbot timer renews automatically)
```

The nginx site exposes only `POST`/`OPTIONS /api/inquiries`: other methods get 403, non-JSON bodies 415,
bodies over 16 KB 413, and more than about 60 requests a minute from one address 429 (a coarse flood guard;
the app applies the precise limit of 5 submissions per address per 10 minutes). `/health` answers only
requests from the server itself; everything else, dotfiles included, is 404; there is no document root, so
no file can be served. HTTP redirects to the configured HTTPS name. No nginx version is disclosed.

**12. Firewall / security group:** as in section 1 (443 + 80 public, 8787 closed, SSH per your policy).

**13. Backups:** already scheduled by step 9. Arrange the off-server copy (section 7).

Then run the **post-deployment verification** (sections 6 and 6b).

## 4. Environment variables

All configuration lives in `/etc/kaileb-inquiry/env` (template: `deploy/env.example`). Changes take effect
after `sudo systemctl restart kaileb-inquiry`. In production the service **refuses to start** on unsafe
values and logs why.

| Variable | Required | Production value / notes |
|---|---|---|
| `NODE_ENV` | yes | `production` (turns on the start-up safety checks) |
| `HOST` | yes | `127.0.0.1`. Production refuses to start with any non-loopback address |
| `PORT` | yes | `8787` (must match `proxy_pass` in the nginx site) |
| `DB_PATH` | yes | `/var/lib/kaileb-inquiry/inquiries.db`. Must be an absolute path outside the code checkout (production refuses otherwise) |
| `ALLOWED_ORIGINS` | yes | comma-separated exact origins, `https://` + host only, no path/wildcard. Staging: `https://kailebbecker.github.io` |
| `TRUST_PROXY` | yes | `true`. nginx on this server passes the client IP; the app trusts that header only from 127.0.0.1/::1 |
| `NOTIFY_PROVIDER` | yes | `none` until the Resend key exists, then `resend` |
| `RESEND_API_KEY` | with `resend` | secret, server only |
| `NOTIFY_TO` | with `resend` | `<OWNER_EMAIL>` |
| `NOTIFY_FROM` | with `resend` | `Kaileb Photography <onboarding@resend.dev>` until a domain is verified in Resend |
| `TURNSTILE_SECRET` | optional | empty = bot check off (section 5) |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | optional | default 5 submissions per IP per 10 minutes |
| `PER_EMAIL_DAILY_CAP` | optional | default 5 inquiries per email address per day |
| `BACKUP_DIR` | backup only | set inside `kaileb-inquiry-backup.service`, not in the env file |

`NOTIFY_PROVIDER=dev` and `DEV_MAIL_FILE` are for local development only; production refuses `dev`.

## 5. Email (Resend), bot check (Turnstile), allowed origins

**Resend (owner notifications).** Kaileb creates the Resend account and API key. Then on the server:

1. In `/etc/kaileb-inquiry/env`: `NOTIFY_PROVIDER=resend`, `RESEND_API_KEY=<key>`, `NOTIFY_TO=<OWNER_EMAIL>`,
   `NOTIFY_FROM=Kaileb Photography <onboarding@resend.dev>`.
   With the `onboarding@resend.dev` test sender, Resend only delivers to the **email address of the Resend
   account itself**, so `NOTIFY_TO` must be that address. Sending to anything else, or from a custom
   address, requires verifying a domain in Resend (DNS records; a later step, not needed for owner
   notifications).
2. `sudo systemctl restart kaileb-inquiry` and check `journalctl -u kaileb-inquiry -n 20` (no "Unsafe
   production config").
3. Verify with a test inquiry (section 6, steps 6 and 9). Emails are plain text, `Reply-To` = the client.

If an email fails (Resend down, bad key), the inquiry is **still stored**; sending is retried with
backoff up to 10 times over about 4 hours. `kaileb-inquiries list` and `/health` (`notifyBacklog`) show
unsent ones; `kaileb-inquiries show <id>` shows the error code. Inquiries that arrive while
`NOTIFY_PROVIDER=none` are never emailed later — check them with `kaileb-inquiries list`.

**Turnstile bot check (optional; recommended before real traffic).** The code is finished; enabling it is
configuration only. It needs a free Cloudflare account (no Cloudflare hosting, DNS or proxying involved):

1. *Owner:* Cloudflare dashboard > Turnstile > Add widget. Mode: Managed. Hostnames: the **website**
   hostnames only (`kailebbecker.github.io`, later the production site and its `www.`), not the API host.
   This gives a public **site key** and a private **secret key**. Never commit or paste the secret.
2. *Website first:* GitHub repo > Settings > Secrets and variables > Actions > Variables >
   `TURNSTILE_SITE_KEY=<site key>`, then re-run the "Deploy staging to GitHub Pages" workflow. The
   contact form now shows the verification box and refuses to send without a token.
3. *Server:* `TURNSTILE_SECRET=<secret key>` in `/etc/kaileb-inquiry/env`, `sudo systemctl restart kaileb-inquiry`.
   The "bot check is OFF" start-up warning disappears.
4. Verify with section 6b, check 12.

How it behaves: the server verifies every token itself with Cloudflare (tokens are single-use and expire
after a few minutes; the website asks for a fresh one after every attempt), requires the token's hostname to
be one of the `ALLOWED_ORIGINS` hostnames, never trusts the browser's claim, and fails closed: if Cloudflare
is unreachable the API returns 503 and stores nothing (the visitor sees "couldn't confirm" and the contact
details). Enabling the secret before the site key is live rejects every submission. Cloudflare's "always
passes" dummy keys report the hostname `example.com` [verify], which this server rejects by design; use a
real (free) widget for testing. Troubleshooting is in the journal (error codes only, never tokens or the
secret): `invalid-input-secret` = wrong `TURNSTILE_SECRET`; "hostname that is not in ALLOWED_ORIGINS" = the
widget's hostnames and `ALLOWED_ORIGINS` disagree.

**Allowed origins (CORS).** Only browsers on listed origins can submit; others get 403. An origin is
scheme + host, so GitHub Pages staging is `https://kailebbecker.github.io` (this allows any Pages site
under that GitHub account, which is the narrowest GitHub Pages allows). When the production website
exists, append it: `ALLOWED_ORIGINS=https://kailebbecker.github.io,https://<site>,https://www.<site>`,
restart. Remove the staging origin once staging should no longer submit real inquiries.

**Point the website at the API** (Kaileb, in GitHub): repo variable `INQUIRY_API_URL=https://API_HOST/api/inquiries`,
then re-run the Pages workflow. Until then, the staging form truthfully says online submission isn't available.

## 6. Post-deployment verification

Run in order; stop at the first failure. Steps 6–8 make 3 API submissions and the staging test 1 more —
the per-IP limit is 5 per 10 minutes, so a 429 after that is expected, not a fault.

```bash
export API_HOST=api.example.com
API=https://$API_HOST/api/inquiries
ORIGIN=https://kailebbecker.github.io

# 1. Service running and enabled
systemctl is-active kaileb-inquiry && systemctl is-enabled kaileb-inquiry          # active / enabled

# 2. Local health (app + database)
curl -s http://127.0.0.1:8787/health; echo                                           # {"ok":true,"notifyBacklog":0}

# 3. HTTPS through nginx (on the server), and the public boundary (from any other machine)
curl -s --resolve "$API_HOST:443:127.0.0.1" "https://$API_HOST/health"; echo        # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' "https://$API_HOST/health"                 # from outside: 403
curl -s -o /dev/null -w '%{http_code}\n' "https://$API_HOST/"                       # 404
curl -s -o /dev/null -w '%{http_code}\n' "http://$API_HOST/api/inquiries"           # 301
nc -zv -w 3 "$API_HOST" 8787                                                         # from outside: must fail/time out

# 4. CORS: staging allowed, others refused
curl -s -i -X OPTIONS "$API" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' | grep -i '^access-control-allow-origin'
#    -> access-control-allow-origin: https://kailebbecker.github.io
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{}'
#    -> 403

# 5. Invalid inquiry rejected (counts toward the rate limit)
curl -s -X POST "$API" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"name":""}'; echo
#    -> {"ok":false,"error":"validation","fields":{...}}

# 6. Valid test inquiry accepted
KEY=deploycheck$(date +%s)xyz
BODY='{"name":"Deploy Check","email":"<OWNER_EMAIL>","sessionType":"Portraits","message":"Deployment test, please ignore.","idempotencyKey":"'$KEY'","website":""}'
curl -s -w ' %{http_code}\n' -X POST "$API" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$BODY"
#    -> {"ok":true,"id":"<ID>","duplicate":false} 201

# 7. Stored in SQLite
kaileb-inquiries show <ID>

# 8. Retry protection: same key again returns the same id, nothing new stored
curl -s -w ' %{http_code}\n' -X POST "$API" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "$BODY"
#    -> {"ok":true,"id":"<ID>","duplicate":true} 200
kaileb-inquiries list                                # exactly one "Deploy Check"
```

9. **Notification:** with `NOTIFY_PROVIDER=resend`, an email "New inquiry: Portraits — Deploy Check"
   arrives at `<OWNER_EMAIL>` within a minute; `kaileb-inquiries list` shows it as sent and `/health` shows
   `"notifyBacklog":0`. (With `none`, the list reports it as not emailed — expected.)
10. **Real browser flow:** once `INQUIRY_API_URL` is set and staging redeployed, submit the form at
    https://kailebbecker.github.io/Kaileb-Photography-/contact.html → success panel with a reference id →
    `kaileb-inquiries show <that id>` → notification email.
11. **Logs hold no inquiry content or secrets:**
    ```bash
    sudo journalctl -u kaileb-inquiry --since today --no-pager | grep -c -i -e 'Deploy Check' -e 'please ignore' -e '<OWNER_EMAIL>' -e 're_'
    # -> 0   (logs contain method, URL, status and client IP only; never bodies or keys)
    ```
12. **Survives restart:** `sudo systemctl restart kaileb-inquiry`, repeat step 2, `kaileb-inquiries show <ID>`
    still works. (Optional: `sudo reboot`, then steps 1–3.)
13. **Backup works and verifies:**
    ```bash
    sudo systemctl start kaileb-inquiry-backup.service
    sudo journalctl -u kaileb-inquiry-backup -n 5 --no-pager      # "backup written and verified: ... (N inquiries)"
    systemctl list-timers kaileb-inquiry-backup.timer             # next daily run listed
    ```
14. **Clean up test data:** `kaileb-inquiries delete <ID> --yes` (and the staging test inquiry).

## 6b. Security verification

Run once after deployment and again after any nginx or environment change. Anything that does not match
the "expect" comment is a defect: stop, fix it, and tell the developer. Run the *from outside* lines from
a machine that is not the server (for example a laptop) and not the owner's usual network.

```bash
export API_HOST=api.example.com   # the real hostname
API=https://$API_HOST/api/inquiries
ORIGIN=https://kailebbecker.github.io

# 1. Only the intended ports are public (from outside; 8787 must be closed, 22 per your own policy)
for p in 80 443 8787 3000 5432 3306; do nc -z -w 3 "$API_HOST" $p && echo "OPEN $p" || echo "closed $p"; done
#    expect: OPEN 80, OPEN 443, everything else closed (22 optional)
sudo ss -tlnp | grep -E ':(8787|80|443)\b'
#    expect: Node on 127.0.0.1:8787 only (never 0.0.0.0 or *), nginx on 80 and 443

# 2. HTTPS certificate valid; old TLS refused; HTTP redirects to the HTTPS name
echo | openssl s_client -connect "$API_HOST:443" -servername "$API_HOST" 2>/dev/null | openssl x509 -noout -subject -issuer -dates
#    expect: subject matches the hostname, notAfter in the future
curl -sS -o /dev/null -w '%{http_code}\n' "https://$API_HOST/"                     # expect 404 and no certificate error
curl -sS --tls-max 1.1 -o /dev/null "https://$API_HOST/" ; echo "exit=$?"           # expect an error (exit != 0)
curl -sI "http://$API_HOST/api/inquiries" | grep -i -E '^(HTTP|location)'           # expect 301 and Location: https://$API_HOST/api/inquiries
curl -sI "https://$API_HOST/" | grep -i '^server:'                                  # expect "nginx" with NO version number

# 3. nginx configuration passes (on the server)
sudo nginx -t                                                                       # expect "syntax is ok" and "test is successful"

# 4. The service runs as the restricted user, not root
ps -o user=,pid=,args= -C node                                                      # expect user kaileb-inquiry
systemctl show kaileb-inquiry -p User -p NoNewPrivileges -p ProtectSystem           # expect User=kaileb-inquiry NoNewPrivileges=yes ProtectSystem=strict

# 5. Environment file and directories (on the server)
sudo stat -c '%U:%G %a %n' /etc/kaileb-inquiry /etc/kaileb-inquiry/env             # expect root:root 700 / root:root 600
sudo -u kaileb-inquiry cat /etc/kaileb-inquiry/env                                  # expect "Permission denied" (systemd reads it, the app user cannot)
sudo find /opt/kaileb-inquiry -name '.env*' -o -name '*.db*'                        # expect no output: no secrets or databases inside the code checkout
sudo -u kaileb-inquiry touch /opt/kaileb-inquiry/app/server/x                       # expect "Permission denied" (the service cannot modify its own code)

# 6. Database and backup permissions (on the server)
sudo stat -c '%U:%G %a %n' /var/lib/kaileb-inquiry /var/lib/kaileb-inquiry/inquiries.db* /var/backups/kaileb-inquiry /var/backups/kaileb-inquiry/*.db
#    expect: owner kaileb-inquiry; directories 700; files 600 (-wal and -shm appear while the service runs)
sudo -u nobody ls /var/lib/kaileb-inquiry /var/backups/kaileb-inquiry               # expect "Permission denied" for both

# 7. Health endpoint is not public (from outside), but works from the server
curl -s -o /dev/null -w '%{http_code}\n' "https://$API_HOST/health"                # expect 403
curl -s --resolve "$API_HOST:443:127.0.0.1" "https://$API_HOST/health"; echo        # on the server: expect {"ok":true,"notifyBacklog":0}
curl -s -m 5 -o /dev/null -w '%{http_code}\n' "http://$API_HOST:8787/health"        # from outside: expect 000 (no connection)

# 8. No sensitive file or internal route is retrievable (expect 404 for every line, never 200)
for p in / /.env /.git/config /inquiries.db /inquiries.db-wal /data/inquiries.db /backups/ /etc/kaileb-inquiry/env /server/src/index.js /package.json /api/ /admin; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://$API_HOST$p")" "$p"; done

# 9. Method, content-type and size limits (nginx)
curl -s -o /dev/null -w '%{http_code}\n' "$API"                                                          # GET: expect 403
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$API" -H 'Content-Type: application/json' -d '{}'       # expect 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API" -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d '{}'   # expect 415
head -c 20000 /dev/zero | tr '\0' x | curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API" -H 'Content-Type: application/json' --data-binary @-   # expect 413

# 10. CORS: only the configured website may call the API from a browser
curl -s -i -X OPTIONS "$API" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin'
#    expect: access-control-allow-origin: https://kailebbecker.github.io   (exactly that value, never *)
for o in https://evil.example null http://kailebbecker.github.io; do
  curl -s -o /dev/null -w "$o -> %{http_code}\n" -X POST "$API" -H "Origin: $o" -H 'Content-Type: application/json' -d '{}'; done   # expect 403 for each

# 11. Rate limiting (these requests are invalid, so nothing is stored). Expect 400 five times, then 429.
for i in 1 2 3 4 5 6 7; do curl -s -o /dev/null -w '%{http_code} ' -X POST "$API" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{}'; done; echo
#    If you submitted test inquiries from this machine in the last 10 minutes, the 429 arrives sooner. The block lifts
#    after 10 minutes. nginx also throttles floods (about 60 requests/minute/address) with 429.

# 12. Turnstile (only once enabled, section 5). A direct call has no valid token, so:
curl -s -X POST "$API" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d '{"name":"x","email":"a@b.co","sessionType":"Cars","message":"x","idempotencyKey":"securitycheck000001","website":"","turnstileToken":"forged"}'; echo
#    expect: {"ok":false,"error":"bot_check_failed"}   (wait 10 minutes after check 11 or use another network)
#    then submit the real form on the website in a browser: it must succeed, and the verification box must be visible.

# 13. Logs hold no inquiry content or secrets (after you have submitted the test inquiry in section 6)
sudo journalctl -u kaileb-inquiry --since today --no-pager | grep -c -i -E 'Deploy Check|please ignore|re_[A-Za-z0-9]{10}|turnstile.*(0x|token)'      # expect 0
sudo grep -c -i -E 'Deploy Check|please ignore|authorization|re_[A-Za-z0-9]{10}' /var/log/nginx/kaileb-inquiry.access.log                        # expect 0

# 14. Restart and reboot recovery
sudo systemctl restart kaileb-inquiry && sleep 2 && curl -s http://127.0.0.1:8787/health; echo      # expect ok
sudo reboot   # then, after logging back in:
systemctl is-active kaileb-inquiry nginx && systemctl list-timers kaileb-inquiry-backup.timer        # expect active, active, and the timer listed

# 15. Backup works and verifies (section 7), and no secret is in the repository checkout
sudo systemctl start kaileb-inquiry-backup.service && sudo journalctl -u kaileb-inquiry-backup -n 3 --no-pager   # expect "backup written and verified"
sudo git -C /opt/kaileb-inquiry/app status --short                                  # expect no output (nothing local, no env files)
cd /opt/kaileb-inquiry/app/server && sudo npm audit --omit=dev                      # expect 0 vulnerabilities (dependency audit; needs internet)
```

Also confirm in the AWS console (the administrator's responsibility): the security group allows inbound
80 and 443 from anywhere, 22 only as you intend, and nothing else; the instance has no access keys stored
on it for this application; and, if Elastic IP/DNS changes later, the certificate renewal
(`sudo certbot renew --dry-run`) still works.

## 7. Backups and restore

- **Database:** `/var/lib/kaileb-inquiry/inquiries.db`, WAL mode with `synchronous=FULL` (an inquiry is on
  disk before the visitor sees success). The `-wal` and `-shm` files next to it are part of the live
  database: never copy, delete or move `inquiries.db` alone while the service runs. Use the backup
  command, which takes a consistent online copy.
- **Schedule:** `kaileb-inquiry-backup.timer` daily at ~03:15; each run writes
  `/var/backups/kaileb-inquiry/inquiries-<timestamp>.db`, runs an integrity check and row count on the copy
  (the run fails, and nothing is pruned, if the copy is bad), then keeps the newest 30.
  Check: `systemctl list-timers kaileb-inquiry-backup.timer`, `journalctl -u kaileb-inquiry-backup`.
  A failed run shows as `failed` in `systemctl status kaileb-inquiry-backup.service`.
- **On demand** (always before an update): `sudo systemctl start kaileb-inquiry-backup.service`.
- **Off-server copy — administrator decision.** Backups on the same disk don't survive losing the
  server. Copy `/var/backups/kaileb-inquiry/` off the server daily by any means you already use (e.g. an
  `rsync` pull over SSH from another machine, or an S3 bucket via an instance role). Keep at least 30 days.
  Backups contain clients' names, emails and messages: store them encrypted/access-restricted, and
  remember deleted inquiries remain in backups until those rotate out.
- **Verify any backup** (restore drill, harmless, read-only):
  ```bash
  sudo -u kaileb-inquiry /usr/bin/node /opt/kaileb-inquiry/app/server/src/backup.js --verify /var/backups/kaileb-inquiry/inquiries-<timestamp>.db
  # -> verified ...: integrity ok, N inquiries, schema version M
  ```
- **Restore** (replaces the live database; inquiries newer than the backup are lost — check
  `kaileb-inquiries list` first):
  ```bash
  sudo systemctl stop kaileb-inquiry
  OLD=/var/lib/kaileb-inquiry/replaced-$(date +%Y%m%d%H%M)
  sudo install -d -o kaileb-inquiry -g kaileb-inquiry -m 0700 "$OLD"
  sudo sh -c "mv /var/lib/kaileb-inquiry/inquiries.db* $OLD/"        # db + -wal + -shm together
  sudo install -o kaileb-inquiry -g kaileb-inquiry -m 0600 /var/backups/kaileb-inquiry/inquiries-<timestamp>.db /var/lib/kaileb-inquiry/inquiries.db
  sudo systemctl start kaileb-inquiry
  curl -s http://127.0.0.1:8787/health; echo && kaileb-inquiries list
  ```
  Keep `$OLD` until the restored service is confirmed good, then delete it (it contains personal data).

## 8. Updates and rollback

Updates only touch `/opt/kaileb-inquiry/app`. The database, env file and backups are outside it.
Database migrations run automatically at start-up; they are append-only and recorded in the database.

```bash
cd /opt/kaileb-inquiry/app
PREV=$(sudo git rev-parse HEAD); echo "rollback point: $PREV"     # write this down
sudo systemctl start kaileb-inquiry-backup.service                  # fresh verified backup
sudo git fetch origin
sudo git log --oneline "$PREV"..origin/main -- server/              # what changed in the API
sudo git checkout --detach <RELEASE_COMMIT>                         # e.g. origin/main
cd server && sudo npm ci --omit=dev
#   Only if files in server/deploy/ changed: re-install them as in section 3 (steps 9/11), then
#   sudo systemctl daemon-reload / sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart kaileb-inquiry
curl -s http://127.0.0.1:8787/health; echo
sudo journalctl -u kaileb-inquiry -n 20 --no-pager
```

**Rollback** if the new release won't start or misbehaves:

```bash
cd /opt/kaileb-inquiry/app && sudo git checkout --detach "$PREV"
cd server && sudo npm ci --omit=dev && sudo systemctl restart kaileb-inquiry
curl -s http://127.0.0.1:8787/health; echo
```

Older code keeps working on a database that a newer release migrated (migrations only add tables and
columns). Restore the pre-update backup (section 7) only if a release damaged data.

## 9. Day-to-day operations

- Status/logs: `systemctl status kaileb-inquiry`, `sudo journalctl -u kaileb-inquiry -f`.
  Logs contain request method, URL, status code and client IP, never form contents, tokens or keys.
  **Client IP addresses are personal data and are kept in two places:** the application journal
  (journald; its retention is set by `/etc/systemd/journald.conf`) and nginx's
  `/var/log/nginx/kaileb-inquiry.access.log` (address, URL, status, browser, referrer; rotation is
  `/etc/logrotate.d/nginx`, which on Ubuntu keeps about 14 weekly files [verify]). The owner has not yet
  decided a log-retention period; until then keep the defaults and do not copy these logs elsewhere.
- Owner CLI (no web admin exists yet). Runs as the service user; output contains personal data:
  ```
  kaileb-inquiries list [--status new,accepted] [--all]
  kaileb-inquiries show <id>
  kaileb-inquiries accept|decline|cancel|complete|spam <id> [--note "text"]
  kaileb-inquiries confirm <id> --date YYYY-MM-DD --start HH:MM --minutes N [--note "text"]   # refuses overlaps
  kaileb-inquiries note <id> "text"
  kaileb-inquiries delete <id> --yes
  kaileb-inquiries purge --days N --status declined,cancelled,spam [--yes]                   # dry run without --yes
  ```
  These do not email the client. Always use this wrapper (or `sudo -u kaileb-inquiry`), never run the
  CLI or `node` against the database as root: SQLite would create root-owned files the service can't open.
- Config change: edit `/etc/kaileb-inquiry/env`, `sudo systemctl restart kaileb-inquiry`, check the journal.
- Restart policy: systemd restarts the app 5 s after a crash and starts it at boot. A bad config makes it
  exit at start-up with the reason in the journal.

## API reference

`POST /api/inquiries` JSON `{name,email,phone?,sessionType,preferredDate?,location?,message,discountCode?,idempotencyKey,website,turnstileToken?}`
- `201 {ok:true,id}` stored · `200 {ok:true,id,duplicate:true}` same `idempotencyKey` seen before (retry) · `400` validation (`fields`) ·
  `403` origin not allowed · `413/415` · `429` rate limit · `500/503` NOT stored (the website never claims success).
- Success is returned only after the row is committed. The owner email is sent afterwards, asynchronously.

`GET /health` → `{ok:true,notifyBacklog:N}`; server-local only.

---

## Development (not needed for deployment)

```
cd server && npm ci
NODE_ENV=development ALLOWED_ORIGINS=http://localhost:4173 NOTIFY_PROVIDER=dev DEV_MAIL_FILE=./data/mail.jsonl npm start
npm test                 # API/security/lifecycle/backup tests (in-memory DB, no network)
npm run inquiries -- list
```
Browser end-to-end tests live in `../tests/inquiry-e2e.spec.js` (`npm test` at the repo root).
`test/deploy.test.js` checks that `deploy/` templates stay consistent with the code (and that no secrets are tracked in Git); `test/security.test.js` covers hostile input, abuse limits, Turnstile, proxy/IP handling and log hygiene.
