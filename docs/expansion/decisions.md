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

## D. Change log
- 2026-10-20 — register created in Phase 0; G1-G13 recorded; P1-P10 proposed; OPEN-1..11 listed.
