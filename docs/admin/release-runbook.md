# Admin console: release runbook

Status: **started in Phase 1.** Sections are added as each phase lands. Nothing here has been run against production. No environment-variable values appear in this file.

## Phase 1: migration `20261102000000_admin_console_foundation`

### What it does (all additive)

| Object | Change |
|---|---|
| `AdminRole` enum | adds `FINANCE_ADMIN`, `MODERATOR` |
| `AdminUser` | adds `roleVersion` (default 1), `mfaRequiredAt`, `lastSignInAt`, `createdById` (all nullable or defaulted) |
| `AuditLog` | adds `reason`, `result` (default `SUCCESS`, checked), `correlationId`, `ipHash` and three indexes. Still append-only (trigger unchanged) |
| New tables | `AdminSession`, `AdminMfaFactor`, `AdminRecoveryCode`, `StaffInvitation`, `OwnershipTransfer`, `StaffRoleChange`, `SecurityEvent`, `ApprovalRequest`, `EntitlementGrant` |
| New enums | `OwnershipTransferStatus`, `ApprovalStatus` |
| New triggers/functions | `tradepal_admin_user_guard` (last-owner rule, role-version bump), `tradepal_ownership_transfer_guard`, `tradepal_approval_guard`, `tradepal_entitlement_grant_guard`, plus the existing append-only, no-delete and no-truncate functions applied to the new tables |
| Row-level security | `EntitlementGrant` joins the tenant policy like `EntitlementEvent` |

No existing row is read, changed or removed. No existing column is renamed or dropped.

### What changes for people on day one

Nothing visible. No route, screen or flag changes in Phase 1. Two behaviours are new at the database level:

1. **The last active owner is protected.** An attempt to delete, disable or demote the only active `SUPER_ADMIN` fails with "the last active platform owner cannot be deleted, disabled or demoted". Today there are two active owners, so ordinary changes still work. The existing `scripts/disableAdmin.ts` hits this rule only if it targets the sole owner.
2. **`AdminUser.roleVersion` goes up when a role changes.** Automatic; nothing needs to set it.

### Preconditions

- PostgreSQL **12 or newer**. The migration adds two enum values in the same transaction as other changes, which PostgreSQL 12+ allows as long as nothing in that transaction uses the new values (nothing does). Prisma itself warns that PostgreSQL 11 and earlier cannot do this. Confirm the production version before running (`select version()` on the Railway Postgres).
- A fresh backup taken the same day (Railway: Postgres service, Backups).
- The migration is applied by the existing pre-deploy command on the `TradePal-Africa` service (`prisma migrate deploy`); nothing else is needed.

### Rehearsal that was run (2026-10-27, scratch Postgres 18.4 on the laptop, never production)

| Rehearsal | Result |
|---|---|
| Every migration applied from empty with `scripts/rehearseMigrations.sh` as a non-superuser | passed; existing-table counts unchanged; expansion flags all off |
| Upgrade rehearsal: all earlier migrations, then 3 staff rows and 2 audit rows, then this migration in **one transaction** (`psql -1`) | passed; row counts 3 and 2 before and after; roles and audit rows unchanged; role versions 1; audit `result` = SUCCESS; enum now has 6 values |
| Test suite against that server, including the concurrent last-owner race (12 rounds of two owners demoting each other at once) | passed: `adminFoundation`, `migrationDrift`, `dbProtection` (35 tests) |

Not rehearsed: a restored copy of the real production backup (the earlier rehearsal doc covers the pre-Phase-1 chain; repeat with a fresh backup before release).

### Rollback and forward-repair

PostgreSQL cannot remove an enum value, so a true rollback of the role values is not offered. The two new values are harmless if unused.

If this migration must be undone **before anything uses the new objects**, run as the table owner, in one transaction:

```sql
DROP TABLE "EntitlementGrant", "ApprovalRequest", "SecurityEvent", "StaffRoleChange", "OwnershipTransfer",
           "StaffInvitation", "AdminRecoveryCode", "AdminMfaFactor", "AdminSession";
DROP TYPE "OwnershipTransferStatus", "ApprovalStatus";
DROP TRIGGER "AdminUser_guard" ON "AdminUser";
DROP FUNCTION tradepal_admin_user_guard(), tradepal_ownership_transfer_guard(), tradepal_approval_guard(), tradepal_entitlement_grant_guard();
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_result_check",
  DROP COLUMN "reason", DROP COLUMN "result", DROP COLUMN "correlationId", DROP COLUMN "ipHash";
ALTER TABLE "AdminUser" DROP COLUMN "roleVersion", DROP COLUMN "mfaRequiredAt", DROP COLUMN "lastSignInAt", DROP COLUMN "createdById";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261102000000_admin_console_foundation';
```

This script was run (inside a rolled-back transaction) against the upgrade-rehearsal database on 2026-10-27: every statement up to the last one succeeded. The last line failed there only because that rehearsal database was loaded with `psql` and so has no `_prisma_migrations` table; it has not been run against a Prisma-managed database.

Do not run this once `SecurityEvent` or `StaffRoleChange` rows exist: they are audit records and must be kept. After that point the safe path is **forward repair**: a new additive migration that fixes the object in question.

### Smoke checks after deploy

1. `curl -s -o /dev/null -w "%{http_code}" https://<api>/admin/login` with a wrong password returns 401, as before.
2. Sign in as an existing owner; open Businesses; sign out.
3. `select count(*) from "AdminUser"` is unchanged; `select enum_range(null::"AdminRole")` shows six values.

### Environment variables

None are added by Phase 1. Phase 2 adds the names listed in `setup.md` section 1 (all optional; the master switch defaults to off). Names that later phases add (values are never recorded here): `ADMIN_CONSOLE_ENABLED`, `ADMIN_MODULE_*`, `ADMIN_BOOTSTRAP_ALLOWED`, `ADMIN_REFUND_EXECUTION_ENABLED`.


## Phase 2: sign-in, second factor, staff access

### Migrations
- `20261103000000_admin_session_cascade` (one foreign key made `ON DELETE CASCADE`: a session goes away with its account). Rehearsed with the full chain on the scratch Postgres (see the Phase 2 rehearsal below).

### Release order (nothing is switched on by deploying)
1. Take a fresh Railway Postgres backup. Confirm the Postgres version is 12 or newer.
2. Set `ADMIN_MFA_ENCRYPTION_KEY` (generate it yourself, 64 hex characters) **before** switching the console on. Without it the console starts but nobody can finish signing in (the server logs a clear error at start).
3. Deploy. The pre-deploy command applies the migrations. **With `ADMIN_CONSOLE_ENABLED` unset the admin API is off: the live console will show errors until you set it.** This is deliberate (the master switch defaults to off).
4. Set `ADMIN_FRONTEND_PUBLIC_URL` (invitation links) and then `ADMIN_CONSOLE_ENABLED=true`.
5. Each existing owner signs in, sets up the authenticator, saves the recovery codes.
6. Smoke checks: wrong password gives 401 and a `LOGIN_FAILED` security event; a correct password then the code opens Businesses; `GET /admin/security-events` as an owner shows the sign-ins; an invitation to a test address produces a link that works once; sign-out ends the session.

### Rollback
Set `ADMIN_CONSOLE_ENABLED` back to anything other than `true`: the admin API disappears (WhatsApp and the rest of the API are unaffected). The migrations are additive and stay in place. Do not unset `ADMIN_MFA_ENCRYPTION_KEY` while people are enrolled: their secrets cannot be read without it.

### Rehearsals run (2026-10-27)
Full-suite tests against a real Postgres 18.4 scratch server (parallel connections, non-superuser migration owner): see `progress.md` for the counts. Not rehearsed: a restored copy of the production backup; the live Vercel site; email delivery of invitations (not built).
