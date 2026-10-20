# Phase 2 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Scope delivered: catalog, price lists, movement-based stock, balanced journals, daily close, admin transactions panel (view / void by reversal / export), merchant WhatsApp commands, docs. Everything is **implemented** and **locally tested**; nothing is sandbox-verified, partner-approved, production-configured or production-activated. All four new capabilities are behind flags that default OFF (`catalogV2`, `stockV2`, `accountingJournals`, `dailyClose`).

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **75 files / 879 tests pass** (Phase 1 ended at 69 / 761). Concurrency-sensitive suites (`stockV2`, `dailyClose`, `adminTransactions`: 61 tests) were run three more times in a row, all passing |
| `admin-frontend` `npx vitest run` + `npm run build` | 7 files / 36 tests pass; build succeeds |
| New in Phase 2 | `catalogPricing` 20, `stockV2` 33, `accounting` 23, `dailyClose` 12, `adminTransactions` 16, `operationsCommands` 14 (118 tests), plus migration drift and DB-protection suites extended |
| Known flake | `tests/inventory.test.ts` race test can fail under full-suite load and passes alone (14/14). Pre-existing, unchanged. |
| Concurrency tests | two-way and six-way contention for the last units, and a double-tap on `/close`, pass repeatedly on the in-process Postgres |

## 1. Failure scenarios

### F1. The Phase 2 migration fails or behaves differently on the real database
- **Plausible because:** it creates tables, CHECKs, constraint triggers, RLS policies and seeds flags. The tests run on PGlite (a superuser, in-process).
- **Evidence for:** migration SQL applies cleanly in order and the drift test proves migrations equal `schema.prisma`; the migration contains **no** `ALTER`/`DROP` on any existing table and no `ALTER TYPE` (verified by search), so it cannot disturb existing data; Railway's pre-deploy fails closed.
- **Not verified:** no Postgres server or Docker daemon was available here, so it has **not** run on a real server, through the real migration engine, or against a privilege-limited role. `scripts/rehearseMigrations.sh` runs `prisma migrate deploy` on a scratch copy, compares row counts before/after, and checks flags are off. It refuses non-local hosts without an explicit confirmation. It is **written, syntax-checked and its refusal paths tested, but never run against a database.** Required before any deploy.

### F2. Two orders take the last unit (scenario 2)
- **Evidence:** reservations lock the balance row (`SELECT ... FOR UPDATE`) and check available stock inside one transaction. Tests: two competing reservations, six concurrent single-unit reservations over three units, retries by idempotency key, release/expiry/fulfil, and a reconciliation that proves balance = movement log = active holds. DB CHECKs stop negative reserved/damaged/in-transit.
- **Not verified:** PGlite serialises sessions, so **true interleaving of two real connections contending for one row lock was not exercised.** The logic (check and update under the lock, conditional status claims) is sound by construction but the claim "no oversell under real concurrency" is **unproven** until run on a real server.

### F3. Books and stock drift because a side-effect failed
- The legacy path writes the transaction, then (flag on) its journal, then the stock mirror, as separate steps, and **swallows a failure** so a merchant's message never breaks. A crash or error between steps leaves a gap.
- **Detectors exist and are tested:** `findUnjournaledTransactions` / `backfillJournals`, `reconcileStock` (balance vs movements), `findLegacyStockDrift` (adopted items: legacy estimate vs new on-hand). **Gap:** nothing runs them on a schedule or shows them in the admin health page yet, so a person must call them. Recommended for Phase 8 (or sooner): a nightly check that raises an incident.

### F4. A merchant is told something wrong at daily close (most important caveat)
- The earlier WhatsApp flow never recorded **how** a sale was paid. The books therefore cannot know what is in the cash drawer: those receipts are posted to "method not recorded" and are deliberately **not** counted as cash. `/close` says so in plain words, but a merchant who counts all their money will see "you have MORE than your records" and the close will post a cash-over adjustment that is not really an overage.
- **Recommendation: do not enable `dailyClose` for any real merchant until payment method is captured (planned Phase 7), or enable it only for a business that logs with explicit methods.** This is recorded as decision D7. The feature is correct for entries that carry a method (tested) and honest about those that do not.

### F5. Costs and profit are overstated or invented
- **Evidence it is not:** no cost is ever guessed; units with no cost are tracked and any sale touching them is flagged `costIncomplete`; opening stock adopted from the old counts carries no cost; the catalog view contains no cost (tested); legacy sales have no COGS. Average and rounding rules are tested including half-way cases.
- **Known limits:** integer cost per base unit means very low-value goods (cost under about 1 minor unit per base unit, for example grams of rice) lose precision; choose a base unit whose unit cost is at least a few minor units. Backdated entries are costed at posting time and history is not restated. Profit reports are not built yet (Phase 8) and must carry the "incomplete" label when any outflow was flagged.

### F6. Tenant leakage through the new tables
- **Evidence:** all 18 new tables carry `businessId`, are in the tenant-scoped set and have an RLS policy (a test keeps those two lists identical); a DB trigger rejects a journal line whose account belongs to another business (tested directly against the database); catalog/stock/accounting/daily-close/command tests assert another tenant sees nothing and cannot post into another tenant's shop or variant.
- **Caveats:** RLS is still inert in production until the role step in `db-protection.md`; the two raw-SQL statements in the stock lock filter by `businessId` explicitly. The admin routes read through the raw client (as all existing admin routes do) and rely on the permission and support-access checks, not on tenant scoping.

### F7. The admin audit guarantee has holes
- **Evidence it holds:** every non-GET admin route that answers with `res.json` and succeeds writes an `admin.write` row (actor, target, reason, correlation id) **before** the response; failures write nothing; verified for existing writes (suspend) and the new void/export.
- **Holes:** (a) a route that answered with something other than `res.json` would be missed; I searched and the only `send` in the admin code is the read-only CSV export. (b) If the audit insert itself fails, the request still answers (the change already happened) and the failure is only logged, so a database outage could lose a row. (c) Step-up and support-access remain flag-gated and OFF, so by default an admin write is audited but not re-authenticated. (d) The Phase 1 gaps remain: support access gates invoices, payment requests and the new financial panels, but not `GET /businesses/:id`, `/mobile-money-alerts` or `/audit-logs`.

### F8. Admin void damages history
- **Evidence it does not:** the original transaction row is byte-for-byte unchanged after a void (compared in a test); a second void, a void of a reversal, a wrong-tenant id and a too-short reason are all refused; there is no DELETE/PUT/PATCH route (tested); the journal reversal nets the sale to zero and the debit/credit totals stay equal; stock is put back through the existing path.
- **Limit:** voiding reverses the legacy transaction and its stock/journal effects. A debt created from a credit sale in the legacy flow is a separate record that the existing `/undo` has never touched; the same is true of an admin void. Debt-book reconciliation is Phase 3 work.

### F9. Prices or quantities misread (scenario 3)
- **Evidence:** pack conversion only through declared packs; an undeclared unit is an error; wholesale minimum and breaks are deterministic; expired/retired/inactive prices never fall back to another list; derived pack prices are flagged; quantities are validated as positive whole numbers; line totals are exact integers.
- **Not yet testable:** "catalog edits never rewrite history" (snapshotting) applies to orders and invoices, which arrive in Phases 3-4; Phase 2 only prepares the price and unit data they will snapshot.

## 2. Master-prompt scenarios

| # | Scenario | Phase 2 status |
|---|---|---|
| 2 | B2C and B2B compete for the last units without overselling | locally tested (logic); real interleaving unverified (F2) |
| 3 | Pack conversion and wholesale minimums give exact stock and amounts | locally tested |
| 4 | Credit sale, partial payment, remaining balance, no duplicated revenue | locally tested |
| 5 | Cash, mobile money, fee, refund, owner withdrawal, stock purchase: balanced journals and daily-close differences | locally tested (explicit-method entries; see F4) |
| 25 | Existing commands and onboarding identical with all new flags off | locally tested: exact `/help` text, unknown-command replies, zero writes to new tables, whole pre-existing suite green |
| 28 | Every admin write audited with actor, reason, target, correlation id | locally tested; step-up requirement is flag-gated (OFF) |
| 29 | Hard delete on financial tables rejected by the database | locally tested for all new financial tables |
| 30 | Admin void leaves the original, creates a balanced reversal, stock and receivables reflect it | locally tested |

## 3. Not done in Phase 2, on purpose or by scope

- No web/PWA merchant surface: bulk catalog editing and stock counts by web are not built (WhatsApp commands and the admin panel are). Master prompt section 3 expects a web surface; it is planned with the storefront (Phase 4) and offline work (Phase 7). **This is a scope decision for you to confirm.**
- No payment-method capture in the WhatsApp flow (Phase 7), no reports (Phase 8), no purchase orders or goods-receipt documents (Phase 3), no storefront (Phase 4).
- No statement import UI (the existing SMS-forwarding flow is unchanged).

## 4. Owner decisions and actions

1. Confirm D1-D12 (`decisions.md` C3), especially D6/D7 and **keeping `dailyClose` off** for real merchants for now.
2. Confirm that bulk/web catalog editing waits for Phase 4/7.
3. Run `scripts/rehearseMigrations.sh` on a restored backup copy before any deploy (or authorise me to download Postgres/Docker locally to do a first real-server run).
4. Unchanged: OPEN-1..11, heartbeat monitor, alert sender + second recipient, Railway CLI relink, pawaPay and mobile-money approvals.

## 5. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access this phase; no messages sent to anyone.
