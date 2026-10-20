# Admin delete and void rules (binding, from master prompt section 18)

| Record | Admin can | Admin cannot |
|---|---|---|
| Transaction (sale, purchase, payment, expense) | view; **void = reverse** (permission `admin:reverse_transaction`, step-up when enabled, reason of 10+ chars, correlation id, audit row in the merchant's own history) | edit, delete |
| Journal entry / line | view; reversed only as part of a transaction void | edit, delete, truncate (database refuses) |
| Stock movement | view | edit, delete, truncate (database refuses) |
| Invoice, subscription, payment request, debt | view | delete (database refuses) |
| Daily close | view | edit, delete |
| Audit log, support-access record | view | edit, delete |
| Business | suspend / reinstate; hard delete only if synthetic (flag set at creation) or it has no financial trail | convert a real business to synthetic to unlock deletion |

A "Delete" control on any financial record is a defect. The admin API exposes no DELETE/PUT/PATCH route for transactions (tested). Void leaves the original row byte-for-byte intact (tested), reverses the stock it moved, and (when `accountingJournals` is on) posts a balanced reversal journal, so receivables and stock reflect it (scenario 30).

Every successful admin write also leaves an `admin.write <METHOD> <route>` audit row with the acting admin, target, stated reason and correlation id, written before the success response is sent (`src/admin/adminAudit.ts`). The correlation id is the caller's `x-correlation-id` if it is a plain token, otherwise generated, and is echoed in the response header.

Export: `GET /admin/businesses/:id/transactions.csv`, capped at 10,000 rows (`X-Export-Truncated` says when it was cut), every text cell that begins with `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe, numeric columns are validated integers, and each export is audited (who, how many rows, date window).

## Phase 4 records

| Record | Admin can | Admin cannot |
|---|---|---|
| Store order, line, payment | view (money and status only: no buyer phone, no cost; behind `admin:view_merchant_financials` and support access) | edit, delete (database refuses delete) |
| Support case | assign, add a note, reassign the responsible party (with a reason), close (with a resolution); each is audited and needs step-up when enabled | edit a note, delete, reopen a closed case |
| Payment exception | view the queue (`admin:view_support_cases`) | resolve it: the SELLER resolves (refund / re-reserve / apply); admin resolution is not built |
| Refund request, cancellation request | counted on the overview | decide them: the seller decides |

The consumer's full phone number is shown to an admin only on a case handled by the platform or assigned to that admin; otherwise it is masked.

## Phase 5 records

| Record | Admin can | Admin cannot |
|---|---|---|
| Payment intent, attempt, allocation, refund, settlement, attempt history | view; refresh an attempt (an authenticated check); close an attempt only after the provider confirms it did not collect; retry a FAILED refund through the same provider | edit, delete (database refuses), mark anything paid, move money, change an attempt the provider reported final |
| Provider exception | resolve with an outcome from a fixed list and a note of 10+ characters (audited) | delete; resolve a shop-order payment exception (the seller resolves those) |
| Callback inbox | replay a dead-lettered callback (`admin:replay_dead_letter`, step-up) | edit or delete a callback |
| Provider connection | create one for a merchant (owner only, step-up, no secret accepted, only providers allowed for merchant sales), disable it | edit a destination, delete |
| Marketplace report | dismiss with a note, or act on it through a takedown | delete |
| Listing / seller moderation | unpublish, suspend, reinstate (a reason of 10+ characters; recorded append-only with the admin) | delete a listing; block order servicing; edit a recorded decision |
| Appeal | decide once (overturning reinstates) | decide twice |
