# State-transition tables (Phase 2)

Each transition is enforced by a conditional update (`WHERE status = <from>`), so a concurrent double action changes state once. Anything not listed is refused.

## Stock reservation

| From | Event | To | Effect on balance |
|---|---|---|---|
| (none) | reserve (enough available, or backorders allowed) | ACTIVE | reserved + qty |
| ACTIVE | fulfil | CONSUMED | on hand - qty fulfilled; reserved - whole hold (a partial fulfilment frees the remainder) |
| ACTIVE | release | RELEASED | reserved - qty |
| ACTIVE | expiry sweep (now >= expiresAt) | EXPIRED | reserved - qty |
| CONSUMED / RELEASED / EXPIRED | anything | refused (`RESERVATION_CLOSED`) | none |

A retried reserve with the same idempotency key returns the original. Fulfilling an expired hold is refused: re-reserve.

## Stock count

OPEN -> APPROVED (every non-zero line has a reason; one `COUNT_ADJUSTMENT` per line of `counted - expected`, expected snapshotted when the line was counted) or OPEN -> CANCELLED (nothing changes). APPROVED and CANCELLED are final. Re-counting a variant while OPEN re-snapshots it; adding a reason does not.

## Stock transfer

DRAFT -> DISPATCHED (source on hand falls with cost carried; destination shows IN TRANSIT) -> RECEIVED (in transit clears; only the received quantity becomes on hand; a shortfall is written off at carried cost). DRAFT -> CANCELLED. A dispatched transfer cannot be cancelled, only received. Over-receipt is refused.

## Daily close

(open day, computed) -> CLOSED, once per (business, date, currency). A non-zero difference needs a reason and posts a CASH_ADJUSTMENT entry in the same transaction. A closed day is never edited; the next day's opening cash is the books' cash balance (which now equals the count).

## Journal entry and transaction (as the admin panel shows them)

POSTED -> REVERSED (a later reversal exists). The reversal row is REVERSAL and cannot be reversed. Neither can be deleted.

## Price resolution outcomes

OK / `LIST_INACTIVE` / `EXPIRED` / `NO_PRICE` / `BELOW_MINIMUM` / `UNIT_NOT_DECLARED` / `CURRENCY_MISMATCH` / `INVALID_QUANTITY` / `NOT_FOUND`: always a single typed result, never a fallback to another list.

## Trade order: acceptance (Phase 3)

| From | Event | To | Notes |
|---|---|---|---|
| DRAFT (buyer) | send to a linked supplier | REQUESTED | prices re-resolved from the supplier's shared lists; seller's row is created by an outbox event |
| DRAFT/REQUESTED (buyer, unlinked supplier) | record the supplier's confirmation with evidence | ACCEPTED | no mirror; terms frozen |
| REQUESTED (seller) | accept | ACCEPTED | stock held for every tracked line in one transaction; credit rules checked; terms frozen |
| REQUESTED/QUOTED (seller) | quote (change qty/price, validity) | QUOTED | stock HELD until validUntil; buyer's row updated |
| QUOTED (buyer) | accept the quote | ACCEPTED | seller finalises: hold extended, terms frozen |
| REQUESTED/QUOTED (seller) | reject | REJECTED | held stock released |
| DRAFT/REQUESTED/QUOTED/ACCEPTED (either) | cancel, only if nothing has shipped | CANCELLED (REJECTED when a seller declines) | held stock released, other side told |
| REQUESTED/QUOTED | validity passes | EXPIRED | each business expires its own row; stock released |

The database refuses: accepting an order with no lines or an unpriced line, and any change to quantity, pack or price once ACCEPTED.

## Goods movement, invoice and payment (separate machines, Phase 3)

- Order goods status: NOT_SHIPPED -> PARTIALLY_SHIPPED -> SHIPPED -> PARTIALLY_RECEIVED -> RECEIVED (RECEIVED when every shipped unit is accounted for as accepted, damaged or short and everything ordered has shipped).
- Shipment: DISPATCHED -> PARTIALLY_RECEIVED -> RECEIVED.
- Invoice (one per shipment): ISSUED. Its payment status is DERIVED: UNPAID, PARTIALLY_PAID, PAID (and overdue when past due with money owing). "Received" never implies "paid".
- Payment: PROPOSED (the other business said so) -> APPLIED (confirmed) or REJECTED; HELD (does not fit: wrong currency, more than owing, disputed) waits for a person. A payment can never push an invoice past what remains owing.

## Reorder suggestion and forecast gate (Phase 3)

- Suggestion: PROPOSED -> ACCEPTED (a DRAFT purchase order exists; nothing sent) | DISMISSED | SUPERSEDED (numbers changed or the condition cleared). One PROPOSED per (shop, variant, method).
- Forecast: written (shadow) -> scored once its period has ended. Never edited.
- Gate: closed -> OPEN only through the promotion function (thresholds set, scored weeks and improvement met, owner, reason, audited; a rejected attempt is also recorded); OPEN -> closed always allowed.

## Consumer store order (Phase 4)

| From | Event | To | Notes |
|---|---|---|---|
| (basket) | checkout | PLACED | stock HELD (reservation); unpaid online hold 60 min, pay-on-collection hold 48 h (per shop); the basket is claimed first so a double submit places once |
| PLACED | seller confirms (pay-on-collection) / provider payment applied (online) | CONFIRMED | an unpaid online order cannot be confirmed by hand; hold is extended; buyer now sees the handover code |
| PLACED | buyer cancels | CANCELLED | immediate; hold released |
| CONFIRMED | buyer asks to cancel | (request) | the seller approves (-> CANCELLED) or declines (order carries on) |
| CONFIRMED | seller prepares | READY | not cancellable from here on |
| CONFIRMED / READY | seller dispatches (delivery only) | OUT_FOR_DELIVERY | stock leaves here |
| CONFIRMED / READY / OUT_FOR_DELIVERY | hand-over with the code (pickup: stock leaves, delivery: already left) | COMPLETED | revenue recognised: Dr Customer advances, Cr Sales (+ Delivery fees); pay-on-collection must be fully collected; a delivery may complete without the code only with an audited reason |
| OUT_FOR_DELIVERY | delivery failed | CANCELLED | goods restocked at the cost they left at |
| PLACED / CONFIRMED | hold passes | EXPIRED | stock released; a late payment becomes a held `PaymentException` |
| EXPIRED | seller re-reserves for a late payment | CONFIRMED | only if every line can be reserved again; the database allows EXPIRED -> CONFIRMED only |
| any | seller cancels | CANCELLED | paid money must be refunded |

COMPLETED and CANCELLED are final (database trigger `tradepal_store_order_terminal`).

Payment exception: OPEN -> RESOLVED (refund | re-reserve | apply). Refund request: REQUESTED -> APPROVED | DENIED; a return then GOODS_RECEIVED; then REFUNDED (once). Cancellation request: REQUESTED -> APPROVED | DENIED. Support case: OPEN -> ASSIGNED -> CLOSED (closed is final; reassigning the responsible party is allowed while open).

## Merchant payment (Phase 5)

Payment attempt (the provider's word is final once SUCCEEDED or FAILED; the database refuses to change either):

| From | Event | To | Notes |
|---|---|---|---|
| (new) | we create it | CREATED | the one-active-attempt-per-intent index is checked here |
| CREATED | provider accepts | PENDING | accepted is not paid; `nextPollAt` set |
| CREATED | provider refuses | FAILED | definitive: it did not create anything |
| CREATED | no answer (timeout/outage) | UNKNOWN | it MAY have collected; blocks a second attempt |
| PENDING / UNKNOWN | provider reports success (signed callback, or an authenticated lookup) | SUCCEEDED | guarded UPDATE: one winner; capture recorded; money allocated |
| CREATED / PENDING / UNKNOWN | provider reports failure | FAILED | |
| UNKNOWN / CREATED | authenticated lookup says "no record" and we never got an acceptance | FAILED | the only way to close an unknown attempt automatically |
| any open | an admin closes it after the provider confirms it never collected | FAILED / CANCELLED | audited |
| SUCCEEDED | provider later says FAILED (or the reverse) | (no change) | CONTRADICTORY_STATUS exception |

Payment intent: OPEN -> PAID (applied amount reaches the amount) | EXPIRED (the order's hold ended or the invoice request lapsed) | CANCELLED (the order was cancelled or completed another way). Final once left OPEN. A success that arrives after the intent closed is HELD as an exception (scenario 10).

Provider refund: REQUESTED -> PENDING (provider accepted or we could not tell) -> SUCCEEDED | FAILED. Funds are reserved on the attempt before sending and released on FAILED. Books move on SUCCEEDED only. A FAILED refund is retried as a NEW refund (new key), only through the same provider.

Allocation: HELD -> APPLIED (the seller re-reserved or accepted a part-payment) | REFUNDED; or created directly APPLIED.

Provider settlement: reported -> POSTED (or an exception and nothing posted). One report posts once; one payment settles once.

## Marketplace (Phase 5)

| Subject | From | Event | To |
|---|---|---|---|
| Seller | OFF | seller opts in and is ready | ACTIVE |
| Seller | ACTIVE | seller opts out | OFF |
| Seller | OFF / ACTIVE | admin suspends (reason, audited) | SUSPENDED (shop, listings and checkout hidden; existing orders serviced as normal) |
| Seller | SUSPENDED | admin reinstates, or an appeal is overturned | ACTIVE |
| Listing | VISIBLE | admin unpublishes (every channel of the item) | UNPUBLISHED (the seller cannot republish it) |
| Listing | UNPUBLISHED | admin reinstates, or an appeal is overturned | VISIBLE |
| Report | OPEN | admin dismisses / acts on it | DISMISSED / ACTIONED |
| Appeal | OPEN | admin decides | UPHELD / OVERTURNED (once) |

## Subscription billing (Phase 6)

Billing attempt (what pawaPay reported as final stays final; the database refuses to change COMPLETED, FAILED or REJECTED):

| From | Event | To | Notes |
|---|---|---|---|
| (new) | we create it before calling pawaPay | INITIATED | the one-active-attempt-per-invoice index is checked here |
| INITIATED | pawaPay accepts | ACCEPTED | the payer now has a PIN prompt; nothing is paid |
| INITIATED | pawaPay rejects | REJECTED | e.g. payer not found |
| INITIATED | no answer | UNKNOWN | it may still prompt the payer; blocks another attempt |
| any active | authenticated lookup: no record | FAILED | only for INITIATED or UNKNOWN (never for an accepted deposit) |
| any active | authenticated lookup: completed | COMPLETED | then allocated if it matches the invoice exactly, otherwise held with an exception |
| ACCEPTED / UNKNOWN | lookup: still processing | ACCEPTED / PROCESSING | bounded polling: 30 s doubling to 30 min, 8 checks, then an exception |

Invoice: PENDING -> OVERDUE (past due, by the sweep) -> PAID (one guarded update, once) -> PARTIALLY_REFUNDED -> REFUNDED (only when pawaPay confirms a refund). PENDING/OVERDUE -> CANCELLED (when the owner cancels and nothing is in flight; a payment that still arrives is held). A paid invoice never becomes unpaid (database trigger).

Entitlement state (computed from stored state and the clock, never from a sweep): no paid subscription = FREE; before the period end = ACTIVE; for `graceDays` after it = GRACE (same entitlements); then EXPIRED (FREE caps; new premium operations refused); a suspended business = SECURITY_SUSPENDED whatever else is true. Cancelling sets `cancelAtPeriodEnd`: access continues to the end, the sweep marks the subscription CANCELED afterwards, and a later renewal starts a new subscription row (the old one stays as history).

Billing refund: REQUESTED -> ACCEPTED -> PROCESSING -> COMPLETED | FAILED | REJECTED. Funds are reserved on the invoice before sending and released on failure.
