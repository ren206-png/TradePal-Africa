# Data model: mapping, ownership and money flows (Phases 1-3)

Where a conceptual entity from the master prompt (section 7) already existed, it was reused; new tables were added only for genuine gaps. Every table below carries `businessId` (the tenant) unless marked, is covered by the application tenant scope and a row-level-security policy, and is **additive**: no existing table or column was altered. The only change to existing tables is two guard triggers on `FeatureFlag` and `BusinessFeatureFlag` (Phase 3) that refuse to turn the forecast promotion gate on except through its controlled function.

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

## Consumer storefront (Phase 4)

Tenant tables (RLS policy + tenant scope): `Storefront`, `DeliveryZone`, `Listing`, `StoreOrder`, `StoreOrderLine`, `StorePayment`, `StoreCancellationRequest`, `StoreRefundRequest`, `StoreRefundLine`, `PaymentException`, `SupportCase`, `SupportCaseNote`. Not tenant data: `Basket`, `BasketLine` (the shopper's, reachable only by the secret token; they hold references to sellers' listings and nothing else).

```
Basket (token hash, 7-day TTL)
  BasketLine (seller, variant, unit, quantity)            -- split at checkout, one order per seller
Storefront 1-1 Business   (slug, title, pickup, delivery on/off, return window, terms, enabled)
  DeliveryZone (name, fee, minimum order, active)
  Listing (variant, channel DIRECT | MARKETPLACE(reserved), status)
StoreOrder (seller-owned; reference ORD-000001 per seller; access token hash + expiry; pickup code; terms snapshot)
  StoreOrderLine (description, unit, quantity, base quantity, price, line total, returned base)
  StorePayment (IN/OUT, method, evidence, state APPLIED | HELD, provider + externalId unique)
  StoreCancellationRequest, StoreRefundRequest -> StoreRefundLine
  PaymentException (LATE_SUCCESS | OVERPAYMENT | UNDERPAYMENT | CURRENCY_MISMATCH; OPEN -> RESOLVED)
  SupportCase (type, handledBy SELLER|PLATFORM|PROVIDER, OPEN|ASSIGNED|CLOSED) -> SupportCaseNote (append-only)
```

What a shopper can see about an order (`publicOrderView`): seller name and support phone, items as ordered with prices, delivery fee, status timeline, collection or delivery details, handover code (only after confirmation), payment and refund state, and which actions are available. Never: unit cost, stock numbers, other customers, internal notes, tenant ids.

The CHECK constraints (slug format, totals arithmetic, line arithmetic, delivery fee only for DELIVERY, `refundedMinor <= paidMinor`, positive amounts) are listed in `db-protection.md`.

## Merchant payments and marketplace (Phase 5)

Tenant tables (RLS + tenant scope): `ProviderConnection`, `PaymentIntent`, `PaymentAttempt`, `PaymentAttemptEvent`, `PaymentAllocation`, `ProviderRefund`, `ProviderSettlement`, `ProviderSettlementLine`, `ModerationAction`, `Appeal`. Not tenant data: `ProviderException` (an unknown reference has no tenant), `MarketplaceReport` (a public report is not the seller's), `SimulatorPayment` (the simulator's own side of the world; development and CI only).

```
ProviderConnection (one per merchant per provider: arrangementRef, destinationKey, credentialRef = a NAME)
PaymentIntent  (purpose MERCHANT_SALE only; subject STORE_ORDER | TRADE_INVOICE; amount; OPEN|PAID|EXPIRED|CANCELLED)
  PaymentAttempt (provider ref; CREATED|PENDING|UNKNOWN active, SUCCEEDED|FAILED final; captured, refunded, fee)
    PaymentAttemptEvent (append-only history)
    PaymentAllocation  (APPLIED | HELD | REFUNDED: where the money went)
    ProviderRefund     (REQUESTED|PENDING|SUCCEEDED|FAILED; links to the refund request, cancelled order or held payment it books against)
    ProviderSettlementLine -> ProviderSettlement (gross = fee + net; POSTED)
ProviderException (global; fingerprint-unique): UNKNOWN_REFERENCE, WRONG_TENANT, PURPOSE_MISMATCH, AMOUNT/CURRENCY/DESTINATION_MISMATCH,
                   CONTRADICTORY_STATUS, UNRESOLVED_ATTEMPT, REFUND_FAILED, SETTLEMENT_MISMATCH, DUPLICATE_COLLECTION
Storefront.marketplaceStatus (OFF | ACTIVE | SUSPENDED), Listing.category / moderation (VISIBLE | UNPUBLISHED) / updatedAt
MarketplaceReport -> ModerationAction (append-only) -> Appeal
```

Every payment application also keeps the Phase 3/4 per-subject rows (`TradePayment`, `StorePayment`) unique per (provider, provider reference), so a replay converges. The payment layer never edits an order or invoice itself: it asks the subject how much is owed and tells it about confirmed money.

## Plan versions, subscription billing and entitlements (Phase 6)

Platform data (not tenant): `PlanVersion`, `PlanPrice`, `BillingException`, `BillingSwitch`, `ProviderSigningKey`, `BillingAccountBinding`. Tenant tables (RLS + tenant scope): `BillingAttempt`, `BillingAllocation`, `BillingRefund`, `EntitlementEvent`. The existing `Invoice` gains `planVersionId`, `kind` (NEW | RENEWAL | PLAN_CHANGE), `reference` (the support reference `INV-XXXXXXXX`), `paidMinor`, `refundedMinor`, `periodStart/End` (set only when payment is allocated) and `cancelledAt`; `Subscription` gains `planVersionId`, `pendingPlanVersionId`, `cancelAtPeriodEnd`, `cancelledAt`.

```
Plan 1-n PlanVersion (DRAFT -> PUBLISHED -> RETIRED; period days, grace days, features, caps) 1-n PlanPrice (country -> currency, price)
Subscription -> planVersion (sold) / pendingVersion (scheduled change)
  Invoice (purpose PLATFORM_SUBSCRIPTION; PENDING | OVERDUE | PAID | PARTIALLY_REFUNDED | REFUNDED | CANCELLED | FAILED)
    BillingAttempt (id == pawaPay depositId; environment; one active per invoice)
      BillingAllocation (unique per invoice and per attempt: the period it bought)
    BillingRefund (id == pawaPay refundId)
  EntitlementEvent (append-only: GRANTED, EXTENDED, PLAN_CHANGE_SCHEDULED, PLAN_CHANGED, CANCEL_REQUESTED, CANCELLED, EXPIRY_NOTED, MANUAL_ADJUSTMENT, REFUND_REVOKED)
```

None of these tables has any link to a journal, store, trade or merchant-payment record. TradePal's subscription revenue is not recorded in any merchant's ledger and merchant money is not recorded here.

`BillingAttempt.refundedMinor` tracks money returned out of one payment (bounded by `capturedMinor`, database CHECK); `BillingRefund.heldPayment` marks a refund of a payment that was collected but never applied to an invoice, whose funds are reserved on the attempt rather than the invoice.
