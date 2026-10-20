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

## D. Change log
- 2026-10-20 — register created in Phase 0; G1-G13 recorded; P1-P10 proposed; OPEN-1..11 listed.
- 2026-10-20 — Phase 1 completed on branch `expansion/phase-1`; section C2 records the provisional application of P1-P4, P10 and new admin controls.
- 2026-10-20 — Phase 2 built on branch `expansion/phase-1` (continuing the same local branch); section C3 records the Phase 2 decisions.
- 2026-10-20 — Phase 3 built on the same local branch; section C4 records the Phase 3 decisions. OPEN-6 (promotion thresholds) remains open on purpose.
