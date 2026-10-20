# Phase 8 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (still the same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Delivered: bookkeeping reports (sales, cash flow, inventory valuation, money owed and owing, gross margin with completeness warnings, payment reconciliation, stock discrepancies) with formula-safe CSV, on WhatsApp and on the phone page; the "Net" line relabelled; performance budgets and a repeatable measurement; admin-route and public-surface penetration checks; a migration rehearsal over legacy data; and fixes for four real defects the checks found. Everything is **implemented** and **locally tested**. **Nothing is sandbox verified, partner approved, production configured or production activated.** New flag `reportsV2` and switch `REPORTS_WEB_ENABLED` are OFF.

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **111 files / 1248 tests pass** (Phase 7 ended at 105 / 1184) |
| `admin-frontend` `npx vitest run` + `npm run build` | 13 files / 57 tests pass; build succeeds (unchanged this phase) |
| New in Phase 8 | `reports` 20, `reportsWeb` 5, `securityAdminRoutes` 14, `securityPublic` 7, `perfBudgets` 8, `migrationRehearsal` 10 (64 tests) |
| Real browser | the phone page was exercised in Chrome (service worker, offline load, local drafts, failed send, logout wipe): see `performance-baseline.md` |

## 1. Failure scenarios

### F1. The migrations lose or change real data
- **Evidence:** the rehearsal compares every legacy column of 23 legacy tables byte for byte after all 12 expansion migrations, plus balances, ownership, references and subscription status (see `migration-rehearsal.md`); the application then runs against the migrated data. **It found a real defect**: a legacy PAID invoice migrated with `paidMinor = 0`. Fixed and re-tested.
- **Unverified:** this is **PGlite, not a real Postgres and not a restored backup.** Lock times on large tables, the Railway role's privileges to create functions, triggers and policies, migration duration and behaviour under live traffic are unknown. `scripts/rehearseMigrations.sh` (extended this phase to check paid invoices and memberships) has still never been run. The legacy dataset is realistic but invented; production's real rows (4 merchants, 1 transaction when Phase 0 looked) may contain shapes it does not (null columns, odd characters, orphaned rows).

### F2. A report shows a wrong or misleading number
- **Evidence:** arithmetic is tested against figures worked out by hand (a shop sale of 300.00 with cost 120.00 gives sales 300.00, cost 120.00, margin 180.00 = 60.0%; aging buckets; opening + in - out = closing; a voided sale nets to zero and is not counted; local-day bucketing across midnight in Lagos); a report that cannot be honest is refused; every figure carries its warnings; other-currency entries are excluded with a warning; a hostile customer name cannot become a formula.
- **Gaps:** (a) **everything depends on the journals.** With `accountingJournals` off, only the sales report works and it excludes shop orders, wholesale sales and refunds; cash flow and margin refuse. Businesses with journals on only have journal entries from the day they were switched on, plus whatever the backfill posted; the report warns about un-journaled chat entries but cannot fix them. (b) **Margin is only as good as stock costs.** Chat-typed sales rarely link to stock, so for a typical chat-only merchant gross margin shows "not available" or an overstated figure with a warning. (c) Money owed to you does not itemise shop orders paid on collection, advances or opening balances (it shows the difference from the books); money you owe a supplier for chat purchases is not tracked at all. (d) Inventory is valued **now** only; a past date is refused, so there is no month-end valuation. (e) No tax, no multi-currency totals, no FX. (f) The reports were tested on small synthetic data; none has been checked against a real merchant's books or by an accountant. (g) The weekly digest still prints "Net" (its text sits inside approved templates).

### F3. The pages are too heavy or too slow for the people who use them
- **Evidence:** byte budgets are enforced in CI; a 30-product shop page is 25.7 KB and 2.8 KB compressed, makes no further requests, needs no script, and loaded in 69-80 ms in a real browser on a fast laptop. Compression was **added** because the page was previously sent uncompressed (about 4 seconds on 2G, computed).
- **Not measured (stated plainly in `performance-baseline.md`):** anything on low-end hardware or a throttled or real mobile network. The transfer times on slow links are arithmetic from byte counts, not measurements. Server times are PGlite on loopback. Image weight is not part of any page (product photos are still blocked by the security headers). The admin console (93 KB gzip) was not tuned for slow links. The compression is deliberately absent from pages carrying secrets, so an order page is sent uncompressed (under its 20 KB budget).

### F4. An attacker, or a former admin, gets in or crashes something
- **Evidence:** every admin route (over 100, read from the router) refuses every form of missing, forged, expired, logged-out, merchant-shaped or disabled credential; the analyst can write nothing; hostile ids and query strings never give a 500; public routes and webhooks survive hostile input.
- **Found and fixed:** (1) a removed, disabled or demoted admin kept their power for up to 12 hours (and no admin could be disabled at all); (2) a NUL character in any URL or body caused a database error and a 500 on the shop, marketplace and other pages; (3) role lookups threw on an unknown role name; (4) cost reports were readable by a sales clerk.
- **Not done:** no human penetration test, no dependency audit, no load or abuse testing. Admin login is limited per email only, in memory, with no multi-factor step; tokens are 12 hours and not device-bound. The phone token sits in IndexedDB. Row-level security is still inert in production. The NUL guard is not applied to the Meta, Flutterwave and older pawaPay webhooks (left unchanged on purpose).

### F5. The new flag changes something for people who did not turn it on
- With `reportsV2` off the earlier suites pass unchanged and `/report` answers "Unrecognized command"; `/today` still says "Net". The only behaviour change that applies to everyone is not flag-gated and is deliberate: pages on the shop and phone assets are gzip-compressed for clients that ask, the NUL guard returns 400 where there used to be a 500, admin tokens are checked against the account on every request (**one extra database read per admin request**), and legacy PAID invoices now read as paid in full after migration.

### F6. Reports leak what they should not
- Reports are tenant-scoped (the connected business only; a `businessId` in the query is ignored, tested); numbers are masked nowhere because they are the merchant's own. A sales clerk cannot read cost or balance reports; only an owner or manager can request a download link. **Gaps:** a manager can read margins and stock value and export them; the phone session is a bearer token (see F4); a CSV file, once downloaded, is outside any control; the reports panel has no audit of who downloaded what (the admin audit covers admin writes only).

### F7. Concurrency and scale
- Reports read live tables with several queries each and **no snapshot isolation**, so a report run during heavy writing can mix moments (small for a merchant's size, unproven). They load a period's journal lines into memory (capped at 366 days); a very busy merchant's sales report would be slow and large. Not load tested.

## 2. Master-prompt scenarios

| # | Scenario | Phase 8 status |
|---|---|---|
| 22 | Migration rehearsal preserves balances, ownership, references, subscription status | locally tested on PGlite with a legacy dataset; **not on a real server or a restored backup** |
| 27 | Admin routes reject every merchant role and unauthenticated access; a platform admin without merchant membership cannot act as a merchant | locally tested (automated route-table walk; not a human pen test) |
| 25 | Existing behaviour identical with flags off | locally tested (full pre-existing suite) |
| n/a | Reports with provenance and completeness warnings; formula-safe exports; performance baselines recorded | reports locally tested; budgets enforced; **speed on target hardware not measured** |

## 3. Owner decisions and actions

1. **OPEN-16:** run `scripts/rehearseMigrations.sh` on a restored production backup (or authorise a local Postgres download) before any deploy; and measure the shop and phone pages on a real low-end phone over a throttled link.
2. **OPEN-17:** whether the weekly digest template's "Net" wording should change (needs a new approved template).
3. Confirm K1-K9 (`decisions.md` C9), especially: cost reports need `finance:reconcile` (a sales clerk cannot see margin); margin is "not available" rather than estimated; gzip only on secret-free pages; admin tokens now re-checked per request.
4. Disable any admin account that should no longer have access with `npx tsx scripts/disableAdmin.ts <email>` (there is still no screen for it).
5. Add to the activation checklist: `REPORTS_WEB_ENABLED`, plus the Phase 4-7 items; keep `dailyClose` off.
6. Get an accountant to read one real merchant's reports against their books before telling merchants to rely on them.
7. Unchanged: OPEN-1..15, heartbeat monitor, alert sender, Railway relink, pawaPay and mobile-money approvals.

## 4. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access; no message sent to anyone; no real money. A throwaway local server with synthetic data was run for measurements and stopped; the built-in browser and Chrome were pointed at it only. Two browser tabs were opened for this and closed.

AWAITING: APPROVED: PHASE 8
