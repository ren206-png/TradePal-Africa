# Runbook: environment setup (development and staging)

Goal: a working copy of the whole system with every expansion feature OFF, then switched on one at a time. Nothing here needs a real provider, a real credential or production access.

## 1. Prerequisites
Node 20+, pnpm or npm, Docker (optional: for Postgres and Redis), `psql` (only for the migration rehearsal). The test suite needs none of these (it uses an in-process Postgres).

## 2. Install and check
```bash
npm install                          # also: (cd admin-frontend && npm install)
npx prisma generate
npx tsc --noEmit -p .                # must be clean
npx vitest run                       # backend: expect all files to pass (111 files / 1248+ tests at Phase 8)
(cd admin-frontend && npx vitest run && npm run build)
```
The suite is deterministic CI. It never contacts a provider. (Known: it must run from a path without surprises; a path with spaces works since the Phase 1 fix.)

## 3. Run the demo (no database to install)
```bash
npx tsx scripts/demoRelease.ts               # prints every step and a panel-by-panel check
npx tsx scripts/demoRelease.ts --serve 4180  # keeps the synthetic world alive; point the admin console at it:
(cd admin-frontend && VITE_API_BASE_URL=http://127.0.0.1:4180 npx vite --port 5199)   # login owner@demo.test / correct-horse (demo only)
```

## 4. A real local database (optional)
Copy `.env.example` to `.env`; set `DATABASE_URL`, `REDIS_URL`, `ADMIN_JWT_SECRET` (`openssl rand -base64 48`). `docker compose up postgres redis`, then `npx prisma migrate deploy` (applies every migration, including the expansion's) and `npm run seed`. Create an admin: `npx tsx scripts/createAdminUser.ts`. Start `npm run dev:server` and `npm run dev:worker`.

## 5. Switch things on, in this order, checking after each
Every step needs BOTH the environment switch (where one exists) AND the per-business flag (admin console -> Feature flags). Defaults are all OFF; do not skip the check.

| Order | Capability | Env | Business flag(s) | Check |
|---|---|---|---|---|
| 1 | Background sweeps | `OPERATIONS_SWEEP_ENABLED`, `OUTBOX_SWEEP_ENABLED` | none | System health: outbox/inbox move; heartbeat |
| 2 | Admin hardening | none | `adminStepUp`, `adminSupportAccessRequired` (global default) | a write now asks for the password |
| 3 | Catalog, stock, journals | none | `catalogV2`, `stockV2`, `accountingJournals` | `/products`, `/receive`; journals balance |
| 4 | Trade (B2B) | none | `tradeOrders`, `reorderRules` | a linked order end to end (`scripts/demoRelease.ts` part 1) |
| 5 | Storefront (simulator only) | `STOREFRONT_ENABLED`, `STOREFRONT_PUBLIC_URL`, `TRUST_PROXY`, (`STOREFRONT_SIMULATOR_ENABLED`, `PAYMENT_SIMULATOR_SECRET` in dev/staging only) | `storefront`, (`storefrontOnlinePayment`) | open the shop page; place a test order |
| 6 | Marketplace | `MARKETPLACE_ENABLED` | `marketplace` | search finds a published item |
| 7 | pawaPay billing (SANDBOX) | see `sandbox-verification.md` | `pawapayBilling` | sandbox run passes |
| 8 | Conversational confirmations | none | `conversationalConfirmations` | a parsed entry waits for YES |
| 9 | Offline drafts / reports on a phone | `OFFLINE_DRAFTS_ENABLED`, `REPORTS_WEB_ENABLED`, `OFFLINE_PUBLIC_URL` | `offlineDrafts`, `reportsV2` | `/connect`, `/report link` |
| 10 | Messages to shoppers | `CONSUMER_MESSAGING_ENABLED`, `MESSAGING_LOG_PEPPER` | `consumerMessaging` | ONLY after templates are approved and the public notices are deployed; see `production-activation.md` |

`dailyClose` stays OFF (no payment method is recorded on legacy entries). `subscriptionEntitlements` stays OFF until OPEN-12 (plan features) is decided.

## 6. Secrets
Never commit `.env`. Secrets are: `WHATSAPP_*`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `FLUTTERWAVE_*`, `PAWAPAY_API_TOKEN`, `ADMIN_JWT_SECRET`, `ALERT_EMAIL_API_KEY`, `PAYMENT_SIMULATOR_SECRET`, `MESSAGING_LOG_PEPPER`, database and Redis URLs.
