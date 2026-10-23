# Final decisions (made on the owner's behalf)

Date: 2026-10-20 · branch `expansion/phase-1` (local only; not pushed, not merged, nothing deployed, no real migration).

The owner asked for a pass over Phases 1-9 for anything unverified, undecided or missing, and for the best option to be chosen in each case. This document is that record. Each row has:

- **Decision**: the option chosen, and why it beat the alternatives.
- **Status**: `built` (code and tests, locally tested only), `decided` (a policy written here, no code needed), `owner action` (decided, but only the owner or a third party can carry it out) or `deferred` (decided not to do it now, with the condition that reopens it).

**Update 2026-10-20 (second pass, after the owner's answers):** Flutterwave is left alone (OPEN-2); language stays English only (OPEN-9); `dailyClose` was explained and decided (section 3); web/PWA bulk editing, product photos and courier integration were **built** (section 3); seller terms and WhatsApp templates are drafted for review in `drafts-for-review/`; a real local Postgres was used and found and fixed two real problems (section 9).

Every decision can be reversed; the "Reverse by" column says how. Nothing here activates anything: the status vocabulary of `status-matrix.md` still applies and nothing is above `locally tested`.

## 1. Open questions (OPEN-1 to OPEN-17)

| # | Question | Decision | Status | Reverse by |
|---|---|---|---|---|
| OPEN-1 | Quarantine `/collect`? | **Yes.** Merchant paylinks stay closed until a merchant-sales provider with a settlement arrangement exists | built (Phase 1) | flag |
| OPEN-2 | Flutterwave's role | **Owner decision: leave Flutterwave as it is.** Nothing is retired and no sunset date or criteria apply. Existing Flutterwave subscribers keep working; pawaPay billing is built beside it (off until its sandbox run); the two paths coexist as they do today. Merchant paylinks stay quarantined (OPEN-1). Revisit only if the owner asks | decided by the owner | owner |
| OPEN-3 | RLS + immutability triggers; Shop/Membership direction | **Approved as built.** RLS is activated in stages: policies exist but are inert until the app connects as a non-owner role; activate on a restored backup first, then a staging copy, then production, with the rehearsal script green at each step | built; owner action for activation | role switch |
| OPEN-4 | Merchant-sales provider and contracting | **Aggregator/integrator model, one contract with TradePal as the merchant of record for the integration, not one contract per shop.** Selection criteria, all required: sandbox with signed callbacks, refunds API, a settlement report in a file or API, coverage of the first two live countries, a written statement of who holds the funds, and no per-shop onboarding delay. Until one passes, shop payment stays cash/recorded/simulator | decided; owner action (choose and contract) | owner |
| OPEN-5 | Subscription prices, grace, refunds, upgrades | **Policy fixed, prices not invented.** Grace 3 days (plan-version setting). Early renewal window 14 days. No proration. A refund of a paid period never shortens it unless an admin ticks "revoke". Upgrades take effect at the next period start unless the admin schedules otherwise; downgrades likewise. Free plan: storefront only (see OPEN-12). Prices are set per country in the admin panel by the owner as a draft version, published after a second look (the "two-person" gap in the Phase 6 self-check is accepted for a one-owner company) | decided; owner action (set prices) | plan version |
| OPEN-6 | Forecast promotion thresholds | **Minimum 8 scored weeks and a 15% (1500 bps) improvement over the simple method.** Seeded by migration `20261030…` (inserts only if no row exists, so an owner-set value is never overwritten). The gate still opens only through its one function | built | admin tool |
| OPEN-7 | Seller terms, delivery responsibility, service areas, dispute process | **Seller terms drafted (section 4). The seller is responsible for the goods until hand-over and for any courier they choose; TradePal is not a party to the sale; service areas are whatever the seller lists; disputes: shopper contacts seller, then the platform support case (already built), which names a responsible party and is escalated automatically after 5 days (built).** Legal review of the wording is still the owner's | decided; owner action (legal review) | text |
| OPEN-8 | Tax rules, retention, notices, legal class | **Retention decided and built**: shopper name, phone, address and notes are removed 24 months after the last event of a finished order (`SHOPPER_DATA_RETENTION_MONTHS`, 0 turns off); amounts, items, journals and history are never touched; orders with an open request, exception or unclosed case are skipped; opt-out records are kept. **Tax**: no tax computation is offered; every report says so. **Legal classification and country notices**: need a lawyer; listed in the country guide | retention built; tax decided (not built); legal owner action | env |
| OPEN-9 | Human-reviewed language samples | **Owner decision: English only for now.** No other language is offered and no invented dialect strings exist. If other languages are wanted later, a named human reviewer signs a sample first | decided by the owner | owner |
| OPEN-10 | Heartbeat monitor, alert sender, second recipient | **Steps fixed (section 7).** Owner actions only; nothing can be done from the repository | owner action | n/a |
| OPEN-11 | Fix `tests/helpers/db.ts` | **Done** earlier (hand-written migrations are registered; drift test guards it) | built | n/a |
| OPEN-12 | Premium features per plan | **FREE = storefront only** (an expired or free business can always keep its shop open and fulfil orders). **Paid = every premium feature:** new trade orders, marketplace publishing, reorder rules. Voice, staff caps and the AI budget stay on the older plan fields for now. `subscriptionEntitlements` may be switched on only after prices exist | built | plan version |
| OPEN-13 | Template wording, languages, Meta submission | **Wording drafted (section 5)**; English first; submitted by the owner in WhatsApp Manager; each approval recorded in the admin console before the class can send | decided; owner action | text |
| OPEN-14 | `conversationalConfirmations` default | **Stays OFF by default; may be enabled per business only after the confidence calibration has been run.** The calibration needs live calls to the AI provider with the owner's key, so it was not run here. A fixed script design is in section 6 | deferred until calibration | flag |
| OPEN-15 | Double opt-in for shopper messages | **Yes, built.** Checkout tick records a claim; the shopper must send "UPDATES <code>" from the same WhatsApp number; only then can any order update be sent (`CONSENT_NOT_VERIFIED` otherwise). Consent text version v2 | built | flag |
| OPEN-16 | Real-Postgres rehearsal and device measurements | **Decided: required before any deploy.** Needs permission to run a Postgres server locally (asked in the final reply) and a real low-end phone | owner action | n/a |
| OPEN-17 | Digest wording "Net" | **Template wording stays (approved templates); the plain message uses the honest label "Sales minus expenses (not profit)" when `reportsV2` is on.** Built. Template wording changes only at the next template submission | built | flag |

## 2. Gaps found in the Phase 1-9 self-checks and what was done

| Gap | Decision | Status |
|---|---|---|
| A seller can sit on a shopper's refund/cancellation request for ever | Unanswered requests older than 5 days automatically open a platform support case (idempotent via a marker), run by the operations sweep | built |
| No scheduled check that books and stock agree | Read-only integrity checks (membership drift, unjournaled transactions, stock balance mismatch, legacy stock drift) run about every 20 hours, raise an incident on findings, and are viewable in System health | built |
| No "re-run reconciliation" admin button | Added to Payments (reason + step-up, audited), runs payment and billing reconciliation | built |
| Digest called net "Net" | See OPEN-17 | built |
| Admin write succeeded but audit row failed silently | Raises an incident ("action succeeded, audit row missing") | built |
| Expired business could not re-open its shop | Fixed with the OPEN-12 decision | built |
| Support staff could read any business detail and financial alerts | Business detail needs support access (read-only support or above); mobile-money alerts need a financial-viewer role | built |
| Credit-limit check not atomic under concurrent acceptance | Partner row is locked and credit evaluated inside the same transaction | built (locally; real interleaving unverified) |
| No duplicate-payment detection on trade invoices | Same invoice, amount and payer within 10 minutes is refused unless the user adds `anyway` | built |
| Shopper PII kept for ever | Retention sweep (OPEN-8) | built |
| Third party's number accepted at checkout | Double opt-in (OPEN-15) | built |
| Seller sat on a shopper request; a shopper learns nothing | Consumer updates exist only behind `consumerMessaging`, which stays off until a template is approved (OPEN-13) | decided |
| Stuck refund raises no exception of its own (Phase 6 F4b) | Accepted: it shows in the refunds list; the integrity and alert path will pick it up when pawaPay sandbox testing shows the real failure modes | deferred until sandbox |
| Payer pays from a different wallet than named (Phase 6 F4d) | Accepted for now; only the last four digits are kept by design | deferred |
| Real concurrency (locks, simultaneous placements) unproven | Needs a real Postgres; scripts exist (`rehearseMigrations.sh`) and the plan is in the final reply | owner action (permission) |
| Callback signature never seen a real pawaPay callback | Sandbox run is a hard gate in the activation checklist | owner action |

## 3. Deferred or not built, on purpose

| Item | Why | Reopen when |
|---|---|---|
| ~~Web/PWA bulk editing for sellers~~ | **Owner asked for it: built** (phone page + CSV), see `bulk-editing-and-photos.md` | n/a |
| Real merchant-sales provider adapter | Cannot be built without a chosen provider's sandbox (OPEN-4) | provider chosen |
| Tax-category infrastructure, statement import | No reviewed tax rules (OPEN-8) | tax review done |
| ~~Product photos on shop pages~~ | **Owner asked for it: built.** Stored in our own database and served from our own address, so no new host and no security-header change; move to object storage at scale | n/a |
| ~~Courier integration~~ | **Owner asked for it: built** as the manual courier, an adapter contract with a simulator and signed callbacks, status polling and stuck-delivery escalation, see `courier-integration.md`. **A real courier adapter cannot be built until a courier is chosen** | a courier is chosen |
| Shopper accounts, CAPTCHA | No evidence of need before pilot | abuse or demand observed |
| Languages other than English | **Owner decision: English only for now** | owner asks |
| Hard-delete / anonymize an org from the console, force password reset | Script-level controls exist; console buttons carry risk | an incident needs them |
| `dailyClose` | **Decided and made safe (see below).** Stays OFF platform-wide; the owner may switch it on for one business at a time. Built: the first close of a business is its starting point, not a comparison | built | flag |

## 4. Draft seller terms (for legal review; not published)

1. You are the seller. TradePal provides the shop software and does not sell, hold, inspect or deliver your goods.
2. List only goods you may lawfully sell, at the price shown. Keep your stock count honest; an order you cannot fulfil must be cancelled promptly.
3. You are responsible for delivery, including any courier you use, until the shopper confirms hand-over with their code.
4. Refunds and returns follow the rules shown on your order pages. You decide a shopper's request within 5 days; after that TradePal may open a support case and ask you to act.
5. Payments you record are your own records. TradePal does not guarantee a mobile-money payment that has not been confirmed by the provider.
6. You may not use the shop to collect personal data beyond what an order needs. Shopper personal details are deleted from finished orders after 24 months.
7. TradePal may suspend a shop for fraud, repeated unfulfilled orders or unlawful goods, and will tell you why.
8. These terms are a draft and must be reviewed by a lawyer in each country before use.

## 5. Draft WhatsApp template submission pack (owner submits; nothing sent)

English only, utility category, no marketing wording, no profit/"code" jargon. Variables in braces. One per class in `message-template-register.md`:

- **Order received**: "Hi {1}, {2} received your order {3}. We will update you here."
- **Order confirmed / ready / dispatched / handed over / cancelled / refund recorded / request decided**: one short line each, naming the seller, the order reference and the status, never a price breakdown.
- **Weekly digest**: "Your week at {1}: sales {2}, expenses {3}. Sales minus expenses (not profit): {4}."
- **Shopper opt-in** needs no template: it is a reply inside the 24-hour window to the shopper's own "UPDATES <code>" message.

Each approval is recorded in the admin console before the corresponding class may send; until then sends are suppressed and logged.

## 6. Procedures and criteria

**Confidence calibration (OPEN-14).** Collect at least 300 real parsed messages with the user's final answer; bucket the model's confidence into deciles; report accuracy per bucket and the lowest threshold with at least 95% accuracy. Enable `conversationalConfirmations` for a business only if the threshold is at most 0.9; otherwise keep it off. The script is not written here because running it needs the owner's AI key and real messages.

**Flutterwave (OPEN-2).** Left as it is, by the owner's decision. No sunset criteria apply.

**Provider selection (OPEN-4).** Criteria in the OPEN-4 row; evaluate at most three providers; score pass/fail; no provider is wired until its sandbox passes the contract tests.

**Plan-version pricing policy (OPEN-5).** Price per country in local currency in whole minor units; changing a price creates a new version, never edits one; existing subscribers keep their version until renewal; a version is published only after it has been viewed on the plans page by the owner.

**Language (OPEN-9).** English only, by the owner's decision.

## 7. Activation order (owner steps)

1. Heartbeat monitor on `/heartbeat` with a second alert channel; verify the alert sender domain and add a second recipient; run the channel check and a synthetic incident.
2. Run `scripts/rehearseMigrations.sh` on a restored backup (or on a local Postgres, with permission).
3. Set `OPERATIONS_SWEEP_ENABLED=true`, `OUTBOX_SWEEP_ENABLED=true`, `TRUST_PROXY`, `HEARTBEAT_ENABLED`, `RATE_LIMIT_BACKEND`.
4. Merge the branch only after steps 1-3; a push to `main` deploys and migrates.
5. Enable features one business at a time, starting with the owner's own test business: storefront, then consumerMessaging (after template approval), then billing (after sandbox). `dailyClose` is per business and optional (section 9).
6. RLS: switch the app to the non-owner role last, on staging first.

## 8. New always-on behaviour introduced by these decisions

These run without a flag, so they are listed in `self-check-addendum-decisions.md` with their failure modes: escalation of unanswered requests, scheduled integrity checks, shopper-data retention, support-access gating on business detail, the FREE plan including the storefront, the forecast thresholds migration, duplicate trade-payment detection, the credit lock, and the verified-consent requirement (a shopper update is suppressed until verified, but it was already suppressed while `consumerMessaging` is off).

## 9. Second pass (2026-10-20, after the owner's answers)

**`dailyClose`, in plain words.** "Daily close" is the end-of-day cash count: the owner counts the money in the till and TradePal compares it with what its records say should be there, and records any difference with a reason. The trouble was that older entries do not say whether a sale was cash or mobile money, so TradePal would wrongly say "you are short" on day one. **Decision:** keep it OFF everywhere by default, but make it safe to switch on for one business at a time. **The first close of a business is its starting point, not a comparison**: the owner counts the drawer, that count becomes the opening cash (no reason needed), and from the second close on TradePal compares. Switch it on for a business only when (a) that business has `accountingJournals` on and has been logging sales with a payment method, and (b) the owner has been told the first close is just a starting count. Built and tested (`dailyClose.test.ts`, `operationsCommands.test.ts`).

**Built on the owner's request:** bulk product editing and CSV (`bulk-editing-and-photos.md`), product photos (same document), courier tracking (`courier-integration.md`). All default OFF behind their own switches (`CATALOG_WEB_ENABLED` + `catalogV2`; `COURIERS_ENABLED` + `storeCourier`).

**A real Postgres was used (permission given).** The full suite (1,340 tests including 7 that only run on a real server) passes on PostgreSQL 18, run serially, as does the legacy-data migration rehearsal as a non-superuser owner. It found and the team fixed: (1) **two commits for one AI-usage request could both be recorded** (a check done before the lock instead of after; fixed for commit and release); (2) **simultaneous orders for one seller made most shoppers see "try again"** (order numbers are now allocated one placement at a time per seller; 10 of 10 succeed). Reasoning about concurrency afterwards closed three more races before they could happen: more than 6 photos or a duplicate photo from simultaneous uploads, the same bulk-edit batch applied twice, and two courier bookings for one order. Each has a test that **fails without its lock** (checked by removing the lock). The rest were test-environment differences (clock rounding, equal timestamps, keep-alive sockets), recorded in `test-evidence.md`.

**Drafts for the owner's review:** `drafts-for-review/seller-terms.md` and `drafts-for-review/whatsapp-templates.md`. The four shopper order-update messages were reworded so Meta will accept them (a template may not start with a variable); the register was regenerated.
