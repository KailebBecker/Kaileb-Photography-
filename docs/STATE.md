# Project State & Autonomous Workflow

**Update this file at the end of every session. It is the only place that tracks progress.**
Last updated: 2026-10-12 · Phase: **M1 complete; M2 partially complete (blocked on true originals, G6). Hosting/backend (G1) still UNAPPROVED. Critical path: owner decision G1 (M3)**

## Doc map (each fact lives in exactly one place)
| File | Controls |
|---|---|
| `CLAUDE.md` | Existing-site conventions (categories, page behavior, SEO rules). Keep accurate when behavior changes |
| `docs/AUDIT.md` | Evidence snapshot of the pre-V1 product (do not repeat the audit) |
| `docs/V1-SPEC.md` | What V1 is: features, booking model, availability rules, acceptance criteria, V1.1/V2 scope |
| `docs/ARCHITECTURE.md` | Hosting choice, images, calendar integration design, security controls |
| `docs/ROADMAP.md` | Gap matrix, owner gates, milestones in order |
| `docs/CODEBASE-MAP.md` | Navigation index: where functionality lives, file relationships, when to open each file. Not authoritative over source |
| `docs/STATE.md` | Current milestone, decisions made, open questions, session log |
| `BACKEND.md` | Legacy notes (Wise Agent, AWS box). Superseded by ARCHITECTURE.md once G1/G3 decided |

## Next milestone
**M2 — Image pipeline** (🟡 autonomous; final run waits on G6 originals) is the next unblocked item. **M3/G1 (host decision) is the critical path:** M4 (backend) and everything after cannot start until the owner decides. Do not begin M4 before G1.

## Decisions log
| Date | Decision | Status |
|---|---|---|
| 2026-10-12 | Product direction (V1-SPEC, ROADMAP) approved by owner. Request-and-approve booking, no instant booking, no on-site payments in V1 | **Approved (G0)** |
| 2026-10-12 | Manual availability first-class; external calendar is V1.1 and optional. External-calendar failure must fail safely (never silently show a date available when a required source can't be verified); exact policy decided in M10 | Approved direction |
| 2026-10-12 | Recommended architecture: Cloudflare Pages + Workers + D1 + R2, Access for admin — recommendation only, nothing provisioned | **Unapproved until G1** |
| 2026-10-12 | M1: contact form is validate-only with a truthful "online submission not available yet" message until M5 (flag `INQUIRY_BACKEND_ENABLED` in main.js); no mailto/localStorage workaround | Done |
| 2026-10-12 | M1: collections uses native scrolling (no wheel hijack, no scroll-snap — proximity snap pulled short wheel scrolls back); lightbox gains prev/next/swipe/arrows (supersedes CLAUDE.md's old "no arrows") | Done |
| 2026-10-12 | M1: accessible accent shades (`--color-accent-text`, `--color-accent-deep`) added for WCAG AA; palette direction (G5) still open | Done |
| 2026-10-12 | Owner uses iCloud on iPhone, willing to switch if needed. Work-calendar *server* still unknown | Open (G2) |

## Open owner questions (see ROADMAP gates)
1. G0 approve spec/roadmap? 2. G1 Cloudflare (recommended) vs. the AWS box? 3. G2 where do work events actually live (iPhone → Settings → Calendar → Accounts); is it employer-managed? 4. G3 Wise Agent at V1 or later? 5. G5 palette (green accent vs. CLAUDE.md "no green"), Kaileb photo, testimonials, Weddings stance. 6. G6 where are true originals? 7. G8 lead time, weekly shoot hours, deposit amount/method, cancellation terms, retention periods, discount-code meaning. 8. Is `kailebbeckerphotography.com` owned, and by whom?

## Placeholder values used until G8 is answered (flag in code as `OWNER-DECISION`)
Lead time 7 days (live now as `MIN_LEAD_DAYS` in scripts/main.js — date picker min + validation) · weekday windows after 5:30 pm, weekends all day · buffer 60 min · retention per V1-SPEC F9.

## Milestone status
M1 ☑ · M2 ◐ (infrastructure done; originals needed) · M3 ☐(gate) · M4 ☐ · M5 ☐ · M6 ☐ · M7 ☐ · M8 ☐ · M9 ☐(gate)

## "Continue Photography Website V1" — session procedure
Principle: **STATE → ROADMAP → RELEVANT DOCS → CODEBASE MAP → RELEVANT SOURCE → IMPLEMENT.** Never read the whole repo; the source stays authoritative, the map is only an index.
1. Read this file.
2. Determine the next unblocked milestone (ROADMAP: first in order whose prerequisites/gates are satisfied). If it is 🔴 or its gate is unanswered, ask the owner the specific gate question — or take another unblocked 🟢 milestone.
3. Read only the relevant parts: that milestone's section and gap-matrix rows in `ROADMAP.md`, the matching F-sections in `V1-SPEC.md`, and `ARCHITECTURE.md` only for backend/calendar/security/images work. Skip `AUDIT.md` unless a specific finding is needed.
4. Consult `docs/CODEBASE-MAP.md` to locate the code.
5. Pick the smallest set of source files that could be affected (check the map's coupling notes).
6. Read those files before modifying them (and `git status`; start from a clean tree and green baseline).
7. Implement, test (unit/API; Playwright at 390/768/1440 + keyboard + axe for UI), self-review the diff (`/code-review` low/medium; for auth/PII/calendar/email also check the ARCHITECTURE.md §4 table), fix legitimate findings.
8. Update `CODEBASE-MAP.md` **only if** file responsibilities or important relationships materially changed (new/removed/renamed files, moved ownership). Update `CLAUDE.md`/spec if behavior or scope changed — no drift.
9. Update this file: milestone status, decisions, new owner questions, deviations.
10. Commit (small, descriptive). Then continue to the next safe milestone, or stop with a summary.
Never: deploy, touch DNS, provision services or create production credentials, connect a real calendar, buy services, or implement payments without the matching gate answered here. Never commit secrets or real client data. Subagents only for bounded parallel research/review; one orchestrator owns the plan.

## M2 outcome and G6 (true originals) — PARTIALLY COMPLETE
**Done:** build script + manifest + hashed AVIF/JPEG derivatives (never upscaled, metadata stripped); `<picture>`/srcset/sizes/dimensions for gallery and teasers; hero is now a real `<img fetchpriority=high>` (was a CSS background); collections backgrounds are lazy `<img>` (were CSS backgrounds); lightbox loads larger derivatives sized to the dialog; originals/ vs source/ separation; tests + measurement script.
**Measured (local static server, image bytes per page, before -> after):**
| Page / device | Before | After |
|---|---|---|
| Home, phone 390px@3x | 1451 KB | 464 KB |
| Home, desktop @1x | 1451 KB | 258 KB |
| Gallery, phone full scroll | 5772 KB | 3310 KB |
| Gallery, desktop @1x full scroll | 5772 KB | 757 KB |
| Gallery, desktop @2x full scroll | 5772 KB | 2080 KB |
| Collections, phone | 428 KB | 311 KB |
Lighthouse was not run (spec requires throttled Lighthouse on the production host, M9). Phones in the 1-column gallery still need ~1000 px-wide photos at 3x DPR, so that number only drops further with a lower-quality setting, which was deliberately not done.
**Quality:** AVIF q60 vs the source JPEG compared at 100% on a face crop: no visible difference. Photos are never upscaled, so no fake resolution. The committed sources are *already heavily compressed* (e.g. 2000x3000 at ~160 KB), so any further processing can only preserve, not restore, quality.
**Why PARTIAL:** the sources are not true originals. Concretely, the collections page shows portrait photos full-bleed (`graduations/ButcherJones8` 1088 px wide, `proposals/Proposal1` 1200 px wide) which the browser upscales on a 1440 px+ screen, and the home hero (2400 px) is the largest step available for retina desktops. These cannot be fixed without originals.
**What the owner needs to provide (G6):** the full-resolution exports (not RAW required; JPEG/TIFF/PNG, ideally >= 3000 px on the long edge, sRGB or Adobe RGB, finished edits) of every published photo, at least the ~10 used as collection/hero images first (`graduations/ButcherJones8`, `proposals/Proposal1`, `proposals/Proposal8` (hero), `cars/Car3`), then the rest. Put them in `originals/<category>/<Name>.<ext>` using the *same category folder and base filename as the existing `source/` file* (e.g. `originals/graduations/ASU2.tif`); the folder is gitignored and never committed. Simplest handoff: zip the files, tell Claude the path, and Claude will place them and run `npm run images` (new hashed derivatives replace the old ones automatically). Keep RAW/Lightroom catalog archived separately and privately; Claude never needs RAW. Total storage guidance: keep originals backed up outside the repo (cloud drive or external disk).

## GitHub Pages STAGING (frontend only) — status: LIVE (2026-10-13)
- **Not production.** Staging only; it does not approve G1 or replace the production hosting/backend decision.
- **URL:** https://kailebbecker.github.io/Kaileb-Photography-/ (repo `KailebBecker/Kaileb-Photography-`, now **public**, so full Git history is public; a secrets/PII scan of files and history found nothing; `originals/` is gitignored and was never committed).
- **How it deploys:** `.github/workflows/pages.yml` runs on every push to `main` (or manually: Actions > "Deploy staging to GitHub Pages" > Run workflow). It runs `npm ci`, `npm run images:check` (fails the deploy if derivatives/markup are stale), assembles `_site/` and publishes it with the official Pages actions. Deployed successfully (run 38428306714, commit e2b69a5) after the owner enabled Pages with Source = GitHub Actions.
- **Redeploy:** push to `main`, or Actions > "Deploy staging to GitHub Pages" > Run workflow. A failed deploy usually means the Pages source was changed away from GitHub Actions (Settings > Pages).
- **Published:** `*.html`, `styles/`, `scripts/main.js`, `images/` (generated AVIF/JPEG + SVG placeholders + og-image), `.nojekyll`, a staging `robots.txt` (`Disallow: /`). **Excluded:** `docs/`, `tests/`, `source/`, `originals/`, `scripts/build-images.js` and `measure-images.js`, `images/manifest.json`, `package*.json`, `node_modules`, `.github/`, `CLAUDE.md`, `BACKEND.md`, `sitemap.xml`.
- **Staging-only changes (done in the artifact, not in the repo HTML):** `<meta name="robots" content="noindex, nofollow">` added and `rel=canonical` removed. Production canonical/OG/sitemap values in the repo are untouched. OG URLs still name the production domain, so link previews from the staging URL show production URLs/image.
- **Limits:** `noindex`/robots are requests to crawlers, **not access control**; the staging site is publicly reachable by anyone with the URL. GitHub Pages cannot set cache/security headers (hashed image names mitigate caching), has no backend (contact form stays in its truthful no-backend state), and serves the site under `/Kaileb-Photography-/` — all site paths are relative and verified under a sub-path.
- **Tests against any deployed URL:** `BASE_URL=https://kailebbecker.github.io/Kaileb-Photography-/ npx playwright test` (tests use base-relative paths; image static checks still read the repo).
- **Validated on the live URL:** all 71 Playwright tests (desktop + mobile) pass against it; all six pages, CSS, JS return 200; staging serves `noindex` + `Disallow: /` robots and no canonical; `docs/`, `source/`, `originals/`, `tests/`, `package.json`, `manifest.json`, `sitemap.xml`, build scripts, `CLAUDE.md`, `BACKEND.md` and `.github/` all return 404. Real-iPhone testing is the owner's step.

## Owner decision still required before production launch
The 7-day minimum lead time on the contact date picker (`MIN_LEAD_DAYS` in `scripts/main.js`) is a **placeholder**, not an approved business rule. It must be decided (G8) before production launch; no other placeholder policy is customer-facing.

## Known deferred visual/UX items (from M1 review; not blocking)
- Home hero: green "Becker" wordmark and desktop nav text over bright sky/grass photo regions have low contrast — axe can't measure text over photos; needs eyes + a palette decision (G5).
- Collections header glass gradient has a reddish cast over photos; collections scrim lightened modestly only.
- (Resolved in M2) gallery dimensions/srcset and lightbox derivative sizing.
- Fonts are third-party render-blocking Google Fonts (not in V1 scope unless Lighthouse says otherwise in M9).
- Sage accent remains CLAUDE.md-contradicting (G5).

## Test commands
`npm install && npx playwright install chromium` (once), then `npm test` (desktop + mobile; some tests are project-specific skips; 71 pass after M2). Keep green before every commit.

## Image workflow (M2)
- Add/replace a photo: put the file in `source/<category>/<Name>.jpg` (or the full-res original in gitignored `originals/<category>/<Name>.<ext>`), add `<picture data-photo="<category>/<Name>" data-preset="grid"><img alt="descriptive alt"></picture>` to the page, then `npm run images` (generates AVIF+JPEG derivatives, `images/manifest.json`, and expands the markup; ~2 min for a full rebuild, incremental after). `npm run images:check` verifies freshness (also run by tests). `npm run measure` (with `npm run serve` running) reports image bytes per page/device.
- Never edit generated files in `images/`; commit them with the source change.

## Session log
- 2026-10-12: Audit, spec, architecture, roadmap written (no application code changed).
- 2026-10-12: Direction approved (G0). Added `CODEBASE-MAP.md`; progressive context-loading procedure; calendar-failure wording changed to fail-safe/deferred-to-M10; Architecture marked unapproved until G1.
- 2026-10-12: M1 front-end hardening done. Truthful interim contact form; native-scroll collections; reveal/typewriter progressive enhancement; 44px touch targets; focus-visible; lightbox prev/next/swipe/trap; gallery jump-nav; AA contrast shades; Playwright+axe suite (55 passing). No backend/hosting/booking/availability/payments work.
- 2026-10-13: M2 image pipeline built (AVIF + JPEG fallback, hashed, manifest-driven `<picture>` markup, hero/collections as real images, lightbox sizing). Marked PARTIAL pending true originals (G6). 71 tests pass.
- 2026-10-13: Added GitHub Pages staging workflow (build verified in CI; deploy waits on owner enabling Pages). Tests now run against a base URL / sub-path. Repo made public by owner.
- 2026-10-13: Staging LIVE at https://kailebbecker.github.io/Kaileb-Photography-/ ; live-URL validation passed (71 tests).
