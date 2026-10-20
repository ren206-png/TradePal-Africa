# Accounting posting rules and worked examples

Phase 2 · code: `src/domain/accounting.ts`, `src/domain/stock.ts`, `src/domain/dailyClose.ts` · every example below is asserted by `tests/accounting.test.ts` / `tests/dailyClose.test.ts` (amounts in minor units; 100 = 1.00).

**Status: implemented, locally tested. These rules have NOT been reviewed by a qualified local accountant. Flag them for review before any merchant relies on a report built from them (open item OPEN-8).** Revenue basis, tax, and the treatment of owner transactions are the places a local reviewer should look first.

## Principles

1. A posted entry has at least two lines, debits equal credits, one currency. The database enforces this at commit (deferred constraint trigger), not only the application.
2. Entries and lines are append-only. A correction is a REVERSAL entry (every debit and credit swapped, linked to the original); the original is never touched.
3. Posting is idempotent per `(business, idempotencyKey)`: a duplicated WhatsApp delivery or a retried request posts once.
4. Revenue is recognised when the sale is recorded, not when cash arrives (collection alone is not revenue).
5. Buying stock is an asset (Inventory), not an expense. Cost of goods sold is recognised when stock leaves by sale.
6. A provider settlement moves money between accounts; it is never revenue. Fees are posted separately and are identifiable.
7. Owner money in/out is equity, not income or expense.
8. Nothing is invented. Where the legacy WhatsApp record lacks information (payment method, cost) it is posted to an explicit "not recorded" account, never guessed.

## Chart of accounts (created per business on first use)

| Key | Code | Account | Type |
|---|---|---|---|
| CASH | 1000 | Cash on hand | Asset |
| MOBILE_MONEY | 1010 | Mobile money wallet | Asset |
| BANK | 1020 | Bank account | Asset |
| UNCLASSIFIED_FUNDS | 1090 | Money in/out (payment method not recorded) | Asset |
| AR | 1100 | Accounts receivable | Asset |
| INVENTORY | 1200 | Inventory | Asset |
| PROVIDER_CLEARING | 1300 | Payment provider clearing | Asset |
| UNRESOLVED_LEGACY | 1900 | Unresolved earlier entries (split not recorded) | Asset |
| AP | 2000 | Accounts payable | Liability |
| CUSTOMER_ADVANCES | 2100 | Customer advances / deposits | Liability |
| DEBT_NOTE_SUSPENSE | 2900 | Debt notes (original sale not recorded) | Liability |
| OWNER_CAPITAL / OWNER_WITHDRAWALS / OPENING_BALANCE_EQUITY | 3000 / 3100 / 3900 | Equity |
| SALES_REVENUE / SALES_RETURNS | 4000 / 4900 | Revenue (returns is a debit-balance contra) |
| COGS / INVENTORY_SHRINKAGE / CASH_OVER_SHORT | 5000 / 5100 / 5200 | Expense |
| OPERATING_EXPENSES / PAYMENT_FEES | 6000 / 6100 | Expense |

## Rules with worked examples (Dr = debit, Cr = credit)

| Event | Entry | Example |
|---|---|---|
| Sale, paid in full by method M | Dr M account, Cr Sales | cash sale 20,000: Dr Cash 20,000 / Cr Sales 20,000 |
| Sale with cost known | + Dr COGS, Cr Inventory (cost) | cost 12,000: Dr COGS 12,000 / Cr Inventory 12,000 |
| Sale on credit / partly paid | Dr each receipt method, Dr Receivable for the rest, Cr Sales (total) | total 10,000, 4,000 cash: Dr Cash 4,000, Dr AR 6,000 / Cr Sales 10,000 |
| Customer pays earlier debt | Dr method, Cr Receivable (**not** revenue) | 2,500 cash: Dr Cash 2,500 / Cr AR 2,500 |
| Operating expense | Dr Expenses, Cr method (or Payables if on credit) | 2,000 cash: Dr Expenses / Cr Cash |
| Stock purchase | Dr Inventory, Cr method (or Payables) | 50,000 cash: Dr Inventory / Cr Cash. **Not an expense.** |
| Provider/operator fee | Dr Fees, Cr the account charged | 450 from wallet: Dr Fees 450 / Cr Mobile money 450 |
| Refund to customer | Dr Sales returns, Cr method; if goods come back sellable also Dr Inventory, Cr COGS at the cost they left at | 5,000 cash, cost 3,000: Dr Returns 5,000 / Cr Cash 5,000; Dr Inventory 3,000 / Cr COGS 3,000 |
| Owner withdraws money | Dr Owner withdrawals, Cr method | 4,000 cash |
| Owner contributes money | Dr method, Cr Owner capital | 7,000 into cash |
| Customer deposit before delivery | Dr method, Cr Customer advances (liability) | 3,000 mobile money |
| Provider settlement | Dr destination (net), Dr Fees, Cr Provider clearing (gross) | gross 100,000, fee 1,500: Dr Bank 98,500, Dr Fees 1,500 / Cr Clearing 100,000. **Sales untouched.** |
| Stock lost / spoiled / count short | Dr Shrinkage, Cr Inventory at average cost | 1 unit @100: Dr Shrinkage 100 / Cr Inventory 100 |
| Count found extra (costed) | Dr Inventory, Cr Shrinkage | |
| Owner takes stock | Dr Owner withdrawals, Cr Inventory at average cost | 2 units @100 |
| Opening balance (declared, labelled `MIGRATED_OPENING`) | Dr assets, Cr liabilities, balance to Opening balance equity | cash 5,000 + stock 20,000 - payables 4,000: equity Cr 21,000 |
| Cash count difference at daily close | short: Dr Cash over/short, Cr Cash; over: Dr Cash, Cr Cash over/short | counted 1,500 short: Dr Over/short 1,500 / Cr Cash 1,500 |
| Reversal of any entry | same accounts, debit and credit swapped, linked to the original | |

### The scenarios the tests assert

Scenario 4 (credit sale, partial payment, remaining balance; no duplicated revenue): sale 10,000 with 4,000 cash leaves AR 6,000; collections of 2,500 cash and 1,000 mobile money leave AR 2,500; Sales stays exactly 10,000 credit; replaying the sale or a collection key changes nothing; a final 2,500 collection takes AR to zero.

Scenario 5 (cash sale, mobile-money sale, fee, refund, owner withdrawal, stock purchase): purchase 50,000 cash; cash sale 20,000 (cost 12,000); wallet sale 30,000 (cost 18,000); fee 450 from wallet; refund 5,000 cash with 3,000 restocked; withdrawal 4,000 cash. Result: Cash -39,000, Wallet 29,550, Sales 50,000 credit and Returns 5,000 debit, Inventory 23,000, COGS 27,000, Fees 450, Withdrawals 4,000; the trial balance totals are equal.

## Legacy WhatsApp transactions (flag `accountingJournals`)

The earlier flow recorded a type, an amount and a paid/credit/partial status, but **no payment method and no cost**. It is journaled honestly:

| Legacy type / status | Entry |
|---|---|
| SALE paid | Dr Money in/out (method not recorded), Cr Sales. **Not assumed to be cash.** |
| SALE credit | Dr Receivable, Cr Sales |
| SALE partial (split never recorded) | Dr Unresolved earlier entries, Cr Sales |
| DEBT_NOTE | Dr Receivable, Cr Debt notes suspense. **No revenue is created** (the original sale is unknown and may already be in Sales) |
| PAYMENT_RECEIVED | Dr Money in/out, Cr Receivable |
| PURCHASE | Dr Inventory, Cr Money in/out |
| EXPENSE | Dr Expenses, Cr Money in/out |
| STOCK_ADJUSTMENT | no monetary effect, not journaled |
| Reversal transaction | reversal of the original's journal entry |

Consequences, stated plainly: the books' Receivable is a ledger figure and can differ from the debt book (a credit sale in the legacy flow never created a Debt row); no COGS exists for legacy sales (no cost was recorded), so profit built on them is incomplete and must be labelled so. Transactions recorded while the flag was off can be journaled later in order (`backfillJournals`), and `findUnjournaledTransactions` reports any that are missing.

## Stock costing (moving weighted average)

- Cost is per BASE unit, integer minor units. Average = round-half-away-from-zero of `(avg x costedOnHand + cost x qty) / (costedOnHand + qty)`.
- Only costed units enter the average. Units that arrived without a cost are tracked (`uncostedQty`), are consumed first on the way out, and any outflow touching them, or going below zero, is flagged `costIncomplete`. Example: 10 uncosted + 10 @200 on hand; selling 12 costs 2 units (400) and is flagged incomplete.
- Returns restock at the cost the units left at. A backdated entry keeps its `occurredAt` but is costed at posting time: history is not restated (known limit).
- Where costs are incomplete, a profit figure must be labelled **incomplete**. "Sales minus cash expenses" is never presented as profit.

## Rounding and allocation

`src/domain/rounding.ts`: division rounds half away from zero; percentages are basis points applied once; splitting an amount across lines uses largest remainder (ties to the earlier line), so parts always sum to the total. Unit tests include 100 across three equal lines = 34/33/33.
