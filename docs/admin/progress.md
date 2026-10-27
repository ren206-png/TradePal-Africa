# Admin console: progress

Branch: `feat/admin-console`. Last updated: 2026-10-27 (end of Phase 5). Status words: **done** = built and tested locally; **not started**; **stub** = a truthful "not available" state. Nothing here is deployed or run in production.

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

## Phase 2: owner bootstrap, staff sign-in, MFA, recovery

| Requirement | Implementation | Test | Status |
|---|---|---|---|
| Admin sign-in with an active staff account + completed second factor, checked on every privileged request | `src/admin/adminAuthRoutes.ts`, `authMiddleware.ts` (`requireAdminAuth`, `requireMfaComplete`) | `tests/adminSignIn.test.ts` | done |
| Distinct admin session type, absolute 12 h / idle 30 min / half-open 15 min, revocation | `AdminSession`, `src/admin/adminSessions.ts`, audience claim `tradepal-admin` | `tests/adminSignIn.test.ts` (idle, absolute, half-open, sign-out, wrong audience, no session) | done (bearer token, not a cookie: see `security.md`) |
| Re-authentication window (10 min) for sensitive actions | `requireRecentReauth`, `POST /admin/session/reauth` | `tests/adminSignIn.test.ts` | done; applied to staff and ownership changes |
| TOTP MFA, encrypted secret, replay guard, 8 hashed single-use recovery codes | `src/admin/mfa.ts` (otplib v13, AES-256-GCM) | `tests/adminSignIn.test.ts` | done |
| Rate limits on sign-in, second factor, re-auth, invitation redemption (shared store when Redis is on) | `adminAuthRoutes.ts`, `staffAdmin.ts`, `server.ts` | `tests/adminSignIn.test.ts` (per email, per address, per admin) | done; in-memory unless `RATE_LIMIT_BACKEND=redis` |
| Generic errors, no enumeration | identical 401; identical invitation failures | `tests/adminSignIn.test.ts`, `tests/adminStaff.test.ts` | done |
| Recovery without a public bypass | recovery codes; `scripts/resetAdminMfa.ts` (audited, gated, identity typed twice) | `tests/adminStaff.test.ts` | done |
| First-owner bootstrap command | `scripts/bootstrapOwner.ts` + `src/admin/ownerBootstrap.ts` | `tests/adminStaff.test.ts` | done (domain functions tested; the thin script wrapper was run only for its usage message) |
| Invitations (hashed, expiring, single-use, email-bound) and ownership transfer (two-step, one open) | `src/admin/staffAdmin.ts` | `tests/adminStaff.test.ts` | done; the link is shown once, no email is sent |
| Last-owner protection | DB trigger (Phase 1) + API error mapping | `tests/adminFoundation.test.ts`, `tests/adminStaff.test.ts` | done |
| Security events (sign-in, MFA, denied access, staff changes) without secrets | `src/admin/securityEvents.ts` | `tests/adminSignIn.test.ts` | done |
| Master switch, `no-store` | `src/admin/mount.ts` | `tests/adminStaff.test.ts` | done; **off by default: the live console needs `ADMIN_CONSOLE_ENABLED=true` at release** |
| Queued admin actions re-check the actor | `src/admin/actorRevalidation.ts` | `tests/adminStaff.test.ts` | done (no queued admin job exists yet; first user will be refunds in Phase 3) |
| Sign-in screens: login, authenticator setup and challenge, recovery code, invitation page, re-confirmation prompt | `admin-frontend/src/pages/MfaPage.tsx`, `AcceptInvitePage.tsx`, `GuardPrompts.tsx` | 13 new tests in `admin-frontend` | done |
| Direct links (such as `/login`) no longer 404 on the admin site | `admin-frontend/vercel.json` | not tested here (needs a deploy) | done in code; **not deployed** |

## Phase 3: modules

The Phase 0 audit found most modules already existed, so Phase 3 closed gaps in them rather than rebuilding them. `GET /admin/modules` reports, for every module, whether it is switched on and how much is really built (so the console never shows a finished-looking module that is not).

| Module (switch) | State | What Phase 3 added | Not built (truthful) |
|---|---|---|---|
| Staff access (`STAFF`) | **available** | Staff, invitations, roles, account status, session revocation, ownership transfer, security events: API (Phase 2) and the console page `Staff access` | none |
| Audit (`AUDIT`) | **available** | Filters: actor, actor type, action (prefix or exact), target type and id, business, outcome, request id, date range; the new reason, result and request-id columns are returned | none |
| System health (`HEALTH`) | **available** | Per provider: last success and the last 24 h of refusals, split into rejected key (401/403), missing balance (402) and other; configuration presence (yes/no, never a value) including the deployment-level pawaPay activation flag, shown read-only | Anthropic reports "no credit" as HTTP 400, which the ledger cannot separate from other bad requests (it is classified at call time into its own incident); whether an external monitor polls `/heartbeat` is not visible from here |
| Merchants (`MERCHANTS`) | **partial** | The list and detail routes now need `admin:view_orgs` for roles added after the original four (R3 from Phase 0 closed) | Approve or reject with recorded verification evidence; the distinction between a security suspension and a subscription lapse is documented, not a new screen |
| Subscriptions (`SUBSCRIPTIONS`) | **partial** | Least-privilege guard on the legacy reads | Complimentary access grants: the table and its database rules exist, but there is no workflow and entitlement checks do not read it |
| Refunds (`REFUNDS`) | **available** | Two-person approval for subscription refunds: request, approve exactly the shown fingerprint, reject, cancel, run. Separate permissions; self-approval refused by the database; execution OFF by default (`ADMIN_REFUND_EXECUTION_ENABLED`) and re-checks the person, role and fingerprint at run time; the older single-person routes refuse while the module is on. Console page `Refund requests` | Merchant sales refunds are the merchant's own and intentionally not here |
| Orders and support (`ORDERS`), Moderation, WhatsApp, Payments | existing, unchanged | Least-privilege guard on the legacy reads; pinned route inventory for the two newest roles | **Payments is partial**: no real sales-payment provider is connected, so monitoring only works against the simulator |
| Config (`CONFIG`) | **partial** | none | Validated country, currency and timezone settings |
| Reports (`REPORTS`) | **not built** | none | Exports with expiring download links; XLSX. (CSV exports with formula-safe cells already exist inside their own modules) |
| Overview (part of `HEALTH`) | existing | none | Panels separating test data, merchant sales volume and billing receipts were not added; recognized revenue is not implemented and is deliberately not shown |

Other Phase 3 changes: per-module switches (`ADMIN_MODULE_*`, all off by default; the module of every route is decided in one place, `src/admin/moduleGate.ts`, and a route with no rule is closed by default); the console hides navigation a person cannot use (the four original roles keep the items they always had); `tests/adminModules.test.ts` pins exactly which routes the moderator and finance roles can reach.

## Phases 4 and 5: hardening, tests, handoff

| Item | Result |
|---|---|
| Atomic change + audit record | Done for staff, invitation, ownership and refund steps (same transaction). Refund execution is the one two-step case (provider call, then mark), documented in `security.md` |
| Input validation | `zod` on the new routes, unknown keys rejected |
| UX | Console: authenticator, recovery, invitation, staff access and refund screens; navigation hides what a person cannot use; environment badge; stale-session and re-confirmation prompts. Not built: a persistent "selected organization / currency / scope" header (the console has no global organization selector) |
| Adversarial self-check | 14 scenarios, each with a test or an existing test cited: `security.md` |
| Site headers | Added in `admin-frontend/vercel.json`; no Content-Security-Policy (follow-up) |

### The 16 verification items

| # | Item | Test evidence |
|---|---|---|
| 1 | Anonymous, consumer and merchant cannot reach admin pages, APIs, exports, storage or privileged database operations | `securityAdminRoutes` (every route rejects every way of not being signed in, read from the router itself), `adminHardening` 2, `adminSignIn` (audience, no session), `dbProtection` and `adminFoundation` (database refusals, row-level isolation) |
| 2 | Forged roles, profile edits, tenant ids and direct URLs cannot escalate | `adminHardening` 1, `securityAdminRoutes` (role lowered, account removed) |
| 3 | MFA, recovery, invitation expiry and reuse, safe redirect, session lifetime, re-auth windows, rate limits | `adminSignIn`, `adminStaff`, `LoginPage.test.tsx` |
| 4 | Revoked or demoted staff lose permissions on the next request; queued actions are re-validated | `adminStaff`, `adminRefunds`, `adminHardening` 3 |
| 5 | Every role's allowed actions succeed and denied ones fail | `permissions`, `adminModules` (pinned inventory for the two new roles), the existing per-panel admin tests for the original four. **Field-level masking and exports by role: not built** (see permission-matrix.md) |
| 6 | Merchant A cannot reach merchant B's private records through any path this task introduced | No new route takes a merchant identity; the new admin routes are platform-level. Existing tenant isolation tests unchanged and passing |
| 7 | Last-owner protection under concurrent demotion | `adminFoundation` and `adminHardening` 4 (real Postgres; skipped in the in-process run) |
| 8 | Duplicate callbacks, retries, approvals and refund requests cannot duplicate effects or exceed refundable balances | `adminRefunds`, `paymentWebhook`, `adminPayments` |
| 9 | pawaPay billing and merchant sales stay separate; no console action bypasses activation | `adminHardening` 9, `purposeBoundary`, `billingRenewal` |
| 10 | Subscription expiry and provider-disable switches preserve servicing of existing transactions | Existing billing tests, unchanged and passing (`billingRenewal`, `billingEntitlements`) |
| 11 | Suspended listings are blocked via public direct URLs as well as search | Existing marketplace and storefront tests, unchanged and passing; not re-examined separately by this task |
| 12 | Sensitive actions emit protected audit events without credentials | `adminStaff`, `adminSignIn` (no secrets in any security row), `adminRefunds` |
| 13 | Sign-out, shared device, cache headers, private downloads | `adminHardening` 10 and 11, `AuthContext.test.tsx` |
| 14 | Existing merchant sign-in, storefronts, checkout, subscriptions and WhatsApp workflows pass regression | The whole backend suite (below) |
| 15 | With `ADMIN_CONSOLE_ENABLED` unset every admin route and job is inert | `adminStaff` (master switch). No admin background job exists in this codebase, so there is none to silence |
| 16 | Route inventory finds no unguarded route | `adminModules` (every route has a module or is self-service; the module of an unknown path is closed) and `securityAdminRoutes` (every route rejects an unauthenticated caller) |

## Final checks (2026-10-27)

| Command | Result |
|---|---|
| `tsc` type check (stray ` 2` duplicate files excluded with a temporary config) | exit 0 |
| `npx vitest run` (in-process database) | 1432 passed, **2 failed (pre-existing)**, 9 skipped |
| `TEST_PG_ADMIN_URL=... npx vitest run --no-file-parallelism` (real Postgres 18.4, scratch server) | 1441 passed, **2 failed (pre-existing)**, 0 skipped. This run includes the concurrent last-owner races |
| `admin-frontend`: `npx vitest run`, `npx tsc -b`, `npx vite build` | 84 tests passed; type check and build pass |
| `scripts/rehearseMigrations.sh` (non-superuser, full chain including the three admin migrations) | REHEARSAL OK |
| Owner commands end to end against a scratch database | refused without the gate; refused on a mismatched confirm; promoted once; no-op the second time; MFA reset worked; audit rows and security events written with actor `system:bootstrap` |
| Lint | not run: the repo has no lint script (the frontend has `oxlint` configured but it was not run) |
| Production build to a temp folder | passed earlier (Phase 1); not re-run after Phases 2 to 4 beyond the type check |

The two failing tests are the same ones found in Phase 0 and are unrelated: `tests/messaging.test.ts` (a stray duplicate `transport 2.ts`) and `tests/reorderTier1.test.ts` (a date-pinned fixture).

## What shipped, by module

Shipped: Staff access, Audit, System health, Refund requests (two-person). Partly: Merchants, Subscriptions, Payments, Config. Existing and unchanged apart from least-privilege guards: Moderation, Orders and support, WhatsApp. **Not built (truthful `GET /admin/modules` states):** verification evidence for merchants, complimentary access grants workflow, validated configuration settings, exports with expiring downloads, platform-wide PII masking with audited unmask, a read-one-conversation view, emailing of invitations.

## Remaining owner actions

1. Decide about the 236 stray duplicate `* 2.*` files in the working folder (they break one test and the plain `tsc`); they are untracked and were not touched.
2. Set `ADMIN_MFA_ENCRYPTION_KEY` (generate it yourself), then the module switches you want, then `ADMIN_FRONTEND_PUBLIC_URL`, then `ADMIN_CONSOLE_ENABLED=true`, in that order (`release-runbook.md`). Until then the live admin API is switched off by design.
3. Each existing owner signs in, sets up the authenticator and saves the recovery codes.
4. Take a fresh backup, confirm the Postgres version is 12 or newer, and rehearse on a restored copy of that backup before release.
5. Deploy the admin site (so `vercel.json` and the new screens go live).
6. Decide whether to switch on `adminStepUp` and `adminSupportAccessRequired` (database flags, both off today).
7. Do not set `ADMIN_REFUND_EXECUTION_ENABLED` until real refunds are meant to move money.
8. Plan a human penetration test and add a Content-Security-Policy for the admin site.
