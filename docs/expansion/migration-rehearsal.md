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
