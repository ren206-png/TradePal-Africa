# Final handoff: B2B + B2C expansion (Phases 0-9)

Branch `expansion/phase-1` (local only: **not pushed, not merged, nothing deployed, no migration run against any real database**). Production is untouched. Date of this handoff: 2026-10-20.

> **Update 2026-10-20 (decisions pass):** every open decision was settled on the owner's behalf in `decisions-final.md`; remaining blockers are owner actions only (provider choice, pawaPay sandbox, templates, real Postgres). Added always-on behaviour is listed in `self-check-addendum-decisions.md`.

## 1. What changed (one paragraph per area; details in the documents named)

TradePal was a WhatsApp bookkeeping bot. It is now also, behind default-OFF flags: a multi-tenant merchant operating system (shops, memberships, permission matrices, catalog, packs, price lists, one stock system with reservations and counts, balanced journals, daily close); B2B trading (linked buyer/seller, quote to order to shipment to receipt to invoice, payments, credit notes, reorder suggestions, shadow demand forecasting); a consumer storefront and marketplace (split baskets, stock holds, hand-over code, returns/refunds, held-payment exceptions, support cases, moderation); a payment layer for merchant sales (provider adapter contract, simulator, reconciliation, exceptions); pawaPay billing of TradePal's own subscriptions with versioned plans and an entitlement matrix; messaging and consent (template register, opt-in/out, enforced send pipeline, STOP/START, shopper order updates), bound confirmations for AI-read entries, offline drafts, English-only localization framework, AI-provider failure alerts with verified delivery; bookkeeping reports with completeness warnings and formula-safe CSV; and a platform admin console with 12 panels. Documents: `decisions.md` (C1-C10), `data-model.md`, `money-flow.md`, `state-transitions.md`, `accounting-postings.md`, `permission-matrix.md`, `db-protection.md`, `admin-delete-void-rules.md`, `refund-cancellation-rules.md`, `reports.md`, `message-template-register.md`, `localization.md`, `country-configuration-guide.md`, `merchant-provider-matrix.md`, `pawapay-audit.md`, `traceability.md`, `product-copy.md`.

## 2. What was validated, and at which level (full table: `status-matrix.md`)

| Level | What reached it |
|---|---|
| production activated | only the pre-expansion WhatsApp features, unchanged behind OFF flags |
| production configured / partner approved / sandbox verified | **nothing** |
| locally tested | everything the expansion built: 117 backend test files / 1273 tests, 14 admin-console files / 59 tests, a build, a release demo, a migration rehearsal on legacy data, route-table security walks, byte budgets |
| implemented only | localization (English only), runbooks and other documents, a few admin script-level controls |
| not built | see section 5 |

Evidence with real command output: `test-evidence.md`. Self-checks with the failure scenarios and what is unverified: `self-check-phase-1.md` to `self-check-phase-9.md`.

## 3. Blockers (things the expansion cannot get past without you or a third party)

1. **No merchant-sales payment provider is chosen** (OPEN-4). Without one, shop payment is the simulator, cash, or recorded-by-the-seller only. A real adapter must be built against the provider's sandbox.
2. **No pawaPay sandbox token or account approval.** Billing has only run against an in-memory fake; the callback signature code has never seen a real callback.
3. **No WhatsApp template exists or is approved.** Shopper messages are suppressed until each class has an approved template recorded in the register.
4. **No real Postgres rehearsal.** The migrations were rehearsed on an in-process database only.
5. **Product decisions:** plan prices and feature split (OPEN-5, OPEN-12), Flutterwave's future (OPEN-2), forecasting promotion thresholds (OPEN-6), seller terms (OPEN-7), tax and legal review (OPEN-8), language review (OPEN-9), double opt-in (OPEN-15), confirmations default (OPEN-14), digest wording (OPEN-17).

## 4. Exact remaining owner and provider actions (in order)

**Owner**
1. Review and decide how to merge the branch (a push to `main` deploys and migrates production).
2. Set up an external heartbeat monitor on `/heartbeat` with a second alert channel; verify the alert sender domain and add a second recipient; run the alert channel check and a synthetic incident (System health).
3. Restore a production backup into a scratch Postgres and run `scripts/rehearseMigrations.sh` (or authorise a local Postgres so it can be done here). Record timings.
4. Review the decisions in `decisions-final.md` (all OPEN items now have a decision); you still must: choose and contract the merchant-sales provider (OPEN-4), set plan prices (OPEN-5), get legal review of the seller terms and notices (OPEN-7, OPEN-8), submit the templates (OPEN-13), and run the confidence calibration (OPEN-14).
5. Assign someone to each local-review item in `country-configuration-guide.md` and to the tax/legal review (OPEN-8).
6. Have an accountant compare one real merchant's reports with their books; test the phone page on a real low-end phone over a throttled connection.
7. Deploy the landing FAQ and privacy edits **at the time** shop orders and shopper messages are activated, not before.
8. Disable any admin account that should not have access (`scripts/disableAdmin.ts`); keep `dailyClose` OFF.

**pawaPay:** sandbox account and token; enable signed callbacks and set callback URLs in the dashboard; complete the ten scenarios in `runbooks/sandbox-verification.md`; KYB/partner approval and a production token when ready.

**Meta/WhatsApp:** create and get approved the shopper order-update templates (`message-template-register.md`); record each approval in the admin console.

**Merchant-sales provider (once chosen):** sandbox, adapter, contract tests, settlement report format, refund support; then `merchant-provider-matrix.md` moves from UNKNOWN to confirmed.

## 5. Not built (recorded, not hidden)

A real merchant payment provider adapter; admin console controls to hard-delete a synthetic org, anonymize an org, force a password reset, and a "re-run reconciliation" button; tax-category infrastructure; statement import; product-measurement instrumentation (the plan is `measurement-plan.md`); acquisition-source tracking on baskets/orders; a merchant web login (reports and drafts use a phone session code); languages other than English; images on shop pages (blocked by the security headers).

## 6. How to see it working
`npx tsx scripts/demoRelease.ts` (and `--serve 4180` to open the admin console on the synthetic world: `runbooks/environment-setup.md`). It runs the whole flow, prints the numbers, and checks every admin panel is populated. It uses a simulator and an in-memory pawaPay fake: it proves the pieces work together, not that any provider will accept them.

## 7. Standing constraints honoured throughout
Nothing pushed or merged; no real migration; no credentials handled; no real-money activity; no message to any real person; no provider dashboard changed; no production access; `dailyClose` left OFF.
