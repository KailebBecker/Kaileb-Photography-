# Project State & Autonomous Workflow

**Update this file at the end of every session. It is the only place that tracks progress.**
Last updated: 2026-10-12 · Phase: **Planning complete, awaiting owner review (G0)**

## Doc map (each fact lives in exactly one place)
| File | Controls |
|---|---|
| `CLAUDE.md` | Existing-site conventions (categories, page behavior, SEO rules). Keep accurate when behavior changes |
| `docs/AUDIT.md` | Evidence snapshot of the pre-V1 product (do not repeat the audit) |
| `docs/V1-SPEC.md` | What V1 is: features, booking model, availability rules, acceptance criteria, V1.1/V2 scope |
| `docs/ARCHITECTURE.md` | Hosting choice, images, calendar integration design, security controls |
| `docs/ROADMAP.md` | Gap matrix, owner gates, milestones in order |
| `docs/STATE.md` | Current milestone, decisions made, open questions, session log |
| `BACKEND.md` | Legacy notes (Wise Agent, AWS box). Superseded by ARCHITECTURE.md once G1/G3 decided |

## Next milestone
**On owner approval (G0): M1 — Front-end hardening** (🟢 autonomous). M3/G1 (host decision) can be decided in parallel; M4 cannot start until it is.

## Decisions log
| Date | Decision | Status |
|---|---|---|
| 2026-10-12 | Request-and-approve booking, no instant booking, no on-site payments in V1 | Proposed |
| 2026-10-12 | Manual availability first-class; external calendar is V1.1 and optional | Proposed |
| 2026-10-12 | Recommended architecture: Cloudflare Pages + Workers + D1 + R2, Access for admin | Proposed (G1) |
| 2026-10-12 | Owner uses iCloud on iPhone, willing to switch if needed. Work-calendar *server* still unknown | Open (G2) |

## Open owner questions (see ROADMAP gates)
1. G0 approve spec/roadmap? 2. G1 Cloudflare (recommended) vs. the AWS box? 3. G2 where do work events actually live (iPhone → Settings → Calendar → Accounts); is it employer-managed? 4. G3 Wise Agent at V1 or later? 5. G5 palette (green accent vs. CLAUDE.md "no green"), Kaileb photo, testimonials, Weddings stance. 6. G6 where are true originals? 7. G8 lead time, weekly shoot hours, deposit amount/method, cancellation terms, retention periods, discount-code meaning. 8. Is `kailebbeckerphotography.com` owned, and by whom?

## Placeholder values used until G8 is answered (flag in code as `OWNER-DECISION`)
Lead time 7 days · weekday windows after 5:30 pm, weekends all day · buffer 60 min · retention per V1-SPEC F9.

## Milestone status
M1 ☐ · M2 ☐ · M3 ☐(gate) · M4 ☐ · M5 ☐ · M6 ☐ · M7 ☐ · M8 ☐ · M9 ☐(gate)

## "Continue Photography Website V1" — session procedure
1. Read this file, then `ROADMAP.md` (gaps + gates), then the `V1-SPEC.md` sections for the milestone. Read `ARCHITECTURE.md` only for backend/calendar/security/images milestones. Do not re-read AUDIT.md unless a finding is relevant.
2. `git status`; confirm clean tree and green tests/baseline.
3. Pick the first milestone in order whose prerequisites and gates are satisfied. If the next one is 🔴 or its gate is unanswered, stop and ask the owner the specific gate question(s) — or take a different 🟢 milestone that is unblocked.
4. Plan briefly (scope, files, tests). Implement only that milestone; no drive-by refactors.
5. Test: unit/API tests, Playwright at 390/768/1440 for UI, keyboard pass, axe; fix failures.
6. Self-review the diff (use `/code-review` low/medium), fix legitimate findings. For auth, PII, calendar, or email work also run a security pass against the ARCHITECTURE.md §4 table.
7. Commit (small, descriptive). Update this file: milestone status, decisions, any new owner questions, deviations from spec (and update the spec if it changed — don't leave drift).
8. Continue to the next safe milestone, else stop with a summary.
Never: deploy, touch DNS, create production credentials, connect a real calendar, buy services, or implement payments without the matching gate being answered in this file. Never commit secrets or real client data. Use subagents sparingly (parallel research/review only); one orchestrator owns the plan.

## Session log
- 2026-10-12: Audit, spec, architecture, roadmap written (no application code changed).
