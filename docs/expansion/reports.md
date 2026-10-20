# Bookkeeping reports (Phase 8)

Flag `reportsV2` (per business, default OFF). On WhatsApp: `/report <name> [today | week | month | <from> <to>]`. On a phone: the `/m/` page (needs `REPORTS_WEB_ENABLED` and a `/report link` code; CSV download needs `finance:export`). Code: `src/reports/`.

Every report carries: date range (calendar days in the **business's timezone**), currency (the business's own; entries in another currency are excluded and counted in a warning, never converted), timezone, `generatedAt`, the sources it read and how many rows, a one-line basis, **every warning**, and the notice "not a tax filing, an audited statement, or a statement of profit". CSV files carry the same header lines, so a caveat never gets separated from the numbers. Amounts are integer minor units. A range is at most 366 days.

| Report | Source | Definition | Permission | What it will NOT do |
|---|---|---|---|---|
| `sales` | journals (flag `accountingJournals`), else the chat ledger | Credits to Sales less debits to Sales returns, by local day, with provenance split. A voided sale nets to zero and is not counted | `reports:view` | With journals off it excludes shop orders, wholesale sales and refunds, and says so |
| `cash-flow` | journals only | Opening (before the start) + money in (debits) - money out (credits) = closing, per cash / mobile money / bank / unclassified | `finance:reconcile` | Refuses without journals (no guessing the payment method). Warns about unclassified money, un-journaled chat entries, and that these are books, not bank statements |
| `inventory-valuation` | stock balances | On-hand units x moving weighted-average cost of the costed units, now only (a past date is refused) | `finance:reconcile` | Values uncosted and negative stock at nothing and says the total is therefore LOWER; lists chat-only items without a value; shows the gap to the Inventory account |
| `ar-aging` | debt book + issued wholesale invoices | Open balances by days past due (no due date: by age with a 30-day allowance) | `reports:view` | Not itemised: shop orders paid on collection, advances, opening balances. Never contacts anyone |
| `ap-aging` | issued supplier invoices | Outstanding balance by days past due | `reports:view` | Chat purchases are recorded as paid, so money owed to a supplier for them is not tracked (warned) |
| `gross-margin` | journals + stock movements | Net sales minus recorded cost of goods sold, with the share of movements that had a complete cost | `finance:reconcile` | Refuses without journals. Warns the margin is OVERSTATED when a sale has no cost. Shows operating expenses but never deducts them. **Never called profit** |
| `payment-reconciliation` | provider payment attempts | Captured, applied to an order or invoice, settled, refunded; stale attempts; unmatched mobile-money alerts | `finance:reconcile` | Compares TradePal's own records; not a provider statement |
| `stock-discrepancies` | stock balances, movements, approved counts, chat tracker | Balance vs movement mismatches, count variances, chat-tracker drift, negative stock, shrinkage | `reports:view` | "None found" does not prove the shelves match; only a count does |

The "Net" line in `/today` becomes "Sales minus expenses (not profit)" when `reportsV2` is on. The weekly digest still says "Net" (its text goes through approved templates; changing it is a template decision).

Exports: every text cell goes through the formula-safe writer (a leading `= + - @`, tab or CR is neutralised) and every number through an integer-only writer. Tested with a hostile customer name.
