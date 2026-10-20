# Progress — B2B + B2C expansion

Resume from this file across sessions. Update after every slice.

## Current state
- **Phase 0 (read-only audit): complete, awaiting approval.** Gate line: `AWAITING: APPROVED: PHASE 0`.
- Repo: `~/Desktop/Renco Technologies/tradepal-africa` (moved from `~/Desktop/tradepal-africa`), commit `86a072d`, working tree clean before Phase 0 (Phase 0 adds only docs; **not committed**).
- Production at `86a072d`: 4 merchants, 111 inbound events, pawaPay/Flutterwave unconfigured, expansion flags absent.

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

## Commands run (reproducible)
- `git log --oneline | head`, `git show --stat dfe8bb6`
- `python3 -c "import json;…package.json…"`, `grep` over `prisma/schema.prisma`, `src/**`, `prisma/migrations/**`
- Production read-only SQL over `DATABASE_PUBLIC_URL` (read at run time, never printed): counts on `AiParseLog`, `AiUsageLedger`, `WebhookEvent`, `FeatureFlag`, `Plan`, `Subscription`, `Invoice`, `PaymentRequest`, `PawaPayDeposit`, `AuditLog`, `AdminUser`
- `railway variables -p <project> -e production --service <name> --kv | cut -d= -f1` (names only)
- Provider docs fetched 2026-10-20 (URLs in `merchant-provider-matrix.md`)

## Open blockers
1. Owner decisions before Phase 1 (`phase-plan.md` §3 items 1-5).
2. Owner actions: external heartbeat; verified alert sender + second recipient; Railway CLI relink; pawaPay approval/token.
3. Pre-existing test-helper path defect (P10) — fix pending approval.
4. No merchant-sales payment provider established.

## Next concrete step
On `APPROVED: PHASE 0`, start Phase 1 slice 1a (schema: Shop, Membership, permission matrix) after the owner answers `phase-plan.md` §3. First action inside Phase 1: write the migration against a copy of production data and rehearse it before touching anything real.
