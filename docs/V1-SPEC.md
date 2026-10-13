# Photography Website V1 — Product Specification

**Status: PROPOSED — awaiting owner approval** (see `STATE.md`). Once approved, this file is the finish line: V1 is done when every V1 acceptance criterion below passes in production.

Tiers: **V1** = required for production launch · **V1.1** = near-term · **V2** = deliberately deferred.
Timezone for all availability: `America/Phoenix` (Arizona does not observe DST; the Navajo Nation does, ignore). Store timestamps UTC, dates as local calendar dates.

## Principle
A one-person business. The site's job: show work → establish trust → get a *qualified* request (type, date, place) to Kaileb without losing it → let Kaileb say yes/no quickly. **Request-and-approve, not instant booking.** Photo sessions depend on weather, location, travel, and fit, and the owner has a day job; instant booking adds double-booking and refund complexity with no business value.

## Booking / inquiry model (V1)
One entity: a **Request** (the inquiry *is* the booking request; no separate conversion step).

```
SUBMITTED → (auto) NEW ─┬→ ACCEPTED ──→ CONFIRMED ──→ COMPLETED
                        ├→ DECLINED                └→ CANCELLED
                        └→ SPAM (hidden; auto-purged)
```
- **NEW**: client submitted; owner emailed; client got "received" email. Date is *requested*, not held.
- **ACCEPTED**: owner replies with exact time/location/price/deposit instructions (V1: owner-authored message sent from admin or own email; status set by owner).
- **CONFIRMED**: owner marks confirmed (after deposit received offline in V1). Creates a *confirmed session* that **blocks that date/time** in availability.
- **DECLINED / CANCELLED**: owner action with optional note; client emailed. Reschedule in V1 = owner edits date or cancels + client re-requests (no self-service).
- **No temporary hold in V1.** Holds let spam or tire-kickers lock dates and add expiry machinery. A date is held only once ACCEPTED→CONFIRMED. (V1.1 option: owner-set hold on ACCEPTED, with expiry.)
- **Double-booking prevention:** at CONFIRM time the server re-checks availability atomically (single DB transaction) and refuses/warns if a confirmed session or block overlaps. Concurrent NEW requests for the same date are allowed (owner chooses).
- **Lead time:** configurable minimum notice (default 7 days; owner decision), enforced server-side and in the date picker. Weddings: longer (owner decision).
- **Duration/time:** V1 collects a *time-of-day preference* (Morning / Golden hour / Afternoon / Flexible), not an exact slot; owner sets exact time on acceptance. Duration is implied by session type (owner-configured default minutes used for conflict checks).
- **Travel:** location free text + "within Phoenix metro? y/n" flag so owner can quote travel fees (pricing page already says fees may apply).
- **Payments/deposits: NOT V1.** V1 confirmation email states deposit amount and *offline* method (Venmo/Zelle/etc.; owner decision). **V1.1:** Stripe Payment Link per session (no custom checkout, no card data touches the site). **V2:** integrated payments/invoices/contracts. Why: adds PCI-adjacent scope, refund/dispute policy and legal terms for a business doing a few sessions a week.
- **Contracts/e-sign, client portal, galleries delivery: V2.** V1.1 at most: owner pastes a delivery link into the "session complete" email.

## Availability model
Public result is exactly **per requested date**: `available` | `unavailable` (+ optional "request anyway"). Never any reason, never any event data.

Inputs, evaluated server-side only, combined as a **union of unavailability** (any source blocking ⇒ unavailable):
1. **Default weekly rules** (owner-set): e.g. weekdays after 5:30 pm, Sat/Sun all day. Outside rules ⇒ unavailable unless owner overrides.
2. **Manual blocks** (V1, first-class): single dates, multiple dates, ranges, whole weeks, optional time range; each has a private label visible only to owner.
3. **Confirmed sessions** (from Requests).
4. **External calendar free/busy (V1.1, optional):** busy intervals only, no event data stored. See ARCHITECTURE.md §Calendar.

Overlap rule: union wins. A manual "open override" for a date that external calendar shows busy is **V1.1** and must be an explicit owner action. External-calendar failure must **fail safely**: if a required external conflict source cannot be verified, the system must never silently expose a date as available. Exact degraded-state behavior is decided in the V1.1 calendar milestone (M10). V1 has no external-calendar dependency and is unaffected: manual rules + blocks + confirmed sessions are complete on their own.
Public API returns a fixed minimal shape: `{ "date": "2026-11-14", "available": true }` (month view returns an array of those). No timestamps, no source, no counts. A test asserts the response shape and that no private strings appear.

## Owner/admin (V1 minimum)
Behind mature auth (see ARCHITECTURE.md), mobile-friendly, one page-set:
- Requests list (filter by status), request detail with internal notes, actions: accept (with message), decline, confirm, cancel, mark spam, mark complete.
- Availability: month calendar of rules + blocks + confirmed sessions (own view only); add/remove blocks (date, range, week).
- Settings: lead time, weekly rules, session-type default durations, notification email.
- **V1.1:** upcoming-sessions agenda, calendar-connection status panel, edit pricing/business info, Wise Agent sync, CSV export. **V2:** multi-user, client records/CRM, analytics.
Everything else (editing site copy, uploading photos through a UI) is **not** V1: photos/copy change via repo + deploy.

---

## Features and acceptance criteria

### F1 Inquiry/request form — V1
Purpose: capture a qualified request reliably.
Fields: name*, email*, phone, session type* (Weddings/Proposals/Graduations/Cars/Portraits), preferred date*, time-of-day, location*, "within Phoenix metro", package/budget notes (message), message*, discount code (free text; owner interprets), consent line linking privacy notice. Hidden: honeypot, Turnstile-class bot token.
States: idle, validating, submitting, success, field errors, server error, rate-limited, date-unavailable (soft).
Edge cases: past/too-soon date, invalid email, duplicate submit (idempotency key), JS off (basic POST fallback optional), very long text, emoji, offline.
**Acceptance:**
- AC-F1.1 Submitting with any required field empty or invalid shows an inline, `aria`-associated error and sends nothing (browser-tested desktop + 390 px).
- AC-F1.2 Valid submit returns success **only after** the server has persisted the request (verified by DB row) and shows a confirmation with reference ID.
- AC-F1.3 Server rejects invalid payloads independently of client (tested with direct POST: missing fields, bad email, past date, oversized body, wrong types ⇒ 4xx, nothing stored).
- AC-F1.4 Double-click / retry creates exactly one request.
- AC-F1.5 If the server/network fails, user sees an error with direct email/phone fallback, and their typed data is preserved.
- AC-F1.6 Honeypot or failed bot token ⇒ no request created/emailed (silent success to bots OK); >N submissions/IP/hour ⇒ 429.
- AC-F1.7 Owner notification email and client "received" email are sent (or failures logged and surfaced in admin) for each real submission; client email never includes other clients' data.

### F2 Availability check on the form — V1
User: picks a date; sees "Looks available" / "Not available — pick another date" (or "request anyway"); month picker greys unavailable dates.
**Acceptance:** AC-F2.1 manual block on a date ⇒ date unavailable in UI and rejected-with-soft-warning server-side; AC-F2.2 response contains no more than `{date, available}`; AC-F2.3 with no external calendar configured everything works; AC-F2.4 lead-time and weekly rules enforced; AC-F2.5 availability endpoint is cached ≤60 s and rate-limited.

### F3 Owner admin: requests + availability — V1
**Acceptance:** AC-F3.1 unauthenticated access to any admin page or admin API ⇒ 401/redirect (tested, including direct API calls); AC-F3.2 owner can accept/decline/confirm/cancel and the client receives the matching email; AC-F3.3 confirming a request that overlaps a confirmed session or block is refused with explanation; AC-F3.4 owner can block a single date, a multi-select of dates, a range, and a whole week, and each immediately reflects in F2; AC-F3.5 usable at 390 px (no horizontal scroll, ≥44 px targets); AC-F3.6 internal notes never appear in any client email or public API.

### F4 Transactional email — V1
Owner "new request", client "received", client "accepted/declined/cancelled" (owner-written text in a template). Sent from the business domain with SPF/DKIM/DMARC (domain gate). **Acceptance:** emails land in Gmail/iCloud inbox (not spam) in a test; failures are retried or logged and visible in admin; no PII in logs.

### F5 Image delivery — V1
Originals preserved privately; site serves generated AVIF derivatives plus one JPEG fallback (WebP intentionally omitted — see ARCHITECTURE.md §2) with `srcset`/`sizes`, intrinsic `width`/`height`, lazy-loading below the fold, preloaded hero as an `<img>` (or preload) with `fetchpriority="high"`. Lightbox loads a larger derivative (~2000 px long edge), prev/next + swipe + keyboard arrows.
**Acceptance:** Lighthouse mobile (throttled) on home and gallery: LCP ≤ 2.5 s, CLS ≤ 0.1, performance ≥ 90 on production host; no gallery image over 300 KB at its largest delivered size except the lightbox derivative (≤ 600 KB); original files are not publicly reachable; a documented script regenerates derivatives from originals.

### F6 Site polish / mobile / accessibility — V1
**Acceptance:** all interactive targets ≥ 44×44 CSS px at 390 px; collections keyboard-operable (arrows) and does not trap scroll; `.reveal` content visible without JS; measured contrast ≥ WCAG AA for text; axe-core run on all pages has 0 serious/critical violations; lightbox focus handling retained; reduced-motion honors all animation including typewriter; gallery category jump-nav.
Palette decision (green vs. CLAUDE.md) resolved by owner.

### F7 Trust content — V1 (content partly owner-supplied)
Real photo of Kaileb and refreshed About copy; ≥3 real testimonials **or** the section removed (never ship placeholders); Weddings either has real photos + a gallery/collections entry or is labelled honestly (e.g. "Now booking 2027 weddings", no fabricated images). **Acceptance:** no placeholder/"coming soon" blocks on production.

### F8 SEO v1 — V1
Real domain in all canonicals/OG/sitemap; Twitter card; JSON-LD `ProfessionalService`/`Photographer` with Arizona `areaServed`; unique descriptive alt text; sitemap `lastmod`; 404 page; privacy page. **Acceptance:** Google Rich Results test passes JSON-LD; Search Console property verified (owner action); no canonical pointing at a dead domain.

### F9 Privacy & legal — V1
Privacy notice (what's collected, why, retention), consent line on the form, terms for cancellation/deposit written on pricing page. Retention proposal: SPAM purged 30 days; DECLINED/never-confirmed 24 months; confirmed sessions kept 7 years (tax) — owner approval. Admin "delete this person's data" action. **Acceptance:** policy page live; delete action removes request + notes.

### F10 Security, backups, monitoring — V1
See ARCHITECTURE.md §Security. **Acceptance:** security checklist items all pass; daily automated DB backup with one tested restore; uptime/error alerting to owner email; no secrets in git (scan passes).

### F11 Production launch — V1
Domain on HTTPS, redirects www/apex, `.html`→clean URLs (or canonical consistent), monitored. **Acceptance:** end-to-end smoke test on production: submit request from phone → owner email arrives → accept in admin → client email arrives → confirm → date shows unavailable on public form.

## V1.1 (near-term, not blocking launch)
External calendar free/busy (Microsoft/Google, provider-dependent); Stripe Payment Link per session; Wise Agent forward (if still wanted); upcoming-sessions agenda; reminder email 48 h before; optional temporary hold with expiry; client self-cancel link; per-category SEO landing pages; photo EXIF-free alt-text workflow; review request email; simple analytics (privacy-friendly).

## V2 (deferred deliberately)
Online payments/invoicing/contracts/e-sign; client galleries & downloads; instant booking; multi-photographer; full CRM; mini-sessions/event slots; blog; admin photo upload UI; i18n.

## Explicit non-goals for V1
No instant booking, no payments on-site, no accounts for clients, no external calendar *requirement*, no CMS, no JS framework migration, no custom auth.
