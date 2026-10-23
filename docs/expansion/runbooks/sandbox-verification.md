# Runbook: sandbox verification (pawaPay subscription billing)

**Status: not done.** No pawaPay token exists, so everything below has only been exercised against an in-memory fake written from pawaPay's documentation. The fake is not a recording of the real service. This runbook is the first contact with the real one.

## Before you start
- A pawaPay SANDBOX account and token (owner action). Never use a production token here: the code refuses a mismatch of `PAWAPAY_ENVIRONMENT`, base URL and `NODE_ENV`.
- A sandbox deployment (or a local server reachable by a tunnel) whose public host name you set in `PAWAPAY_BILLING_CALLBACK_AUTHORITY`.
- In the pawaPay dashboard: **signed callbacks enabled**, deposit callback URL `https://<host>/webhooks/pawapay/billing`, refund callback likewise.

## Environment (staging only)
`PAWAPAY_API_TOKEN` (sandbox), `PAWAPAY_API_BASE_URL=https://api.sandbox.pawapay.io/v2`, `PAWAPAY_ENVIRONMENT=SANDBOX`, `PAWAPAY_BILLING_CALLBACK_AUTHORITY=<host>`, `PAWAPAY_REQUIRE_SIGNED_CALLBACKS=true`, `OPERATIONS_SWEEP_ENABLED=true`, `OUTBOX_SWEEP_ENABLED=true`. Leave `PAWAPAY_BILLING_PRODUCTION_ACTIVATED` unset.

## Setup in the admin console
1. Create a plan version (STARTER) with an explicit test price for Sierra Leone and **publish** it (there are no default prices).
2. Turn the `pawapayBilling` flag on for ONE test business; turn the SL billing switch on.
3. Subscriptions panel: the configuration line must say "pawaPay: sandbox. Signed callbacks required".

## Scenarios to run (record the outcome of each in `progress.md`; unexpected = stop and write it down)
| # | Scenario | Expected |
|---|---|---|
| 1 | `/renew <sandbox MSISDN that succeeds>` | PIN prompt (simulated by pawaPay), then COMPLETED; callback verified; **period granted once** |
| 2 | The same callback re-sent (dashboard resend) | nothing changes |
| 3 | A sandbox number that FAILS | attempt FAILED, no period, merchant told |
| 4 | A number that stays pending, then completes after the poll window | resolved by status polling, period granted once |
| 5 | Callback with a tampered body, a stale `created`, a wrong key id | refused 401, recorded as an auth failure |
| 6 | Stop the sweeps, pay, restart | callback sat in the inbox; nothing granted until processed; then granted once |
| 7 | Pay a different amount / currency (sandbox amounts) | exception, no access granted |
| 8 | Refund a paid subscription invoice from the admin panel | refund PROCESSING -> COMPLETED; invoice REFUNDED |
| 9 | Provider outage (block the API) | new renewals refused with a clear message; reconciliation keeps trying |
| 10 | Look at the REAL callback's signature headers | **this is the unknown:** compare `@authority`, `@path`, the signed components and `keyid` with what `pawapay/signature.ts` expects (see `pawapay-audit.md` section 7). If every callback fails verification, polling still finds payments; fix the base string before going further |

## Exit criteria
All ten scenarios behave as expected on the real sandbox, the open documentation conflicts in `pawapay-audit.md` are resolved by what the sandbox does, and the result is written into `pawapay-audit.md`. Only then is billing "sandbox verified". It is still not "partner approved".
