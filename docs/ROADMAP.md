# Gap Matrix & Roadmap

Source of truth for *what remains* and *in what order*. Spec: `V1-SPEC.md`. Design: `ARCHITECTURE.md`. Current position: `STATE.md`.
Autonomy key: 🟢 Claude may execute alone · 🟡 Claude executes up to a named gate then stops · 🔴 STOP — owner decision/action required first.

## Gap matrix (current → V1)

| # | Capability | Current (verified) | V1 target | Gap | Pri | Depends on | Risk | Cx | Owner input? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Inquiry submission | Stub; empty submit "succeeds"; nothing stored | Server-validated, persisted, idempotent | Backend + client validation | P0 | G1, M4 | High | M | Host (G1) |
| 2 | Owner notification / client confirmation | None | Emails (owner, received, accepted/declined) | Email provider, domain auth | P0 | M4, G4 | Med | M | Provider, DNS |
| 3 | Spam/abuse protection | None | Turnstile, honeypot, rate limits | New | P0 | M4 | Med | S | Turnstile account |
| 4 | Availability check | None; past dates allowed | Per-date available/unavailable, lead time, rules | New | P0 | M4 | Med | M | Rules/lead time (G8) |
| 5 | Manual availability mgmt | None | Block dates/ranges/weeks in admin | New | P0 | M6 | Low | M | Weekly rules (G8) |
| 6 | Owner admin | None | Requests + availability + settings, secure | New | P0 | G1, M4 | High (security) | L | G1 |
| 7 | Booking lifecycle | None | NEW→ACCEPTED→CONFIRMED etc., double-booking guard | New | P0 | M6 | Med | M | Cancellation terms (G8) |
| 8 | External calendar free/busy | None | **V1.1** adapter (Google/MS), privacy-tested | Deferred | P2 | G2, V1 live | High (privacy/policy) | L | Provider + employer policy |
| 9 | Deposits/payments | Promised in copy only | Offline instructions in V1; Stripe Link V1.1 | Copy+email only in V1 | P1 | G8, G9 | Med | S (V1) | Method, amount |
| 10 | Image delivery | Single JPEG per photo, CSS hero, no srcset, no dims in gallery | Derivatives, `<picture>`, hero `<img>`, hashed caching | Pipeline + markup | P0 | G6 (soft) | Low | M | Originals location |
| 11 | Lightbox | Open/close only | + prev/next, swipe, arrows, bigger derivative | Enhance | P1 | M2 | Low | S | – |
| 12 | Mobile/touch/a11y | No overflow; many targets <44 px; no no-JS reveal | AA, ≥44 px, axe clean | Fixes | P0 | – | Low | S | Palette (G5) |
| 13 | Collections page | Wheel-hijack paging, no keyboard | Keyboard + no scroll trap, lighter scrim | Fix | P1 | – | Low | S | – |
| 14 | Trust content | Placeholder testimonials, SVG portrait, no wedding photos | Real content or sections removed | Content | P0 | G5 | Med (credibility) | S | **Yes: photos, quotes** |
| 15 | SEO | Basics only | JSON-LD, Twitter, real domain, alt text, lastmod, 404 | Add | P1 | G7 (domain) | Low | S | Domain, GBP, Search Console |
| 16 | Privacy/legal | None | Notice, consent, retention, delete | New | P0 | G8 | Med | S | Policy approval |
| 17 | Backups/monitoring | N/A | Nightly export, restore drill, alerts | New | P0 | M4 | Med | S | – |
| 18 | Tests/CI | None | Unit+API tests, Playwright e2e, axe, Lighthouse, secret scan | New | P0 | M1 | Low | M | – |
| 19 | Deployment/domain | None | Prod on chosen host, HTTPS, redirects | New | P0 | G1,G7 | Med | S | Accounts, DNS |
| 20 | Wise Agent forward | Documented plan | V1.1 server-side POST (unless G3 says V1) | Deferred | P2 | M4, G3 | Low | S | Token, still wanted? |

## Owner gates (the only places Claude must stop)
| Gate | Decision/action | Needed before |
|---|---|---|
| **G0** | Approve V1 spec, architecture direction, roadmap | M1 |
| **G1** | Choose host/architecture (rec: Cloudflare A; alt: AWS box — answer BACKEND.md Qs); create accounts | M4 |
| **G2** | Identify calendar provider (iPhone → Settings → Calendar → Accounts); check employer policy; choose "mirror to Google/Outlook" vs manual-only | M10 (not V1) |
| **G3** | Is Wise Agent required at V1 or V1.1? | M5 |
| **G4** | Paid/new services: email provider, Turnstile, domain email auth (DNS) | M5 |
| **G5** | Content: Kaileb photo, testimonials, wedding status, palette (green vs. "no green") | M7 |
| **G6** | Where true originals live; confirm derivatives policy | M2 final run |
| **G7** | Production deploy, domain/DNS, production credentials | M9 |
| **G8** | Policies: lead time, weekly hours, buffers, retention, cancellation/deposit terms & method, discount codes | M6/M7 |
| **G9** | Payments (Stripe Link) | V1.1 |

## Milestones (dependency order)

### M1 — Front-end hardening 🟢
Objective: fix everything fixable without a backend. Scope: client-side validation + inline accessible errors + honest interim behavior (no false "success"; until M5 the form says it can't submit and shows email/phone — or is gated off) · min-date/lead time in date picker · ≥44 px targets · `.reveal` no-JS fallback · collections keyboard paging + lighter scrim · lightbox prev/next/swipe/arrows · gallery category jump-nav · reduced-motion on typewriter · measured contrast fixes · remove unused leftover image folders · add test tooling (Playwright + axe) and a one-command local run.
Accept: AC-F1.1, F6 criteria; axe 0 serious/critical on 6 pages at 390 & 1440; Playwright smoke suite green; no regressions in CLAUDE.md-described behavior (update CLAUDE.md where changed).
Prereqs: G0. Validation: Playwright at 390/768/1440, keyboard-only pass.

### M2 — Image pipeline 🟡 — **PARTIALLY COMPLETE** (infrastructure done 2026-10-13; true originals still needed, G6)
Objective: F5. Scope: `scripts/build-images` (sharp), manifest, `<picture>`/srcset markup generated from manifest, hero as `<img>`, hashed filenames, lightbox large derivative, `width/height`. Works from current JPEGs now; re-run on true originals later.
Accept: F5 acceptance (Lighthouse on local static server as proxy; re-measure in prod M9). Prereqs: M1 (tests).

### M3 — 🔴 G1 decision: host/architecture + accounts. No code.

### M4 — Backend foundation 🟢 (after G1)
Scope: Worker project, D1 schema + migrations, `POST /api/requests` (validation, idempotency key, size limit, honeypot, Turnstile *test* keys, rate limit), `GET /api/availability` (rules + blocks + sessions only), config/secrets scaffolding, local dev + CI, unit/API tests, structured PII-free logging.
Accept: AC-F1.2–F1.6 (local), AC-F2.1–2.5, direct-POST negative tests, all tests green. Local only — **no production resources.**

### M5 — Form integration + email 🟡 (G3, G4)
Scope: wire form to API, success/error/rate-limited states, availability hint on date picker, email templates and sender abstraction (sandbox/mock until G4), delivery-failure surfacing.
Accept: AC-F1.2, F1.5, F1.7 with mocked provider; real-provider test after G4. Prereqs: M4.

### M6 — Owner admin + booking lifecycle 🟢 (G8 for defaults; use placeholders flagged in STATE)
Scope: Access-JWT guard (dev bypass only under explicit local flag, never deployable), requests list/detail/notes, state machine, accept/decline/confirm/cancel emails, confirm-time conflict check, availability rules/blocks UI (single/multi/range/week), settings, audit log, data-delete action. Mobile-first.
Accept: F3 acceptance (all), AC-F3.1 negative tests for every admin route, privacy test that notes never leak, e2e: request→accept→confirm→date unavailable.

### M7 — Trust content, SEO, legal 🟡 (G5, G8; domain for final SEO)
Scope: About rewrite w/ real photo, testimonials or removal, wedding handling, JSON-LD, Twitter tags, alt text pass, 404, privacy page + consent copy, terms on pricing, sitemap lastmod. Can run in parallel with M4–M6.
Accept: F7, F8, F9 (policy page). No placeholders remain.

### M8 — Security & operations hardening 🟢
Scope: CSP/headers, Access JWT verification tests, secret scan in CI, backup cron + export + **restore drill**, health check/alerts, retention purge cron, dependency audit, final pass on threat table.
Accept: F10; every ARCHITECTURE.md §4 control checked off in STATE.md with evidence.

### M9 — Production launch 🔴 (G7)
Scope: production Cloudflare project, domain/DNS, SPF/DKIM/DMARC, secrets, deploy, redirects, Search Console, real-device smoke test, Lighthouse in prod.
Accept: F11 end-to-end smoke test on a real phone; Lighthouse targets met; backups confirmed. **V1 is DONE here.** Owner presses deploy/DNS; Claude prepares runbook.

### V1.1 (post-launch, each its own gated milestone)
M10 External calendar adapter (G2; privacy test mandatory) · M11 Stripe Payment Link (G9) · M12 Wise Agent forward (G3) · M13 agenda/reminders/holds · M14 per-category SEO pages.

## Dependency sketch
`G0 → M1 → M2 ┐` · `G1 → M4 → M5 (G3,G4) → M6 → M8 → M9 (G7)` · `M7 parallel (G5,G8)` · `M10+ after M9`.
Every V1 gap-matrix row (1–7, 9–19) maps to M1–M9; rows 8, 20 are V1.1 by design.
