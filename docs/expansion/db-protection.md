# Database-level protection: runbook

Phase 1-3 · migrations `20261020000000` … `20261022000000` · status: **implemented, locally tested (PGlite). Not applied to any real database. Not rehearsed on a copy of production.**

## 1. What the database now enforces (without relying on application code)

| Rule | Mechanism | Tables |
|---|---|---|
| Rows are never edited | `BEFORE UPDATE` trigger raises | `Transaction`, `InventoryMovement`, `AuditLog`, `ConsentLog`, `DebtPayment`, `AiUsageLedger`, `SupportAccess`; `TransactionItem` (sole exception: one-time `inventoryItemId` NULL → value) |
| Rows are never deleted | `BEFORE DELETE` trigger raises | the append-only tables above, plus `Debt`, `Subscription`, `PaymentRequest`, `PawaPayDeposit`, `Invoice` |
| `TRUNCATE` is refused | statement-level trigger | the same tables |
| A business with a financial trail cannot be deleted | `tradepal_business_guard` | `Business` (delete allowed only if `isSynthetic`, or it has no Transaction/Debt/Subscription/PaymentRequest) |
| `isSynthetic` can never change | same guard | `Business` |
| Cross-tenant reads return nothing | RLS policy `tenant_isolation` on `businessId = current_setting('app.current_business_id')` | 24 tenant tables incl. `Shop`, `Membership` |
| Journals balance (debits = credits, >= 2 lines, every line in the entry's own business) | deferred constraint trigger, checked at commit | `JournalEntry`, `JournalLine` |
| Journal lines are one-sided positive amounts | CHECK | `JournalLine` |
| Stock/journal/daily-close history is append-only and cannot be truncated | triggers (same as Phase 1) | `StockMovement`, `JournalEntry`, `JournalLine`, `DailyClose` |
| Counts, transfers, reservations, accounts cannot be deleted | no-delete triggers | `StockCount(Line)`, `StockTransfer(Line)`, `StockReservation`, `Account` |
| Value sanity (pack >= 2, price > 0, validity windows, non-negative buckets, count discrepancy = counted - expected, close difference = counted - expected) | CHECK constraints | catalog/stock/close tables |
| Accepted trade orders are frozen (qty, pack, unit, price, variant); an order cannot become ACCEPTED unless it has priced lines | triggers `tradepal_order_accept_guard`, `tradepal_order_line_frozen` | `TradeOrder`, `TradeOrderLine` |
| Order lines are deletable only while the order is DRAFT | `tradepal_order_line_no_delete` | `TradeOrderLine` |
| Goods receipts, forecast predictions, scores and gate events are append-only; partners, links, orders, shipments, invoices, payments, credit notes, suggestions cannot be deleted | triggers | Phase 3 tables |
| Invoice amounts (paid + credited <= total), shipped <= ordered, received <= shipped, accepted + damaged + short <= shipped, line totals = qty x price | CHECK constraints | `TradeInvoice`, `TradeOrderLine`, `ShipmentLine`, `GoodsReceiptLine` |
| One open reorder suggestion per (shop, variant, method) | partial unique index | `ReorderSuggestion` |
| The per-merchant forecast gate can only be turned on through the promotion function; the global default can never be on | triggers on `BusinessFeatureFlag` and `FeatureFlag` (these two guards are the only change to existing tables) | flags |
| Money-purpose boundary | enum `PaymentPurpose` on `Invoice` / `PaymentRequest`; code guard `assertProviderAllowedForPurpose` | pawaPay: subscription only |

Synthetic (test/demo) businesses are the only ones whose financial rows may be hard-deleted. A real merchant is closed by suspension/anonymisation, never deletion (decision G13).

## 2. RLS is NOT active in production until you activate it

Postgres lets a table **owner** bypass RLS. The app connects as the owner, so the policies are present but **inert**. They have only been proven under a non-owner test role (`tradepal_tenant`). Turning them on is a separate, reversible step:

1. Rehearse on a copy first (see §5).
2. `CREATE ROLE tradepal_tenant NOLOGIN;` then `GRANT SELECT, INSERT, UPDATE, DELETE` on the tenant tables and `USAGE` on the sequences/types used (the owner keeps its rights). Grant the connecting login role membership: `GRANT tradepal_tenant TO <app_login_role>;`.
3. Move one code path at a time to `withTenantContext(prisma, businessId, work, { enforceRls: true })` (`src/db/tenantContext.ts`). It sets the setting with `set_config(..., true)` (transaction-local, cannot leak to the next request) and `SET LOCAL ROLE tradepal_tenant`.
4. Rollback: stop passing `enforceRls`. The policies stay but are inert again. Nothing is dropped.

Known limit: the append-only triggers apply to the owner too, so they **are** live as soon as the migration runs. RLS is the part that needs the role step.

## 3. Break-glass (legitimate corrections the triggers refuse)

Normal corrections never need this: reversals and adjustments are **inserts**, which the triggers allow. Break-glass is only for an owner-approved data repair (e.g. fixing a row written by a bug).

1. Get written owner approval and record the reason in `docs/expansion/decisions.md` or the ticket.
2. Take a backup/snapshot first.
3. In one transaction, as the table owner: `ALTER TABLE "<T>" DISABLE TRIGGER USER;` → the narrowest possible `UPDATE`/`DELETE` → `ALTER TABLE "<T>" ENABLE TRIGGER USER;` → verify with `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"<T>"'::regclass AND NOT tgisinternal;` (all `O`).
4. Insert an `AuditLog` row describing what was changed and why (the table is append-only; inserts work).
5. Never `DISABLE TRIGGER ALL` (that includes internal FK triggers).

`tests/helpers/db.ts` `backdateTransaction` uses exactly this pattern, for tests only.

## 4. Deleting synthetic data

Set `Business.isSynthetic = true` **at creation** (it cannot be changed later). Only then can its financial rows be deleted. A business created as real can never be converted to synthetic to enable deletion: this is deliberate.

## 5. Before any deploy (required, not yet done)

- Restore a recent production backup into a scratch database and run `prisma migrate deploy` there. Check: migrations apply cleanly; `SELECT count(*)` on every tenant table is unchanged; the Shop/Membership backfill created one default shop and one membership per active merchant; the four production merchants can still onboard/log/undo in a smoke test.
- Confirm the Railway Postgres role can run `CREATE FUNCTION`, `CREATE TRIGGER`, `ENABLE ROW LEVEL SECURITY`, `ALTER TYPE ... ADD VALUE`. **Unverified**: PGlite is superuser, so privilege problems cannot appear in tests.
- `/undo` and the dispatcher's welcome-rollback were exercised in tests; confirm on the copy that an undo still works (it inserts a reversal, never deletes).
- Railway's pre-deploy runs `prisma migrate deploy`: a failing migration blocks the deploy, which is the safe failure.

## 6. Verification state

| Claim | Evidence |
|---|---|
| Triggers refuse UPDATE/DELETE/TRUNCATE; synthetic exception works; `isSynthetic` immutable | `tests/dbProtection.test.ts` (18, PGlite direct) |
| Migrations build the same schema as `schema.prisma` | `tests/migrationDrift.test.ts` |
| RLS isolates tenants under the non-owner role | `tests/dbProtection.test.ts` (test role only) |
| Phase 2 tables are covered by RLS and the tenant scope | same test (the two lists must match exactly) |
| Migrations apply on a REAL Postgres server | **not verified**: no Postgres server or Docker daemon was available. `scripts/rehearseMigrations.sh` is provided for the owner to run on a restored backup (written, not yet run) |
| The forecast-gate trigger is an integrity guard, not a security boundary against someone with database superuser access who knows its transaction-local marker | by design; the application-level and admin controls are the policy |
| True concurrent lock contention (`FOR UPDATE`) | **not verified**: PGlite serializes sessions; the logic and atomic checks are tested, interleaving is not |
| Production Postgres accepts these migrations | **not verified** |
| RLS active in production | **no** (inert by design until §2) |

## Phase 4 additions

Migration `20261023000000_phase4_storefront_orders_support` (additive: no ALTER/DROP of existing objects, no ALTER TYPE).
- CHECKs: storefront slug format and values, delivery fee and minimum, basket line quantity, store order amounts (subtotal + fee = total, `paid >= 0`, `refunded <= paid`, delivery fee only for DELIVERY), line arithmetic, positive payment/exception amounts, refund line bounds.
- Trigger `tradepal_store_order_terminal`: COMPLETED and CANCELLED are final; EXPIRED may only go to CONFIRMED.
- `SupportCaseNote` is append-only (reuses `tradepal_append_only`).
- No-delete triggers on `Storefront`, `DeliveryZone`, `StoreOrder`, `StoreOrderLine`, `StorePayment`, `StoreCancellationRequest`, `StoreRefundRequest`, `StoreRefundLine`, `PaymentException`, `SupportCase`; TRUNCATE guards on all of them.
- RLS `tenant_isolation` policies on the 12 tenant tables (inert until the non-owner role step, like Phases 1-3). `Basket` and `BasketLine` are deliberately outside RLS: they are not tenant data and are reached only by token.
- Flags `storefront` and `storefrontOnlinePayment` are seeded OFF.

Verification: PGlite only (as before). **Not verified on a real Postgres server**; the migration is part of the same unrehearsed set (`scripts/rehearseMigrations.sh`).

## Phase 5 additions

Migration `20261024000000_phase5_payments_marketplace` (additive; the only changes to existing tables are new columns with defaults on `Storefront` and `Listing`; no `ALTER TYPE`, no drops).
- CHECKs: **`PaymentIntent.purpose = 'MERCHANT_SALE'`** (a forged subscription intent is refused by the database); positive amounts; `refunded <= paid` on the intent and `refunded <= captured` on the attempt (concurrent refunds cannot exceed what was collected); a SUCCEEDED attempt has a positive capture; settlement `gross = fee + net`; settlement line bounds.
- Partial unique index `PaymentAttempt_one_active_per_intent` (one active attempt per intent); unique (provider, provider reference) and idempotency keys on attempts, refunds and intents; one allocation per attempt; one settlement line per attempt; unique exception fingerprints.
- Triggers: a SUCCEEDED or FAILED attempt cannot change status; an intent that left OPEN cannot change status; `PaymentAttemptEvent` and `ModerationAction` are append-only; no-delete and TRUNCATE guards on every new payment and moderation table.
- RLS `tenant_isolation` on the 10 tenant tables. `ProviderException`, `MarketplaceReport` and `SimulatorPayment` are deliberately outside it (see data-model.md).
- Flag `marketplace` seeded OFF.

Verification: PGlite only (see sections 5-6). **Not verified on a real Postgres server.**

## Phase 6 additions

Migration `20261025000000_phase6_billing_entitlements` (additive: new columns with defaults on `Invoice` and `Subscription`; no `ALTER TYPE`, no drops; the `Invoice` table now has foreign keys pointing at it, so `TRUNCATE "Invoice"` needs `CASCADE` to even be attempted, and the TRUNCATE guard still refuses it).
- CHECKs: `BillingSwitch.purpose = 'PLATFORM_SUBSCRIPTION'` (billing can never be switched for merchant sales); `Invoice.refundedMinor <= paidMinor`; amounts and period bounds; `PlanVersion` period 1-366 days and grace 0-30; positive prices; `BillingAttempt.environment` is SANDBOX or PRODUCTION; a COMPLETED attempt has a positive capture.
- Partial unique index `BillingAttempt_one_active_per_invoice`; unique `BillingAllocation` per invoice and per attempt; unique exception fingerprints.
- Triggers: a COMPLETED, FAILED or REJECTED billing attempt cannot change status; a PAID invoice cannot become unpaid and a refunded one cannot become anything but refunded; a published `PlanVersion` is frozen (only PUBLISHED -> RETIRED) and so are its `PlanPrice` rows; `EntitlementEvent` and `BillingAllocation` are append-only; no-delete and TRUNCATE guards on every new table.
- RLS `tenant_isolation` on the 4 tenant tables. Plans, prices, switches, signing keys, exceptions and the account binding are platform data.
- Flags `pawapayBilling` and `subscriptionEntitlements` seeded OFF.

Verification: PGlite only. **Not verified on a real Postgres server.**
