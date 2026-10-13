# Architecture, Calendar Integration & Security

**Status: hosting/backend selection is UNAPPROVED until owner gate G1 (Cloudflare is the current recommendation only; nothing is provisioned).** CLAUDE.md says not to assume a host until decided. Product direction (V1-SPEC, ROADMAP) was approved 2026-10-12. Facts about prices/limits marked **[verify]** come from memory or third-party sources and must be re-checked against provider docs before commitment.

> **Update 2026-10-14:** the owner directed that the inquiry backend run on their existing **AWS server** (Node/Fastify + SQLite behind HTTPS, see `server/README.md`). That overrides the Cloudflare recommendation below for the API/database/email path; Cloudflare Access/Workers/D1 are no longer the plan for it. Security controls in §4 still apply (admin auth will need a mature mechanism on AWS, e.g. SSO/OIDC or a reverse-proxy auth layer, decided at M6). Static hosting for production remains undecided (GitHub Pages is staging only).

## 1. Architecture options

Requirements: one-person business, ~tens of requests/month, low cost, real storage, auth for one admin, email, strong image delivery, calendar integration optional, minimal maintenance, **keep the existing static HTML site** (no framework migration).

| | **A. Static site + serverless edge API (Cloudflare Pages + Workers + D1 + R2)** | **B. The AWS server from the personal contact** (EC2/Lightsail + Nginx + Node + SQLite/Postgres) | **C. Static host + BaaS (Netlify/Vercel + Supabase/Firebase)** |
|---|---|---|---|
| Frontend | Pages (static, global CDN, free tier) [verify] | Nginx on the box | Netlify/Vercel static |
| API | Workers (TypeScript), one small API | Node/Express process | Functions / BaaS rules |
| DB | D1 (SQLite) w/ Time Travel point-in-time restore [verify] | SQLite/Postgres you back up | Supabase Postgres / Firestore |
| Admin auth | **Cloudflare Access** in front of `/admin` + `/api/admin` (email OTP/Google SSO; free tier up to 50 users [verify]); no passwords stored | Must build or bolt on auth (custom ⇒ risk) | Supabase Auth / Netlify Identity (OK) |
| Images | R2 (private originals) + build-time derivatives served from Pages CDN; Cloudflare Images optional later | Disk + Nginx; no CDN unless added | Provider CDN; transforms often paid |
| Email | Resend/Postmark via API from Worker (free tier covers volume [verify]) | Same, or local SMTP (deliverability pain) | Same |
| Calendar OAuth | Worker holds secrets (Wrangler secrets); tokens encrypted in D1 | env vars/files on box | Functions + secrets |
| Secrets | Wrangler/Pages secrets | `.env` on server | Provider env |
| Backups | D1 Time Travel + scheduled export to R2 | DIY cron + offsite | Supabase daily backups (plan-dependent) [verify] |
| Logs/monitoring | Workers logs, Logpush off; email alert on 5xx via cron/health check | DIY | Provider logs |
| Deploy | `git push` → auto deploy; preview URLs | SSH/rsync; patching the OS is yours | `git push` |
| Maintenance | Lowest (no servers/OS patching) | **Highest**; depends on a third party's box and goodwill; unknown access (BACKEND.md Qs unanswered) | Low–medium; vendor lock-in |
| Cost | ≈ $0–5/mo + domain [verify] | Unknown (contact's cost/willingness) | $0–25/mo [verify] |

### Recommendation: **A — static site on Cloudflare Pages + one Workers API + D1 + R2 (+ Access, Turnstile)**
Why it wins here: (1) the current static site deploys unchanged — no rewrite; (2) real server-side validation, storage and email without running a server; (3) **admin auth is delegated to Cloudflare Access** so we ship no password/session code (mature solution, as required); (4) Turnstile + rate limiting cover spam in the same platform; (5) free/near-free at this scale with automatic HTTPS, CDN and previews; (6) D1/SQLite is ample for one photographer; (7) secrets and cron (for calendar sync, backups) are first-class.
Why not B: ownership/maintenance/uptime/backups all depend on someone else's unknown box, and a public site plus PII plus OAuth tokens on a hand-maintained server is the riskiest option for a part-time owner. B stays viable only if the contact answers the BACKEND.md questions *and* the owner prefers it; the API should keep its logic in plain TS modules behind a thin handler to keep a port possible (not a goal to engineer for).
Why not C: heavier than needed, vendor-specific rules/auth models, image transforms cost.
**Wise Agent (BACKEND.md):** our D1 is the system of record. Forwarding a lead to Wise Agent is a one-way server-side POST (token as a secret) = **V1.1**, unless the owner says Wise Agent is mandatory for V1 (gate G3). It is a real-estate CRM; confirm owner actually uses it for photography.

### Components (A)
- `/` static pages (existing).
- `/api/*` Worker: `POST /api/requests`, `GET /api/availability?month=`, admin routes under `/api/admin/*` (Access-protected, and the Worker **also verifies the Access JWT** — defense in depth, never trust the route alone).
- `/admin/*` small vanilla HTML/JS admin (no framework, mobile-first).
- D1 tables (sketch): `requests`, `blocks`, `sessions` (or status on requests), `settings`, `audit_log`, later `calendar_connections` (encrypted tokens), `busy_cache`.
- Cron trigger: purge spam/expired data, (V1.1) refresh calendar free/busy, nightly export.

## 2. Image delivery strategy
- **Originals** (full-res, untouched) live in a private R2 bucket or the owner's own storage; never committed to the repo, never publicly served. Current repo JPEGs are already downsized (≤2000 px) — the owner should locate/back up true originals (gate G6).
- **Derivatives (implemented in M2)** by `scripts/build-images.js` (`sharp`): AVIF at widths 480/960/1440/2000/2400 capped at the source's own width (never upscaled) + one 1200 px JPEG fallback; EXIF/GPS stripped, orientation applied, sRGB. **WebP deliberately omitted** (+11 MB committed for a sliver of browsers). Outputs are committed so any static host serves them with no build step; `images/manifest.json` holds dimensions/hash/widths and `<picture data-photo=… data-preset=…>` blocks in the HTML are expanded from it. Sources: private `originals/` (gitignored, preferred) else committed `source/` (today's downsized JPEGs).
- Markup: `<picture>` + `srcset`/`sizes`, intrinsic `width`/`height`, `loading="lazy"` below fold; home hero as `<img fetchpriority="high">` (not CSS background); the lightbox swaps in the larger AVIF steps with `sizes` computed from the photo's aspect and the dialog box.
- Caching: immutable, content-hashed filenames, `Cache-Control: public, max-age=31536000, immutable`; HTML short TTL.
- Escape hatch if the gallery grows large: Cloudflare Images/transformations [verify cost].

## 3. Calendar / availability architecture

### What we know / don't know
- Owner: "I use iCloud with my iPhone but can switch if there are compatibility issues." **Unresolved:** is the *work* calendar's server iCloud, or Outlook/Exchange/Google merely displayed on the iPhone? iPhone Settings → Calendar → Accounts reveals it (gate G2).
- Provider facts (web research 2026-10-12; third-party sources noted — **[verify]** against official docs before building):
  - **Microsoft 365/Outlook:** Graph `getSchedule` returns free/busy only (no titles) and works with app or delegated permissions; Microsoft's doc lists `Calendars.Read` as least-privileged for it, while `Calendars.ReadBasic` is reported to also work **[verify]**. App-only calls use `/users/{id}/calendar/getSchedule`. **Employer tenants frequently block third-party app consent or require admin consent** — the main feasibility risk if the work calendar is Exchange. Also: an Outlook calendar can be *published as busy-only ICS* by the owner (if the tenant allows).
  - **Google Calendar:** `freebusy.query` with the narrow `calendar.freebusy` scope returns busy intervals only. A Google Cloud OAuth app left in *Testing* issues refresh tokens that expire after ~7 days; production consent (and possibly verification, depending on scope sensitivity) is needed **[verify scope classification]**. Workspace admins can also restrict third-party apps.
  - **iCloud:** no OAuth and no free/busy API. Access is CalDAV (`caldav.icloud.com`) with an **app-specific password** (2FA required; managed Apple IDs may not support it); that credential grants broad read access to calendar data, so we'd read events and derive busy ourselves, polling only; Apple's "public calendar" ICS link exposes **full event details** (no busy-only mode). Sources are mostly vendor blogs — **[verify]**. Verdict: *technically possible, worst privacy/security fit* (we would hold a credential that can read everything, and would receive event titles we must discard immediately).
  - **Subscribed ICS feeds** of unknown origin: free/busy depends on what the feed publishes; treat like iCloud (we'd receive details and must discard them).

### Recommended model
1. **V1 ships without any external calendar.** Manual availability + weekly rules + confirmed sessions is first-class and complete (V1-SPEC §Availability). No schema or UI assumes an external source.
2. **V1.1 adds an `AvailabilitySource` adapter interface**: `getBusyIntervals(from, to) → [{start,end}]` — only intervals leave the adapter; nothing else is ever stored or returned. Adapters in preference order: Google (`calendar.freebusy`), Microsoft Graph free/busy, then ICS/CalDAV last-resort.
3. **Provider guidance to owner [R]:** the iPhone doesn't need to change. If the work calendar is in iCloud and the owner wants auto-conflict checking, the lowest-risk path is to *move or mirror the work calendar to a Google or Outlook account he controls* (the iPhone Calendar app displays Google/Outlook natively), then use the free/busy API. That is a calendar-account change, not a phone change. If the employer owns the calendar (Exchange), first check IT policy (**legal/ToS gate G2**): connecting an employer calendar to a personal app may violate policy even if technically allowed — the owner must decide. If neither is acceptable, manual blocks remain fine: a part-time photographer can block dates when he books work.
4. **Privacy boundary (hard rules):** (a) provider call requests free/busy only where the API allows; (b) adapter output is `{start,end}` only; (c) cache holds only merged busy intervals for ~90 days ahead, no titles/attendees/locations; (d) public API returns `{date, available}` only; (e) intervals are never sent to the browser; (f) an automated test seeds events with distinctive titles and asserts those strings appear nowhere in API responses, DB dumps, or logs.
5. **Sync:** Cron every 15 min refreshes a rolling 90-day busy cache (poll beats webhooks for a single user; Google/MS push channels expire and need renewal). On-demand refresh when the owner confirms a request. Respect rate limits with backoff. Failure/staleness must **fail safely** and must not silently expose a date as available when a required external conflict source can't be verified; owner is alerted. Exact degraded-state policy (display vs. confirmation behavior, staleness threshold) is **deferred to the V1.1 calendar milestone (M10)** — not designed yet.
6. **Tokens:** OAuth authorization-code flow with PKCE, least-privilege scope, refresh token encrypted at rest (AES-GCM via WebCrypto, key in secret store — platform primitive, not custom crypto), stored only in `calendar_connections`; revocation/`invalid_grant` ⇒ mark disconnected, notify owner, apply the same fail-safe rule (above). "Disconnect" button deletes tokens and cache.
7. **Time zones:** busy intervals stored UTC; evaluated against `America/Phoenix` day boundaries and weekly rules; all-day events treated as busy for that local date; tentative/free events treated per owner setting (default: only `busy`/`oof` block).
8. **Conflict computation:** day is `available` iff the requested time-of-day window (or any default shoot window that day, for date-only requests) has ≥ session-duration + buffer free after subtracting busy ∪ blocks ∪ confirmed sessions, and falls within weekly rules and lead time.

## 4. Security review (planned system)

| Area | Threat | Control |
|---|---|---|
| Admin auth | Credential theft, brute force | Cloudflare Access (SSO/OTP, MFA via IdP) in front; Worker verifies Access JWT (aud/iss/exp); single allowed identity; no password code |
| Authorization | Route-level miss exposes admin API | All admin handlers share one guard; test that every `/api/admin/*` route 401s without a JWT |
| Client PII | Leak via DB, logs, email, backups | Collect minimum; no PII in logs (log IDs only); retention/purge cron; delete action; encrypted-at-rest by platform; backups access-restricted |
| Spam | Form abuse, email bombing | Turnstile + honeypot, per-IP and global rate limits, max body size, per-email/day cap, owner-notification digest if flood |
| Injection | SQLi | Parameterized queries only (D1 prepared statements) |
| XSS | Stored XSS from request text in admin | Render with `textContent`/escaping, strict CSP (no inline script), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'` on admin |
| CSRF | Admin state change from another site | Access cookie is `SameSite`/`HttpOnly`; admin APIs require JSON content-type + custom header + Origin check; public form POST has no auth to ride |
| Email | Spoofing/phishing from our domain, header injection | SPF/DKIM/DMARC; templates with escaped fields; user input never in headers; reply-to set to client only on owner mail |
| OAuth/Calendar | Token theft, over-broad scope | Narrow scope, encrypted refresh token, secret key separate from DB, revocation flow, no event data stored (privacy test) |
| Secrets | Leakage in repo/CI | Platform secret store only; gitleaks/pre-commit scan; `.dev.vars` gitignored; no secrets to client |
| Calendar privacy | Event metadata exposure | See §3.4 hard rules + test |
| Availability endpoint | Scraping / calendar inference (months of busy days reveal work pattern) | Return only date availability, ≤ 6-month horizon, rate limit; accept that pattern of unavailable days is visible (owner informed) |
| Errors | Stack traces / PII leakage | Generic client errors, structured server logs without bodies |
| Backups | Loss/ransom | Nightly export to private R2 + D1 point-in-time; restore drill before launch |
| Supply chain | Dependencies | Few deps (sharp, wrangler dev-only); lockfile; Dependabot |
| Domain | Hijack | Registrar MFA; DNSSEC if available; owner-held account |
| Cookies/session | Misconfig | Access-managed; no custom sessions; `Secure`, `HttpOnly` |

Out of scope for V1: WAF tuning, SOC2-style controls, field-level encryption of PII (platform at-rest encryption suffices; revisit if payments/ID data are added).
