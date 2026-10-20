# Data model: mapping, ownership and money flows (Phases 1-3)

Where a conceptual entity from the master prompt (section 7) already existed, it was reused; new tables were added only for genuine gaps. Every table below carries `businessId` (the tenant) unless marked, is covered by the application tenant scope and a row-level-security policy, and is **additive**: no existing table was altered.

## Entity mapping

| Conceptual entity | Model(s) | Notes |
|---|---|---|
| Organization | `Business` (the tenant) | kept as the tenant; no `Organization` layer above it (decision P4) |
| Shop | `Shop` (Phase 1) | default shop per business |
| Membership, Permission | `Membership` (Phase 1), `src/auth/permissions.ts` | matrix in `permission-matrix.md` |
| MerchantCustomer | `Customer` | private to the merchant |
| SupplierRelationship / counterparty | `TradePartner` (Phase 3), earlier `Supplier` | a partner may be linked to another TradePal business |
| (link between two businesses) | `BusinessLink`, `PriceListShare` (Phase 3) | two parties, so its own RLS policy; no `businessId` |
| Product, Variant, PackConversion, aliases | `Product`, `ProductVariant`, `PackConversion`, `VariantAlias` (Phase 2) | |
| PriceList, PriceRule | `PriceList`, `PriceRule` (Phase 2) | |
| StockMovement, StockReservation, StockCount, Transfer | `StockMovement`, `StockBalance`, `StockReservation`, `StockCount(Line)`, `StockTransfer(Line)` (Phase 2) | legacy `InventoryItem`/`InventoryMovement` unchanged and bridged |
| CostLayer (equivalent) | moving weighted average on `StockBalance` | documented in `accounting-postings.md` |
| Account, JournalEntry, JournalLine | `Account`, `JournalEntry`, `JournalLine` (Phase 2) | balanced by a deferred trigger |
| CashSession (equivalent) | `DailyClose` (Phase 2) | |
| PurchaseOrder / SalesOrder, OrderLine | `TradeOrder` (`side` BUY or SELL), `TradeOrderLine` (Phase 3) | each business owns its own row |
| Fulfillment | `Shipment`, `ShipmentLine` (Phase 3) | seller's row and buyer's copy |
| GoodsReceipt | `GoodsReceipt`, `GoodsReceiptLine` (Phase 3) | append-only |
| Invoice (trade), payable/receivable | `TradeInvoice`, `TradeInvoiceLine` (Phase 3) | the earlier `Invoice` is the TradePal subscription invoice and is untouched |
| PaymentAllocation / external payment | `TradePayment` (Phase 3) | with evidence label and state |
| CreditNote | `CreditNote` (Phase 3) | short-delivery credits only |
| Reorder rule / suggestion | `ReorderRule`, `ReorderSuggestion` (Phase 3) | |
| ForecastPrediction (+ scores) | `ForecastPrediction`, `ForecastScore`, `ForecastGateConfig`, `ForecastGateEvent` (Phase 3) | predictions and scores are append-only |
| OutboxEvent, inbox | `OutboxEvent`, `CallbackInbox` (Phase 1) | reused for cross-business sync and simulator callbacks |
| AuditEvent | `AuditLog` (+ `SupportAccess`) | |

Not yet built (later phases): Quote/PO documents for consumers, SalesOrder for storefront buyers, Return, ConsumerIdentity, Listing, merchant payment intents/attempts/refunds/settlements, billing plan versions, consent records, support cases.

## Ownership boundaries (B2B)

```
Retailer's books (tenant R)                      Wholesaler's books (tenant W)
  TradePartner "Alpha"  <--- BusinessLink --->     TradePartner "Retail Corner"
  TradeOrder  PO-1 (BUY)  <-- counterpartOrderId -->  TradeOrder SO-1 (SELL)
  TradeOrderLine                                      TradeOrderLine   (agreed qty, pack, price: the SAME numbers)
  Shipment (copy)  <-- counterpartShipmentId -->      Shipment
  TradeInvoice BILL-1 (payable) <-- counterpart -->   TradeInvoice INV-1 (receivable)
  GoodsReceipt (R only)  ------ status mirrored --->  ShipmentLine accepted/damaged/short
  stock, costs, journals: R only                      stock, costs, journals: W only
```

- There is **no foreign key across tenants**. Counterpart ids are plain unique columns, set by outbox handlers.
- What crosses: references, SKUs and descriptions as ordered, quantities in the ordered unit and in base units, agreed unit prices and totals, statuses, shipment quantities, receipt outcomes (accepted/damaged/short), invoice numbers and amounts, payment proposals (amount, method, reference). What never crosses: cost prices, average cost, stock levels, other customers or suppliers, private price lists, margins, notes, journals.
- The seller's **shared catalog** (published variants on a shared wholesale list) is the only cross-tenant read, through one function with an explicit field projection (tested to contain no cost or stock fields).
- Linking shares nothing by itself and is reversible by either party; revoking ends new orders and sharing but leaves agreed documents in place.

## Money flows (who owes whom, where it is booked)

```
Seller ships (revenue recognised, per shipment)   Dr Receivable  Cr Sales ;  Dr COGS Cr Inventory (from stock cost)
Buyer receives (what arrived, accepted + damaged) Dr Inventory   Cr Payables
Short delivery credit (seller)                    Dr Sales returns  Cr Receivable   (buyer: no entry, the short units were never booked)
Buyer records a payment                           Dr Payables  Cr cash/wallet/bank      -> PROPOSAL to the seller
Seller confirms it                                Dr cash/wallet/bank  Cr Receivable
Simulator/provider-confirmed payment              seller: Dr Provider clearing  Cr Receivable ; buyer: Dr Payables Cr Mobile money
Provider settlement (Phase 5)                     Dr Bank  Cr Provider clearing   (never revenue)
```

TradePal subscription money (`Invoice`, pawaPay/Flutterwave) is a different table, a different purpose enum and different credentials; the simulator is allowed for `MERCHANT_SALE` only and refuses a body that claims `PLATFORM_SUBSCRIPTION`.
