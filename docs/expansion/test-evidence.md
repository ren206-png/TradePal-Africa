# Test evidence (actual command output)

Captured 2026-10-20 on the development machine, branch `expansion/phase-1`, from a clean tree. Output is trimmed only where it is a stack-trace line from a test that deliberately provokes an error. **There are no failing tests.** What this evidence cannot show is in "External limitations" at the end.

## Type check
```
$ npx tsc --noEmit -p .
exit 0
```

## Backend suite
```
$ npx vitest run
tests/pawapayCollection.test.ts (34 tests)
tests/commandRouter.test.ts (62 tests)
tests/stockV2.test.ts (35 tests)
tests/billingRenewal.test.ts (17 tests)
tests/storeCheckout.test.ts (16 tests)
tests/messageDispatcher.test.ts (49 tests)
tests/storeOrders.test.ts (19 tests)
tests/tradeRules.test.ts (21 tests)
tests/paymentsLifecycle.test.ts (21 tests)
tests/accounting.test.ts (23 tests)
tests/catalogPricing.test.ts (20 tests)
tests/messaging.test.ts (21 tests)
tests/migrationRehearsal.test.ts (10 tests)
tests/deepseekProvider.test.ts (23 tests)
tests/billingEntitlements.test.ts (11 tests)
tests/tradeFlow.test.ts (5 tests)
tests/marketplace.test.ts (9 tests)
tests/conversation.test.ts (22 tests)
tests/deletion.test.ts (14 tests)
tests/reports.test.ts (20 tests)
tests/forecast.test.ts (13 tests)
tests/offlineDrafts.test.ts (17 tests)
tests/merchantIdentity.test.ts (18 tests)
tests/businessDigest.test.ts (12 tests)
tests/payments.test.ts (12 tests)
tests/subscriptionExpiry.test.ts (12 tests)
tests/reorderTier1.test.ts (10 tests)
tests/storefrontWeb.test.ts (17 tests)
tests/adminTransactions.test.ts (16 tests)
tests/paymentRequests.test.ts (10 tests)
tests/outboxInbox.test.ts (15 tests)
tests/adminSubscriptions.test.ts (9 tests)
tests/signupJourney.test.ts (15 tests)
tests/dbProtection.test.ts (18 tests)
tests/deepseekIntegration.test.ts (11 tests)
tests/adminPayments.test.ts (6 tests)
tests/dailyClose.test.ts (12 tests)
tests/storeCommands.test.ts (7 tests)
tests/mobileMoneyReconciliation.test.ts (21 tests)
tests/adminMessaging.test.ts (11 tests)
tests/adminRoutes.test.ts (64 tests)
tests/aiUsageLedger.test.ts (14 tests)
tests/outboundGateway.test.ts (15 tests)
tests/operationsCommands.test.ts (14 tests)
tests/adminReorder.test.ts (6 tests)
tests/inventory.test.ts (14 tests)
tests/billing.test.ts (13 tests)
tests/pawapaySignature.test.ts (8 tests)
tests/memberships.test.ts (10 tests)
tests/applyParsedIntent.test.ts (13 tests)
tests/onboardingFlow.test.ts (15 tests)
tests/aiBudget.test.ts (14 tests)
tests/tradeSetupCommands.test.ts (3 tests)
tests/platformAdmin.test.ts (20 tests)
tests/featureFlags.test.ts (14 tests)
tests/webhookRedrive.test.ts (11 tests)
tests/planAdmin.test.ts (12 tests)
tests/storeCommandsPayments.test.ts (3 tests)
tests/securityPublic.test.ts (7 tests)
tests/tradeCommands.test.ts (4 tests)
tests/securityAdminRoutes.test.ts (14 tests)
tests/aiFailureAlerts.test.ts (8 tests)
tests/adminModeration.test.ts (4 tests)
tests/reportsWeb.test.ts (5 tests)
tests/adminSupport.test.ts (6 tests)
tests/dailySummary.test.ts (6 tests)
tests/permissions.test.ts (9 tests)
tests/adminOps.test.ts (5 tests)
tests/perfBudgets.test.ts (8 tests)
tests/aiParse.test.ts (10 tests)
tests/retryWithBackoff.test.ts (7 tests)
tests/asyncHandler.test.ts (6 tests)
tests/processGuards.test.ts (5 tests)
tests/alerts.test.ts (7 tests)
tests/debtBook.test.ts (4 tests)
tests/circuitBreaker.test.ts (6 tests)
tests/authMiddleware.test.ts (4 tests)
tests/purposeBoundary.test.ts (7 tests)
tests/inboundRateLimiter.test.ts (6 tests)
tests/listEntry.test.ts (6 tests)
tests/adminRateLimiter.test.ts (6 tests)
tests/paymentRequestExpiry.test.ts (4 tests)
tests/redisFixedWindowLimiter.test.ts (5 tests)
tests/bareCommands.test.ts (7 tests)
tests/webhookHandler.test.ts (6 tests)
tests/aiProvider.test.ts (8 tests)
tests/countryRegistry.test.ts (5 tests)
tests/businessModeration.test.ts (8 tests)
tests/billingCommands.test.ts (3 tests)
tests/mediaGateway.test.ts (5 tests)
tests/modelRegistry.test.ts (7 tests)
tests/paymentWebhook.test.ts (2 tests)
tests/tenantScope.test.ts (5 tests)
tests/sttProvider.test.ts (4 tests)
tests/envExample.test.ts (3 tests)
tests/requestErrorHandler.test.ts (3 tests)
tests/riskLabel.test.ts (6 tests)
tests/deepseekEnv.test.ts (4 tests)
tests/webhookSignature.test.ts (5 tests)
tests/countries.test.ts (4 tests)
tests/migrations.test.ts (3 tests)
tests/ledger.test.ts (4 tests)
tests/money.test.ts (5 tests)
tests/adminPagination.test.ts (6 tests)
tests/seed.test.ts (2 tests)
tests/flutterwaveSignature.test.ts (4 tests)
tests/migrationDrift.test.ts (1 test)
tests/reminders.test.ts (2 tests)
tests/auditLog.test.ts (3 tests)
tests/storeSweep.test.ts (1 test)
tests/aiParseLog.test.ts (2 tests)
tests/spike.test.ts (1 test)
tests/demoPath.test.ts (1 test)
tests/demoRelease.test.ts (1 test)
 Test Files  114 passed (114)
      Tests  1257 passed (1257)
   Start at  17:23:23
   Duration  76.02s (transform 3.24s, setup 0ms, collect 24.35s, tests 693.39s, environment 13ms, prepare 6.17s)
```

## Admin console suite and build
```
$ (cd admin-frontend && npx vitest run && npm run build)
 Test Files  14 passed (14)
      Tests  59 passed (59)
   Duration  2.46s (transform 1.08s, setup 1.58s, import 1.91s, tests 7.24s, environment 8.02s)
dist/index.html                   0.85 kB │ gzip:  0.44 kB
dist/assets/index-CngxflmW.css    8.51 kB │ gzip:  2.76 kB
dist/assets/index-Cu-ORQ15.js   338.61 kB │ gzip: 93.62 kB

✓ built in 81ms
```

## Release demo (also run as `tests/demoRelease.test.ts`)
```
$ npx tsx scripts/demoRelease.ts
PART 1. Wholesaler purchase and retailer receipt
  Retail Corner's reorder rule fires: You have 0 piece (on hand 0 - reserved 0 + on order 0). Your reorder point is 10, and 0 is at or below it. Your usual reorder quantity is 60 piece.
  Order PO-000001 (6600.00 NGN) accepted, shipped, invoiced as INV-000001, received. Stock goes up only on the confirmed receipt.
  The retailer pays the invoice through the SIMULATED provider: a signed callback is stored, then applied once. No money moved.
PART 2. Consumer orders at Retail Corner, paid through the simulator, then fulfilled
  Amaka orders 5 and pays online: order ORD-000001 is CONFIRMED, paid 750.00 NGN. Revenue is NOT recognised yet.
  She collects it with her code: stock leaves, revenue and cost of goods are booked at hand-over.
  Chidi orders 2, pays cash at the counter: same hand-over rule.
  A third shopper cancels, but their payment still arrives: it is HELD as an exception (1), never silently applied.
  A visitor reports the marketplace listing: it goes to the moderation queue. Nothing is taken down automatically.
  Consumer messaging: Amaka opted in at checkout, but no template is approved, so the update is SUPPRESSED (TEMPLATE_NOT_APPROVED). Nothing was sent.
PART 3. Reports for Retail Corner (bookkeeping, never profit)
  Sales (2026-10-13 to 2026-10-21, Africa/Lagos, NGN)
  Sales: 1050.00 NGN
  Returns and refunds: 0.00 NGN
  Gross margin (before operating expenses) (2026-10-13 to 2026-10-21, Africa/Lagos, NGN)
  Net sales: 1050.00 NGN
  Cost of goods sold: 641.69 NGN
  Cash flow (2026-10-13 to 2026-10-21, Africa/Lagos, NGN)
  cash: 0.00 NGN + in 300.00 NGN - out 0.00 NGN = 300.00 NGN
  mobile money: 0.00 NGN + in 0.00 NGN - out 6600.00 NGN = -6600.00 NGN
  Inventory valuation (as of 2026-10-20, Africa/Lagos, NGN)
  Valued stock: 5958.55 NGN (65 units)
  Units with no cost: 0
  Money owed to you (aging) (as of 2026-10-20, Africa/Lagos, NGN)
  Total: 0.00 NGN
  ! This report lists what is owed to you. TradePal does not contact anyone about it.
  Money you owe (aging) (as of 2026-10-20, Africa/Lagos, NGN)
  Total: 0.00 NGN
  ! Purchases and expenses you typed in chat are recorded as paid. Money you owe a supplier for those is not tracked, so it does not appear here.
  Payment reconciliation (2026-10-13 to 2026-10-21, Africa/Lagos, NGN)
  Captured: 900.00 NGN; applied: 750.00 NGN; not applied: 150.00 NGN (held in exceptions: 150.00 NGN)
  Settled: 0.00 NGN; captured, not yet settled: 900.00 NGN
  Stock discrepancies (2026-10-13 to 2026-10-21, Africa/Lagos, NGN)
  Balance mismatches: 0
  Count variances: 0
PART 4. A SEPARATE subscription renewal through pawaPay (an in-memory FAKE: no sandbox exists yet)
  Fatu Traders pays its renewal: the signed callback answered 200, pawaPay's own record confirmed it, the plan is ACTIVE for 30 days, invoice PAID.
  A payment of the wrong amount from another business grants nothing and becomes a billing exception (1).
PART 5. A synthetic merchant's shadow forecast, scored against what really sold
  scored weeks 4; forecast error 55.25% vs the simple rule 95.24%. Visible only in the admin console; never shown to the merchant until a gate is passed.
PART 6. Every admin panel of section 18, read through the real admin API
  populated  Overview: 6
  populated  Organizations and users: 5
  populated  Feature flags: 19
  populated  Transactions and orders (journals): 9
  populated  Transactions and orders (store orders): 3
  populated  Transactions and orders (trade orders): 1
  populated  Payments: 3
  populated  Payments (exception queue): 1
  populated  Subscriptions: 2
  populated  Subscriptions (billing exceptions): 1
  populated  Listings and moderation (report queue): 1
  populated  Listings and moderation: 1
  populated  Messaging and consent: 1
  populated  Messaging and consent (outbound log): 1
  populated  Reorder and forecasting: 5
  populated  Support cases: 1
  populated  Audit log: 5
  populated  System health: 1

Admin panels populated: 18 of 18
```

## External limitations (why green here is not "done")
- **Test database:** the suite runs on PGlite, an in-process Postgres with one connection and a superuser. It cannot show lock contention, real concurrent interleaving, role privileges, migration time, or behaviour of row-level security under the application's role. Concurrency tests are sequential for this reason.
- **No provider is real:** the payment "provider" is TradePal's own simulator; pawaPay is an in-memory fake written from its documentation; WhatsApp sends go to a recording transport or a stubbed HTTP client; the AI provider is a stub. None of this proves compatibility with Meta, pawaPay, DeepSeek or Anthropic.
- **No real network or device:** page weights are measured, speed on a low-end phone or throttled link is not; the phone page was exercised by hand in Chrome and in the built-in browser, not on a phone.
- **Not run:** `scripts/rehearseMigrations.sh` (needs a restored backup and Postgres); the sandbox verification runbook; any load, soak or abuse test; a human penetration test; a dependency audit.
- **Determinism:** the suite uses fixed clocks where time matters, but several tests use real time (rate-limit windows, expiry minutes); they have passed repeatedly, and none is known to be flaky.
