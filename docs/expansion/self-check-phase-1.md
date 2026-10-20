# Phase 1 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (not pushed, not merged, nothing deployed) · status vocabulary per master prompt §0.11.

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| `npx vitest run` (backend, in place, path with spaces) | **69 files / 761 tests pass** (baseline before Phase 1: 61 / 677) |
| `admin-frontend`: `npx vitest run` | 6 files / 32 tests pass; `npm run build` succeeds |
| Known flake | `tests/inventory.test.ts` race test can fail under full-suite load; passes alone. Pre-existing. |

All Phase 1 behaviour is **implemented** and **locally tested**. Nothing is sandbox-verified, partner-approved, production-configured or production-activated.

## 1. Failure scenarios (what could go wrong, evidence, what is still unproven)

### F1. A migration fails or half-applies on the real Railway database
- **Why plausible:** the migrations create functions, triggers, enable RLS, add enum values and backfill. Tests run on PGlite as a superuser, so a privilege problem on Railway's role cannot show up locally.
- **Mitigation present:** Railway's pre-deploy runs `prisma migrate deploy`; a failure blocks the deploy (fails closed). Backfill is idempotent. Drift test proves migrations ≡ schema.
- **Unproven:** never run against a copy of production. **Required before any deploy** (runbook `db-protection.md` §5).

### F2. A real code path now throws because a database trigger refuses its UPDATE/DELETE
- **Why plausible:** append-only/delete protection applies to the owner role too, and is live the moment the migration runs, with no flag.
- **Evidence it is covered:** full suite green with protection ON by default; static search of `src/` finds exactly one delete on a protected model (`messageDispatcher.ts:885`, abandoned onboarding, no financial trail, explicitly allowed) and **no** `update`/`upsert` on append-only models and no raw `UPDATE`/`DELETE` SQL. `/undo` inserts a reversal.
- **Unproven:** paths that only run in production (scheduled jobs against real data volumes) and any manual operator SQL. A refused write surfaces as a 500/failed job, not silent corruption.

### F3. A provider callback is processed twice, or lost
- **Evidence:** `CallbackInbox` has a unique `(provider, externalId)` and `recordCallback` uses `ON CONFLICT DO NOTHING` (duplicate test); failed handlers back off, then dead-letter and raise an incident; dead items replay by an explicit call. A `PROCESSED` row is immutable (trigger).
- **Unproven:** true concurrent claiming. `FOR UPDATE SKIP LOCKED` is written, but PGlite is single-session, so two workers racing for the same row was **not exercised**. Also: no real handler is registered yet (registries are empty), so no business event flows through this today. With `OUTBOX_SWEEP_ENABLED` off (default) nothing is processed at all.
- **Behaviour to know:** an event with no handler is retried and then dead-lettered (it is never silently dropped or marked published).

### F4. Step-up or support-access can be bypassed
- **Step-up token theft/replay:** token is signed with a derived key (cannot be used as an access token, and vice versa), bound to the admin id and the access token's `jti`, 5-minute TTL; wrong password is audited and rate-limited (tested). Needs the access token too, which logout revokes.
- **Real gap, support access covers only two routes:** `GET /businesses/:id/invoices` and `/payment-requests` are gated. **Not gated:** `GET /businesses/:id` (merchant phone numbers, subscriptions), `GET /mobile-money-alerts` (amounts), `GET /audit-logs` (metadata). With the flag on, an ANALYST can still read those. Recommended: gate them in Phase 2 when the admin transactions panel lands; left out here to avoid changing today's behaviour.
- **Both controls are OFF** (flags default false): enabling them is an owner decision, not part of this phase.

### F5. Turning on `adminStepUp` locks out an admin
- **Why plausible:** with the flag on, every sensitive admin write returns 403 `STEP_UP_REQUIRED` until a password prompt succeeds. The new frontend handles it (modal + one retry, tested). Any other client (curl, an old cached frontend) gets 403.
- **Mitigation:** flag is a global switch an owner can turn off via the existing flags page; reads are never blocked.
- **Order dependency:** deploy the admin frontend before flipping the flag.

### F6. Health signals give a false green or false red
- **False green:** the heartbeat is written from a timer, so it proves the process's event loop is alive, **not** that jobs are being processed. A hung queue consumer with a live timer looks healthy. Partial cover: the health page also counts inbound messages stuck pending over 5 minutes and shows outbox/inbox backlog.
- **False red:** `/heartbeat` returns 503 if a required service never reported. If `HEARTBEAT_ENABLED` is set on the API but not on the worker, it alerts forever. Both services must be configured together.
- **Still owner-only:** an external monitor must poll `/heartbeat`; none exists today.

### F7. Membership mirror drifts from the merchant table
- **Why plausible:** syncing a membership after onboarding/staff/phone changes is best-effort (failure is logged, never breaks the message flow).
- **Cover:** `findMembershipDrift` reports any mismatch (tested). **Gap:** nothing calls it on a schedule yet, so drift would be noticed only by a person running it. Phase 2 should add it to the health page or a nightly check.

### F8. A country is mis-configured in the database and disappears
- **Evidence:** registry reads the DB, falls back to the static list when the DB has no country rows, and skips a country with no `CountryConfig` (tested). A half-configured country is hidden rather than offered, which is safe but silent.
- **Unproven:** behaviour when the DB is unreachable at cold start with an empty cache (falls back to static by design; not tested against a real outage).

### F9. Existing admin writes that were never audited
- **Found and fixed:** global flag default, plan upsert and inventory backfill wrote no audit row. Now audited with the acting admin id (tested). Maintenance triggers (expire subscriptions / payment requests) audit per affected record in the domain code.
- **Not audited, by nature:** read-only admin routes (other than the two support-access-gated reads when that flag is on).

## 2. Master-prompt scenarios touched by Phase 1

| # | Scenario | Phase 1 status |
|---|---|---|
| 13 | pawaPay cannot be used for a merchant sale | locally tested (purpose guard + forged-purpose negative test) |
| 14 | merchant paylink / `/collect` quarantined | locally tested (hard-locked before any side effect) |
| 18 | tenant isolation | partial: app-level scoping + RLS policy proven under a non-owner test role; **RLS not active in production** |
| 27–28 | admin RBAC, step-up, audit of admin writes | locally tested; step-up and support-access flags off |
| 29 | append-only financial history at the DB | locally tested (triggers, TRUNCATE guard) |
| 30 | reversal leaves the original intact | locally tested |
| 25 | existing slash commands unchanged | full existing suite green |

## 3. What the owner must still do or decide

1. Approve rehearsal of the migrations on a copy of production data (no deploy until done).
2. Owner decisions still open: OPEN-1..11 in `decisions.md` (P1–P4 and P10 were applied provisionally; please confirm or reject).
3. External heartbeat monitor, verified alert sender + second recipient, Railway CLI relink, pawaPay approval/token, mobile-money API approval: unchanged owner actions.

## 4. Not done in this phase (by design)

Nothing was pushed, merged, deployed, migrated in any real database, or sent to anyone. No credentials were read or entered. Production access this phase: none.
