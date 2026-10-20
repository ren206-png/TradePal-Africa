# Runbook: rollback

Principle: **switch off, don't undo.** Every expansion capability is behind a flag and an environment switch, so the fastest, safest rollback is turning it OFF. Nothing below deletes financial data (the database refuses it).

## 1. A feature misbehaves (any time)
1. Admin console -> Feature flags: turn the flag OFF for the business, or reset the override; for everyone, set the global default OFF. Takes effect on the next request.
2. For a whole surface: unset its environment switch (`STOREFRONT_ENABLED`, `OFFLINE_DRAFTS_ENABLED`, `REPORTS_WEB_ENABLED`, `CONSUMER_MESSAGING_ENABLED`, `MARKETPLACE_ENABLED`) and redeploy/restart the service; the router is then not mounted at all.
3. A runaway background job: System health -> Background jobs -> Pause (with a reason). Inbound messages and payment callbacks are never paused.
4. Money keeps being serviced: pausing or switching off NEW activity never stops callbacks, reconciliation, refunds or exports.

## Per capability
| What | Roll back by | What stays |
|---|---|---|
| Storefront | `storefront` flag off / `STOREFRONT_ENABLED` unset | existing orders, holds (they lapse by sweep), journals |
| Consumer messaging | `consumerMessaging` off and/or `CONSUMER_MESSAGING_ENABLED` unset; or disable a template in the register | consent records and the outbound log |
| Conversational confirmations | `conversationalConfirmations` off | pending proposals expire; nothing is saved by them |
| Offline drafts | `offlineDrafts` off; "revoke phone sessions" for a business | server-side draft rows (they cannot be deleted) |
| Reports | `reportsV2` off | nothing is stored by reports |
| pawaPay billing | the country switch OFF (stops NEW charges only); `pawapayBilling` flag off | existing attempts, callbacks, invoices, entitlement history |
| Entitlements | `subscriptionEntitlements` off | |

## 2. Code rollback
Redeploy the previous build. **The database is forward-only for the expansion:** the migrations are additive (new tables, nullable or defaulted columns) so the previous build is expected to run against the new schema; none of it is dropped by a code rollback. **That expectation is untested:** the suite always runs the current build, and the new protective triggers (append-only, no-delete) could reject an operation the old build performs. Check with the migration rehearsal plus a smoke test of the previous build against the migrated scratch database before relying on it. Do NOT run a down-migration or drop tables: append-only triggers and the data they hold are the audit trail.

## 3. A migration failed part-way
Stop. Do not re-run blindly. Prisma records the failed migration; restore the pre-deploy backup into a scratch database, find the failing statement, fix the migration in a new commit, rehearse again (`rehearseMigrations.sh`), and only then retry in production. Restoring production from backup loses everything since the backup: decide that consciously (owner).

## 4. A bad admin account or token
`npx tsx scripts/disableAdmin.ts <email>` (effective on their next request). Rotating `ADMIN_JWT_SECRET` ends every admin session.

## 5. What cannot be rolled back
Messages already sent to a person; money already moved at a provider; a refund already paid. These are handled by exception queues, support cases and the provider, never by editing records.
