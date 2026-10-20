# Runbook: production activation (checklist; nothing here has been done)

**Nothing in this phase deploys, migrates, rotates credentials, enables money movement, contacts users, or changes provider dashboards. Each step below is an owner action, taken one at a time, with a rollback ready (`rollback.md`).**

## Gate 0: before ANY expansion code reaches production
1. Review the branch (`expansion/phase-1`, local only). Decide how it is merged: a push to `main` deploys production AND runs `prisma migrate deploy` (see `PHASE_0_FINDINGS.md`).
2. **Rehearse the migrations** on a restored copy of the production backup: `REHEARSAL_DATABASE_URL=<scratch> ./scripts/rehearseMigrations.sh`. It has never been run. Needs a scratch Postgres (restore a backup into it) and `psql`. Record the timing and any lock waits.
3. Take a fresh production backup and note the restore command.
4. Confirm production alerts work: send a synthetic incident and a channel check from System health; confirm they arrive. Set up the external heartbeat monitor on `/heartbeat` with a second alert channel (owner action, open since Phase 0).
5. Set `OPERATIONS_SWEEP_ENABLED`, `OUTBOX_SWEEP_ENABLED`, `HEARTBEAT_ENABLED`, `TRUST_PROXY` on server and worker.
6. Deploy. Check: existing commands (`/today`, `/debts`, `/undo`), onboarding, the WhatsApp webhook, the admin console, subscription expiry. **Every new flag is OFF, so behaviour must be unchanged** (scenario 25).

## Gate 1: each capability, in its own change
| Capability | Prerequisites beyond the environment switch | Notes |
|---|---|---|
| Admin step-up / support access | an admin password known to every admin | flip globally only after each admin has logged in once |
| Reports (`reportsV2`) | an accountant has compared one real merchant's reports to their books | per business; keep `dailyClose` OFF |
| Storefront (real shoppers) | **a merchant payment provider chosen and its adapter built**, else pay-on-collection only; `STOREFRONT_SIMULATOR_ENABLED` must be unset; public notices deployed; `TRUST_PROXY` set; Redis rate limiting | one pilot seller first |
| Marketplace | moderation staffed; report-reason list agreed | |
| pawaPay billing | sandbox verification complete; pawaPay KYB/partner approval; production token; signed callbacks enabled in the dashboard; plan versions with prices and OPEN-12 decided; `PAWAPAY_ENVIRONMENT=PRODUCTION` + matching base URL; **then** `PAWAPAY_BILLING_PRODUCTION_ACTIVATED=true`; controlled live verification with a small real payment you can refund | a SL billing switch row per country |
| Subscription entitlements | OPEN-12 decided | otherwise every business without a paid plan loses premium operations |
| Conversational confirmations | decision on OPEN-14 | per business; the legacy auto-log stays for everyone else |
| Offline drafts | the page tested on a real low-end phone | `OFFLINE_PUBLIC_URL` |
| **Messages to shoppers** | **all of:** templates created and APPROVED by Meta and recorded in the admin template register; landing FAQ and privacy page deployed (they are edited in the repo only); OPEN-15 (double opt-in) decided; `MESSAGING_LOG_PEPPER` set; a test to your own number | **last**; the most policy-sensitive step |

## Gate 2: after each activation
Watch System health, the exception queues, the AI/alert status and the audit log for a day. Keep the previous step's rollback ready.
