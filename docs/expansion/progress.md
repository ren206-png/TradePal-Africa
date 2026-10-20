# Progress — B2B + B2C expansion

Resume from this file across sessions. Update after every slice.

## Current state
- **Phase 0: approved. Phase 1: approved** (`APPROVED: PHASE 1` received).
- **Phase 2 (catalog, pricing, stock, journals, daily close, admin transactions panel): complete, awaiting approval.** Gate line: `AWAITING: APPROVED: PHASE 2`.
- Branch `expansion/phase-1` (local only: **not pushed, not merged, nothing deployed, no migration run against any real database**). A push to `main` would deploy production and run `prisma migrate deploy`.
- Tests: backend 75 files / 879 pass; admin-frontend 7 files / 36 pass + build OK. Self-check: `self-check-phase-2.md`.
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

## Commands run (reproducible)
- `git log --oneline | head`, `git show --stat dfe8bb6`
- `python3 -c "import json;…package.json…"`, `grep` over `prisma/schema.prisma`, `src/**`, `prisma/migrations/**`
- Production read-only SQL over `DATABASE_PUBLIC_URL` (read at run time, never printed): counts on `AiParseLog`, `AiUsageLedger`, `WebhookEvent`, `FeatureFlag`, `Plan`, `Subscription`, `Invoice`, `PaymentRequest`, `PawaPayDeposit`, `AuditLog`, `AdminUser`
- `railway variables -p <project> -e production --service <name> --kv | cut -d= -f1` (names only)
- Provider docs fetched 2026-10-20 (URLs in `merchant-provider-matrix.md`)

## Open blockers
1. **Migration rehearsal on a real Postgres / restored backup** before any deploy (`scripts/rehearseMigrations.sh`; no Postgres or Docker daemon was available in this environment).
2. Owner decisions OPEN-1..11 and Phase 2 decisions D1-D12 (`decisions.md` C3), especially: keep `dailyClose` OFF; web/PWA catalog editing deferred.
3. Owner actions: external heartbeat monitor polling `/heartbeat`; verified alert sender + second recipient; Railway CLI relink; pawaPay approval/token; mobile-money API approval.
4. No merchant-sales payment provider established (matrix).
5. Known gaps: no scheduled drift/reconcile checks; support access gates only some routes (Phase 1 list + new panels); RLS not activated; FOR UPDATE contention untested on a real server.

## Next concrete step
On `APPROVED: PHASE 2`: start Phase 3 (B2B procurement and wholesale slice, reorder engine Tier 1 + Tier 2 shadow + scoring job, admin reorder panel). Before any deploy of Phase 1-2 work: rehearse the migrations on a restored production backup.
