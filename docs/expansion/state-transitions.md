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
