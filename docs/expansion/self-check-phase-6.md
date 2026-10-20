# Phase 6 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (still the same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Delivered: TradePal's own subscription billing through pawaPay (versioned plans with country prices; customer-authorised renewal charges; callbacks verified per RFC 9421 with Content-Digest; an authenticated status lookup before any entitlement; idempotent allocation to invoice and billing period; reconciliation; refunds of subscription charges and of unapplied payments; cancellation and scheduled plan changes), the server-side entitlement matrix with grace, expiry and a separate security-suspension state, owner WhatsApp commands, and the admin subscriptions panel. Everything is **implemented** and **locally tested** against an in-memory reading of pawaPay's documentation. **Nothing is sandbox verified, partner approved, production configured or production activated, and the whole feature is OFF and fails closed**: no pawaPay token exists anywhere, the flags `pawapayBilling` and `subscriptionEntitlements` are off, no country switch is on, and in production new charges additionally need `PAWAPAY_BILLING_PRODUCTION_ACTIVATED=true`.

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **100 files / 1103 tests pass** (Phase 5 ended at 95 / 1055) |
| `admin-frontend` `npx vitest run` + `npm run build` | 12 files / 53 tests pass; build succeeds |
| New in Phase 6 | `billingRenewal` 17, `billingEntitlements` 11, `adminSubscriptions` 9, `pawapaySignature` 8, `billingCommands` 3 (48 backend tests) + 4 frontend; the legacy admin invoices route was fixed to serialise the two new money columns |

## 1. Failure scenarios

### F1. The Phase 6 migration misbehaves on the real database
- Same standing caveat as Phases 1-5: never run on a real server; `scripts/rehearseMigrations.sh` is still unrun against a database. This migration **alters two existing, live tables** (`Invoice`, `Subscription`: additive columns with defaults) and puts a status trigger on `Invoice`, which also fires for the older Flutterwave subscription path (it only refuses un-paying a paid invoice, which that path never does). The Railway role's privileges for the new functions, triggers and policies are unverified (PGlite is superuser).

### F2. It works against our model of pawaPay, not against pawaPay
- **This is the largest limit.** Every pawaPay response in the tests comes from an in-memory fake written from the documentation. Real behaviour on timing, statuses (`IN_RECONCILIATION`, `ENQUEUED`), failure codes, the `DELAYED` availability state for deposits, partial refunds, rate limits and callback delivery is unproven.
- **Signature verification has never seen a real pawaPay callback.** The vectors come from an independent minimal signer in the test file (so the verifier agrees with RFC 9421's construction), but pawaPay's page publishes no sample to compare against, no rotation rules and no replay rules, and its own examples disagree about `keyid` (`CUSTOMER_TEST_KEY` vs `HTTP_EC_P256_KEY:1`). A mismatch in how pawaPay forms the signature base (for example the `@authority` or `@path` it signs, a port, a proxy, a custom domain) would make **every callback fail closed and be refused**; the sweep would still find completed payments by polling (within minutes), so money is not lost, only delayed. This is why the activation checklist insists on a sandbox run first.
- Open documentation conflicts, resolved conservatively and flagged: the refund status path (prose says `/payouts/{id}`, the API reference says `/refunds/{id}`; we use the reference); the limit field names (`minAmount` vs `minTransactionLimit`; both accepted); `DELAYED` availability for a deposit (we refuse a new charge unless OPERATIONAL).

### F3. A merchant is wrongly given, or wrongly denied, service
- **Evidence it does not happen wrongly:** only an exact, authenticated, correctly-owned payment grants a period (wrong amount, wrong currency, a duplicate, a payment for a cancelled invoice, an unknown deposit and one from another environment all grant nothing and raise an exception; a perfectly signed callback claiming success that pawaPay's own record contradicts grants nothing); replays, re-signed retries and concurrent-style repeats leave one allocation and one period (scenario 15); entitlement is computed from stored state and the clock, so a stopped sweep cannot keep or remove access (scenario 16); expiry never stops servicing.
- **Known gaps:** (a) **the product has not decided which features each plan includes.** Plans created before versions existed have no feature list, so the rule is "a paid plan includes every premium feature, FREE includes none". With `subscriptionEntitlements` on, every business without a paid subscription loses the four premium operations. That is a decision for the owner before anyone switches enforcement on (OPEN-12 below); (b) only four operations are gated (new trade orders, marketplace publishing, reorder rules, re-opening a shop); voice, staff caps and the AI budget still come from the older plan fields; (c) the grace period is the plan version's setting with default 3 days and no separate "grace behaviour" other than full access.

### F4. Money is wrong
- Exact-amount rule, guarded updates, unique allocation per invoice and per attempt, a database trigger that a paid invoice never becomes unpaid, refunds bounded by a guarded update and a CHECK (on both the invoice and the attempt), one refund in flight per payment, funds reserved before sending and released on failure, no refund path for merchant money (tested), and **no billing record is ever linked to a merchant journal, store, trade or merchant-payment record** (tested directly).
- **Gaps:** (a) money that arrives wrong (short, over, duplicate) is real money held on pawaPay's side until an admin gives it back or settles it outside; nothing is automatic, and a payer is not told (no consumer messaging yet); (b) a refund pawaPay accepts but never confirms is polled with backoff indefinitely and raises no exception of its own (deposits do after 8 checks; refunds do not), so a stuck refund is visible only in the refunds list; (c) TradePal's own accounting of its subscription revenue is outside this system, so "billing revenue" appears only as invoices and payments; a refund of a paid period does not shorten it unless the admin ticks "revoke"; (d) a payer who pays from a different wallet than the one named is not detected (only the last four digits of the number we asked are kept).

### F5. Concurrency
- Replays, duplicate callbacks and repeated appliers are tested, and every decisive step is a single guarded statement backed by a constraint. As in Phases 4 and 5, **PGlite serialises sessions, so real interleaving of two connections is unproven**; the exception writes are deliberately issued after the allocation transaction because writing them inside it deadlocked the single test connection (a limit of the test database, but a reminder that no multi-connection run exists). A crash between "attempt marked COMPLETED" and "period granted" is repaired by the sweep (`repaired`), reasoned and exercised through replay, never injected.

### F6. The sweeps are not running
- Callbacks are processed from the inbox and unresolved charges, refunds and lapses are reconciled by the operations sweep. **With `OPERATIONS_SWEEP_ENABLED` and `OUTBOX_SWEEP_ENABLED` off, a callback sits unprocessed, an UNKNOWN charge never resolves and nobody is granted a period** even though the payer paid. Both must be on before any activation. Polling is bounded (30 s doubling to 30 min, 8 checks) and then raises an exception for a person; nothing pages anyone.

### F7. Configuration and environment mistakes
- Fail closed on: no token, an unknown host, a declared environment that disagrees with the URL, a sandbox from a production deployment, production credentials outside production, no callback authority, production without explicit activation, a country switch that is off, a business flag that is off, and a pawaPay account name that differs from the one an environment first authenticated as. **Not covered:** a *correct but wrong* configuration (the right environment, someone else's valid account) before the first call binds it; a rotated token for the same account; a proxy that rewrites the Host header (the callback authority is configured, not read, so it is safe, but a mismatch with what the dashboard holds breaks verification as in F2).
- The old `/webhooks/pawapay` route (merchant collection, quarantined) is still mounted when a token exists. If the dashboard's deposit callback URL is pointed at it instead of `/webhooks/pawapay/billing`, subscription callbacks are ignored there (unknown deposit, 200) and the charges are found by polling instead.

### F8. Admin and privacy
- All writes are owner-only (exception handling also operator), step-up when enabled, reasoned and audited; there is no delete and no mark-paid; a manual entitlement adjustment is limited to within a year and always writes an event naming the admin and reason. **Gaps:** SUPPORT can read subscription and invoice metadata (no payer number is stored, only its last four digits); the owner can create a draft plan version that nobody reviews before publishing (no second-person rule); the reminder action sends a plain WhatsApp text, which Meta may refuse outside the 24-hour window (the same limit the older lapse notice has), and it is not recorded as sent to anyone but the audit log.

### F9. Existing behaviour regressed
- With every new flag off the earlier suites pass unchanged; the Flutterwave subscription path is untouched and still creates subscriptions without a plan version (read by the entitlement matrix as legacy). One real regression was found and fixed by the suite: the older admin invoices route serialised only `amountMinor`, so the two new money columns would have made it return 500. **Not decided:** OPEN-2 (Flutterwave's long-term role for subscriptions); two billing paths now coexist.

## 2. Master-prompt scenarios

| # | Scenario | Phase 6 status |
|---|---|---|
| 15 | Duplicate subscription callbacks cannot double-extend; mismatched billing payments grant no access | locally tested (replays, re-signed retries, a second payment for a paid invoice, wrong amount, wrong currency, unknown deposit, another environment, a false "completed" claim) |
| 16 | Expiry restricts configured features while pending payments, reconciliation, servicing, refunds and renewal continue | locally tested (callbacks applied with billing flags and switch OFF; an expired shop still takes shopper orders and fulfils them; closing allowed, re-opening refused; renewal and refunds work) |
| 13 | Settlement is not a second sale; subscription revenue never enters merchant revenue | locally tested (a paid and refunded subscription creates no journal, store, trade or payment record) |
| 14 | Merchant payment routes cannot reach the pawaPay adapter or credentials | locally tested (registry has no pawaPay; connecting a merchant is refused; a billing switch or intent for merchant sales is refused by the database) |
| 25 | Existing slash commands identical with flags off | locally tested; the five new commands answer "Unrecognized command" and are absent from `/help` while `pawapayBilling` is off |
| 27-30 | Admin routes reject merchants; step-up; audit rows; no hard delete | locally tested for the new panel and tables |

## 3. Owner decisions and actions

1. **OPEN-12 (new): which premium features each plan includes**, and whether voice, staff caps and the AI budget should move onto plan versions. Until decided, do not switch `subscriptionEntitlements` on for any real business.
2. **Plan prices and periods.** There are none by design; an owner must create, price and publish a version per country.
3. Confirm I1-I15 (`decisions.md` C7), especially the period rules (14-day early window, contiguous in grace, no proration), the 3-day default grace, and that consumers are not blocked by a merchant's lapse.
4. Follow the activation checklist in `pawapay-audit.md` section 7: account approval, sandbox token, dashboard signed callbacks and callback URLs, sandbox end-to-end run (this will be the first contact with the real service), controlled live verification, and only then `PAWAPAY_BILLING_PRODUCTION_ACTIVATED`.
5. Add to the activation checklist: `OPERATIONS_SWEEP_ENABLED=true`, `OUTBOX_SWEEP_ENABLED=true`, `PAWAPAY_BILLING_CALLBACK_AUTHORITY`, signed callbacks required, `TRUST_PROXY` and the proxy's handling of the callback host.
6. Decide Flutterwave's future for subscriptions (OPEN-2) now that two paths exist.
7. Run `scripts/rehearseMigrations.sh` on a restored backup or authorise a local Postgres download (carried; this migration alters `Invoice` and `Subscription`).
8. Unchanged: OPEN-1..11, heartbeat monitor, alert sender, Railway relink, mobile-money API approval; keep `dailyClose` off.

## 4. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no pawaPay token exists or was used; no production access; no messages sent to anyone; no real money moved or requested. Nothing was configured in any dashboard.

AWAITING: APPROVED: PHASE 6
