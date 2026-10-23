# Status matrix: every requirement classified (master prompt section 0.11)

Levels, in increasing strength, **not interchangeable**: `implemented` (code exists) -> `locally tested` (automated tests pass in this repository against the in-process test database and our own simulator/fakes) -> `sandbox verified` (run against the provider's real sandbox) -> `partner approved` (the provider/Meta/regulator has approved it) -> `production configured` (set up in production) -> `production activated` (live for real users). `not built` means it does not exist.

**Nothing in the expansion is above `locally tested`** (since 2026-10-20 "locally tested" includes a full run on a real local PostgreSQL 18, serially; see `test-evidence.md`). No sandbox exists for any provider; no template, provider or partner approval has been obtained; nothing is configured or activated in production. The only items at `production activated` are the pre-expansion WhatsApp features that were already live, which the expansion leaves unchanged behind OFF flags (scenario 25). Evidence column names the tests; limits are in the self-check of the phase that built it.

## A. Foundations

| Requirement | Status | Evidence / limit |
|---|---|---|
| Existing WhatsApp onboarding, commands, AI parsing, debts, stock tracking, digest, staff, deletion, monitoring unchanged with all flags off | production activated (pre-existing) + locally tested (regression) | full pre-expansion suite; `migrationRehearsal.test.ts` |
| Tenant isolation: tenant-scoped client, memberships, permission matrices (merchant + platform) | locally tested | `permissions`, `memberships`, `securityAdminRoutes` tests |
| Row-level security policies on tenant tables | locally tested under a test role | **inert in production** until the non-owner-role step; not production configured |
| Append-only / no-delete / no-truncate DB protection; synthetic-only hard delete | locally tested (PGlite) | `dbProtection.test.ts`; real Postgres privileges unverified |
| Transactional outbox and durable callback inbox; dead-letter replay | locally tested | `outboxInbox.test.ts`; concurrency on PGlite only |
| Payment purpose boundary (pawaPay = subscriptions only; merchant routes cannot reach it) | locally tested | `purposeBoundary`, `paymentsLifecycle` |
| Country configuration single source | locally tested | `countryRegistry.test.ts`; `country-configuration-guide.md` |
| Migrations additive and rehearsed on legacy data | locally tested (PGlite) | `migrationRehearsal.test.ts`; **real-server rehearsal not done** |
| All new behaviour behind default-OFF flags | locally tested | flag-off assertions in each suite; `migrationRehearsal` checks no flag ON |

## B. Merchant operating system

| Requirement | Status | Evidence / limit |
|---|---|---|
| Catalog, units, pack conversions, aliases | locally tested | `catalogPricing` |
| Price lists, quantity breaks, validity, deterministic resolution | locally tested | `catalogPricing` |
| One stock system: movements, buckets, reservations with expiry, counts, transfers, costing | locally tested | `stockV2`; real lock interleaving unverified |
| Balanced journals, posting rules, reversals | locally tested | `accounting` |
| Daily close | locally tested | OFF by default; **may be enabled per business** (the first close is a starting count, not a comparison); see `decisions-final.md` section 9 |
| Admin transactions panel: view, void/reverse, export | locally tested | `adminTransactions` |
| Bookkeeping reports (sales, cash flow, valuation, AR/AP aging, gross margin, payment reconciliation, stock discrepancies) | locally tested | `reports`, `reportsWeb`; not checked by an accountant; depends on journals/stock costs |
| Formula-safe CSV exports | locally tested | `reports`, `adminTransactions` |
| Tax-category infrastructure; multi-currency reporting | **not built** | exports only; one currency per report, no FX (by design) |
| Statement import | **not built** | SMS forwarding (pre-existing) is unchanged |

## C. B2B

| Requirement | Status | Evidence / limit |
|---|---|---|
| Linked buyer/seller records, shared price list, quote -> order -> shipment -> receipt -> invoice, partial fulfilment | locally tested | `tradeFlow`, `tradeRules` |
| Receivables/payables, partial payments, credit notes, seller-recorded trade credit (no lending, no scoring) | locally tested | `tradeRules` |
| Reorder Tier 1 (deterministic, draft only) | locally tested | `reorderTier1` |
| Forecasting Tier 2 in shadow mode, scoring, audited promotion gate | locally tested | `forecast`; **real-data accuracy unknown** |

## D. B2C and marketplace

| Requirement | Status | Evidence / limit |
|---|---|---|
| Storefront: catalogue, basket split per seller, checkout with stock holds, pickup/delivery, hand-over code, returns, refunds, held payments, support cases | locally tested | `storeCheckout`, `storeOrders`, `storefrontWeb`; low-end device behaviour unmeasured |
| Nothing a shopper sees leaks cost, stock counts, tenant ids; token-only order access | locally tested | `storefrontWeb`, `securityPublic` |
| Online payment for shop orders | locally tested **with the simulator only** | **no real provider is connected**; refused in production |
| Merchant-provider adapter contract, intents/attempts/allocations/refunds/settlements, reconciliation, outage circuit | locally tested | `paymentsLifecycle`; the provider decision is open |
| A real merchant-sales provider | **not built** | provider not established (`merchant-provider-matrix.md`) |
| Marketplace discovery, reports, moderation, appeals, suspension | locally tested | `marketplace`, `adminModeration` |
| Shopper messages (order updates) | locally tested | `messaging`; **no template exists or is approved**, nothing ever sent |

## E. Platform billing

| Requirement | Status | Evidence / limit |
|---|---|---|
| Versioned plans with country prices; no default prices | locally tested | `billingRenewal` |
| pawaPay renewal (customer-authorised), callbacks verified (RFC 9421), authenticated status lookup, idempotent allocation, refunds | locally tested **against an in-memory fake** | **sandbox not run; real callback never seen**; `sandbox-verification.md` |
| Entitlement matrix with grace/expiry/suspension; servicing never gated | locally tested | `billingEntitlements`; **OFF; OPEN-12 undecided** |
| Existing Flutterwave subscription path | production activated (pre-existing) | OPEN-2: two billing paths coexist |

## F. Messaging and AI

| Requirement | Status | Evidence / limit |
|---|---|---|
| Message class registry and generated template register | locally tested | `messaging` |
| Consent register; opt-in/out; platform block list; windows; business identity | locally tested | `messaging`; no double opt-in (OPEN-15) |
| Bound confirmations, guards, clarification, voice rules | locally tested (flag, default OFF) | `conversation`; legacy auto-log remains for businesses without the flag |
| AI provider billing/auth alerts with own titles; verified delivery record; channel check | locally tested | `aiFailureAlerts`; "delivered" = accepted by the email service |
| Offline drafts (sessions, idempotent sync, revalidation, shell-only service worker) | locally tested; also exercised by hand in Chrome | `offlineDrafts`; never on a real phone |
| Localization framework | implemented (English only) | `messaging`; no other language has any text |

## G. Admin console (section 18), 12 panels

| Panel / control | Status | Limit |
|---|---|---|
| Overview; Organizations; Feature flags; Transactions and orders; Payments; Subscriptions; Listings and moderation; Messaging and consent; Reorder and forecasting; Support cases; Audit log; System health | locally tested; every panel populated by the demo and viewed in a real browser against the demo data | `demoRelease.test.ts` |
| Step-up for every write; reasons; audit with correlation id; support access logging | locally tested (flags default OFF) | step-up flag OFF by default |
| Pause/resume a job class; synthetic incident; revoke phone sessions | locally tested | added in Phase 9 |
| Disable an admin account | locally tested (script only, no screen) | |
| Soft-delete + anonymize an organization; force password reset; hard-delete of a synthetic org from the console; "re-run reconciliation" button | **not built** | DB permits synthetic hard delete; deletion-request flow exists for merchants |
| Admin-route and public-surface penetration checks | locally tested (automated) | no human pen test, no dependency audit |

## H. Operations and release

| Requirement | Status | Evidence / limit |
|---|---|---|
| Performance budgets enforced; baselines recorded | locally tested | **no measurement on low-end hardware or throttled networks** |
| Runbooks: environment, sandbox, production activation, rollback, reconciliation, incident | implemented (documents) | never executed end to end |
| Demo: wholesaler -> retailer -> consumer -> simulator payment -> fulfilment -> reports + subscription renewal (fake) | locally tested | `scripts/demoRelease.ts` |
| Product measurement events (section 23) | **specified, not instrumented** | `measurement-plan.md` |
| Revised truthful product/help copy | implemented (repo only; not deployed) | `product-copy.md` |

## Z. Decisions pass additions (2026-10-20) — all `locally tested`

Bulk product editing and CSV import on the phone page (`CATALOG_WEB_ENABLED` + `catalogV2`); product photos stored and served from our own address; courier tracking for delivery orders (manual courier, adapter contract, simulator, signed callbacks, polling, stuck-delivery escalation; `COURIERS_ENABLED` + `storeCourier`): **implemented and locally tested; no real courier exists**; the first daily close as a starting point (daily close can be enabled per business); Meta-compliant order-update wording. Evidence: `bulkCatalog`, `productImages`, `catalogWeb`, `courierContract`, `storeShipments`, `storeCourierCommands`, `realPostgresConcurrency`, `dailyClose`. Also: Verified (double opt-in) shopper consent; escalation of unanswered shopper requests; scheduled data-integrity checks and admin view; "re-run reconciliation" admin control (removed from "not built"); shopper-data retention (24 months); duplicate trade-payment detection; atomic credit decision; support-access gating; FREE plan includes the storefront; forecast thresholds seeded. Evidence: `escalation`, `integrity`, `retention`, `messaging`, `adminOps`, `tradeFlow`, `billingEntitlements` tests. See `decisions-final.md` and `self-check-addendum-decisions.md`.
