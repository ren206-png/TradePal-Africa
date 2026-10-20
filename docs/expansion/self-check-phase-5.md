# Phase 5 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (still the same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Delivered: the merchant-provider payment layer (adapter contract, deterministic simulator, intent, attempt, allocation, refund and settlement records, authenticated outcome handling, bounded polling, an outage circuit, an exception queue, a callback webhook route), B2B invoices and consumer orders moved onto it, provider-aware refunds in `/store`, the marketplace (opt-in, publishing, search, listing pages, reports, moderation, appeals), and the admin payments-and-exceptions and listings-and-moderation panels. Everything is **implemented** and **locally tested**; nothing is sandbox-verified, partner-approved, production-configured or production-activated. **No real payment provider exists in this build**: the production adapter registry is empty, so live online checkout is unavailable (as the provider matrix requires). New flag, default OFF: `marketplace`. New environment switches, all default OFF: `MARKETPLACE_ENABLED`; the simulator needs `PAYMENT_SIMULATOR_SECRET` and `STOREFRONT_SIMULATOR_ENABLED` and never runs when `NODE_ENV=production`.

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **95 files / 1055 tests pass** (Phase 4 ended at 89 / 1009) |
| `admin-frontend` `npx vitest run` + `npm run build` | 11 files / 49 tests pass; build succeeds |
| New in Phase 5 | `paymentsLifecycle` 21, `marketplace` 9, `adminPayments` 6, `adminModeration` 4, `storeCommandsPayments` 3, `paymentWebhook` 2, `storefrontWeb` +1 (outage); the Phase 3 trade simulator test and the Phase 4 storefront pay test were rewritten onto the new pipeline; + 6 frontend |

## 1. Failure scenarios

### F1. The Phase 5 migration misbehaves on the real database
- Same standing caveat as Phases 1-4: never run on a real server; `scripts/rehearseMigrations.sh` is the required step and has still never been run against a database.
- Specific to this one: it is the first migration since Phase 1 that **alters existing tables** (adds columns with defaults to `Storefront` and `Listing`; small tables, but a rewrite on a larger one would lock it), and it adds a partial unique index and status-guard triggers whose behaviour under real concurrent writes is untested. The Railway role's privileges to create these objects are unverified (PGlite is superuser).

### F2. The payment layer works against the simulator but not against a real provider
- **This is the biggest limit.** Every provider behaviour here is the simulator's: signed-HMAC callbacks, refund semantics, status codes, timing, idempotency and bounds were all chosen by us. A real provider's callback format, signature scheme, refund and partial-refund rules, fee reporting, settlement timing and rate limits are unknown (matrix: U for every Sierra Leone candidate), so the first real adapter will find mismatches. The contract, the state machine and the reconciliation rules are what carry over.
- The WEAK-callback rule (a callback is only a hint; the authenticated status lookup decides) is tested with a deliberately weakened copy of the simulator, not a real weak provider.
- `checkoutUrl` from a provider is stored but not yet used by any page (the test checkout completes inside the simulator). When a real provider returns a hosted-checkout address, it must be checked against that provider's allow-list before a shopper is sent there; **not built**, because there is nothing to redirect to. No merchant-supplied URL exists anywhere in the model (a connection holds only an arrangement reference, a destination key, a label and the name of a server-side secret).

### F3. Money is wrong: duplicated, lost, mis-attributed or mis-booked
- **Evidence for correctness:** replays, re-sent events under new ids, and repeated appliers leave one payment, one allocation and one journal (7); forged, mismatched or unknown evidence applies nothing and raises one exception (8); accepted, timed-out and unknown stay unpaid until an authenticated lookup (9); a late success after expiry or cancellation is held and recoverable (10); refunds are reserved by a guarded update and can never exceed the capture, a failed refund stays visible and unresolved, and the books move only when the provider confirms (12); settlement posts Dr bank / Dr fees / Cr clearing and leaves revenue untouched (13); trial balances balance after each.
- **Known gaps:** (a) a refund the provider confirmed but whose bookkeeping then fails (for example the order changed in between) leaves money gone and books behind: it raises a `REFUND_FAILED` exception with stage BOOKKEEPING for a person; it is not self-healing; (b) a refund of money the provider already settled leaves Provider clearing negative until a later settlement nets it; there is no automatic netting; (c) the settlement fee is booked when the settlement is reported, not per payment; (d) a wrong-currency payment is held and **not journaled**, so the books do not show it until a person acts; (e) **a payment on a B2B invoice cannot be refunded through the provider** (refused with an explicit error: a credit note between the two businesses is the route); (f) a successful provider payment that arrives for a B2B invoice that was settled another way in the meantime is held, not auto-refunded; (g) nothing detects a seller recording a cash payment for the same order a shopper also paid online.

### F4. Concurrency
- Replays, duplicate deliveries and repeated appliers are tested, and every decisive step is a guarded single-statement update (`UPDATE ... WHERE status IN (...)`, `refunded + x <= captured`) backed by a database constraint. **PGlite serialises sessions, so real interleaving of two connections was never exercised**: simultaneous starts, simultaneous appliers and simultaneous refunds were tested one after another (a first attempt at running them together deadlocked the single test connection, which is the test database's limit, not evidence about Postgres). Unverified until run against a real server under load.
- Two crash points are handled by repair rather than by one transaction: between "attempt marked SUCCEEDED" and "money allocated", and between "provider accepted the refund" and "books moved". The reconciliation sweep repairs the first (`repaired` count); the second becomes an exception (F3a). A crash was never injected; this was reasoned and unit-exercised through replay.

### F5. The sweeps are not running
- Reconciliation (polling unresolved attempts and refunds, lapsing intents, repairing allocations) and callback processing are driven by `OPERATIONS_SWEEP_ENABLED` and the callback inbox sweep. **With the sweeps off, an UNKNOWN attempt never resolves, a lost callback is never found and the inbox never drains**; shoppers would see "waiting for the provider" indefinitely. Both sweeps must be in the activation checklist before any provider is enabled. Polling is bounded (30 s doubling to 30 min, 8 checks) and then raises an `UNRESOLVED_ATTEMPT` exception for a person; nothing pages anyone, the exception appears in the admin payments panel and the overview count.
- The callback webhook is a 404 for every provider in production today (the registry is empty). It authenticates, stores and answers, applying nothing inline. It has no per-address rate limit of its own and no allow-list of provider IP addresses; a real provider's source ranges are unknown.

### F6. A provider outage or flapping
- After 3 consecutive failures a connection refuses new attempts for 60 seconds with a plain message ("temporarily unavailable"); attempts already made keep reconciling, signed callbacks keep applying and an admin can still check an attempt (tested through the service and the web). The circuit is per merchant connection, not per provider, so one provider outage opens each merchant's circuit separately as they hit it. A request that timed out is UNKNOWN and blocks a second attempt for the same order until the provider says whether it exists. **Not tested:** a provider that answers slowly rather than failing, partial outages by operation (status works, refund does not), and clock skew between our clock and the provider's.

### F7. The marketplace is abused, or shows the wrong thing
- **Abuse:** there is no pre-approval, so a bad seller is visible until someone reports and a person acts. Reports can be filed by anyone; rate limits are per address, there is no CAPTCHA, and the per-target cap (200 open) stops floods but also means a determined group can bury a real report. Reports never act by themselves (so reporting cannot remove a competitor), at the cost of slower takedown. There is **no seller identity verification**: the name shown is the seller's own shop title and phone number, so impersonating another business's name is possible; "clear seller identity" here means name, contact and country are always shown, nothing more. No ratings, trust badges, volumes or delivery guarantees exist or are invented.
- **Search:** candidates are fetched (up to 300) and ranked in memory with per-seller price and stock lookups; at hundreds of sellers the result set is incomplete and slow. Ranking inputs are documented and shown on the page (match, availability, recency of seller update, id). Marketplace pages are `noindex` for now (owner decision H15), so discovery works only for people who already have the site address.
- **Suspension and takedown:** tested through search, listing URL, shop URL, add-to-basket and checkout, with orders already placed serviced to completion (24). **Not covered:** a suspended seller's saved basket links in other shoppers' browsers (they fail politely at checkout, tested) and cached copies in browsers or proxies.
- **Moderation workload:** the queue sorts by age, shows how many open reports a seller has, and has no automatic prioritisation or SLA. A single admin decision (unpublish, suspend) needs no second person; OPERATOR now has that permission (H14).

### F8. Admin and privacy
- Every admin write is audited with the acting admin, reason and correlation id; payment records are never edited or deleted from the console (tested: no delete, put or mark-paid route exists); a connection needs the owner, step-up and refuses any secret or any provider not allowed for merchant sales. **Gaps:** report text and a reporter's optional contact (free text, possibly personal data) are visible to anyone with `admin:view_moderation`, including SUPPORT; reading payment exceptions shows business names and amounts to OPERATOR without a support-access reason (it opens no merchant books, but it is financial metadata).

### F9. Existing behaviour regressed
- The Phase 3 B2B payment path and the Phase 4 storefront pay path were **rewritten**, not just extended: the old direct-reference simulator is gone. The rewritten tests assert the same business outcomes (one payment, balanced books on both sides, buyer mirror, held overpayment). With all new flags off the earlier suites are green. Any real merchant data created through the old simulator (there is none: the simulator never existed outside tests and dev) would have no intent or attempt behind it.

### F10. Provider decision and arrangements
- No provider is established, so nothing real can be enabled and no real fee, limit or settlement time is known. The owner decisions in `merchant-provider-matrix.md` section 4 are unchanged and now block the real adapter, not the architecture.

## 2. Master-prompt scenarios

| # | Scenario | Phase 5 status |
|---|---|---|
| 7 | Concurrent and replayed callbacks apply one business effect | locally tested (replays, re-sent events, repeated appliers); real interleaving unproven (F4) |
| 8 | Forged signature, wrong account/tenant/purpose, amount/currency mismatch, unknown reference cannot mark paid | locally tested |
| 9 | Accepted, timed-out, unknown stay unpaid until authenticated evidence | locally tested |
| 10 | Late success after cancellation or expiry is a recoverable exception | locally tested (re-reserve, and refund through the provider) |
| 11 | Retry/fallback cannot create two active attempts | locally tested, including the database index |
| 12 | Concurrent partial refunds cannot exceed refundable funds; failed refund stays unresolved | locally tested (sequential; F4) |
| 13 | Settlement is not a second sale; subscription revenue never enters merchant revenue | locally tested |
| 14 | Merchant payment routes cannot reach the pawaPay adapter or credentials | locally tested (purpose policy, the database CHECK on intents, a connection refused for pawaPay and Flutterwave) |
| 23 | Provider outage blocks new attempts with clear UI; reconciliation stays operable | locally tested through the service and the web page |
| 24 | Suspended listings unavailable by direct URL and search; eligible order servicing continues | locally tested |
| 25 | Existing slash commands and onboarding identical with new flags off | locally tested: the earlier suites are green; `/store` marketplace and payment subcommands exist only behind the `storefront` flag |
| 27-30 | Admin routes reject merchants; step-up; audit rows; no hard delete on financial tables | locally tested for the new panels and tables |

## 3. Owner decisions and actions

1. **The provider decision** (matrix section 4): which provider, who holds the commercial relationship, merchant-direct or integrator, and whether Flutterwave stays in scope. Without it no real adapter can be written.
2. Confirm H1-H15 (`decisions.md` C6), especially H6 (refunds go back through the collecting provider and books move on confirmation), H9 (circuit and polling constants), H13 (no automatic takedown, appeals) and H14 (operators may moderate).
3. Decide whether marketplace pages should be indexable by search engines (H15) and whether sellers need identity verification before listing.
4. Add to the activation checklist: `OPERATIONS_SWEEP_ENABLED=true`, `OUTBOX_SWEEP_ENABLED=true` (callbacks), `MARKETPLACE_ENABLED=true` only when ready, `PAYMENT_SIMULATOR_SECRET` and `STOREFRONT_SIMULATOR_ENABLED` only outside production, `TRUST_PROXY`, Redis rate limiting, and a provider source-address allow-list at the proxy once a real provider exists.
5. Run `scripts/rehearseMigrations.sh` on a restored backup, or authorise a local Postgres download for a first real-server run (carried from Phase 2); this migration alters existing tables.
6. Unchanged: OPEN-1..11, heartbeat monitor, alert sender, Railway relink, pawaPay and mobile-money approvals; keep `dailyClose` off.

## 4. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access; no messages sent to anyone. The simulator moves no money and contacts no provider; no real provider was called.

AWAITING: APPROVED: PHASE 5
