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
