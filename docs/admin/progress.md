# Admin console: progress

Branch: `feat/admin-console`. Last updated: 2026-10-27 (end of Phase 1). Status words: **done** = built and tested locally; **not started**; **stub** = a truthful "not available" state. Nothing here is deployed or run in production.

Design decisions taken (defaults, confirmed by "go ahead" on 2026-10-27; revisit at any point): extend the existing admin system, do not rebuild; keep `AdminUser` as the staff identity; add `FINANCE_ADMIN` and `MODERATOR` to the existing four roles and use the brief's names as labels; keep the single `admin:` permission vocabulary.

## Phase 0

| Requirement | Implementation | Test / evidence | Status |
|---|---|---|---|
| Read-only audit with citations | `docs/admin/PHASE_0_FINDINGS.md` | baseline: typecheck pass, build pass, tests 1346 pass / 2 pre-existing failures | done |

## Phase 1: authorization model, data model, migrations

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Staff roles, deny by default, server-side resolution | `AdminRole` + `PLATFORM_MATRIX` (`src/auth/permissions.ts`); role read from DB each request (existing, `src/admin/authMiddleware.ts:49`) | `tests/permissions.test.ts` | done |
| Named permissions for the new modules | 12 new `admin:` permissions; mapping in `docs/admin/permission-matrix.md` | `tests/permissions.test.ts` (owner-only, refund split, new roles) | done |
| Step-up on every sensitive permission | new non-view permissions added to `PLATFORM_STEP_UP_PERMISSIONS` | `tests/permissions.test.ts` ("requires step-up for every permission that changes anything") | done |
| One guard function on every admin route + inventory test | **not started** (Phase 2/5) | n/a | not started |
| Staff assignment history, current role single-sourced | `StaffRoleChange` (append-only) + `AdminUser.role`/`roleVersion` | `tests/adminFoundation.test.ts` | done (table); writer code in Phase 2 |
| Invitations (hashed, expiring, single use, email-bound) | `StaffInvitation` + constraints | `tests/adminFoundation.test.ts` | done (table); flow in Phase 2 |
| Security events, no secrets | `SecurityEvent` (append-only, checked values) | `tests/adminFoundation.test.ts` | done (table); writers in Phase 2 |
| Admin audit: append-only, no UPDATE/DELETE for the app | existing `AuditLog` trigger (unchanged) + new typed columns (`reason`, `result`, `correlationId`, `ipHash`). Enforced by **trigger** (not by grants); documented in the runbook | `tests/adminFoundation.test.ts` ("audit table kept its protection") | done |
| Two-person approval, frozen payload, no self-approval | `ApprovalRequest` + checks + `tradepal_approval_guard` | `tests/adminFoundation.test.ts` (4 tests) | done (table); workflow in Phase 3 |
| Complimentary access with reason and end date | `EntitlementGrant` + guard + tenant RLS | `tests/adminFoundation.test.ts`; `tests/dbProtection.test.ts` (RLS list stays in step) | done (table); grant workflow in Phase 3 |
| Last-owner protection under concurrency | `tradepal_admin_user_guard` with an advisory lock | `tests/adminFoundation.test.ts` (PGlite: refusals; **real Postgres: 12 concurrent rounds, exactly one succeeds**) | done |
| Ownership transfer two-step, one open | `OwnershipTransfer` + guard | `tests/adminFoundation.test.ts` | done (table); flow in Phase 2 |
| Server-side sessions for idle/absolute/reauth | `AdminSession` (admin audience only) | `tests/adminFoundation.test.ts` | done (table); use in Phase 2 |
| Second factor storage (encrypted secret, replay counter, one live factor) | `AdminMfaFactor`, `AdminRecoveryCode` | `tests/adminFoundation.test.ts` | done (tables); code in Phase 2 |
| Migration additive, rehearsed, with rollback and runbook | `prisma/migrations/20261102000000_admin_console_foundation/` ; `docs/admin/release-runbook.md` | scratch Postgres 18.4: full-chain rehearsal, upgrade rehearsal in one transaction, drift test, protection test | done locally; production rehearsal on a restored backup **not run** |

## Checks run at the end of Phase 1 (2026-10-27)

| Command | Result |
|---|---|
| `tsc` type check (the stray ` 2` duplicate files excluded with a temporary config; see risk R1) | exit 0 |
| `tsc` build to a temp folder (same exclusion) | exit 0 |
| `npx vitest run` (in-process database) | 1362 passed, 2 failed, 8 skipped (126 files) |
| `TEST_PG_ADMIN_URL=... npx vitest run --no-file-parallelism` (real Postgres 18.4, scratch server) | 1370 passed, 2 failed, 0 skipped, including the concurrent last-owner race |
| `scripts/rehearseMigrations.sh` (non-superuser, empty database) | REHEARSAL OK |
| Upgrade rehearsal in one transaction on a database with existing staff and audit rows | applied; rows unchanged |
| Lint | not run: the repo has no lint script |

The two failures are the same pre-existing ones as in Phase 0 (a stray duplicate `transport 2.ts` file; the date-pinned `reorderTier1` test). With the plain `tsc -p tsconfig.json` the stray `src/auth/permissions 2.ts` duplicate now also fails to compile (it has the old four-role matrix), which is risk R1 in action: those untracked duplicates should be deleted.

## Remaining work

Phase 2 (sign-in, MFA, recovery, bootstrap command, invitations, ownership transfer, session rules, security-event writers); Phase 3 (module gaps in the existing admin API; refunds under two-person approval; exports; flags); Phase 4 (hardening, adversarial checks); Phase 5 (tests, handoff docs). Owner-side items so far: none.
