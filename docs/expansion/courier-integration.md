# Couriers for delivery orders

Status: **implemented, locally tested (in-process database and a real local Postgres). Not sandbox verified against any real courier: none is chosen.** Default OFF everywhere.

## What exists
| Piece | Where |
|---|---|
| A delivery job per order: who is carrying it, how it is going, tracking link, rider name and phone, the courier's fee (the **seller's** cost, never added to the shopper's total) | tables `DeliveryShipment`, `DeliveryShipmentEvent` (migration `20261101000000_store_couriers`) |
| The built-in **manual** courier: the seller's own rider or any outside courier tracked by hand | `/store dispatch <order> via manual ...` |
| An **adapter contract** every real courier integration must satisfy | `src/couriers/adapter.ts`, checks in `tests/helpers/courierContract.ts` |
| A **simulator courier** (development and tests only; refused when `NODE_ENV=production`) | `src/couriers/simulatorCourier.ts` |
| Signed status **callbacks** | `POST /webhooks/courier/:courier` (mounted only when `COURIERS_ENABLED=true`) |
| A **safety net** for a missed callback: the sweep asks each courier that can be asked about quiet jobs | `pollQuietShipments` in the operations sweep |
| A **stuck-delivery escalation**: an order out for delivery for 7 days with no word opens one support case TradePal follows up | `escalateStuckDeliveries` in the operations sweep |
| What the shopper sees: courier name, status, a tracking link (https only), rider name and phone | the order page |

Switches: platform `COURIERS_ENABLED`; per seller the flag `storeCourier`; development only `COURIER_SIMULATOR_ENABLED` + `COURIER_SIMULATOR_SECRET`.

## The rules that make it safe (each is tested)
1. **A courier can never complete an order.** "Delivered" from a courier is shown to the shopper and the seller; the order completes only with the shopper's 6-digit hand-over code (or a written reason), exactly as before.
2. **A courier can never move stock or money.** Dispatching an order still moves stock once, at dispatch, by the seller's action.
3. **A job only moves forward** (booked -> picked up -> in transit -> delivered / failed / cancelled / returned). A late or out-of-order report is kept in the history and changes nothing. The database enforces it too (a finished job cannot be taken back; a failed job can still be marked returned).
4. **One live job per order**, enforced by the database, so two phones booking at once create one job and dispatch the order once (tested with parallel connections on a real Postgres).
5. **A callback is believed only if the courier's adapter verifies its signature over the exact raw bytes**; a forged, tampered, unsigned or replayed (old timestamp) callback is refused with 401 and stored nowhere. A repeated genuine callback is a duplicate, not a second event.
6. **A courier that refuses a booking changes nothing**; the seller is told plainly.
7. **Tracking links must be https** with no password in them; the rider's number is checked; everything shown on the order page is HTML-escaped; the link opens without sending a referrer.
8. **Isolation:** a seller can never see or change another seller's jobs.
9. **The shopper never sees** the courier's fee, its own ids, or internal notes.

## Seller commands (WhatsApp)
```
/store couriers
/store dispatch <order> via <courier> [name <shown name>] [ref <tracking ref>] [url <https link>] [rider <name> <phone>]
/store courier <order> picked | transit | delivered | returned | failed <reason> | cancel <reason>
/store track <order>
/store failed <order> <reason>      (existing: puts the goods back in stock and cancels the order)
/store done <order> <code>          (existing: the only thing that completes a delivery)
```
While the flag is off, `couriers`, `track` and `courier` answer as unknown, and `/store dispatch <order> <delivery ref>` behaves exactly as before.

## Adding a real courier (when you choose one)
Nothing here picks a courier for you. When you do, the work is one adapter file plus proof:

1. Get the courier's **sandbox**, its API documentation and its callback-signing scheme in writing.
2. Write `src/couriers/<name>Courier.ts` implementing `CourierAdapter` (`book`, optionally `cancel`, `fetchStatus`, `verifyCallback`). Map the courier's statuses to ours; carry the courier's own event id; make `book` idempotent on our `idempotencyKey` (pass it as the courier's reference/idempotency header, or look the job up by our reference first).
3. Register it in `src/couriers/registry.ts` behind its own environment variable and secret (never in code).
4. Run the contract: add a `describeCourierContract("<name>", ...)` test with a harness that produces genuine signed callbacks from the sandbox (or a faithful recording). **It must pass before registration.**
5. Run the sandbox end to end: book, receive a callback for each status, a repeated callback, a forged callback, a missed callback (poll), a cancel before pick-up, a failed delivery.
6. Only then set `COURIERS_ENABLED=true` in production and turn `storeCourier` on for one pilot seller.

Questions to put to any courier first: is booking idempotent; how are callbacks signed and how are replays prevented; what statuses exist (and which means "delivered" versus "left with a neighbour"); how is the fee reported and when; can a job be cancelled and until when; what is the rate limit; which countries and areas; who is liable for loss and damage; how do refunds of a delivery fee work.

## What is not built (and why)
- **Quoting a courier's price at checkout.** The delivery fee a shopper pays is still the seller's delivery-zone fee. Quoting would put a courier's price on a shopper's bill and needs a decision on who carries a price difference.
- **Automatic booking.** A courier is booked by the seller, on purpose.
- **Shopper WhatsApp messages about the courier** (a fifth template; see `drafts-for-review/whatsapp-templates.md`).
- **An admin panel for jobs.** Stuck deliveries surface as support cases; failed jobs show on the seller's orders list.
