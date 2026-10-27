# Admin permission matrix (Phase 1)

The code is the source of truth: `src/auth/permissions.ts` (`PLATFORM_PERMISSIONS`, `PLATFORM_MATRIX`, `PLATFORM_STEP_UP_PERMISSIONS`). `tests/permissions.test.ts` pins it. The full generated table (every permission by every role, with the step-up column) is [`docs/expansion/permission-matrix.md`](../expansion/permission-matrix.md); regenerate it with `npx tsx scripts/genPermissionMatrix.ts > docs/expansion/permission-matrix.md`.

This file adds what a table cannot say: the mapping to the brief's role names, the scope of each permission, and what each role may see in a record.

## Rules that never change

1. **Deny by default.** A role has only the permissions listed for it. An unknown role or permission is denied.
2. **The database decides, not the token.** The role is read from `AdminUser.role` on every privileged request (`src/admin/authMiddleware.ts`); a role claim in a token is a hint only. `AdminUser.roleVersion` goes up by one whenever the role changes (database trigger), so a queued job can tell that its actor's role changed after it was queued and must re-check.
3. **Two separate permission systems.** Staff permissions are all `admin:`-prefixed and live in `PLATFORM_MATRIX`; merchant permissions live in the merchant matrix. No role name or permission is shared, and no platform role holds a merchant permission. Staff are never shop members.
4. **Staff roles live in the staff table, not in editable data.** Nothing a merchant or consumer can edit grants a staff permission.
5. **Step-up.** Every permission that changes something, opens merchant money, or reveals private data is in `PLATFORM_STEP_UP_PERMISSIONS` (password confirmation today; password + second factor within the re-authentication window once Phase 2 ships). Read-only `admin:view_*` permissions are not, except `admin:view_merchant_financials`.
6. **The owner cannot be removed by accident.** A database trigger refuses to delete, disable or demote the last active `SUPER_ADMIN`, even under two simultaneous requests (verified on a real Postgres; `tests/adminFoundation.test.ts`).

## Role mapping

| Brief's role | Repo role (`AdminRole`) | Status |
|---|---|---|
| `platform_owner` | `SUPER_ADMIN` | existing |
| `operations_admin` | `OPERATOR` | existing |
| `support_agent` | `SUPPORT` | existing |
| `finance_admin` | `FINANCE_ADMIN` | **new** (migration `20261102000000_admin_console_foundation`) |
| `moderator` | `MODERATOR` | **new** |
| `auditor` | `ANALYST` | existing (the read-only role) |

The existing role names are kept (rule: no renaming of working code). The brief's names are labels in the UI.

## What each role is for

| Role | Default responsibility | Deliberately cannot |
|---|---|---|
| `SUPER_ADMIN` (owner) | Everything, including staff, ownership, configuration, global flags | n/a. Still subject to two-person approval on refunds (it cannot approve its own request) |
| `OPERATOR` | Day-to-day operations: exceptions, replays, job control, reversals, moderation, messaging, report views, opening refund requests | Manage staff, approve or execute refunds, global flags, owner-only tools |
| `SUPPORT` | Assigned support cases, limited customer data, reading one conversation and unmasking one number (audited, with a reason) | Refunds, flags, exports, unrestricted lists |
| `FINANCE_ADMIN` | Subscription billing, payment exceptions, reports, exports, refund request/approve/execute, complimentary access with an end date | Staff changes, flags, moderation, messaging, system health |
| `MODERATOR` | Listings, reports, appeals, suspensions of listings | Any financial, support, messaging, staff or export access |
| `ANALYST` (auditor) | Read-only views: overview, health, organizations, audit log, staff list, security events, reports | Any change, any export, merchant financials |

## New permissions in Phase 1, with the brief's dotted names

| Permission | Brief's name | Scope | Roles |
|---|---|---|---|
| `admin:view_staff` | `staff.read` | staff list, roles, sessions (no password data, ever) | owner, auditor |
| `admin:view_security_events` | `audit.security.read` | sign-in, second-factor, denied-access events | owner, auditor |
| `admin:view_reports` | `reports.read` | report views; never a merchant's books | owner, operations, finance, auditor |
| `admin:create_export` | `exports.create` | an expiring, redacted export of an allowed view | owner, operations, finance |
| `admin:read_whatsapp_conversation` | `whatsapp.conversation.read` | one conversation, with a reason; audited | owner, support |
| `admin:unmask_pii` | `pii.unmask` | one masked phone number or name; audited | owner, support |
| `admin:request_refund` | `billing.refund.request` | open a request; frozen payload and hash | owner, operations, finance |
| `admin:approve_refund` | `billing.refund.approve` | approve exactly that hash; never your own request (database rule) | owner, finance |
| `admin:execute_refund` | `billing.refund.execute` | run an approved refund; also needs `ADMIN_REFUND_EXECUTION_ENABLED=true` (default false) | owner, finance |
| `admin:grant_entitlement` | `entitlements.grant` | complimentary access, with a reason and an end date | owner, finance |
| `admin:manage_config` | `config.manage` | validated country, currency, timezone settings; never anything about pawaPay activation | owner |
| `admin:transfer_ownership` | `staff.ownership.transfer` | two-step handover; both people need a recent re-authentication | owner |

Existing permissions keep their names: for example `admin:manage_admins` covers `staff.roles.manage` (invitations, role changes, account restriction), and `admin:view_audit_log` covers `audit.read`. There is deliberately one vocabulary (`admin:`), not two.

## Field visibility

What is enforced today, and what is only defined:

| Data | Enforced today | Not built yet |
|---|---|---|
| Phone numbers, shopper names | The messaging panel already masks numbers (its own design). The other admin screens show them as they always did | A platform-wide mask-by-default with an audited, reasoned unmask. The permission `admin:unmask_pii` exists and is held by the roles listed above, but **no route uses it yet** |
| WhatsApp message bodies | Never returned by any admin route | A "read one conversation" route. The permission `admin:read_whatsapp_conversation` exists; **no route uses it yet** |
| A merchant's books (sales, debts, stock values) | `admin:view_merchant_financials` and, while flag `adminSupportAccessRequired` is on, an open support-access window with a recorded reason (each read is an audit row) | the flag defaults off in the database: turn it on at release if you want reasons enforced |
| Staff password hashes, second-factor secrets, recovery codes, token hashes | Never returned: no admin query selects them (checked by `tests/adminStaff.test.ts` on the staff list) | |
| Secrets and keys | Presence only ("configured / not configured"), never a value or part of one (checked by `tests/adminHealthAudit.test.ts`) | |

## Boundaries that no permission can cross

- pawaPay production activation is a deployment-level decision (`PAWAPAY_BILLING_PRODUCTION_ACTIVATED` and the activation runbook). No admin permission, flag or setting here changes it.
- No role can edit financial history. Corrections are reversals or adjustments through the existing services, producing new ledger rows.
- Merchant sales payments and TradePal subscription billing stay separate in routes, credentials and reports; no role merges them into one total.


## Routes that predate the matrix (legacy reads)

Several read routes were written before staff permissions existed and had no permission check (any signed-in admin could read them). Changing that for the four original roles would change what people already rely on, so `requireLegacyAccess(permission)` keeps those four roles exactly as they were and gives a role added later (`FINANCE_ADMIN`, `MODERATOR`, and any future one) access only when its own permissions include the one named for the route:

| Route | Permission a newer role needs |
|---|---|
| `GET /businesses`, `GET /businesses/:id`, `GET /feature-flags`, `GET /businesses/:id/feature-flags` | `admin:view_orgs` |
| `GET /deletion-requests` | `admin:view_support_cases` |
| `GET /audit-logs` | `admin:view_audit_log` |
| `GET /mobile-money-alerts`, `GET /businesses/:id/payment-requests` | `admin:view_payments` |
| `GET /plans`, `GET /businesses/:id/invoices` | `admin:view_subscriptions` |

`tests/adminModules.test.ts` pins the exact set of routes each newer role can reach, so a new route cannot open to them by accident.
