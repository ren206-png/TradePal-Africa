# Admin backend: Phase 0 findings (read-only audit)

Date of audit: 2026-10-27. Branch at audit time: `main` at `04cec5b`. Nothing was changed except this file.
Every claim below carries a `path:line` reference or says it was run/not run. "Not found" means a search of `src/`, `prisma/schema.prisma`, `scripts/` and `docs/` found nothing; it is not proof of absence elsewhere.

## 0. The headline finding

**A platform-admin backend already exists and is large.** The brief is written as if staff sign-in, a staff permission model, an audit trail and most admin modules are missing. They are not. The repo already has (all `locally tested`, per `docs/expansion/status-matrix.md:77-86`):

- a separate staff identity (`AdminUser`, bcrypt, `AdminRole`) and an HTTP admin API under `/admin` (about 5,700 lines in `src/admin/`),
- a platform permission matrix (`PLATFORM_PERMISSIONS`, 29 `admin:*` permissions, `src/auth/permissions.ts:78-135`), with step-up (password re-confirmation) and time-boxed "support access" with a recorded reason (`src/admin/platformGuards.ts:11-120`),
- an append-only audit table (`AuditLog`, DB trigger) and per-write audit with correlation ids (`src/admin/adminAudit.ts:56`),
- admin API modules for transactions, reorder, support cases, payments, moderation, subscriptions, ops/system health, messaging (`src/admin/platformAdmin.ts:61-69`),
- a React admin console (`admin-frontend/`, 16 pages plus the login page, `admin-frontend/src/App.tsx:30-190`).

What is genuinely **missing** against the brief: MFA of any kind, staff invitations, an `ADMIN_CONSOLE_ENABLED` master flag and per-module flags, a distinct session type with idle timeout and re-auth windows, security-event logging of sign-ins, two-person approval, a bootstrap command for the first owner, and several of the brief's roles. The right Phase 1 is therefore **extend**, not **build**. This is the first design fork for you (section 9, Q1).

## 1. Stack (all detected, nothing assumed)

| Area | Finding | Evidence |
|---|---|---|
| Language/runtime | TypeScript (ES2022, `NodeNext`, strict, `exactOptionalPropertyTypes`), Node 20 | `tsconfig.json:3-12`, `Dockerfile` (`node:20-slim`) |
| Web framework | Express 4 + `helmet` + `cors` | `src/server.ts:2-6,128` |
| ORM / DB | Prisma 6 on PostgreSQL; 30 migrations; 128 models | `prisma/migrations/` (30 migration directories), `prisma/schema.prisma` |
| Queue / jobs | BullMQ on Redis; 4 worker processes + `server` | `src/queue/*.ts`, `package.json:5-14` scripts, `Dockerfile` header |
| Validation | `zod` (already standard, e.g. `loginBodySchema`) | `src/admin/adminRoutes.ts:61` |
| Tests | Vitest, PGlite in-process DB by default, real Postgres via `TEST_PG_ADMIN_URL` | `vitest.config.ts`, `tests/helpers/db.ts` |
| Deploy | Railway: server + 4 workers + Postgres + Redis (project `noble-dedication`); landing site on Vercel | `Dockerfile` header; Railway CLI (seen 2026-10-24) |
| Admin UI | Vite + React + TypeScript SPA, separate package, deployed to Vercel (`admin.tradepalafrica.com`, also `admin-frontend-pipe-field-os-pro.vercel.app`) | `admin-frontend/README.md`, `src/server.ts:219` (`ADMIN_FRONTEND_ORIGINS`) |
| Lint | **No lint script exists** | `package.json:3-14` (no `lint`) |

Production reality that differs from the code: the **deployed** admin console shows 6 sections (Businesses, Deletion requests, Audit logs, Mobile money alerts, Plans, Feature flags), while `admin-frontend/src/App.tsx:30-190` routes 16. The deploy is older than the code (observed 2026-10-26 in the signed-in login screen). Also, direct deep links such as `/login` return a Vercel 404 because the project has no SPA rewrite (`admin-frontend/` contains no `vercel.json`; observed 2026-10-26).

## 2. Authentication

- **Staff identity is its own store**, not the merchant identity: `AdminUser { id, email @unique, name, role, passwordHash, createdAt, disabledAt }` (`prisma/schema.prisma:338-348`). It is excluded from tenant scoping on purpose (`src/db/tenantScope.ts:3-8`).
- **Password**: bcrypt cost 12 (`src/admin/auth.ts:5,8-14`).
- **Session mechanism**: stateless JWT sent as `Authorization: Bearer`, stored by the SPA in `localStorage` (`admin-frontend/README.md`, "Login" bullet). Not a cookie, so CSRF is not applicable to the current design, but any XSS can read the token.
- **Token lifetime**: absolute 12 hours, **no idle timeout, no refresh** (`src/admin/auth.ts:44`, comment at `src/admin/auth.ts:33-43`).
- **Secret**: `ADMIN_JWT_SECRET` is required at boot (`src/server.ts:48`).
- **Where identity is resolved**: `requireAdminAuth` (`src/admin/authMiddleware.ts:33-62`) verifies the signature, checks the revocation table (`:42`), then **re-reads the account on every request** and takes the role from the DB, not the token (`:49-56`). A disabled account is rejected on its next request (`:50`). This already satisfies the brief's "DB is authoritative, claim is a hint" rule.
- **Revocation**: `POST /admin/logout` writes the token `jti` to `RevokedAdminToken` (`src/admin/adminRoutes.ts:226-232`, `src/admin/tokenRevocation.ts:14-29`). There is no "revoke all sessions of this admin" operation; disabling the account does the job.
- **Rate limiting**: login attempts are limited per attempted email, 5 per 15 minutes (`src/admin/adminRoutes.ts:184-193`, `src/admin/rateLimiter.ts:64-66`). Redis-backed only when `RATE_LIMIT_BACKEND=redis` (`src/server.ts:115-117`); otherwise per-process memory. **Not found:** a per-IP limit; one attacker can lock out a known admin email (denial of sign-in).
- **Enumeration**: identical 401 for unknown email, wrong password, and disabled account (`src/admin/adminRoutes.ts:199-203`). Good. Timing: the password hash is only compared when the account exists (`:198`), so a timing difference exists. Minor.
- **MFA / TOTP / recovery codes**: **not found** (search for `totp|otplib|mfa|2fa|recovery code` over `src/` and the schema returned nothing).
- **Staff invitations / sign-up**: **not found.** Staff accounts are created only by a CLI that takes the password **as a command-line argument** (`scripts/createAdminUser.ts:12-13,22`), which exposes it in shell history and the process list.
- **Open-redirect handling / `next` parameter**: not applicable today; the API has no redirect flow.
- **Recovery**: none for admins. A forgotten password needs a direct DB write. (This was done twice on 2026-10-26 for the two existing SUPER_ADMIN accounts, by a script that updates `passwordHash` directly; those two writes are **not** in the audit table.)
- **Existing admin accounts** (from the production DB, 2026-10-26): `ren206@gmail.com` and `rencoenterprise25@gmail.com`, both `SUPER_ADMIN`, active.

## 3. Authorization

- **Two separate systems already**, with no shared role names:
  - merchant side: `MembershipRole` (OWNER, MANAGER, SALES_CLERK, INVENTORY_OPERATOR, FINANCE_OPERATOR, RESTRICTED_SUPPORT) (`prisma/schema.prisma:209-232`), matrix in `src/auth/permissions.ts:15-76`;
  - platform side: `AdminRole` = SUPER_ADMIN, ANALYST, SUPPORT, OPERATOR (`prisma/schema.prisma:329-336`), matrix `PLATFORM_MATRIX` (`src/auth/permissions.ts:111-126`).
- **Roles stored in editable data?** No. Platform role lives in `AdminUser.role` (server-only table, not tenant-scoped, no write route found for self-edit). Merchant roles live in memberships. No place found where a merchant-editable field grants a platform privilege.
- **Permission checks**: `requirePlatformPermission(permission)` (`src/admin/platformGuards.ts:31-39`) on newer routes; older routes use `requireAdminRole(...roles)` (`src/admin/authMiddleware.ts:64-73`). Two mechanisms coexist.
- **Step-up**: password re-confirmation token bound to admin and session (`src/admin/platformGuards.ts:47-90`), enforced for the 19 permissions in `PLATFORM_STEP_UP_PERMISSIONS` (`src/auth/permissions.ts:137-157`) **only when DB flag `adminStepUp` is on, which defaults OFF** (`src/admin/platformGuards.ts:24,30-33,71`).
- **Support access** (reason + time box before opening a merchant's books): table `SupportAccess` (`prisma/schema.prisma:1152-1165`), enforced **only when `adminSupportAccessRequired` is on, default OFF** (`src/admin/platformGuards.ts:25`).
- **Guard gap found:** `GET /admin/businesses` (list of every business) has **no permission check**, only authentication (`src/admin/adminRoutes.ts:235-249`). Any active admin, including ANALYST, can list all businesses. Other routes added since Phase 1 use `requirePlatformPermission`.
- **No route-inventory test** that fails on an unguarded admin route was found (searched `tests/` names: `securityAdminRoutes`, `platformAdmin`; contents not exhaustively read). Treat as not present until Phase 5 verifies.

## 4. Database and tenant isolation

- Tenant isolation: a Prisma client extension scopes every model in `TENANT_SCOPED_MODELS` by `businessId` (`src/db/tenantScope.ts:9-...`). `AdminUser` and reference data are intentionally outside it. Admin cross-tenant reads use the unscoped `prisma` client directly in the admin routers (e.g. `src/admin/adminRoutes.ts:241`).
- No RLS found. Isolation is service-layer plus DB protections added in `20261020000100_phase1_db_protection`.
- **Audit table**: `AuditLog { id, businessId?, actorType, actorId?, action, entityType, entityId?, metadata Json?, createdAt }` (`prisma/schema.prisma:990-1004`). **Append-only enforced by DB trigger** `AuditLog_append_only` (`prisma/migrations/20261020000100_phase1_db_protection/migration.sql:105`), so the "app role must not UPDATE/DELETE" requirement is already met by a trigger (not by grants). Gaps against the brief: no `reason`, `result`, `ip/user-agent hash` columns (reason and correlation id live in `metadata`), and no separate `security_event` table. Sign-in success/failure is **not** audited (`src/admin/adminRoutes.ts:176-209` writes nothing).
- Other append-only tables use the same trigger family (`20261020000100…`, ledger and journal migrations).
- Outbox/inbox with dead-letter semantics: `OutboxEvent` (`prisma/schema.prisma:1095`), `OutboxStatus`/`InboxStatus` ("Gave up after the retry budget; needs a human (dead-letter replay in the admin console)", `:1088`).
- Feature flags: DB table `FeatureFlag` with `enabledByDefault` and per-business overrides (`prisma/schema.prisma:1006`), read by `isFeatureEnabled`. About 30 flag keys exist (e.g. `src/domain/store/common.ts:11-12`, `src/domain/subscriptions/common.ts:16-17`). **This is the repo's flag mechanism; there is no `ADMIN_CONSOLE_ENABLED` env switch.**

## 5. Existing admin surface

API (all mounted under `/admin`, `src/server.ts:225-235`; chain at `src/admin/adminRoutes.ts:174-220`: null-byte rejection, `requireAdminAuth`, correlation id, audit of every write, then the platform router):

| Module | File | Notes |
|---|---|---|
| Businesses, merchants, deletion requests, audit log, mobile-money alerts, plans, flags | `src/admin/adminRoutes.ts` (909 lines) | `/businesses` unguarded by permission (see 3) |
| Overview, system health, step-up, support access, admin list, `/me/permissions` | `src/admin/platformAdmin.ts:61-71` | |
| Transactions (void/reverse, export) | `src/admin/adminTransactions.ts` | |
| Reorder and forecast | `src/admin/adminReorder.ts` | |
| Support cases (assign, notes, close) | `src/admin/adminSupport.ts:94-126` | `SupportCase`, `SupportCaseNote` exist (`prisma/schema.prisma:2565,2596`) |
| Payments (attempts, exceptions, refunds, settlements, callbacks, reconcile, provider connections) | `src/admin/adminPayments.ts:42-215` | |
| Moderation (listing/seller suspend, reports, appeals) | `src/admin/adminModeration.ts:28-123` | |
| Subscriptions (plans, versions, invoices, adjust, refund, billing switches, remind) | `src/admin/adminSubscriptions.ts:56-269` | `PlanVersion`, `EntitlementEvent`, `BillingSwitch` exist |
| Ops (job pause, integrity, synthetic incident, revoke phone sessions) | `src/admin/adminOps.ts:29-73` | |
| Messaging (templates, consent, blocks, outbound, stuck inbound, alert channel) | `src/admin/adminMessaging.ts:46-226` | |

UI: React SPA, 16 routes (`admin-frontend/src/App.tsx:30-192`), JWT in `localStorage`, no tests wired into CI (`admin-frontend/README.md`, "Known gaps").

## 6. Billing, merchant payments, messaging, AI, alerting, jobs, exports

- **pawaPay (merchant to TradePal subscriptions only)**: client defaults to sandbox unless `PAWAPAY_API_BASE_URL` is set (`src/config/paymentsEnv.ts:79-86`, `src/pawapay/client.ts:17`). Production activation requires `PAWAPAY_BILLING_PRODUCTION_ACTIVATED=true` and signed callbacks are required unless `PAWAPAY_REQUIRE_SIGNED_CALLBACKS=false` (`src/domain/subscriptions/common.ts:67`, `src/pawapay/billingWebhook.ts:17`). A feature flag `pawapayBilling` gates the commands (`src/domain/subscriptions/common.ts:16`). **The gate is an environment variable plus a DB flag; the admin API has `PUT /billing-switches` (`src/admin/adminSubscriptions.ts:235`).** Whether any billing switch can flip the production activation was not verified; Phase 1 must read `BillingSwitch` handling before any admin config work (brief rule 9).
- **Merchant sales payments**: **no real provider is registered in production**. The adapter registry is empty until a reviewed change adds one; only a development simulator can join (`src/payments/registry.ts:8-16`; `docs/expansion/merchant-provider-matrix.md`). A Flutterwave client and webhook exist (`src/flutterwave/*`) and the owner decided to leave Flutterwave untouched. Admin UI must show "no sales provider configured" truthfully.
- **WhatsApp**: signed webhook (`src/whatsapp/signature.ts`, `webhookRoute.ts`), outbound gateway (`outboundGateway.ts`), redrive (`redrive.ts`), consent log (`ConsentLog`, `prisma/schema.prisma:1033`), template register (`MessageTemplate`, `:3283`; `docs/expansion/message-template-register.md`). Credentials rotated 2026-10-24 (not code).
- **AI providers**: provider abstraction in `src/ai/provider.ts`; failure classification already distinguishes billing/credit errors (`src/ai/failureClass.ts:9,41`, `src/ai/provider.ts:23,49`, from the 2026-08 outage). `AIProviderId`/usage ledger tables exist (`prisma/schema.prisma:734-743`). Whether the admin system-health view surfaces this classification was not verified.
- **Alerting**: email alerts via `ALERT_EMAIL_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` (`src/monitoring/alerts.ts`); alert-channel check endpoint `POST /admin/messaging/alert-channel/check` (`src/admin/adminMessaging.ts:226`); heartbeat/dead-man's switch writes only when `HEARTBEAT_ENABLED=true` (`src/monitoring/heartbeat.ts:3-12`) and the public `GET /heartbeat` reports it (`src/server.ts:150`). Whether alert delivery and the heartbeat are **enabled in production** was not checked in this phase (the app's behaviour on Railway is out of the read-only repo scope); Phase 1 should add an explicit "configured / not configured per environment" check, as the brief asks.
- **Jobs**: BullMQ queues and sweeps (`src/queue/*.ts`), job-class pause (`src/admin/adminOps.ts`, `src/ops/jobControl.ts`), outbox sweep, webhook redrive (`src/queue/webhookRedrive.ts`).
- **Exports**: formula-injection-safe CSV (`src/admin/csv.ts:6-12`) already prefixes `= + - @ tab CR` (leading whitespace too). **Not found:** signed, expiring download URLs or XLSX export; exports are streamed in the response.
- **Cache headers**: not verified for admin responses (`helmet` defaults only, `src/server.ts:128`). The SPA is static on Vercel. **Not found:** `Cache-Control: no-store` set explicitly on `/admin` API responses.

## 7. Baseline checks (run 2026-10-27, from the repo root)

| Command | Result |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | exit 0, no output |
| `npx tsc -p tsconfig.json --outDir /private/tmp/tp-build-check` (build to a temp dir so the repo is untouched) | exit 0 |
| `npx vitest run` | **2 failed, 1346 passed, 7 skipped** (125 files; 2 failed, 122 passed, 1 skipped); duration 83 s |
| Lint | not run: no lint script exists |
| `admin-frontend` tests | not run in this phase |

The two failures, both **pre-existing and environmental, not caused by this task**:

1. `tests/messaging.test.ts:146` "lets only messaging/send.ts reach the unchecked WhatsApp senders": it walks `src/` and found an extra file `src/messaging/transport 2.ts` (see risk R1).
2. `tests/reorderTier1.test.ts:104` "only the merchant's own recorded sales count": expected 55, received 35. The test pins its fixture to `NOW = 2026-10-20` (`:25`) but calls `netUnitsSold(..., new Date())` with the real clock (`:104`); with the real date now 2026-10-27 a sale dated 25 days before the pinned date falls outside the 30-day window. It will keep failing with each passing day. Not fixed here (rule 3); recorded for a separate change.

## 8. Capability table (areas the console touches)

| Area | Status |
|---|---|
| Staff identity, login, logout, revocation | implemented |
| Role/permission matrix (platform), per-route checks | implemented (two mechanisms; one route unguarded) |
| Step-up (password) / support-access reasons | implemented, **OFF by default** |
| MFA, recovery codes | **not found** |
| Staff invitations, ownership transfer, last-owner protection | **not found** |
| First-owner bootstrap CLI | partial (`scripts/createAdminUser.ts`, password on the command line, no confirm echo, no bootstrap gate, no audit) |
| Admin audit trail (append-only) | implemented (trigger); sign-in events not recorded; no reason/result columns |
| Merchants/organizations view, suspension | implemented (`adminRoutes.ts`, `adminModeration.ts`) |
| System health, dead letters, job control | implemented |
| Subscriptions/plans/entitlements | implemented; complimentary-access grant model not confirmed (`EntitlementEvent` exists) |
| Moderation, appeals | implemented |
| Orders/transactions admin | implemented |
| Support cases | implemented |
| WhatsApp operations | implemented (templates, consent, replay) |
| Merchant payment monitoring | implemented against the simulator only; **no real provider** |
| Refunds | request/retry routes exist (`adminPayments.ts:172`, `adminSubscriptions.ts:216-226`); **two-person approval, separate request/approve/execute permissions, payload-hash binding: not found** |
| Config and flags | implemented via DB flags and billing switches |
| Reports/exports | CSV with formula safety; signed expiring downloads and XLSX **not found** |
| Admin master flag and per-module flags (`ADMIN_CONSOLE_ENABLED`, `ADMIN_MODULE_*`) | **not found** (admin is always mounted) |
| Idle session timeout, re-auth windows, `no-store` | **not found** |
| Deployed console vs code | deployed UI is older (6 vs 16 sections) |
| Claimed on the website only | not checked in this phase |

## 9. Gap list (this task)

`must-build`: MFA (TOTP + hashed recovery codes); staff invitations (single-use, hashed, expiring); `security_event` (sign-in, MFA, denial); first-owner bootstrap CLI with `--confirm`, gate variable and audit; last-owner protection under concurrency; two-step ownership transfer; route-inventory guard test; master and module flags; idle timeout and re-auth windows; two-person approval (`approval_request`) with immutable payload hash.

`must-extend`: roles (add `finance_admin`, `moderator`, map `auditor`); audit table (reason/result/ip-hash; add `actor_kind`); `/admin/businesses` permission guard; unify the two guard mechanisms; refund flow (request/approve/execute split, execution OFF behind `ADMIN_REFUND_EXECUTION_ENABLED=false`); exports (signed expiring links, XLSX with the existing `csvText` neutralization); system-health view (AI-provider status, alert-delivery presence per environment, heartbeat); cache headers; per-IP login limit.

`must-stub-truthfully`: merchant sales-payment monitoring (no real provider); recognized revenue (do not show unless implemented).

`out-of-scope` for this task: changing any pawaPay activation state; the deployed-vs-code frontend drift (record only); fixing the two pre-existing test failures.

## 10. Risk register

| # | Risk | Evidence | Severity |
|---|---|---|---|
| R1 | **236 untracked byte-identical duplicate files** named `* 2.*` (Finder/iCloud copies) across `src/`, `tests/`, `prisma/migrations/`, `admin-frontend/`, `docs/`, `scripts/` | `git status` (236 entries; all compared identical to their originals); `tests/messaging.test.ts:146` fails because of `src/messaging/transport 2.ts`; `tsconfig.json:25` compiles `src`, `prisma`, `tests`; 4 duplicate files sit inside `prisma/migrations/` | High: can break builds and migration drift tests; do not commit them |
| R2 | No MFA on accounts that can read every merchant's books and reverse transactions | section 2 | High |
| R3 | `GET /admin/businesses` lacks a permission check | `src/admin/adminRoutes.ts:235` | Medium |
| R4 | Step-up and support-access are OFF by default; today any admin can open any merchant's books without a reason | `src/admin/platformGuards.ts:24-33` | High |
| R5 | Bearer token in `localStorage`, 12 h absolute, no idle timeout | `src/admin/auth.ts:44`; `admin-frontend/README.md` | Medium |
| R6 | Staff provisioning takes the password on the command line; no audit of provisioning or password resets (two direct-DB resets on 2026-10-26 left no audit row) | `scripts/createAdminUser.ts:12,22` | Medium |
| R7 | Login limiter is per email only (lockout of a known admin; no per-IP limit) and in-memory unless `RATE_LIMIT_BACKEND=redis` | `src/admin/adminRoutes.ts:184`, `src/server.ts:115-117` | Medium |
| R8 | Sign-in success/failure not logged | `src/admin/adminRoutes.ts:176-209` | Medium |
| R9 | Deployed admin console is older than the code; deep links 404 (no SPA rewrite) | observed 2026-10-26 | Low (operational) |
| R10 | Pre-existing time-dependent test failure (`reorderTier1`) hides real regressions in CI | `tests/reorderTier1.test.ts:25,104` | Low |
| R11 | `ADMIN_FRONTEND_ORIGINS` and a Vercel project named `pipe-field-os-pro` host TradePal's console | `src/server.ts:219`; Vercel team name | Low (naming) |
| R12 | `ADMIN_JWT_SECRET` rotated 2026-10-23: all sessions were invalidated once (expected); the secret is also the root of the step-up key derivation | `src/admin/platformGuards.ts:47-49` | Info |

## 11. Stack decisions proposed for Phase 1 (each with the rejected alternative)

1. **Keep `AdminUser` as the staff identity; add MFA to it.** Rejected: moving staff onto the merchant identity (there is none to reuse: merchants authenticate via WhatsApp number, not email+password; adopting it would create the "second user store" in reverse).
2. **Keep bearer JWT** for the SPA, add `iat`-based idle timeout and a server-side session row (`AdminSession`) so idle timeout and "revoke all" work; add a distinct audience claim. Rejected: switching to cookies (would force CSRF handling, and the SPA is on a different origin from the API).
3. **TOTP with `otplib`**, secret encrypted with the existing token-encryption pattern, 8 hashed single-use recovery codes. Rejected: SMS codes (cost and SIM-swap risk in the target markets).
4. **Flags**: add the env master switch `ADMIN_CONSOLE_ENABLED` (checked before mounting `/admin`, returning the app's normal 404) and per-module flags using the existing DB `FeatureFlag` table, not a new mechanism. Rejected: only env flags (module toggling would need a redeploy).
5. **Authorization**: keep `PLATFORM_PERMISSIONS`/`canPlatform` as the single resolver, migrate the old `requireAdminRole` routes to it, add one guard wrapper, and add a route-inventory test. Rejected: introducing dotted permission names alongside (two vocabularies).
6. **Audit**: keep `AuditLog` (trigger-protected) and add a new `SecurityEvent` table for sign-in/MFA events; extend audit via the existing `metadata`, add typed `reason`/`result` columns additively. Rejected: a second audit table for everything (would split the trail).

## 12. Open questions (real design forks)

- **Q1. Extend or rebuild?** I recommend extending what exists (sections 0 and 11). Confirm that the brief's "must not rebuild or rename working modules" rule overrides its Phase 3 list wherever a module already exists, so Phase 3 becomes "audit and fill gaps in existing modules".
- **Q2. Roles.** Existing: SUPER_ADMIN, OPERATOR, SUPPORT, ANALYST. Brief: platform_owner, operations_admin, support_agent, finance_admin, moderator, auditor. Do I (a) add `FINANCE_ADMIN` and `MODERATOR` to `AdminRole` and treat the brief's names as display labels for the existing ones, or (b) rename? Rule 3 forbids (b); I will do (a) unless you say otherwise.
- **Q3. The two existing owners.** Both existing `SUPER_ADMIN` accounts predate MFA. Should Phase 2 force MFA enrolment at next sign-in (recommended) or allow a grace period? Either way the bootstrap CLI would not be needed for them.
- **Q4. Master-flag behaviour.** The brief wants `/admin*` to look like a non-existent route when the flag is off. Today `/admin` is always live and your team uses it. Turning the flag default off would take the console offline until it is set. Confirm: default off in code but set to `true` on Railway at release, in the same change.
- **Q5. Frontend deploy drift.** The live console is the older 6-section build. Redeploying the current code is out of scope for this brief but affects what you see. Do you want that done with Phase 5?
- **Q6. Duplicate `* 2.*` files (R1).** They are untracked and identical. I will not touch them; do you want them deleted separately, since they break one test and can break tooling?
