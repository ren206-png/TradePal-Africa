# Refund and cancellation rules (consumer storefront and subscriptions)

One policy, written once in code (`cancellationPolicy`, `refundPolicy` in `domain/store/orders.ts`) and shared by the shop page and the backend, so a page can never promise what the backend refuses. Sources: `decisions.md` C5 (F5, F7, F8), C7 (I14); `state-transitions.md`.

## Shop orders (consumer)

| Order is | Shopper can | Seller can | Money |
|---|---|---|---|
| PLACED (not yet confirmed) | cancel at once | cancel | hold released; nothing paid yet unless online: then a refund is owed |
| CONFIRMED | ask to cancel (a REQUEST) | approve or decline the request; cancel with a reason | paid money must be refunded on cancel |
| READY / OUT FOR DELIVERY | cannot cancel; can report a problem | cancel (delivery failure restocks) | refund the seller records |
| COMPLETED (handed over) | request a return or refund while the seller's own return window is open (`returnWindowDays`; none set = the seller accepts none) | approve or deny; a RETURN restocks at the cost the goods left at and fixes the refund to the value received | refund bounded by what was paid (guarded update + CHECK), once per request |
| After the window | report a problem (a support case) | at their discretion | n/a |

- A refund REQUEST is not a refund; a cancellation REQUEST is not a cancellation: the seller decides.
- **Refunds are recorded by the seller, not sent by TradePal.** A seller who records a mobile-money refund must actually pay it (provider refunds exist only for simulator payments).
- Money that arrives and does not fit (late after expiry, after the shopper cancelled, too much, too little, wrong currency) is HELD as an exception and recovered by refund, re-reserve (only if stock can be taken again; a cancelled order is never reinstated) or a part-payment.
- Support cases always name who answers: SELLER (delivery, goods, refunds), PROVIDER (payment disputes where money moved through one), otherwise PLATFORM.

## Trade (wholesale) orders

Cancel only before anything has shipped (DRAFT/REQUESTED/QUOTED/ACCEPTED); held stock is released and the other side is told. After shipment, problems are handled by receipt discrepancies and credit notes, never by deleting.

## TradePal subscriptions (pawaPay)

- A renewal is customer-authorised (a PIN prompt on the payer's phone); nothing is charged unattended.
- Refunds are for **subscription charges only**, by the platform owner with a reason, bounded by what was paid, one in flight per payment; revoking service is an explicit extra choice on a full refund.
- Cancelling stops renewal; access continues to the end of the paid period. No proration, ever: a plan change takes effect at the next renewal.
- A payment that arrives wrong (short, over, duplicate, for a cancelled invoice, unknown) grants nothing and becomes a billing exception; the money is real and a person returns or settles it.
