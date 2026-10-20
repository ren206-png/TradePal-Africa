# Self-check addendum: the decisions pass (2026-10-20)

Branch `expansion/phase-1`, local only. Covers the changes recorded in `decisions-final.md`. Status: **implemented, locally tested; nothing sandbox verified or above.**

## New behaviour that is on without a flag

| Change | Failure mode | Mitigation / what is unverified |
|---|---|---|
| Escalation of shopper requests unanswered for 5 days (operations sweep) | Opens a platform support case per request; a flood of cases if a seller ignores many | One case per request (marker in summary); only REQUESTED refund/cancellation requests. Needs the sweep on; real volume unknown |
| Scheduled integrity checks (about every 20 h) | False positive raises an incident; heavy read on a large database | Read-only, capped at 200 businesses per run with a `truncated` flag; 5-minute cache on the admin view. Query cost on a real database unmeasured |
| Shopper-data retention (daily, 24 months) | Removes personal fields of finished orders; irreversible | Only COMPLETED/CANCELLED/EXPIRED orders past the cutoff; skips orders with open requests, exceptions or unclosed cases; financial fields untouched; `SHOPPER_DATA_RETENTION_MONTHS=0` turns it off; up to 500 orders per run. Legal retention periods per country not reviewed (OPEN-8) |
| Business detail needs support access; financial alerts need financial-viewer | A legitimate admin role is refused | Guards reuse the existing platform permission matrix; tested for allowed and refused roles |
| FREE plan includes the storefront | A business expects other features on FREE | Only the storefront is free; marketplace publishing still refused |
| Forecast-gate thresholds seeded (8 weeks, 1500 bps) | The gate could open earlier than the owner wants | Insert-if-absent; opening still requires the one gated function; forecasts remain shadow |
| Duplicate trade-payment detection (10 minutes) | A genuine second equal payment is refused | The user can add `anyway` |
| Credit decision locked inside the order-acceptance transaction | Lock contention | Row lock on the partner only; **real concurrency unverified (PGlite serialises)** |
| Verified shopper consent | Fewer shoppers receive updates | Only matters when `consumerMessaging` is on, which is off; the order page shows how to verify |
| Audit-failure alert | Noise if the audit table is unavailable | One incident per failure type, de-duplicated by the incident system |

## Not verified

Real Postgres: lock interleaving, trigger behaviour under the Railway role, migration timing on real data. Real devices. Real providers. The AI confidence calibration (needs live calls). All unchanged from the phase self-checks.
