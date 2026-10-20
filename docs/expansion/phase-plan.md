# Proposed phase plan (Phases 1-9) and owner decisions required

Date: 2026-10-20 · Phase 0 output · evidence: `PHASE_0_FINDINGS.md` "Expansion Audit"
Every phase ends at a hard stop: `AWAITING: APPROVED: PHASE <n>`. All new behaviour behind default-off flags, fully implemented before the phase is reported done.

## 1. Does Phase 0 evidence change the §21 order?

**No change to the order**, with four evidence-based adjustments to scope and one dependency flag:

1. **Phase 1 grows a DB-level protection slice** (RLS second layer + immutability triggers). Evidence: isolation and append-only exist only in the Prisma extension; production rows were deleted with raw SQL (E.6, E.14). Scenarios 18 and 29 cannot pass without it. This is the largest new item in Phase 1.
2. **Phase 1 includes the payment-purpose boundary and the `/collect` + merchant-paylink quarantine** (decisions P1, P2). Evidence: the only pawaPay code is the forbidden use; Flutterwave mixes subscription and merchant-sale purposes on one credential.
3. **Phase 1 includes country configuration consolidation** (move the hard-coded `src/config/countries.ts` list to the DB-backed `Country/CountryConfig`), because G4 says configuration, not branches.
4. **Phase 3 reorder engine is a net-new build** (no code exists); reuse limited to low-stock thresholds and the digest worker.
5. **Dependency flag for Phase 6:** pawaPay approval is pending; sandbox verification and any live step cannot start until the owner has a token and approved configuration. Code and local tests can proceed.

## 2. Slices by phase (indicative boundaries)

| Phase | Slices | Key evidence-driven risks | Gate (done means) |
|---|---|---|---|
| **1 Tenancy, permissions, config, purposes, outbox, admin core** | 1a schema: Shop, Membership, permission matrix (merchant + `PLATFORM_ADMIN` family), CountryConfiguration as single source · 1b DB protection: RLS + append-only triggers + void/reverse admin semantics · 1c `PaymentPurpose` + pawaPay/Flutterwave purpose guards + quarantine · 1d inbox/outbox reliability · 1e admin core: overview, orgs/users, flags, audit log, system health, step-up auth, support-access logging | Migration on a live DB with 4 merchants/1 transaction: rehearse on a copy; trigger/RLS must not block reversals or anonymization; `AuditLog` is empty in prod so no history to preserve | Migrations additive + rehearsed; scenarios 13, 14, 18 (partial), 27-30 green; all flags off; existing slash commands unchanged (scenario 25) |
| **2 Catalog, pricing, inventory, accounting, daily close, admin transactions panel** | 2a products/variants/units/pack conversions · 2b price lists · 2c stock model: derived on-hand, reserved, available, reservations with expiry, counts, transfers · 2d journals + posting rules (`accounting-postings.md`) · 2e daily close · 2f admin transactions panel (view, reverse, export) | Migrating `InventoryItem`/`estimatedStockQty` (mutable counter) to movement-derived stock without losing data; legacy "old money" denomination ambiguity | Scenarios 2, 3, 4, 5, 25 green |
| **3 B2B procurement/wholesale; reorder Tier 1 + Tier 2 shadow + scoring; admin reorder panel** | linked buyer/seller records, quote→PO→receipt→invoice, payables/receivables, trade-credit records; Tier 1 rules; forecast shadow + nightly scoring + audited promotion gate | Cross-tenant linking must share only agreed documents (scenario 18); forecasts will be sparse at pilot scale | Scenarios 1, 31, 32 green; demo wholesaler→retailer with simulator |
| **4 B2C storefront/checkout/fulfillment; admin support cases** | storefront routes (low-bandwidth), guest checkout with expiring tokens, reservations, pickup/delivery, returns/refund requests, multi-seller baskets | Shared-number WhatsApp model needs explicit shop context in links; "TradePal only replies to merchants" copy must change first | Scenarios 10, 18, 19 green |
| **5 Merchant-provider adapters, marketplace, moderation; admin payments + moderation panels** | adapter contract, simulator, intent/attempt/allocation/refund/settlement, exception queue, callback inbox; marketplace discovery + reports + suspension | **No provider is established** (matrix); live checkout stays unavailable; manual evidence-labelled payments only | Scenarios 7-12, 23, 24 green; matrix complete (confirmed/conditional/unknown) |
| **6 pawaPay subscriptions + entitlements; admin subscriptions panel** | plan versions + country prices, billing invoices/attempts, idempotent period allocation, grace/expiry matrix, subscription-only refunds, RFC 9421 callback verification | pawaPay approval/token pending; Flutterwave subscription path to be reconciled (OPEN-2) | Scenarios 15, 16 green; activation checklist complete; **still disabled in production** |
| **7 WhatsApp action flows, AI clarification, consent register, localization, offline drafts; admin messaging panel** | bound confirmations (P8), clarification dialogue, consumer consent + opt-out, template register, localization framework (English only; no invented dialect strings), offline draft queue | New outbound classes need approved templates and consent; AI calibration on the DeepSeek provider (P9) | Scenarios 6, 17, 20, 21, 26 green; template register complete; consumer messaging flag off |
| **8 Reports, performance, security, migration rehearsal** | AR/AP aging, inventory valuation, margin with completeness warnings, formula-safe CSV; low-end-device perf budgets; admin-route penetration checks; full migration rehearsal | Profit labelling ("Net" today = sales − expenses) | Scenario 22 green; perf baselines recorded |
| **9 Release package** | runbooks, demo (wholesaler → retailer → consumer → simulated merchant payment → fulfilment → reports; separate pawaPay subscription renewal in sandbox), handoff | none new | All §22 deliverables; each requirement classified per §0.11 |

## 3. Owner decisions required before Phase 1

| # | Decision / action | Type |
|---|---|---|
| 1 | Approve quarantining pawaPay `/collect` (P1) | decision |
| 2 | Flutterwave's role; keep merchant paylinks quarantined until settlement exists (P2, OPEN-2) | decision |
| 3 | Approve DB-level protection (RLS + immutability triggers) in Phase 1 (P3) | decision |
| 4 | Approve Shop/Membership direction (P4) | decision |
| 5 | Approve the one-line path-quoting fix in `tests/helpers/db.ts` (P10) as pre-Phase-1 hygiene | decision |
| 6 | Set up an external heartbeat / dead-man's switch (e.g. an uptime monitor on `/` that alerts to a second channel) | **owner action** |
| 7 | Verify a sending domain for alerts and add a second recipient (today: `onboarding@resend.dev` → one address) | **owner action** |
| 8 | Relink the Railway CLI for the new repo location (local config only; the CLI now resolves this folder to the empty "Desktop" project) | **owner action** |
| 9 | Provide pawaPay status/token when approved; no sandbox verification is possible before then | **owner action** |

## 4. What Phase 0 did *not* do
No migrations, dependency changes, config edits, secret reads, production writes, provider-dashboard changes, or messages to anyone. Production access was read-only (counts, env-var names). Files written: `PHASE_0_FINDINGS.md` (appended), `docs/expansion/*`.
