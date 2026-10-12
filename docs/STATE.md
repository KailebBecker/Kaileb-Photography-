# Project State & Autonomous Workflow

**Update this file at the end of every session. It is the only place that tracks progress.**
Last updated: 2026-10-12 · Phase: **Product direction approved (G0 ✔). Hosting/backend (G1) still UNAPPROVED. Next: M1**

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
**M1 — Front-end hardening** (🟢 autonomous; G0 approved). M3/G1 (host decision) can be decided in parallel; M4 cannot start until it is.

## Decisions log
| Date | Decision | Status |
|---|---|---|
| 2026-10-12 | Product direction (V1-SPEC, ROADMAP) approved by owner. Request-and-approve booking, no instant booking, no on-site payments in V1 | **Approved (G0)** |
| 2026-10-12 | Manual availability first-class; external calendar is V1.1 and optional. External-calendar failure must fail safely (never silently show a date available when a required source can't be verified); exact policy decided in M10 | Approved direction |
| 2026-10-12 | Recommended architecture: Cloudflare Pages + Workers + D1 + R2, Access for admin — recommendation only, nothing provisioned | **Unapproved until G1** |
| 2026-10-12 | Owner uses iCloud on iPhone, willing to switch if needed. Work-calendar *server* still unknown | Open (G2) |

## Open owner questions (see ROADMAP gates)
1. G0 approve spec/roadmap? 2. G1 Cloudflare (recommended) vs. the AWS box? 3. G2 where do work events actually live (iPhone → Settings → Calendar → Accounts); is it employer-managed? 4. G3 Wise Agent at V1 or later? 5. G5 palette (green accent vs. CLAUDE.md "no green"), Kaileb photo, testimonials, Weddings stance. 6. G6 where are true originals? 7. G8 lead time, weekly shoot hours, deposit amount/method, cancellation terms, retention periods, discount-code meaning. 8. Is `kailebbeckerphotography.com` owned, and by whom?

## Placeholder values used until G8 is answered (flag in code as `OWNER-DECISION`)
Lead time 7 days · weekday windows after 5:30 pm, weekends all day · buffer 60 min · retention per V1-SPEC F9.

## Milestone status
M1 ☐ · M2 ☐ · M3 ☐(gate) · M4 ☐ · M5 ☐ · M6 ☐ · M7 ☐ · M8 ☐ · M9 ☐(gate)

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

## Session log
- 2026-10-12: Audit, spec, architecture, roadmap written (no application code changed).
- 2026-10-12: Direction approved (G0). Added `CODEBASE-MAP.md`; progressive context-loading procedure; calendar-failure wording changed to fail-safe/deferred-to-M10; Architecture marked unapproved until G1.
