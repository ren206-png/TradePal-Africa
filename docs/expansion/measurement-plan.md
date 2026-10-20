# Product measurement plan (master prompt section 23)

**Status: specified, not instrumented.** No dashboard, event pipeline or metric table was built in this expansion. Each definition below says what it is computed from today (existing tables, so a query can produce it) and what is missing. Pilot targets are hypotheses, not claims: **none has been set**, and nothing here assumes success.

Rules for every metric: synthetic data is excluded (`Business.isSynthetic = true`, and all demo/test traffic); a metric states its event, denominator, cohort, window and exclusions; no metric stores a phone number, a name or an amount per person (aggregate counts and durations only); a merchant's own numbers are never shown to another merchant; small cells (fewer than 5 merchants) are not reported.

| Metric | Event | Denominator | Cohort | Window | Exclusions | Computable today from | Missing |
|---|---|---|---|---|---|---|---|
| Activation | a merchant with onboarding COMPLETE records their first transaction | merchants whose onboarding completed | by signup week and country | within 7 days of onboarding | synthetic; staff numbers (not owners) | `Merchant.onboardingStep`, `Transaction.createdAt` | onboarding-complete timestamp (use the consent row time as a proxy) |
| Weekly meaningful merchant activity | in a week: at least 3 entries on at least 2 distinct days (or one order fulfilled) | active merchants (onboarded, not suspended) | by signup cohort week | rolling 7 days, local timezone | reversed entries, test entries, synthetic | `Transaction`, `StoreOrder`, `TradeOrder` | none |
| B2B order completion | a purchase order reaches fully received and invoiced | purchase orders submitted | by buyer cohort | 30 days from submission | cancelled before acceptance counted separately | `TradeOrder`, `Shipment`, `TradeInvoice` | none |
| B2C checkout conversion | a basket with lines becomes a placed order | baskets with at least one line | by seller and by acquisition source | basket lifetime (7 days) | bots (rate-limited clients), synthetic | `Basket`, `BasketLine`, `StoreOrder.placedAt` | **acquisition source**: merchant-link vs marketplace is not recorded on baskets or orders |
| Fulfilment | an order is handed over | orders placed and confirmed | by seller, by fulfilment type | placement to hand-over; and the share cancelled/expired | held-payment orders reported apart | `StoreOrder` (placedAt, confirmedAt, completedAt, status) | none |
| Repeat ordering | a second order from the same buyer to the same seller (B2C) or the same partner (B2B) | buyers with a first completed order | by first-order month | 60 days | B2C buyers are identified by phone number only: report counts, never numbers | `StoreOrder.buyerPhone` (hash it for analysis), `TradeOrder` | a stable, privacy-preserving buyer key |
| Payment resolution time | an attempt reaches a final status, an exception is resolved | attempts / exceptions | by provider | creation to resolution; p50/p95 | simulator (reported apart) | `PaymentAttempt`, `PaymentAttemptEvent`, `ProviderException`, `BillingException` | none |
| Reconciliation exceptions | an exception opened | payments attempted | by type and provider | per week | simulator | exception tables | none |
| Stock-count differences | an approved count with a non-zero variance | counts approved | by seller | per count | counts with no reason are flagged, not dropped | `StockCountLine` | none |
| Support effort | a case opened / closed; notes added | cases opened | by type and responsible party | open to close; notes per case | spam | `SupportCase`, `SupportCaseNote` | hours spent (people time is not recorded) |
| Paid renewal | a due subscription invoice becomes PAID | invoices that came due | by plan version and country | due date + grace | admin-adjusted entitlements reported apart; first-time purchases separate from renewals | `Invoice.kind`, `BillingAllocation` | none (billing is OFF until activated) |

## Costs (tracked separately; payment volume is not revenue)

| Cost | Source today | Missing |
|---|---|---|
| AI per provider and model | `AiUsageLedger` (reserve/commit, micro-USD) | an aggregate view |
| Messaging | `OutboundMessageLog` counts by class | provider price per template category |
| Hosting, provider fees, onboarding, support | none in the system | external accounts |
Subscription revenue is the approved monetisation; commissions and paid consumer plans are disabled and not built.

## Independent completeness check (transaction completeness)
A sampled, human check: each month pick merchants (stratified by country and activity), ask each for their own notebook or till record for a chosen week, and compare to TradePal's entries; record the missing and extra entries as a percentage and the reasons. Record merchant-observed outcomes (did they stop using the notebook? did disputes fall?) rather than attributing any change to TradePal. This is a procedure, not a feature; it has not been run.

## Not to be inferred from these metrics
Creditworthiness, tax compliance, or merchant success. Reports are bookkeeping reports; lenders and tax authorities have not accepted them.
