# Runbook: incidents

First rule: **stop the harm, then diagnose.** Every step below can be done from the admin console or with an environment switch, and none deletes data.

## Severity and first action
| Symptom | Likely cause | First action |
|---|---|---|
| Merchants get no replies | worker down, WhatsApp token/number, Redis down, AI provider out of credit | System health (heartbeats, stuck inbound, AI status); check the alert emails; **AI billing/auth alert** has its own title per provider ("AI provider billing failure (DeepSeek)" etc.): top up / replace the key; messages fall back to the other provider or a degraded reply |
| An alert email did not arrive | alert key/recipient wrong | System health -> Alert channel -> check; "needs attention" means nothing delivered in 7 days or the last attempt failed. There is no second channel: fix this first |
| Callbacks refused (auth failures) | signature-base mismatch (host, path, key), a real attack, wrong environment | Subscriptions overview -> callback auth failures; compare with `pawapay-audit.md` section 7; payments are still found by polling (delay, not loss) while the sweeps run |
| Orders paid but not confirmed | sweeps off or paused; callback dead-lettered | System health -> jobs (resume); Payments -> callbacks -> replay |
| Wrong amounts / double-entry | a defect | Pause the affected job class; do NOT edit: void/reverse; open an exception; preserve logs |
| A shopper complains of a message they did not want | consent bug or wrong number | Messaging -> block the number with a reason; disable the template; check consent records (they are append-only history) |
| A merchant's phone is lost or shared | stolen device | Revoke phone sessions for the business; change the merchant's number in admin if needed |
| A former admin still active | | `scripts/disableAdmin.ts`; rotate `ADMIN_JWT_SECRET` if in doubt |
| Suspected data exposure | | preserve evidence; disable the surface (unset its env switch); revoke sessions; see Privacy contact; notify as local law requires (owner) |
| Migration/deploy failure | | `rollback.md` section 3 |

## Test the alarm (do this before you need it)
System health -> "Send a synthetic incident…": it travels the real alert path and reports whether the email service accepted it. Quarterly at least.

## During an incident
1. Write down the time, what you saw, and each action as you do it (the audit log records admin actions, not your reasoning).
2. Prefer switching a capability OFF (`rollback.md`) to hot-fixing.
3. Pausing a job class is reversible and audited; inbound messages and payment callbacks cannot be paused, by design.
4. After: write what happened, what the system did and did not tell you, and what alert or runbook line was missing; add it here.

## Who to tell
Merchants affected (a plain message from the owner, not from the bot); the provider (pawaPay/Meta) if their side is implicated; anyone the law requires. Nobody is notified automatically.
