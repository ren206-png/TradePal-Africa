# Runbook: reconciliation (daily and weekly)

TradePal reconciles its OWN records and asks providers for authenticated status. It does not receive provider statements automatically: where a settlement report or bank/mobile-money statement exists, a person compares it.

## Daily (operator, 10 minutes)
1. **System health:** heartbeats OK; stuck inbound messages 0 (else replay from Messaging); outbox/inbox dead 0 (else Payments -> callbacks -> replay); alert channel not "needs attention".
2. **Payments panel:** unresolved attempts (nothing stale > 1 hour after expiry); exception queue; collected-but-not-settled.
3. **Subscriptions panel:** open billing exceptions; callback auth failures (24h) should be 0, any non-zero is either an attack or a signature-base mismatch.
4. **Support cases:** open cases by responsible party; anything with TradePal as responsible party is yours.
5. **Mobile-money alerts:** unmatched count (the merchant matches them with `/confirmmomo` or `/rejectmomo`).

## Resolving an exception
Payments/billing exception -> open it -> **check with the provider first** (the panel's "check status" is an authenticated lookup) -> choose an outcome from the fixed list with a note of at least 10 characters. Nothing here marks a payment paid or moves money: refunds go through the provider (subscription charges) or are recorded by the seller (shop orders).
- *Short, over, duplicate or late payment:* money is real and held; refund it or let the seller apply it. Never "mark paid".
- *Unknown deposit:* ask pawaPay; if it is not ours, record "ESCALATED_TO_PROVIDER".
- *Wrong amount on a subscription:* refund the payment (admin -> "Refund the payment…") and ask the merchant to retry.

## Weekly (owner/operator)
1. **Provider statement vs books:** compare pawaPay's settlement/transaction report with the Subscriptions panel invoices (paid) for the week. Differences go to exceptions, not to edits.
2. **Merchant books:** Reports -> payment reconciliation and stock discrepancies for a sample of merchants; the "provider clearing" account should only grow between settlement reports, then drop when a settlement is recorded.
3. **Stock:** stock-discrepancy report; ask merchants with balance mismatches (there should be none) or large count variances.
4. **Forecast scores (shadow):** Reorder panel; never promote a gate by feel.
5. **Alert channel check:** run it weekly (System health or Messaging) so a silent failure is found by you, not an outage.

## Month end
Export the invoices CSV (Subscriptions) and reconcile to pawaPay and to your own bank; keep the files. Reports for merchants are bookkeeping, not tax filings.
