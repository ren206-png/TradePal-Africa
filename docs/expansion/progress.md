# Progress — B2B + B2C expansion

Resume from this file across sessions. Update after every slice.

## Current state
- **Phases 0, 1, 2: approved.** (`APPROVED: PHASE 2` received.)
- **Phase 3 (B2B procurement and wholesale, reorder engine Tier 1 + Tier 2 shadow + scoring + gate, admin reorder panel): complete, awaiting approval.** Gate line: `AWAITING: APPROVED: PHASE 3`.
- Branch `expansion/phase-1` (local only: **not pushed, not merged, nothing deployed, no migration run against any real database**). A push to `main` would deploy production and run `prisma migrate deploy`.
- Tests: backend 83 files / 944 pass; admin-frontend 8 files / 40 pass + build OK. Self-check: `self-check-phase-3.md`. Demo: `npx tsx scripts/demoWholesale.ts`.
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
6. Known gaps: credit-limit check not atomic under concurrent acceptance; no duplicate-payment detection; no dead-letter replay button; quotes/partial receipts/credit notes lack merchant commands; no web surface; FOR UPDATE contention untested on a real server; forecast quality unknown on real data.

## Next concrete step
On `APPROVED: PHASE 3`: start Phase 4 (B2C storefront, checkout and fulfilment on the same inventory and accounting services; admin support-cases panel). Before any deploy of Phase 1-3 work: rehearse the migrations on a restored production backup.
