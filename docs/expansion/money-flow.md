# Money flow and ownership boundaries

Whose money is it, where is it recorded, and what is it never allowed to touch. Everything here is enforced in code and/or the database; where it is only convention that is said.

```
 TRADEPAL'S OWN MONEY                                   A MERCHANT'S MONEY (each business is its own owner)
 ─────────────────────                                  ──────────────────────────────────────────────────

 Merchant pays a TradePal subscription                  Shopper / trade buyer pays a merchant
   │  pawaPay (mobile money PIN prompt to the payer)      │  merchant-chosen external provider (NONE connected yet;
   ▼                                                      │  today: the SIMULATOR, or cash recorded by the seller)
 BillingAttempt ─► BillingAllocation ─► Invoice           ▼
   │  (PLATFORM_SUBSCRIPTION only)                      PaymentIntent ─► PaymentAttempt ─► PaymentAllocation
   ▼                                                      │  (MERCHANT_SALE only; DB CHECK)        │ APPLIED | HELD | REFUNDED
 EntitlementEvent (period granted)                        ▼                                        ▼
                                                        StoreOrder / TradeInvoice          PaymentException (held, never silently applied)
 NEVER links to:                                          │                                        │
   journals, stock, orders, merchant payments             ▼                                        ▼
 NEVER uses: any merchant provider                      JOURNAL (the merchant's own books):
                                                          Dr Provider clearing / Cash / Mobile money
                                                          Cr Customer advances  ──(hand-over)──►  Cr Sales (+ Delivery fees)
                                                          Dr Cost of goods sold / Cr Inventory (at hand-over)
                                                          later: Dr Mobile money / Cr Provider clearing (settlement report)
```

## Boundaries

| Boundary | Enforced by |
|---|---|
| pawaPay is for TradePal subscriptions only | `domain/paymentPurpose.ts`; adapter registry has no pawaPay for merchants; DB CHECK `PaymentIntent.purpose = 'MERCHANT_SALE'`; billing switch CHECK `PLATFORM_SUBSCRIPTION` |
| Subscription money never enters a merchant's ledger; merchant money never enters billing tables | separate tables, no foreign keys between them (tested) |
| Each business's rows are its own | `businessId` on every tenant table; tenant-scoped client; RLS policies (INERT in production until the non-owner role step) |
| A consumer's order belongs to the seller, not to TradePal and not to a pooled basket | checkout splits a basket into one order per seller; no float |
| TradePal holds no merchant funds | no settlement account exists; provider clearing is the merchant's asset at the provider |
| Revenue is recognised at hand-over, never at payment | advance first; hand-over moves it to Sales |
| A provider's "accepted" is not "paid"; "paid" is not "settled" | attempt statuses; allocation; settlement lines |
| Corrections are new rows | append-only triggers on journals, movements, payments, history |
| A merchant's cost prices are the merchant's | cost-bearing reports need `finance:reconcile`; the public catalogue is a field projection with no cost |

## Where each kind of money is counted

| Event | Customer-facing record | Books (journal) |
|---|---|---|
| Shopper pays online (simulator today) | order shows paid | Dr Provider clearing, Cr Customer advances |
| Seller hands the goods over | order COMPLETED | Dr Customer advances, Cr Sales; Dr COGS, Cr Inventory |
| Shopper pays cash at the counter | order COMPLETED | Dr Cash (advance) then as above |
| Late/duplicate/wrong payment | exception | held, not revenue, until a person refunds or applies it |
| Refund | refund request -> refunded | Dr Sales returns (or advance), Cr method; restock at original cost |
| Provider settles | settlement line | Dr Mobile money/Bank, Dr fees, Cr Provider clearing (not a second sale) |
| TradePal subscription renewal | invoice PAID, period granted | none (not the merchant's books) |
