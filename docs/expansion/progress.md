# Progress — B2B + B2C expansion

Resume from this file across sessions. Update after every slice.

## Current state
- **Phase 0: approved** (`APPROVED: PHASE 0` received).
- **Phase 1 (tenancy, permissions, config, purposes, outbox/inbox, DB protection, admin core): complete, awaiting approval.** Gate line: `AWAITING: APPROVED: PHASE 1`.
- Branch `expansion/phase-1` (local only: **not pushed, not merged, nothing deployed, no migration run against any real database**). A push to `main` would deploy production and run `prisma migrate deploy`.
- Tests: backend 69 files / 761 pass; admin-frontend 6 files / 32 pass + build OK. Self-check: `self-check-phase-1.md`. DB runbook: `db-protection.md`.
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

## Commands run (reproducible)
- `git log --oneline | head`, `git show --stat dfe8bb6`
- `python3 -c "import json;…package.json…"`, `grep` over `prisma/schema.prisma`, `src/**`, `prisma/migrations/**`
- Production read-only SQL over `DATABASE_PUBLIC_URL` (read at run time, never printed): counts on `AiParseLog`, `AiUsageLedger`, `WebhookEvent`, `FeatureFlag`, `Plan`, `Subscription`, `Invoice`, `PaymentRequest`, `PawaPayDeposit`, `AuditLog`, `AdminUser`
- `railway variables -p <project> -e production --service <name> --kv | cut -d= -f1` (names only)
- Provider docs fetched 2026-10-20 (URLs in `merchant-provider-matrix.md`)

## Open blockers
1. **Migration rehearsal on a copy of production** before any deploy (`db-protection.md` §5).
2. Owner decisions OPEN-1..11 (`decisions.md`); P1-P4 and P10 applied provisionally in Phase 1, awaiting confirmation.
3. Owner actions: external heartbeat monitor polling `/heartbeat`; verified alert sender + second recipient; Railway CLI relink; pawaPay approval/token; mobile-money API approval.
4. No merchant-sales payment provider established (matrix).
5. Known gaps carried to Phase 2: support access gates only invoices/payment-requests; membership drift check not scheduled; RLS not activated.

## Next concrete step
On `APPROVED: PHASE 1`: start Phase 2 (catalog, pricing, inventory, accounting, daily close, admin transactions panel). Before any deploy of Phase 1 work: rehearse the migrations on a restored production backup.
