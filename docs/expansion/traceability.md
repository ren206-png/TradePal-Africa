# Requirement traceability (Phases 1-3)

Status vocabulary: implemented / locally tested / sandbox verified / partner approved / production configured / production activated. Nothing here is above "locally tested". Rows for later phases are added as they are built.

| Requirement (master prompt) | Code | Tests | Status |
|---|---|---|---|
| 5/G5 pawaPay only for subscriptions | `domain/paymentPurpose.ts`, guarded initiators, `/collect` `/paylink` locked | `purposeBoundary.test.ts` | locally tested |
| 7/G7 separate subscription vs merchant money | purpose enum on `Invoice`/`PaymentRequest` | same | locally tested |
| 6 tenancy, memberships, permissions | `auth/permissions.ts`, `domain/memberships.ts`, Shop/Membership | `permissions.test.ts`, `memberships.test.ts` | locally tested |
| 7 invariant 1 integer minor units | BigInt everywhere; `rounding.ts` | `catalogPricing.test.ts` (rounding), accounting tests | locally tested |
| 7 invariant 4 rounding/allocation, totals agree | `domain/rounding.ts`, `pricing.ts` | `catalogPricing.test.ts` | locally tested (document-level totals arrive with orders in Phase 3/4) |
| 7 invariant 5 balanced journals | `domain/accounting.ts` + deferred DB trigger | `accounting.test.ts` | locally tested |
| 7 invariant 6 corrections by reversal | `reverseJournalEntry`, `reverseStockMovement`, `reverseTransaction` | `accounting.test.ts`, `stockV2.test.ts`, `adminTransactions.test.ts` | locally tested |
| 7 invariant 7 provenance | `Provenance` on journals and stock movements | `accounting.test.ts`, `catalogPricing.test.ts` | locally tested |
| 7 invariant 8 opening balances labelled, nothing fabricated | `postOpeningBalance`, `adoptLegacyInventory`, legacy "not recorded" accounts | `accounting.test.ts`, `catalogPricing.test.ts` | locally tested |
| 7 invariant 9 DB-enforced under concurrency | triggers/CHECKs/row locks | `dbProtection.test.ts`, `stockV2.test.ts` | locally tested (PGlite; real interleaving unverified) |
| 8 catalog, units, packs, aliases | `domain/catalog.ts` | `catalogPricing.test.ts` | locally tested |
| 8 retail/wholesale lists, breaks, validity | `domain/pricing.ts` | `catalogPricing.test.ts` | locally tested |
| 8 one stock system, buckets, reservations with expiry | `domain/stock.ts` | `stockV2.test.ts` | locally tested |
| 8 counts with approved adjustments, transfers with dispatch/receipt | same | same | locally tested |
| 8 costing, incomplete-cost labelling | same | same | locally tested |
| 8 PO does not increase stock; confirmed receipt does | `receiveStock` is the only stock-in | n/a until POs exist (Phase 3) | implemented |
| 11 balanced postings, daily close | `accounting.ts`, `dailyClose.ts` | `accounting.test.ts`, `dailyClose.test.ts` | locally tested |
| 11 statement import, SMS-as-proposal | existing `MobileMoneyAlert` flow unchanged | existing tests | partial (pre-existing; import UI not in Phase 2) |
| 18 admin: transactions panel view/void/export | `admin/adminTransactions.ts`, frontend `TransactionsPage` | `adminTransactions.test.ts`, `TransactionsPage.test.tsx` | locally tested |
| 18 admin: step-up, support access, audit with correlation id | `admin/platformGuards.ts`, `adminAudit.ts` | `platformAdmin.test.ts`, `adminTransactions.test.ts` | locally tested (flags off by default) |
| 18 delete rules, 29 hard delete rejected in DB | triggers | `dbProtection.test.ts`, `stockV2.test.ts`, `accounting.test.ts` | locally tested |
| 20 scenario 2 last units, no oversell | `reserveStock` | `stockV2.test.ts` | locally tested |
| 20 scenario 3 pack conversion + wholesale minimum exact | catalog + pricing | `catalogPricing.test.ts` | locally tested |
| 20 scenario 4 credit/partial, no duplicated revenue | `postSale`, `postDebtCollection` | `accounting.test.ts` | locally tested |
| 20 scenario 5 cash/wallet/fee/refund/withdrawal/purchase + daily close | posting rules, `dailyClose.ts` | `accounting.test.ts`, `dailyClose.test.ts` | locally tested |
| 20 scenario 25 flags off = unchanged | flag-gated hooks; commands return null | `operationsCommands.test.ts` + the full pre-existing suite | locally tested |
| 20 scenario 28/30 admin audit, void keeps original | `adminAudit.ts`, void route | `adminTransactions.test.ts` | locally tested |
| 9 linked buyer/seller records with separate tenant ownership | `domain/trade/*` (own row per business, outbox sync) | `tradeFlow.test.ts`, `tradeRules.test.ts` | locally tested |
| 9 supplier publishes listings; buyer orders against valid pricing and minimums | `partners.ts` shared catalog, `pricing.ts` | `tradeFlow.test.ts`, `tradeRules.test.ts` | locally tested |
| 9 acceptance freezes terms; quote validity; separate acceptance/goods/invoice/payment states | `orders.ts`, DB triggers, `fulfilment.ts`, `payments.ts` | `tradeRules.test.ts` | locally tested |
| 9 partial fulfilment, receipt, discrepancies; PO does not raise stock, receipt does | `shipOrder`, `receiveShipment` | `tradeFlow.test.ts` | locally tested |
| 9 invoice, receivable/payable, partial payments, external payments are not a second sale | `TradeInvoice`, `TradePayment` | `tradeFlow.test.ts` | locally tested |
| 9 trade credit recorded by the seller; no lending/scoring/AI | `credit.ts` | `tradeRules.test.ts` | locally tested |
| 9 reorder Tier 1 deterministic, draft only | `reorder.ts` | `reorderTier1.test.ts` | locally tested |
| 9 reorder Tier 2 shadow, scoring, promotion gate | `forecast.ts`, `forecastGate.ts` | `forecast.test.ts`, `adminReorder.test.ts` | locally tested |
| 12 simulator, signed callbacks, durable inbox, purpose boundary, forged purpose refused | `payments/simulator.ts` | `tradeFlow.test.ts` | locally tested |
| 18 admin: reorder and forecasting panel, flip gate (owner only), thresholds | `admin/adminReorder.ts`, `ReorderPage` | `adminReorder.test.ts`, `ReorderPage.test.tsx` | locally tested |
| 20 scenario 1 wholesaler to retailer, partial receipt, isolation | as above | `tradeFlow.test.ts` | locally tested |
| 20 scenario 31 Tier 1 arithmetic, draft only | `reorder.ts` | `reorderTier1.test.ts` | locally tested |
| 20 scenario 32 Tier 2 shadow invisible, scored vs actual and Tier 1, gate rejected below / audited above | `forecast.ts`, `forecastGate.ts` | `forecast.test.ts`, `adminReorder.test.ts` | locally tested |
| 22 demo: wholesaler -> retailer with simulator; forecast rows and scores in admin | `scripts/demoWholesale.ts` | `demoPath.test.ts` | locally tested (consumer step and pawaPay renewal belong to later phases) |
| 10 B2C storefront on the same inventory and accounting services | `domain/store/*`, `storefront/routes.ts` | `storeCheckout.test.ts`, `storeOrders.test.ts`, `storefrontWeb.test.ts` | locally tested |
| 10 pickup and delivery workflows, handover code | `orders.ts`, `/store` commands, order page | `storeOrders.test.ts`, `storefrontWeb.test.ts`, `storeCommands.test.ts` | locally tested |
| 10 cancellation and refund policy, returns restock at original cost | `cancellationPolicy`, `refundPolicy`, `refunds.ts` | `storeOrders.test.ts` | locally tested |
| 10 support cases name the responsible party; admin panel | `cases.ts`, `admin/adminSupport.ts`, `SupportCasesPage` | `storeOrders.test.ts`, `adminSupport.test.ts`, `SupportCasesPage.test.tsx` | locally tested |
| 20 scenario 10 late / duplicate / over / under / wrong-currency payment | `payments.ts`, simulator inbox route | `storeOrders.test.ts`, `storefrontWeb.test.ts` | locally tested |
| 20 scenario 18 no tenant or cost leakage; token-only order access | `storefront.ts` projection, `resolveOrderByToken`, `publicOrderView` | `storefrontWeb.test.ts`, `storeCheckout.test.ts` | locally tested |
| 20 scenario 19 pickup and delivery end to end through the web | `storefront/routes.ts` | `storefrontWeb.test.ts` | locally tested |
| 12 online payment is simulator-only and refused in production | `simulatedPaymentsAllowed`, `/order/:token/pay` | `storefrontWeb.test.ts` | locally tested |
| 20 scenario 2 no oversell across channels (consumer holds) | reservations, expiry sweep | `storeCheckout.test.ts`, `storeSweep.test.ts` | locally tested |
| 12 adapter contract, explicit capability errors, simulator | `payments/adapter.ts`, `simulatorAdapter.ts` | `paymentsLifecycle.test.ts` | locally tested (no real provider exists to test against) |
| 12 intent / attempt / allocation / refund / settlement, idempotency, DB constraints | `domain/merchantPayments/*`, migration 20261024 | `paymentsLifecycle.test.ts`, `tradeFlow.test.ts`, `storefrontWeb.test.ts` | locally tested |
| 12 secrets server-side, no merchant URLs, provider allow-list | `registerConnection`, `PURPOSE_POLICY` | `paymentsLifecycle.test.ts`, `adminPayments.test.ts` | locally tested |
| 20 scenario 7 concurrent and replayed callbacks, one effect | `applyPaymentSnapshot` (guarded UPDATE) | `paymentsLifecycle.test.ts` | locally tested (replays and repeated appliers; real interleaving unproven) |
| 20 scenario 8 forged signature / wrong account, tenant, purpose / amount, currency mismatch / unknown reference | `receiveProviderCallback`, `applyPaymentSnapshot` | `paymentsLifecycle.test.ts` | locally tested |
| 20 scenario 9 accepted, timed-out, unknown stay unpaid until authenticated evidence | `startPaymentAttempt`, `refreshAttempt`, `reconcilePayments` | `paymentsLifecycle.test.ts` | locally tested |
| 20 scenario 10 late success is a recoverable exception | `closeIntentsForSubject`, `applyToSubject`, `resolvePaymentException` | `paymentsLifecycle.test.ts` | locally tested |
| 20 scenario 11 no two active attempts | partial unique index, `startPaymentAttempt` | `paymentsLifecycle.test.ts` | locally tested |
| 20 scenario 12 refunds bounded; failed refund stays unresolved | `refundThroughProvider`, `retryFailedRefund` | `paymentsLifecycle.test.ts`, `storeCommandsPayments.test.ts` | locally tested (sequential; real interleaving unproven) |
| 20 scenario 13 settlement is not a second sale | `recordSettlementReport` | `paymentsLifecycle.test.ts` | locally tested |
| 20 scenario 14 merchant routes cannot reach pawaPay; forged purpose | purpose policy, DB CHECK, `registerConnection` | `paymentsLifecycle.test.ts`, `adminPayments.test.ts` | locally tested |
| 20 scenario 23 provider outage blocks new attempts, reconciliation continues | circuit in `common.ts`, `startPaymentAttempt` | `paymentsLifecycle.test.ts`, `storefrontWeb.test.ts` | locally tested |
| 20 scenario 24 suspended listings unavailable by URL and search; servicing continues | `marketplace.ts`, `moderation.ts`, storefront loaders | `marketplace.test.ts` | locally tested |
| 10 marketplace discovery, filters, seller identity, ranking inputs, reports, moderation, appeals | `domain/marketplace.ts`, `domain/moderation.ts`, marketplace routes | `marketplace.test.ts`, `storeCommandsPayments.test.ts` | locally tested |
| 18 admin payments and exceptions panel; listings and moderation panel | `admin/adminPayments.ts`, `admin/adminModeration.ts`, `PaymentsPage`, `ModerationPage` | `adminPayments.test.ts`, `adminModeration.test.ts`, page tests | locally tested |
| 13 versioned plans, country prices, no invented price points | `domain/subscriptions/plans.ts`, DB freeze triggers | `billingRenewal.test.ts`, `adminSubscriptions.test.ts` | locally tested |
| 13 renewal checkout customer-authorised, no recurring mandates | `domain/subscriptions/renewal.ts` | `billingRenewal.test.ts`, `billingCommands.test.ts` | locally tested (against an in-memory fake of pawaPay) |
| 13 account-enabled configuration, sandbox/production distinct, fail closed | `common.ts` config builder, active-conf, account binding | `billingRenewal.test.ts` | locally tested |
| 13 RFC 9421 callback verification, digest, replay window, key rotation | `pawapay/signature.ts`, `billingWebhook.ts` | `pawapaySignature.test.ts`, `billingRenewal.test.ts` | locally tested (self-generated vectors; not verified against pawaPay) |
| 13 idempotent allocation to invoice and period; duplicate/over/under/mismatch handling | `collection.ts` | `billingRenewal.test.ts` | locally tested |
| 13 early renewal, late payment, plan change, cancellation defaults (no proration) | `renewal.ts`, `collection.ts` | `billingRenewal.test.ts` | locally tested |
| 13 refunds for subscription charges only, audited | `collection.ts`, `adminSubscriptions.ts` | `billingEntitlements.test.ts`, `adminSubscriptions.test.ts` | locally tested |
| 13 entitlement matrix, grace, expiry, servicing continues, security suspension separate | `entitlements.ts` | `billingEntitlements.test.ts` | locally tested |
| 13 billing flags do not block servicing; separate switch for new charges | `assertNewChargeAllowed`, `BillingSwitch` | `billingEntitlements.test.ts`, `adminSubscriptions.test.ts` | locally tested |
| 13 billing money never enters merchant ledgers; merchant routes cannot reach pawaPay | schema separation, purpose policy | `billingEntitlements.test.ts`, `paymentsLifecycle.test.ts` | locally tested |
| 20 scenario 15 duplicate subscription callbacks cannot double-extend; mismatched payments grant no access | `allocateBillingPayment` | `billingRenewal.test.ts` | locally tested |
| 20 scenario 16 expiry restricts configured features while pending payments, reconciliation, servicing, refunds, renewal continue | `assertEntitled`, call-site gates | `billingEntitlements.test.ts` | locally tested |
| 18 admin subscriptions panel: plans, versions, subscriptions, invoices, entitlements, attempts, exceptions, refunds, manual adjustment, switches, reminder, export | `admin/adminSubscriptions.ts`, `SubscriptionsPage` | `adminSubscriptions.test.ts`, `SubscriptionsPage.test.tsx` | locally tested |
