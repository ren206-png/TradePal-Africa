# Progress — B2B + B2C expansion

Resume from this file across sessions. Update after every slice.

## Current state
- **Phases 0, 1, 2: approved.** (`APPROVED: PHASE 2` received.)
- **Phase 3: approved.** (`APPROVED: PHASE 3` received.)
- **Phase 4: approved.** (`APPROVED: PHASE 4` received.)
- **Phase 5: approved.** (`APPROVED: PHASE 5` received.)
- **Phase 6: approved.** (`APPROVED: PHASE 6` received.)
- **Phase 7 (WhatsApp action flows, AI clarification, consent register, localization framework, offline drafts; admin messaging and consent panel): complete, awaiting approval; everything OFF by default.** Gate line: `AWAITING: APPROVED: PHASE 7`.
- Branch `expansion/phase-1` (local only: **not pushed, not merged, nothing deployed, no migration run against any real database**). A push to `main` would deploy production and run `prisma migrate deploy`.
- Tests: backend 105 files / 1183 pass; admin-frontend 13 files / 57 pass + build OK. Self-check: `self-check-phase-7.md`. Demo (Phase 3): `npx tsx scripts/demoWholesale.ts`.
- Production at `86a072d`, untouched.

## Completed slices
| Date | Slice | Result |
|---|---|---|
| 2026-10-20 | Stack + known-facts verification | done; findings E.1-E.2 |
| 2026-10-20 | Production health gate | done; E.3 (AI funded, alerts set, **no external heartbeat**) |
| 2026-10-20 | Capability matrix, data-model mapping, tenancy/ledger/payments/WhatsApp/admin audits | done; E.4-E.12 |
| 2026-10-20 | Baseline tests | `npx tsc --noEmit -p .` exit 0; `npx vitest run` (space-free copy) **61 files / 677 tests pass**; `admin-frontend` `npx vitest run` 5 files / 26 tests pass. In-place run from the spaced path fails (pre-existing defect `tests/helpers/db.ts:14-15`). |
| 2026-10-20 | pawaPay audit + activation checklist | `docs/expansion/pawapay-audit.md` |
| 2026-10-20 | Provider matrix draft | `docs/expansion/merchant-provider-matrix.md` (documentation-based; no provider established) |
| 2026-10-20 | Decisions seeded, phase plan proposed | `decisions.md`, `phase-plan.md` |

| 2026-10-20 | 1c payment-purpose boundary + `/collect`/paylink quarantine | locally tested (scenarios 13, 14) |
| 2026-10-20 | 1b DB protection: append-only/delete/TRUNCATE triggers, synthetic-only hard delete, RLS policies, migration drift guard | locally tested (PGlite); not rehearsed on a production copy; RLS inert in prod until role step |
| 2026-10-20 | 1a permissions matrices (merchant + platform incl. OPERATOR), Shop/Membership/ActiveContext + backfill, country registry (DB, static fallback) | locally tested |
| 2026-10-20 | 1d transactional outbox + durable callback inbox (sweep OFF by default, no handlers yet) | locally tested; concurrent claim unproven on PGlite |
| 2026-10-20 | 1e admin core: platform permissions, step-up, support access (append-only), overview, system health, heartbeat + `/heartbeat`, admin frontend pages + prompts, audit gaps closed | locally tested; step-up and support-access flags default OFF |
| 2026-10-20 | 2a catalog, packs, price lists, rounding | locally tested (scenario 3) |
| 2026-10-20 | 2b stock: movements, balances, reservations, counts, transfers, costing, legacy bridge | locally tested (scenario 2; real lock interleaving unverified) |
| 2026-10-20 | 2c journals (DB-enforced balance), posting rules, legacy bridge | locally tested (scenarios 4, 5, 25) |
| 2026-10-20 | 2d daily close | locally tested; do not enable for real merchants yet (no payment method in legacy entries) |
| 2026-10-20 | 2e admin transactions panel, void-by-reversal, formula-safe export, correlation ids, `admin.write` audit guarantee | locally tested (scenarios 28, 30) |
| 2026-10-20 | 2f WhatsApp commands behind flags, docs, rehearsal script | locally tested; script never run against a DB |
| 2026-10-20 | 3a trade schema + migration (partners, links, orders, shipments, receipts, invoices, payments, credit notes, reorder, forecasts, gate) | locally tested; migration not run on a real server |
| 2026-10-20 | 3b trade domain: linking, shared catalog, order lifecycle with quotes/holds/expiry, shipments, receipts, invoices, credit notes, payments, credit rules, simulator, outbox mirror handlers | locally tested (scenario 1) |
| 2026-10-20 | 3c reorder Tier 1 | locally tested (scenario 31) |
| 2026-10-20 | 3d Tier 2 shadow forecasting, scoring, promotion gate with DB guard | locally tested (scenario 32); real-data accuracy unknown |
| 2026-10-20 | 3e merchant commands, operations sweep, permissions | locally tested; sweeps default off |
| 2026-10-20 | 3f admin reorder and forecasting panel, trade views, demo, docs | locally tested |
| 2026-10-20 | 4a storefront schema + migration (12 tenant tables, Basket/BasketLine, flags OFF) | locally tested; migration not run on a real server |
| 2026-10-20 | 4b store domain: storefront set-up, public catalog projection, basket split, checkout with stock holds, lifecycle, payments + exceptions, refunds/returns, support cases | locally tested (scenarios 10, 18, 2) |
| 2026-10-20 | 4c public web layer: server-rendered, no JS, cookie basket, secret order links, Origin check, rate limits, escaping, size budget | locally tested (scenario 19) |
| 2026-10-20 | 4d admin: support cases, payment exceptions, store orders view, overview counts, `admin:view_support_cases` | locally tested |
| 2026-10-20 | 4e seller `/store` commands, `store:*` permissions, expiry sweep | locally tested; sweeps default off |
| 2026-10-20 | 5a schema + migration (payments, settlement, exceptions, marketplace moderation; two existing tables gain columns) | locally tested; migration not run on a real server |
| 2026-10-20 | 5b adapter contract, simulator adapter, intent/attempt/outcome/refund/settlement domain; B2B and consumer payments moved onto it; webhook route | locally tested (scenarios 7-14); no real provider exists to test against |
| 2026-10-20 | 5c reconciliation sweep, outage circuit, provider-aware refunds in `/store` | locally tested (scenario 23); sweeps default off |
| 2026-10-20 | 5d marketplace discovery, reports, moderation, appeals, public pages, seller commands | locally tested (scenario 24) |
| 2026-10-20 | 5e admin payments/exceptions and listings/moderation panels, permissions, overview counts | locally tested |
| 2026-10-20 | 6a schema + migration (plan versions/prices, billing attempts/allocations/refunds, entitlement history, exceptions, switches, signing keys; columns added to Invoice and Subscription) | locally tested; migration not run on a real server |
| 2026-10-20 | 6b pawaPay client additions + RFC 9421 callback verification + key cache | locally tested (self-generated vectors; not verified against pawaPay) |
| 2026-10-20 | 6c versioned plans, customer-authorised renewal, authenticated allocation, reconciliation, refunds (invoice and held payments), cancellation, scheduled plan change | locally tested (scenario 15) against an in-memory pawaPay fake |
| 2026-10-20 | 6d entitlement matrix, grace/expiry, security suspension, call-site gates | locally tested (scenario 16) |
| 2026-10-20 | 6e owner commands, admin subscriptions panel, permissions, sweep, signed billing webhook | locally tested; everything OFF by default |

| 2026-10-20 | 7a schema + migration (templates, consent register and events, block list, outbound log, pending actions, device sessions, offline drafts, alert delivery; 3 flags OFF) | locally tested; migration not run on a real server |
| 2026-10-20 | 7b localization framework (English only; Krio and French registered MISSING) | locally tested |
| 2026-10-20 | 7c message class registry, generated template register, consent register, enforced send pipeline, shopper order updates, STOP/START, checkout tick, website notice | locally tested (scenario 20); no template approved, nothing sent to anyone |
| 2026-10-20 | 7d conversational confirmations: bound proposals, guards, clarification, voice rules | locally tested (scenarios 6, 21) for businesses with the flag ON |
| 2026-10-20 | 7e offline drafts: `/connect`, device sessions, idempotent sync, revalidation, shell-only service worker page | locally tested (scenario 17); page never run on a real phone |
| 2026-10-20 | 7f AI provider failure classification, verified alert delivery record, channel check | locally tested (scenario 26) |
| 2026-10-20 | 7g admin messaging and consent panel, permissions | locally tested |

## Commands run (reproducible)
- `git log --oneline | head`, `git show --stat dfe8bb6`
- `python3 -c "import json;…package.json…"`, `grep` over `prisma/schema.prisma`, `src/**`, `prisma/migrations/**`
- Production read-only SQL over `DATABASE_PUBLIC_URL` (read at run time, never printed): counts on `AiParseLog`, `AiUsageLedger`, `WebhookEvent`, `FeatureFlag`, `Plan`, `Subscription`, `Invoice`, `PaymentRequest`, `PawaPayDeposit`, `AuditLog`, `AdminUser`
- `railway variables -p <project> -e production --service <name> --kv | cut -d= -f1` (names only)
- Provider docs fetched 2026-10-20 (URLs in `merchant-provider-matrix.md`)

## Open blockers
1. **Migration rehearsal on a real Postgres / restored backup** before any deploy (`scripts/rehearseMigrations.sh`; still never run against a database).
2. Owner decisions OPEN-1..11 (**OPEN-6 promotion thresholds unset on purpose**), Phase 2 decisions D1-D12 and Phase 3 decisions E1-E15 (`decisions.md`); keep `dailyClose` OFF.
3. Activation prerequisites to add to the checklist: `OUTBOX_SWEEP_ENABLED=true`, `OPERATIONS_SWEEP_ENABLED=true`, `HEARTBEAT_ENABLED` on both services.
4. Owner actions: external heartbeat monitor; verified alert sender + second recipient; Railway CLI relink; pawaPay approval/token; mobile-money API approval.
5. No merchant-sales payment provider established (simulator only).
6a. Phase 7 known gaps: see `self-check-phase-7.md` (no template approved or submitted; conversational confirmations are per-business and the legacy auto-log remains for everyone else; the offline page never ran on a real phone; alert delivery means accepted by the email service).
6. Phase 6 known gaps: no pawaPay token or sandbox exists, so everything is proven only against an in-memory fake; callback signature verification never saw a real callback; OPEN-12 (plan features) undecided so entitlements must stay off; two subscription billing paths coexist (OPEN-2); real concurrency and a real Postgres unverified; sweeps must be on or callbacks and lost payments are never processed.
7. Phase 5 known gaps: no real provider (the provider decision blocks the real adapter); everything provider-side was the simulator's behaviour; real concurrency, a real Postgres and a real callback format are unverified; refunds of B2B invoice payments are not supported through the provider; settlement is not netted against later refunds; no seller identity verification; marketplace search is capped at 300 candidates; callbacks and reconciliation need the sweeps on.
8. Phase 4 known gaps: no courier integration; no outbound messages to shoppers (Phase 7); online payment is the simulator only (real provider Phase 5); no marketplace discovery or moderation (Phase 5); a shopper who loses the order link cannot look the order up; low-end-device measurements are Phase 8; the web layer was exercised with supertest, not on real phones.
9. Known gaps: credit-limit check not atomic under concurrent acceptance; no duplicate-payment detection; no dead-letter replay button; quotes/partial receipts/credit notes lack merchant commands; no web surface; FOR UPDATE contention untested on a real server; forecast quality unknown on real data.

## Next concrete step
On `APPROVED: PHASE 7`: start Phase 8 (per the master prompt). Before any deploy of Phase 1-7 work: rehearse the migrations on a restored production backup; add to the activation checklist `CONSUMER_MESSAGING_ENABLED`, `OFFLINE_DRAFTS_ENABLED`, `OFFLINE_PUBLIC_URL`, `MESSAGING_LOG_PEPPER`, `STOREFRONT_ENABLED`, `OPERATIONS_SWEEP_ENABLED`, `OUTBOX_SWEEP_ENABLED`, `TRUST_PROXY`, Redis rate limiting and `HEARTBEAT_ENABLED`. Keep `dailyClose` OFF.
