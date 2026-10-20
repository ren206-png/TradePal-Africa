# Phase 9 self-check (release package)

Date: 2026-10-20 · branch `expansion/phase-1` (local only: **not pushed, not merged, nothing deployed, no real migration**) · status vocabulary per master prompt section 0.11.

Delivered: the release package: a demo that runs the whole flow and checks every admin panel; the missing System-health controls; six runbooks; the money-flow and ownership diagram; refund and cancellation rules; a country configuration guide with local-review dependencies; the requirement status matrix; the product-measurement plan; a truthful-copy audit; real test output; `.env.example` completed and tested; and the final handoff. **Nothing is above `locally tested`, and `status-matrix.md` says so.**

## 0. Test evidence
| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **114 files / 1257 tests pass** (Phase 8 ended at 111 / 1248) |
| `admin-frontend` `npx vitest run` + `npm run build` | 14 files / 59 tests pass; build succeeds |
| New in Phase 9 | `adminOps` 6, `demoRelease` 1, `envExample` 3 (+ 2 frontend); full output in `test-evidence.md` |

## 1. Failure scenarios

### F1. The runbooks are wrong, because nobody has run them
- None of the six runbooks was executed end to end: the sandbox verification needs a pawaPay sandbox that does not exist; production activation and rollback were not rehearsed; the incident runbook's first action (the alert path) was tested only with a stubbed email service.
- One rollback claim is **explicitly untested**: that the previous build runs against the new, additive schema. The new append-only and no-delete triggers could reject an operation the old build performs. `rollback.md` says so and gives the check (migrate a scratch copy, then smoke-test the old build).
- Expect each runbook to need correction on first real use. The first person to follow one should write down every deviation.

### F2. The demo proves less than it looks like it proves
- It runs on the simulator and an in-memory pawaPay fake that **we** wrote; a pass says the pieces work together, not that any provider will accept them. The panel check asserts a panel returns rows, **not that the rows are right**.
- Running it found a real defect: the payment-reconciliation report counted a **held** (late) payment as applied. Fixed and covered by the demo test. That one slipped past 20 report tests, so other report definitions may hold similar surprises that only a real merchant's data would expose.
- The demo's data is tidy (one seller, a handful of orders). It says nothing about scale, messy history or two people acting at once.

### F3. A promised admin control does not exist
- Section 18 lists controls that were **not built**: hard-deleting a synthetic org, anonymizing an org, forcing a password reset, "re-run reconciliation" from the console; admin disable exists only as a script. They are listed in `status-matrix.md` and `handoff.md`, not hidden. Added this phase: pause/resume a job class, synthetic incident, revoke a business's phone sessions.
- Job pausing: the pause check is one line in each of six places and only the operations sweep is exercised by a test through its real tick; the other five rely on the same code pattern (the hourly workers return a "paused" result, which BullMQ records as a completed job). A pause does not stop a run already in progress. A failed read of the pause state **runs** the job (fails open, deliberately).

### F4. Public copy says something untrue
- The landing FAQ and privacy edits are in the repository only. If they are deployed **before** shop orders exist they describe a feature that is not live; if consumer messaging is turned on **before** they are deployed, the site still says TradePal "never" messages customers (the old text). The activation runbook orders this correctly, but it depends on a person doing it in order.
- Pricing has two sources that disagree in kind: the landing page and legacy plan table say ₦5,000 for Starter; the new plan versions have no prices. The owner must pick which is authoritative before billing opens.
- The sale-receipt reply still says "TradePal cannot message customers directly". True today; revisit it when shopper messages go live.

### F5. The status matrix is optimistic or wrong
- It is my own assessment, not an independent review. Rows marked `locally tested` mean tests exist and pass here, not that the tests are sufficient; each phase's self-check lists what remained unverified for that area and is the better source.
- Some rows hide a large caveat in one clause (RLS is inert in production; online shop payment is the simulator only; forecast accuracy on real data is unknown). A reader who skims the status column will overrate the system.

### F6. The measurement plan is mistaken for measurement
- Nothing is instrumented. Two metrics cannot be computed even with a query: merchant-link versus marketplace-acquired consumers (no acquisition source is recorded) and repeat ordering (B2C buyers are identified only by phone number). People time for support effort is not recorded. No pilot target has been set, by design.

### F7. The release is mistaken for being ready to ship
- Blockers remain that code cannot remove: no merchant payment provider, no pawaPay sandbox or approval, no approved WhatsApp template, no real-Postgres migration rehearsal, no measurement on low-end phones or real networks, no human security review, and a set of undecided product questions (OPEN list). `handoff.md` section 3-4 lists them in order.

### F8. Existing behaviour regressed
- With every flag off the whole pre-expansion suite passes, and the migration rehearsal runs the bot's real commands against migrated legacy data. New always-on changes since Phase 7 are listed in `self-check-phase-8.md` (compression for secret-free pages, NUL-byte refusal, admin account re-check, paid-invoice backfill) plus this phase's one: a new `JobControl` table whose absence never stops a job.

## 2. Master-prompt deliverables (section 22)
| Deliverable | Where |
|---|---|
| Source integrated into existing navigation, commands, APIs | the branch |
| Schema, migrations, synthetic seed data, config examples without secrets | `prisma/migrations/`, `scripts/demoRelease.ts`, `.env.example` (+ `envExample.test.ts`) |
| Tests with actual output, remaining failures and external limits | `test-evidence.md` |
| Findings, decisions, progress, self-checks, traceability | `PHASE_0_FINDINGS.md`, `decisions.md`, `progress.md`, `self-check-phase-1..9.md`, `traceability.md` |
| Data-model and money-flow diagrams with ownership boundaries | `data-model.md`, `money-flow.md` |
| Provider matrix; pawaPay audit and activation checklist | `merchant-provider-matrix.md`, `pawapay-audit.md` |
| Permission matrix, posting examples, state tables, refund/cancellation rules, admin delete/void rules | `permission-matrix.md`, `accounting-postings.md`, `state-transitions.md`, `refund-cancellation-rules.md`, `admin-delete-void-rules.md` |
| Admin console, every panel populated in the demo; forecast scoring report | `demoRelease.ts` / `demoRelease.test.ts` (18 panel checks, forecast scores) |
| Country guide and local-review dependencies | `country-configuration-guide.md` |
| Consent/template register; truthful copy | `message-template-register.md`, `product-copy.md` |
| Runbooks | `runbooks/` (six) |
| Demo | `scripts/demoRelease.ts` |
| Final handoff | `handoff.md` |
| Measurement (section 23) | `measurement-plan.md` (specified, not instrumented) |

## 3. Owner decisions and actions
The full ordered list is `handoff.md` sections 3-4. The three that unblock the most: choose a merchant-sales provider (OPEN-4); provide a pawaPay sandbox token and run `sandbox-verification.md`; restore a backup and run `scripts/rehearseMigrations.sh`.

## 4. What was and was not touched
Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access; no message to anyone; no real money. Throwaway local servers with synthetic data were run for the demo and stopped; the built-in browser was pointed at them only. `.env.example` gained variable names with no values.

AWAITING: APPROVED: PHASE 9
