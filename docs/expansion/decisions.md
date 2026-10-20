# Decisions register — B2B + B2C expansion

Created 2026-10-20 (Phase 0). Each entry: decision · status · alternatives · rationale · consequences · confidence.
Status: **GIVEN** (owner decision, recorded verbatim in spirit; not to be relitigated) · **PROPOSED** (engineering recommendation awaiting owner approval) · **OPEN** (owner decision needed; no default invented).

## A. Owner decisions (GIVEN)

| # | Decision | Notes |
|---|---|---|
| G1 | Keep the product name TradePal Africa and existing branding conventions. | |
| G2 | Build both B2B and B2C around one merchant operating system; do not reduce scope to bookkeeping. | |
| G3 | WhatsApp is the primary channel; a lightweight responsive web/PWA serves storefront, checkout, stock counts, bulk editing, reporting. | |
| G4 | Sierra Leone is the first new pilot configuration; preserve existing countries/customers; expansion is configuration, not branches. | Current country config is partly hard-coded — see P4. |
| G5 | **pawaPay is exclusively for businesses paying TradePal subscriptions.** Never for merchant goods sales, supplier settlements, wallets, escrow, payouts or commissions. | **Conflicts with existing `/collect` code**; see P1. |
| G6 | Merchant B2B/B2C sales use other external providers under approved merchant arrangements, settling to the selling merchant. Provider not yet established. | See `merchant-provider-matrix.md`. |
| G7 | Subscription revenue and merchant sales proceeds stay separate in accounts, credentials, events, ledgers, reconciliation, reporting, refunds. | Existing Flutterwave code mixes the two credential sets; see P2. |
| G8 | Retain and audit existing pawaPay integration; disabled in production until the owner's activation conditions are met. Passing tests is not activation. | `pawapay-audit.md`. |
| G9 | A lapsed subscription must not block completion, callbacks, reconciliation or servicing of transactions already underway. | |
| G10 | Build the entire agreed structure in the §21 dependency order, each phase complete behind its flag first. | |
| G11 | Reorder engine in scope inside Procurement: Tier 1 deterministic (merchant-visible), Tier 2 forecasting in shadow mode only, per-merchant scored promotion gate (owner action in admin). | No reorder code exists today (E.12). Thresholds are configurable with **no invented production defaults**. |
| G12 | Consumers pay no subscription; no seller commissions. | |
| G13 | Platform admin console in scope, cross-cutting, thin in Phase 1, extended each phase; can never hard-delete financial history. | |

Do not assume affiliation with the separately referenced TradePal AI (tradepalai.xyz).

## B. Engineering proposals (PROPOSED — need owner approval before Phase 1 relies on them)

### P1 — Quarantine pawaPay `/collect`; rebuild pawaPay for subscriptions only
- **Alternatives:** (a) leave as is; (b) delete the code; (c) quarantine behind a purpose guard and rebuild for subscriptions.
- **Rationale:** (a) contradicts G5; (b) destroys reviewed, tested code and history; (c) is additive, reversible, and enforces G5 in code (negative test, scenario 14).
- **Consequences:** `/collect` becomes unreachable by a purpose guard, not just a flag; no data migration (0 `PawaPayDeposit` rows); subscription billing adapter written fresh in Phase 6.
- **Confidence:** high.

### P2 — Split payment purposes and credentials; quarantine merchant paylinks
- **Rationale:** one `FLUTTERWAVE_SECRET_KEY` serves `payments.ts` (subscriptions) and `paymentRequests.ts` (merchant → customer links); a paid merchant link credits TradePal's account with no settlement path, which contradicts G6-G7.
- **Consequences:** add a `PaymentPurpose` (`PLATFORM_SUBSCRIPTION | MERCHANT_SALE`) derived server-side; merchant paylinks stay disabled until a merchant-settling arrangement exists.
- **Open sub-question (OPEN-2):** is Flutterwave to remain for subscriptions, be retired, or sit beside pawaPay?
- **Confidence:** high on the finding, medium on the remedy.

### P3 — DB-level protection in Phase 1
- **Finding:** tenant isolation and append-only are enforced only in the Prisma client extension (`tenantScope.ts`); production rows were deleted with raw SQL on 2026-10-18.
- **Proposal:** Postgres RLS as a second layer on tenant tables (session variable set per request/job) and triggers rejecting `UPDATE`/`DELETE` on financial append-only tables; admin "delete" becomes void/reverse/suspend/anonymize (G13).
- **Alternatives:** application-only (current); DB roles without RLS. Rejected: scenarios 18 and 29 require DB-level proof.
- **Risk:** migration must be rehearsed on a copy; triggers must not break legitimate corrections (reversals are inserts) or GDPR-style anonymization (anonymize touches `Customer`, not financial rows).
- **Confidence:** medium-high.

### P4 — Organization / Shop / Membership model
- **Finding:** `Business` is organization and shop; `Merchant(phoneNumber @unique)` binds one phone to one business.
- **Proposal:** keep `Business` as the tenant (organization) to avoid rewriting `businessId` everywhere; add `Shop` (many per Business) and `Membership` (N:M between a verified user identity and Businesses, with role); relax the phone→business 1:1 only through Membership, with an explicit "active organization/shop" per conversation.
- **Alternative:** introduce a new `Organization` above `Business`. More faithful to §7 but touches every query; defer unless Phase 1 evidence demands it.
- **Country configuration:** move the hard-coded `src/config/countries.ts` array to the DB-backed `Country/CountryConfig` as the single source (G4).
- **Confidence:** medium.

### P5 — Keep the modular monolith, existing stack and service boundaries
- Express 4 + Prisma 6 + BullMQ/Redis + zod 3 on Railway; new modules inside the same repo; jobs stay in the existing worker services unless load proves otherwise. No new framework/vendor.
- **Alternatives:** Next.js/NestJS rewrite, separate services. Rejected: no repository-compatibility benefit (§5).
- **Confidence:** high.

### P6 — Outbox/inbox
- Reuse `WebhookEvent` + re-drive as the durable inbox; add a transactional outbox table for outbound payment/messaging events (none exists today).
- **Confidence:** medium-high.

### P7 — Reorder engine
- Tier 1: reorder point / days-of-cover, arithmetic shown, no model calls. Tier 2: per-variant demand forecast using a simple documented method (moving average / exponential smoothing), run in shadow mode, scored nightly (MAPE or documented equivalent; stockout periods flagged) against actuals and against Tier 1; per-merchant promotion by an audited owner action once configurable minimums are met.
- **Known limits to record:** few weeks of history per merchant at pilot scale; intermittent demand; no seasonality data. Merchant-facing copy must not say "AI forecasting".
- **Confidence:** medium (design); no evidence yet on achievable accuracy.

### P8 — Confirmation-before-execution for consequential AI actions
- **Finding:** entries at confidence ≥ 0.7 are applied immediately (`AUTO_LOG_MIN_CONFIDENCE`, `src/ai/parse.ts`), with `/undo` as the safety net. §14 requires a confirmation bound to action, amount, actor and expiry for consequential changes.
- **Proposal:** keep immediate logging for low-consequence bookkeeping entries; require bound confirmation for new classes (purchase orders, payments, price changes, stock adjustments above a threshold, anything touching another party).
- **Confidence:** medium.

### P9 — Confidence calibration
- The 0.7 bar was set on 18 production rows plus an Anthropic-model measurement, while DeepSeek is the live primary. **Re-measure through the DeepSeek provider before relying on it** (see audit E.14 #1).

### P10 — Pre-Phase-1 hygiene
- Quote the repo path in `tests/helpers/db.ts:14-15` (paths with spaces break every DB test).

## C. Open owner decisions (OPEN — no defaults invented)

| # | Question | Needed by |
|---|---|---|
| OPEN-1 | Approve P1 (quarantine `/collect`)? | Phase 1 |
| OPEN-2 | Flutterwave's role: subscriptions only / retire / alongside pawaPay? Merchant paylinks stay quarantined until a settlement arrangement? | Phase 1 (purpose guard), Phase 6 |
| OPEN-3 | Approve P3 (RLS + immutability triggers) and P4 (Shop/Membership direction)? | Phase 1 |
| OPEN-4 | Merchant-sales provider and contracting model (direct per-merchant vs integrator) | Phase 5 |
| OPEN-5 | Subscription prices per country/currency, free-plan limits, grace period, refund terms, upgrade policy | Phase 6 |
| OPEN-6 | Forecasting promotion thresholds (minimum scored weeks; minimum improvement over Tier 1) | Phase 3 |
| OPEN-7 | Seller terms, delivery responsibilities, service areas, consumer dispute process | Phase 4-5 |
| OPEN-8 | Reviewed tax rules, retention requirements, country notices, legal classification | Phase 8 |
| OPEN-9 | Human-reviewed language samples and error thresholds (Krio etc.); until then English only, no invented dialect strings | Phase 7 |
| OPEN-10 | External heartbeat / dead-man's switch (owner action); verified alert sender domain and a second recipient (owner action) | Before any activation |
| OPEN-11 | Whether to fix `tests/helpers/db.ts` (P10) now | Before Phase 1 |
| OPEN-12 | Which premium features each plan includes (and whether voice, staff caps and the AI budget move onto plan versions). Until decided, `subscriptionEntitlements` must stay off for real businesses | Before enabling entitlements |

## C2. Phase 1 application of proposals (provisional, reversible, awaiting owner confirmation)

Phase 1 was started on `APPROVED: PHASE 0` without separate answers to OPEN-1..3 and OPEN-11, so the proposals were implemented **additively and behind safe defaults**. Confirm or reject each; none is irreversible in code.

| Proposal | What was built | How to reverse |
|---|---|---|
| P1 quarantine `/collect` | purpose guard; original initiators renamed `...Quarantined`; `/collect` and `/paylink` hard-locked | remove guard (not recommended) |
| P2 purposes/credentials | `PaymentPurpose` enum + policy table (pawapay/flutterwave: subscription only; simulator: merchant sale); merchant paylinks unreachable | change policy table |
| P3 DB protection | append-only/delete/TRUNCATE triggers live on migrate; RLS policies present but **inert** until role activation | `DROP TRIGGER`; stop using `enforceRls` |
| P4 Shop/Membership | `Shop`, `Membership`, `ActiveContext`; `Business` stays the tenant; backfill; legacy `Merchant` unchanged | tables are additive |
| P10 test path quoting | one-line fix in `tests/helpers/db.ts` | trivial |
| New: OPERATOR admin role | enum value + permission matrix; existing roles unchanged | do not assign |
| New: admin step-up and support access | flags `adminStepUp`, `adminSupportAccessRequired`, **default OFF** | leave off |
| New: heartbeat | `SystemHeartbeat`, `/heartbeat` (404 unless `HEARTBEAT_ENABLED=true`) | leave unset |

## C3. Phase 2 decisions (built additively, flags default OFF; confirm or change)

| # | Decision | Alternatives | Why | Reverse by |
|---|---|---|---|---|
| D1 | Keep the legacy `InventoryItem`/`Transaction` path unchanged and layer the new catalog/stock/journal system beside it, bridged by explicit adoption (`/adopt`) and flag-gated mirrors | rewrite the legacy tables; dual-write silently | additive-only rule; existing commands must behave identically with flags off (scenario 25) | leave flags off |
| D2 | Stock is quantities in integer BASE units; pack sizes are declared conversions (>= 2); an undeclared unit is an error | decimal quantities; guessing conversions | no floats; "a bag, carton and piece are never interchangeable without a declaration" | n/a |
| D3 | Costing = moving weighted average over costed units only; uncosted units tracked and flagged; returns restock at the cost they left at; backdated entries not restated | FIFO layers; blending unknown cost as zero | simplest sound method that never overstates profit; limits documented in `accounting-postings.md` | switch method in `stock.ts` |
| D4 | Negative-stock policy per business: ALLOW (default, legacy behaviour) or BLOCK with a named approver override; backorders off by default | block always | the existing product never blocks a sale; B2B/B2C reservations need available stock, so reservations always check unless backorders are enabled | `setStockPolicy` |
| D5 | Overselling is prevented by a row lock on the balance (`SELECT ... FOR UPDATE`) plus append-only movements; reconcile proves balance = movement sum | optimistic retry; advisory locks | atomic, auditable | n/a |
| D6 | Legacy WhatsApp transactions are journaled to explicit "method not recorded" / "unresolved" / "debt-note suspense" accounts, never guessed as cash or revenue | assume cash; treat debt notes as credit sales | the earlier flow recorded no method and no cost; inventing them would fabricate history (invariant 8) | do not enable `accountingJournals` |
| D7 | Daily close expects ONLY cash explicitly recorded as cash; receipts with no recorded method are reported separately | assume unspecified = cash | same reason as D6. Consequence: until payment method is captured (Phase 7), a merchant who counts all money will see a "more than books" difference | do not enable `dailyClose` yet (see self-check F6) |
| D8 | Admin "void" = reverse via the existing `reverseTransaction`, plus audit; no delete route exists | allow delete | master prompt section 18 | n/a |
| D9 | Every successful admin write gets a generic audit row (`admin.write`) in addition to any specific one; the row is written before the response | per-route audits only | scenario 28 by construction, including routes whose domain code audits nothing | remove middleware (not advised) |
| D10 | CSV export is formula-safe: apostrophe-prefixed text cells, validated integer columns, 10,000-row cap, audited | no escaping | spreadsheet formula injection from merchant-controlled text | n/a |
| D11 | Rounding: half away from zero; basis-point percentages; largest-remainder allocation | banker's rounding | retail convention; parts always sum to the total | n/a |
| D12 | New merchant WhatsApp commands (`/close /products /addproduct /pack /receive /count /adopt`) answer as "unrecognized" while their flag is off | always on | scenario 25 | n/a |

Not decided here (still OPEN): tax treatment, retention periods, which payment-method capture UX (Phase 7), whether to let bulk catalog editing live in a web/PWA surface (planned for a later phase; Phase 2 delivers WhatsApp commands and the admin panel only).

## C4. Phase 3 decisions (built additively, flags default OFF; confirm or change)

| # | Decision | Alternatives | Why / consequence | Reverse by |
|---|---|---|---|---|
| E1 | Each business owns its OWN row of each trade document; counterpart rows are kept in step by outbox events that copy agreed fields only; no foreign key across tenants | one shared cross-tenant document; direct cross-tenant reads | tenant isolation by construction (scenarios 1, 18). Cost: eventual consistency (seconds). The trade flow therefore **needs `OUTBOX_SWEEP_ENABLED=true` in production**; the merchant commands also deliver inline as a fast path | n/a |
| E2 | Linking is an explicit, one-time, reversible invitation (token hashed at rest, 7-day expiry); a link shares nothing except a published wholesale price list the seller chooses to share | auto-link by phone number | "invitation does not share books" | revoke |
| E3 | Acceptance freezes terms, enforced by the database (no change to qty/pack/price after ACCEPTED; cannot accept an unpriced order) | application-only | invariant 3 and 9 | n/a |
| E4 | Seller stock is HELD (reserved) when the seller commits (accept or quote), in the same transaction; default hold 14 days (a parameter, renewable). A quote holds stock until its validity | hold only on acceptance | no overselling across B2B/B2C (scenario 2). The 14-day default is an operational parameter, not a promotion threshold; change in `orders.ts` | `DEFAULT_HOLD_DAYS` |
| E5 | One invoice per shipment; revenue recognised at shipment/invoice; invoice and receipt values use cumulative rounding | one invoice per order; recognise on payment | totals reconcile exactly (invariant 4); collection alone is not revenue | n/a |
| E6 | Buyer books Dr Inventory / Cr Payables at goods RECEIPT, for what arrived (accepted + damaged); short units are not booked | book at invoice | "purchase orders do not increase stock; confirmed receipts do". Consequence: credit notes limited to short delivery (derived from the buyer's receipt) in this phase | extend credit-note types later |
| E7 | A payment a business records is mirrored to the other side only as a PROPOSAL; it counts there only when confirmed. Authenticated evidence (simulator now, provider later) applies directly and is labelled | trust the counterparty's report | "a forwarded SMS or screenshot proposes, never confirms" | n/a |
| E8 | The merchant-payment SIMULATOR is allowed for MERCHANT_SALE only; signed callbacks (HMAC-SHA256), durable inbox, applied once per (provider, externalId); collected money sits in Provider clearing until settlement (Phase 5) | skip the simulator | section 12 | n/a |
| E9 | Trade credit: limits and overdue cut-offs are the SELLER's own recorded rules; a block can be overridden by the owner with a reason (audited). No scoring, no lending, no AI | automatic scoring | section 9 | n/a |
| E10 | Reorder Tier 1: FIXED and DAYS_OF_COVER rules, position = on hand - reserved + incoming open orders; arithmetic stored and shown; accepting makes a DRAFT purchase order only | automatic ordering | section 9; scenario 31 | n/a |
| E11 | Tier 2 method `ses-v1`: simple exponential smoothing on 12 weekly buckets, alpha 0.30, 7-day horizon, integer fixed-point; needs 4+ weeks of history; shadow only. alpha and window are STARTING values to be judged by scoring, not tuned | moving average; ARIMA; an LLM (forbidden) | simple, documented, reproducible | edit `forecast.ts` and bump the method version |
| E12 | Scoring: actual units in the period vs forecast and vs the Tier 1 baseline for the same period; MAPE (undefined when actual is 0) and WAPE; stock-out periods are flagged and excluded from the headline metric. "Scored weeks" = distinct 7-day epoch buckets (overlapping daily runs do not inflate it) | count predictions | honest evidence | n/a |
| E13 | Promotion thresholds (minimum scored weeks, minimum improvement over Tier 1 in basis points) are NULL until the owner sets them: **no defaults were invented** (open item OPEN-6). The gate opens only through one function and a database trigger refuses any other route (generic flag tools return 409) | default thresholds | section 9 | n/a |
| E14 | Known forecasting limits: few weeks of history at pilot scale; intermittent demand leaves few measurable periods (many zero weeks make MAPE undefined); no seasonality/price/promotion modelling; a legacy-sale reversal is not linked back to its sale; merchant wording says "based on your recent weekly sales", never "AI" | | | n/a |
| E15 | New merchant permissions `trade:buy`, `trade:sell`, `trade:payments`, `trade:partners`, `trade:credit_override` (owner only); platform `admin:view_reorder`, `admin:set_forecast_thresholds` (owner only) | | see `permission-matrix.md` | n/a |

## C5. Phase 4 decisions (consumer storefront; built additively, flags default OFF; confirm or change)

| # | Decision | Alternatives | Why / consequence | Reverse by |
|---|---|---|---|---|
| F1 | A shopper's basket is a global, token-only object (`Basket`, not tenant data); checkout SPLITS it into one independent order per seller, each owned by that seller. A shopper never has an account in this phase | one pooled order across sellers; mandatory accounts | each seller prepares, charges and accounts for their own order; no pooled money (invariant: no marketplace float). Cost: a shopper who buys from three sellers gets three order links | n/a |
| F2 | The only credentials a shopper has are unguessable tokens: a basket cookie, and a secret order link (48 hex chars, stored hashed, 90-day expiry, then 30 days + the return window after hand-over). Orders are never reachable by id, order number or phone number | order number + phone lookup | scenario 18: nothing to enumerate. Cost: a shopper who loses the link cannot look the order up; they phone the seller (the shop page shows the number) | extend later with a verified-phone lookup |
| F3 | Stock is HELD with a reservation at placement (same service B2B uses), released on cancel/expiry, consumed only when the goods leave (pickup: hand-over; delivery: dispatch). Holds: unpaid online order 60 min, confirmed pay-on-collection order 48 h (both per-shop settings) | decrement at placement | no overselling across channels (scenario 2). A pay-on-collection order that is never confirmed lapses; the sweep must run (`OPERATIONS_SWEEP_ENABLED`) | per-shop settings |
| F4 | Revenue is recognised ONLY at hand-over. Every payment first lands as a customer advance (Cr Customer advances); hand-over moves it to Sales and, separately, Delivery fees. Delivery fee is its own revenue account (`DELIVERY_FEES` 4100) | recognise at payment | cancelling or failing a delivery never needs a revenue reversal; refunds before hand-over are advance refunds | n/a |
| F5 | One cancellation policy, one refund policy, shared by the web page and the backend (`cancellationPolicy`, `refundPolicy`): PLACED = cancel at once; CONFIRMED = a REQUEST the seller decides; READY or later = not cancellable; refunds only after hand-over and inside the seller's own `returnWindowDays` (null = the seller accepts none) | separate rules per surface | the page can never promise what the backend refuses (tested: the order view reports exactly what the backend will allow). A request is not a cancellation and a refund request is not a refund | n/a |
| F6 | The handover code is a 6-digit plaintext code shown on the buyer's order page once the seller confirms; the seller enters it at hand-over. A delivery can be completed without it only with a stated reason (audited); a pickup never can | hashed code; SMS code | the shopper needs to read it, so it is not secret from them; it only proves the person at the counter has the link | n/a |
| F7 | Money that arrives and does not fit (late after expiry, after the buyer cancelled, too much, too little, wrong currency) is never silently applied: it is HELD as a `PaymentException`, recoverable by the seller: refund, re-reserve (only if the stock can be taken again; a CANCELLED order is never reinstated) or apply a part-payment | auto-apply / auto-refund | scenario 10. The money is always accounted for and nothing is oversold | n/a |
| F8 | Refunds are bounded by what was paid (guarded UPDATE + DB CHECK `refunded <= paid`) and happen once per request. A return restocks at the cost the goods left at and fixes the refund amount to the value received | refund then restock | concurrent refunds can never exceed what was paid (tested) | n/a |
| F9 | Support cases name the responsible party (SELLER for delivery, goods and refunds; PROVIDER for a payment dispute when money moved through one; otherwise PLATFORM). Admin can reassign with a reason; notes are append-only; a closed case stays closed | one shared inbox | section 10: "who answers for this" is always visible to the shopper and the seller | n/a |
| F10 | Online payment is the simulator only (`ONLINE_SIMULATED`), refused whenever `NODE_ENV=production`, and offered only when `STOREFRONT_SIMULATOR_ENABLED=true` AND the seller's `storefrontOnlinePayment` flag is on. The page builds a signed callback exactly as a provider would and sends it through the durable inbox, so nothing bypasses the real path | a "test" shortcut that marks orders paid | no real money can move; the same code path will accept a real provider later (Phase 5) | n/a |
| F11 | The public pages are server-rendered HTML with no JavaScript: cookie basket (HttpOnly, SameSite=Lax), form posts checked against Origin, per-client rate limits, escaped output, `no-store` + `noindex` + `no-referrer` on any page carrying a secret. The router is mounted only when `STOREFRONT_ENABLED=true`, and a shop appears only when its owner has switched on the `storefront` flag and opened it | a React app | works on low-end phones and slow links; page budget under 30 KB for a 30-item shop (tested) | unmount |
| F12 | New merchant permissions `store:manage` (owner, manager), `store:fulfil` (owner, manager, sales clerk), `store:refund` (owner, manager); platform `admin:view_support_cases` (owner, operator, support). Support writes reuse `admin:resolve_support_case` with step-up | reuse sales permissions | see `permission-matrix.md` | n/a |
| F13 | The `MARKETPLACE` listing channel and marketplace moderation are RESERVED, not built (Phase 5). No outbound message to a shopper is sent (Phase 7); the shopper sees status on their order page | | scope | n/a |

## C6. Phase 5 decisions (merchant-provider payments and marketplace; built additively, flags default OFF; confirm or change)

| # | Decision | Alternatives | Why / consequence | Reverse by |
|---|---|---|---|---|
| H1 | Payments are modelled as intent -> attempt -> allocation -> refund -> settlement, each its own table. An intent is a request to be paid a fixed amount for one order or invoice; an attempt is one try through one provider; an allocation says where confirmed money went; a refund and a settlement are separate records | one "payment" row | section 12: provider acceptance is not payment, payment is not settlement, a refund is not a reversal | n/a |
| H2 | At most one ACTIVE attempt (CREATED, PENDING or UNKNOWN) per intent, enforced by a partial unique index. A request that timed out is UNKNOWN: it may still collect, so it blocks a retry until an authenticated status lookup resolves it | allow retries and reconcile later | scenario 11. Cost: a shopper whose request timed out must wait for the reconciliation sweep before trying again | n/a |
| H3 | Every provider message (callback, status poll, admin refresh) goes through one function. Ownership comes from OUR stored attempt (provider + provider reference), never from the message; reference, tenant, currency and destination must match or nothing is applied and an exception is raised | trust the callback | scenario 8. A mismatch leaves the attempt as it was | n/a |
| H4 | A callback scheme that is not cryptographically strong is stored as an UNVERIFIED hint; the handler asks the provider (authenticated) and acts on THAT answer | trust it | Flutterwave-style header tokens are of this kind. Tested with a deliberately weak adapter | n/a |
| H5 | What the provider reported as final stays final (SUCCEEDED, FAILED): a contradictory later report is an exception, never an edit, and the database refuses the status change too | last write wins | integrity over convenience | n/a |
| H6 | Refunds go back through the provider that collected the money; the seller's books and the order's refunded amount move only when the provider confirms. Funds are reserved by a guarded UPDATE (`refunded + x <= captured`) before anything is sent; a failed refund releases the reservation, stays recorded as FAILED with an open exception, and is never retried through a different provider | record the refund first | scenario 12. Cost: a refund the provider accepted but has not confirmed shows "sent, will be recorded when confirmed" | n/a |
| H7 | A settlement is Dr bank (net), Dr payment fees, Cr provider clearing (gross): never revenue. A report that does not add up, names another merchant or account, or lists a payment already settled posts nothing and raises an exception | auto-post | scenario 13 | n/a |
| H8 | The payment layer is one pipeline for B2B invoices and consumer orders. The Phase 3 and 4 simulator shortcuts (callbacks that named an order or invoice directly) are gone: the simulator now behaves like a provider that has its own state, signed callbacks, refunds, outages and a missing settlement-pull capability | keep both paths | no code path marks anything paid except provider evidence | n/a |
| H9 | After 3 consecutive provider failures the connection refuses NEW attempts for 60 seconds ("temporarily unavailable"); reconciling existing attempts, applying signed callbacks and admin checks continue | keep trying | scenario 23. Bounded polling: 30 s doubling to 30 min, 8 checks, then an exception | constants in `common.ts` |
| H10 | A connection stores no secret and no URL: only the merchant's arrangement reference, a destination key the provider must report, a display label, and the NAME of a server-side secret. Providers the purpose policy does not allow for merchant sales (pawaPay, Flutterwave) cannot be connected; a payment intent's purpose is checked by the database (`MERCHANT_SALE` only) | accept credentials via the console | sections 12 and 17: nothing merchant-supplied can become an SSRF path or a secret in chat | n/a |
| H11 | Marketplace is its own flag (`marketplace`) plus the seller's own switch; a seller must be ready (open shop, contact number, a priced published item with a category from a fixed list). There is no pre-approval: moderation is by reports after publishing | pre-moderation | section 10: separate activation flags | flags |
| H12 | Ranking inputs, in order: match of the searched words, availability, how recently the seller updated the listing, listing id. No paid placement, ratings, trust badges, volumes or delivery guarantees are shown or invented | popularity or sponsored ranking | section 10 | n/a |
| H13 | A report proposes and never acts; every takedown is a person's decision, recorded append-only with the admin and reason, reversible, and appealable (an overturned appeal reinstates). Suspension hides a shop, its listings and checkout publicly and never blocks servicing orders already placed | auto-suspend on N reports | reports can be weaponised; scenario 24 | n/a |
| H14 | `admin:moderate_listings` is now also given to OPERATOR (it was owner-only), so a moderation queue has someone who can act on it; new `admin:view_payments`, `admin:view_moderation`, `admin:manage_payment_connections` (owner only) | owner-only moderation | operators run the queue; connections stay with the owner | `permissions.ts` |
| H16 | Provider callbacks arrive at one route, `POST /webhooks/merchant-payments/:provider`, that authenticates per the provider's scheme, stores in the durable inbox, answers, and applies nothing inline. It is always mounted but only providers in the adapter registry answer; in production the registry is empty, so it is a 404 for everything | a route per provider written when each exists | one reviewed edge, nothing to forget | n/a |
| H15 | Marketplace pages are served with `noindex` like the rest of the storefront until the owner decides on search-engine exposure | indexable | open question for the owner | `html.ts` |

## C7. Phase 6 decisions (subscriptions through pawaPay, entitlements; built additively, flags default OFF; confirm or change)

| # | Decision | Alternatives | Why / consequence | Reverse by |
|---|---|---|---|---|
| I1 | The existing pawaPay client is already **v2**, so it is kept and extended (refunds, availability, public keys, the account's signature configuration): no rewrite, no migration cost | rebuild on a newer API | section 13: reuse a working integration. The quarantined merchant `/collect` flow and its `/webhooks/pawapay` route are untouched | n/a |
| I2 | Subscription billing is its own pipeline: new tables (`BillingAttempt`, `BillingAllocation`, `BillingRefund`, `EntitlementEvent`, `BillingException`, `BillingSwitch`, key cache, account binding), a new callback route (`/webhooks/pawapay/billing`), and additive columns on the existing `Invoice` and `Subscription`. The earlier hosted-checkout path (Flutterwave) is unchanged and its subscriptions are read by the same entitlement matrix | one shared payment table | financial ownership stays unmistakable: nothing here can touch a merchant ledger (tested) | n/a |
| I3 | Every charge is customer-authorised: one deposit whose PIN prompt goes to the payer's phone. No recurring mandate, no unattended charge. The payer's number is used once and not kept (last four digits only) | stored mandates | section 13: do not assume recurring mandates | n/a |
| I4 | Plans are versioned. A version is editable while DRAFT and frozen by the database once PUBLISHED (it and its prices); a subscriber stays on the version they bought until they renew onto a newer one. **There are no default prices**: nothing can be sold until an owner enters a country price and publishes | edit plans in place | no invented price points; no surprise changes | new version |
| I5 | Premium features per plan version are a list (`trade`, `marketplace`, `reorder`, `storefront`, `voice`). **Plans created before versions existed carry no list, so: a paid plan includes every premium feature and FREE includes none. This is an ASSUMPTION and an OPEN product decision for the owner** | invent a feature split | needed so enforcement has defined behaviour; flag it | publish versions with explicit features |
| I6 | The entitlement matrix: FREE / ACTIVE / GRACE / EXPIRED / SECURITY_SUSPENDED, computed from stored state and the clock (never from a sweep having run). Default grace is 3 days with FULL access (a per-version setting). Expired means NEW operations of four premium kinds are refused (new trade orders, publishing to the marketplace, new reorder rules, re-opening a shop) with a message pointing to renewal; everything else, including all servicing, continues. Enforcement is behind the per-business flag `subscriptionEntitlements` (default OFF) | restrict broadly | section 13 matrix; scenario 16 | flag |
| I7 | Servicing is never gated by subscription state or by billing flags: existing payments, callbacks, status checks, reconciliation, orders already placed (including shoppers' new orders at an expired shop: consumers are not penalised for a merchant's lapse), authorised refunds, historical data and export, closing a shop, and renewal itself. New charges are controlled by a separate fail-closed switch | one switch | section 13: "separate controls for creating new charges vs servicing existing ones" | n/a |
| I8 | Security suspension (`Business.status`) is its own state with its own message and operator path; paying never lifts it, and an expiry message is never shown for it | treat as expiry | section 13 | n/a |
| I9 | Period rules, all conservative and disclosed: a renewal may start 14 days before the end (earlier is refused); paying in time or inside the grace period begins the new period where the old one ended (no days lost, none given away); paying after grace begins it at payment time; plan changes take effect at the next renewal (scheduled, nothing charged or prorated now) and a live plan cannot be switched mid-period; there is no proration anywhere | prorate | section 13: no silent proration | constants in `common.ts` |
| I10 | Only an exact payment grants a period. A wrong amount, a wrong currency, a second payment for a paid invoice, a payment for a cancelled invoice, an unknown deposit or one from another environment is recorded as a billing exception and grants nothing; the money is real and is for a person to resolve. A guarded update claims the invoice and a unique allocation per invoice and per attempt makes double-extension impossible | auto-apply or auto-refund | scenario 15 | n/a |
| I11 | Money is only believed after an AUTHENTICATED status lookup at pawaPay, even for a validly signed callback. The signature (RFC 9421 with Content-Digest, our rebuilt signature base from OUR configured authority and path, `created`/`expires` window, the four documented algorithms, key rotation by one refresh on an unknown key id) decides whether a message is worth acting on and is recorded when it fails | trust the signature alone | defence in depth; the signing spec has gaps (no rotation or replay rules published) that the lookup covers | n/a |
| I12 | Signed callbacks are REQUIRED by default (`PAWAPAY_REQUIRE_SIGNED_CALLBACKS`): a callback with no signature is refused; one with a bad signature is refused and recorded. With the requirement off, an unsigned callback is only an unverified hint that triggers a lookup | accept unsigned | the dashboard must have signed callbacks enabled before activation | env |
| I13 | Environment safety fails closed on three cross-checks (base URL, declared `PAWAPAY_ENVIRONMENT`, `NODE_ENV`): the sandbox is never used from production and production credentials never outside it; production additionally needs `PAWAPAY_BILLING_PRODUCTION_ACTIVATED=true` for new charges; and the first authenticated account name binds each environment, so a different account later is refused | trust the configuration | go-live page: the two environments differ only by URL and token | env |
| I14 | Refunds are for subscription charges only, by the owner with a reason, bounded by a guarded update plus a database CHECK, one in flight per payment (pawaPay's own rule), reserved before sending and released on failure; the invoice becomes PARTIALLY_REFUNDED or REFUNDED only when pawaPay confirms; revoking service is an explicit extra choice on a full refund | refund = revoke | section 13 | n/a |
| I15 | New merchant permissions `billing:view` (owner, manager) and `billing:manage` (owner only); platform `admin:view_subscriptions` (owner, operator, support). Writes use `admin:manage_subscriptions` (owner) except exception handling (`admin:resolve_exception`) | | see `permission-matrix.md` | n/a |

## C8. Phase 7 decisions (WhatsApp action flows, consent, localization, offline drafts, alert delivery)

All provisional, all OFF by default. Per-business flags: `consumerMessaging`, `conversationalConfirmations`, `offlineDrafts`. Platform switches: `CONSUMER_MESSAGING_ENABLED`, `OFFLINE_DRAFTS_ENABLED` (both unset).

| # | Decision | Rejected alternative | Why | Reversible by |
|---|---|---|---|---|
| J1 | Every outbound class lives in `src/messaging/registry.ts`; `docs/expansion/message-template-register.md` is GENERATED from it and a test fails when it drifts. Three kinds: ENFORCED (new, only via `sendMessage`), REPLY (a free-text answer to the registered merchant who just wrote, via the dispatcher) and LEGACY (existed before; documented, NOT subject to the new checks) | hand-written register; pretend every legacy send is checked | section 14: no new class without a registered template; honesty about what is and is not enforced | edit the registry |
| J2 | A message to a shopper needs ALL of: platform switch, the seller's `consumerMessaging` flag, a registered class, an APPROVED template, the shopper's opt-in for that seller, the number not blocked, and the seller's name in the message. Each refusal is recorded with its reason; a decision for one event is final (a suppressed event is not sent later). **Nothing is approved: no template has been created or submitted anywhere** | send first, record later | sections 14-16 | switches |
| J3 | Consent is a separate tick ("WhatsApp order updates from TradePal", exact wording versioned `order-updates-v1`) shown only when messaging is live for a seller in the basket. "The seller may contact me" is NOT consent to TradePal messages. Marketing is a separate purpose that checkout can never grant (database CHECK), and **no marketing class exists** | reuse the old tick | section 14: transaction updates and marketing are separate | n/a |
| J4 | STOP (whole message) from a non-merchant with a consent history withdraws every consent with every seller, blocks the number platform-wide and is confirmed once. START lifts only a block the person made and restores only what STOP withdrew; an operator block outlasts START; unblocking never re-opts anyone in. A STOP from a stranger with no record enters the old path unchanged | one seller only; auto-resubscribe on unblock | sections 14-16, scenario 20 | n/a |
| J5 | Window rule: shopper order updates are always sent as templates (even inside 24 hours); a free-text reply is allowed only within 24 hours of the person's own last message (a future timestamp is not a window). The opt-out confirmation is the one reply allowed to a blocked number | free text whenever convenient | WhatsApp policy | registry |
| J6 | Order updates carry the seller name and order reference only: never the order link (stored only as a hash), the handover code, an amount, or any payment or debt language. CANCELLED and EXPIRED share one message | richer updates | secrets must not travel by message; no collections | catalog |
| J7 | **Conversational confirmations (flag `conversationalConfirmations`, default OFF).** With the flag ON, every AI-read entry is previewed and saved only after YES; with it OFF, the legacy rule (auto-log at confidence >= 0.7) is UNCHANGED. This is a deliberate trade between scenario 25 (flags off = identical) and scenario 21 (nothing consequential saved silently): scenario 21 holds only for businesses with the flag on | change the default for everyone | P8; scenario 25 | flag |
| J8 | A proposal is bound by a digest over business, person, currency and the exact parsed entry; it expires in 10 minutes; a person has at most one open question (the database refuses a second) and a newer message supersedes the older, so YES only ever means the latest. At YES everything is checked again (person still active, business not suspended, digest, currency, stock tracking, quota) and the claim and the entry are ONE transaction. A duplicate delivery never proposes twice. Undo stays the existing `/undo` (a reversal) | execute at preview | master prompt confirmation rules | flag |
| J9 | A typed code (shown only in the preview) is required for suspected injection, a large amount (10x the business's largest entry, or 1,000,000 major units with little history), and an amount that is not among the digits of the message. Three wrong codes cancel | YES for everything | a reflex YES must not authorise a risky entry | thresholds in code |
| J10 | Currency: a message naming a currency other than the business's (symbol, code, word, or "old"/"new" leones) saves nothing and asks for the amount again in the business currency. **No old-to-new conversion exists anywhere** | convert | the factor and date are not ours to guess | n/a |
| J11 | Voice: the transcript is shown ("I heard: ..."), a spoken YES or code does not confirm (typing is required; a spoken NO cancels), and a transcript is never run as a slash command. Clarification: two or more stock items fit a typed name -> numbered options (asked once); a name that fits none is shown as NEW and not created until confirmed; carton/bag/dozen wording shows a unit warning | auto-pick | scenario 21 | flag |
| J12 | Offline drafts: a one-time 8-digit code (`/connect [shared]`, 10 minutes, one use, hashed) becomes a device token (hashed; 14 days, or 8 hours for a shared phone). A draft is a labelled note with a client-chosen id; syncing the same id again changes nothing; it records no money until confirmed online; prices (SKU lines), stock, totals, clock and permissions are re-checked at sync AND at confirmation; any difference is a conflict that needs an explicit accept. The page keeps its queue and token in IndexedDB (never localStorage or cookies), a service worker caches only the two shell files, logout or a 401 deletes everything, and a shared phone deletes local copies after each successful sync | cache API responses; queue silently | master prompt offline rules | switch/flag |
| J13 | Localization: a catalog (`src/i18n`) with English only, a locale registry whose statuses are SOURCE / HUMAN_REVIEWED / UNREVIEWED / MISSING, English fallback that reports `fallbackUsed`, a translation served only with a named reviewer. Krio and French are registered MISSING. Applied to Phase 7 messages only; older messages are still inline English. Coverage is a key count and is labelled unmeasured | machine-translate; invent Krio | master prompt | add reviewed text |
| J14 | AI provider failures: billing and authentication get their OWN incident title per provider (four titles); a refused alert send does not consume the dedupe window; every attempt is recorded in `AlertDelivery`; an admin "channel check" sends a labelled test; system health shows the last proven delivery and warns when none in 7 days or the latest failed. "Delivered" means the email service accepted it (a message id), NOT that it reached an inbox | email and hope | scenario 26 | n/a |
| J15 | New platform permissions: `admin:view_messaging` (owner, operator, support), `admin:manage_messaging` (owner, operator; step-up), `admin:approve_templates` (owner only; step-up). Nothing in the panel sends a message, edits a consent or deletes a record | | `permission-matrix.md` | n/a |

Open: **OPEN-13** the real template wording, languages and Meta submission (owner action; nothing is submitted); **OPEN-14** whether and when to turn `conversationalConfirmations` on by default, which depends on P9 (confidence re-measured through DeepSeek, still not done).

## D. Change log
- 2026-10-20 — register created in Phase 0; G1-G13 recorded; P1-P10 proposed; OPEN-1..11 listed.
- 2026-10-20 — Phase 1 completed on branch `expansion/phase-1`; section C2 records the provisional application of P1-P4, P10 and new admin controls.
- 2026-10-20 — Phase 2 built on branch `expansion/phase-1` (continuing the same local branch); section C3 records the Phase 2 decisions.
- 2026-10-20 — Phase 3 built on the same local branch; section C4 records the Phase 3 decisions. OPEN-6 (promotion thresholds) remains open on purpose.
- 2026-10-20 — Phase 4 built on the same local branch; section C5 records the Phase 4 decisions.
- 2026-10-20 — Phase 5 built on the same local branch; section C6 records the Phase 5 decisions; the provider matrix (sections 5) maps capabilities onto the adapter contract.
- 2026-10-20 — Phase 6 built on the same local branch; section C7 records the Phase 6 decisions; `pawapay-audit.md` section 7 records the activation status.
- 2026-10-20 — Phase 7 built on the same local branch; section C8 records the Phase 7 decisions; `message-template-register.md` records the outbound classes.
