# Inquiry API

Small Node service that accepts the website's inquiry form, validates it server-side, stores it durably
in SQLite, and emails the owner. Fastify + better-sqlite3, no other infrastructure. Designed to run on
the existing AWS server behind an HTTPS reverse proxy. **Not deployed yet** (see "Owner gates").

## Run locally
```
cd server && npm ci
NODE_ENV=development ALLOWED_ORIGINS=http://localhost:4173 NOTIFY_PROVIDER=dev DEV_MAIL_FILE=./data/mail.jsonl npm start
npm test                 # 40 API/security/lifecycle/backup tests (in-memory DB, no network)
npm run inquiries -- list                       # owner CLI (output contains PII)
npm run inquiries -- accept <id> --note "..."   # also decline|cancel|complete|spam
npm run inquiries -- confirm <id> --date 2026-12-20 --start 16:00 --minutes 90   # refuses overlaps
npm run inquiries -- purge --days 365 --status declined,spam [--yes]            # dry run unless --yes
```
Browser end-to-end tests live in `../tests/inquiry-e2e.spec.js` (`npm test` at the repo root).

## API
`POST /api/inquiries` JSON `{name,email,phone?,sessionType,preferredDate?,location?,message,discountCode?,idempotencyKey,website,turnstileToken?}`
- `201 {ok:true,id}` stored · `200 {ok:true,id,duplicate:true}` same `idempotencyKey` seen before (retry) · `400` validation (`fields`) ·
  `403` origin not allowed · `413/415` · `429` rate limit · `500/503` NOT stored (client must not claim success).
- Success is returned only after the row is committed (`synchronous=FULL`). Owner email is sent after, asynchronously; failures are
  recorded (`notify_status`, `notify_last_error`), retried with backoff (up to 10 times), and visible in `/health` (`notifyBacklog`) and the CLI.
`GET /health` internal liveness + notification backlog (do not expose publicly).

## Configuration
Environment only — see `deploy/env.example`. Production start-up fails fast on unsafe config (wildcard/http origins, dev notifier, missing email settings).

## Deploy to the AWS server (needs owner access, see gates)
1. Requirements: Linux, Node >= 20, outbound HTTPS, a hostname with TLS (nginx + certbot, or another HTTPS front such as an ALB/CloudFront).
2. `sudo useradd --system --home /opt/kaileb-inquiry kaileb-inquiry; sudo mkdir -p /opt/kaileb-inquiry /var/lib/kaileb-inquiry /etc/kaileb-inquiry`
3. Copy the repo's `server/` to `/opt/kaileb-inquiry/server`, then `cd server && npm ci --omit=dev` (better-sqlite3 ships Linux binaries; if it must compile, install `build-essential python3`).
4. Create `/etc/kaileb-inquiry/env` from `deploy/env.example` (`chmod 600`, group `kaileb-inquiry`); put the Resend key in it **on the server only**.
5. `sudo chown -R kaileb-inquiry: /var/lib/kaileb-inquiry; sudo cp deploy/kaileb-inquiry.service /etc/systemd/system/; sudo systemctl enable --now kaileb-inquiry`
6. nginx: add `deploy/nginx.conf.example` as a new server block for the API hostname; `certbot --nginx -d <hostname>`.
7. Backups: cron `0 3 * * * BACKUP_DIR=/var/backups/kaileb-inquiry node /opt/kaileb-inquiry/server/src/backup.js` and copy that folder off the server (e.g. S3 bucket).
8. Point the site at it: set repo variable `INQUIRY_API_URL=https://<hostname>/api/inquiries` (Settings > Secrets and variables > Actions > Variables) and redeploy staging.
