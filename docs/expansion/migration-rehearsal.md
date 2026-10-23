# Migration rehearsal (Phase 8, scenario 22)

`tests/migrationRehearsal.test.ts` builds a database from **only the migrations that existed before the expansion** (12), fills it with a realistic legacy dataset (3 businesses in 3 countries and currencies, 4 merchants including a staff member, every transaction type, an itemised sale, a reversal pair, customers, suppliers, debts with a part-payment, stock items and movements, subscriptions in ACTIVE / PAST_DUE / PENDING with PAID / PENDING / FAILED invoices, audit rows, webhook events, a payment request, consent rows and a legacy per-business flag), applies **every expansion migration in order**, and compares.

Checked, with the result:
- every legacy row, in every legacy column of 23 legacy tables, is byte-for-byte unchanged (hash per table) and counts are equal (the flag table legitimately gains rows; the one legacy row is unchanged);
- **balances**: sales per business with the reversal netted (550,000 for the Nigerian business), debts owed, stock on hand: identical;
- **ownership**: every merchant keeps their business and role; each business gets exactly one default shop; each merchant gets one active membership (OWNER stays OWNER, STAFF becomes SALES_CLERK);
- **references**: WhatsApp message ids, reversal links, invoice references and provider references: identical;
- **subscription status**: id, business, plan, status and period end identical; none was moved onto a plan version or set to cancel;
- nothing new is switched on (no flag ON by default; the legacy override survives); no journal, stock, order, payment, consent, message or draft rows appear;
- the new protections apply to the old rows (an old transaction cannot be edited or deleted; a correction is a new row);
- the application then runs against the migrated data: `/today` and `/debts` answer for a legacy merchant, every expansion command (`/store`, `/report`, `/plans`, `/connect`, `/close`) answers "Unrecognized command", a legacy transaction reverses, a legacy subscription (no plan version) has an entitlement.

**Found and fixed by the rehearsal:** a legacy invoice that was already PAID would have migrated with `paidMinor = 0`, so billing screens and the refund limit would have shown a paid invoice as having received nothing. The Phase 6 migration now sets `paidMinor = amountMinor` for invoices that were PAID, before the Invoice triggers exist.

**Update 2026-10-20:** the same rehearsal now also runs on a **real local PostgreSQL 18** (`TEST_PG_ADMIN_URL=... npx vitest run tests/migrationRehearsal.test.ts`, as a non-superuser database owner) and passes, and `scripts/rehearseMigrations.sh` applied every migration on an empty real database (one script bug fixed: a bash 3.2 array index that stopped it on macOS). See `runbooks/real-postgres-local.md`.

**What this is not:** a run on a restored production backup, and not a timing of the migrations on production-sized data. PGlite is a single-connection superuser database: it says nothing about lock durations on large tables, privileges of the Railway role (creating functions, triggers, policies), migration time, or concurrent traffic during the migration. `scripts/rehearseMigrations.sh` is the real rehearsal and has still **never been run**; it needs a scratch copy of a backup or permission to install a local Postgres. Production holds the real data (4 merchants and 1 transaction when Phase 0 looked): that makes a restored-backup rehearsal cheap and it should be done before any deploy.


## Rehearsal on a restored copy of the PRODUCTION backup (2026-10-23)
- **Backup:** `pg_dump --format=custom` of the live Railway Postgres (PostgreSQL 18.6, 10 MB, 4 merchants, 6 transactions, 13 migrations applied, latest `20260821000000`), taken read-only through the Railway CLI session (`railway run --service Postgres`); no credential was printed or stored. File: `~/tradepal-backups/tradepal-prod-20261023T091529Z.dump` (112 KB, owner-only permissions, with a `.sha256`). It holds real merchant data: it stays on the owner's Mac, outside the repository and outside iCloud-synced folders. **This is a `pg_dump`, not a Railway-native volume backup**; the dashboard's own backup (if the plan has it) was not created.
- **Restore:** into a local PostgreSQL 18.4 as a non-superuser owner; counts matched (4 / 6 / 13).
- **Migrations:** `prisma migrate deploy` applied the 17 new migrations in order, with no error and no failed or rolled-back entry (30 applied in total). It took a second or two.
- **Existing data:** a content hash of every row of all 34 existing tables, over their original columns, before and after: **identical**, except `FeatureFlag`, which gained 20 rows (the new flags). The 12 existing flags are unchanged; **0 new flags are ON by default**.
- **Properties:** every merchant has a membership and every business a default shop (backfill worked); 94 tables have row-level security (inert for the owner role); no paid invoice reads as zero paid; database 10 MB -> 16 MB.
- **The new code on the real data:** for each of the 4 real merchants (all Sierra Leone owners) `/today`, `today` (no slash), `/debts` and `/help` answer correctly (one merchant's `/debts` shows real debts); `/store` and `/report` answer "Unrecognized command" because their flags are off, as intended.
- **Not covered:** the migrations were not timed under live traffic; the Railway role's exact privileges were assumed to match an ordinary owner (they have run as one here); nothing was written to production at any point.
