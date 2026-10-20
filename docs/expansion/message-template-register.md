# Message template register

Generated from `src/messaging/registry.ts` by `npx tsx scripts/genTemplateRegister.ts > docs/expansion/message-template-register.md`. The code is the source of truth and `tests/messagingRegistry.test.ts` fails when this file is stale.

**Approval state of every template in this register: NOT SUBMITTED.** No template has been created in WhatsApp Business Manager, submitted to Meta, or approved. Until an operator records an approval (provider template name and where the approval can be checked) in the admin messaging panel, a class that needs a template is suppressed, not sent. Consumer messaging is off: the flag `consumerMessaging` defaults to off, the platform switch `CONSUMER_MESSAGING_ENABLED` is unset, and no existing customer number has ever been messaged.

Rules (master prompt sections 14-16): a message class that is not in this register cannot be sent through the pipeline; order updates and marketing are separate permissions; there is no marketing class; there is no debt-collection, lending or reminder-to-pay class; every shopper message names the seller; a shopper who sends STOP is blocked platform-wide until they send START.

Pipeline column: **ENFORCED** = sent only through `sendMessage` (class, consent, block list, window, template approval, switch, log). **REPLY** = free-text answer to the registered merchant who just wrote, via the dispatcher's reply, inside the window they opened; not in the outbound log. **LEGACY** = existed before Phase 7 and sends through its own module; documented here, NOT subject to the new checks.

| Class | Audience | Category | Pipeline | Trigger | Consent basis | Window rule | Template / body | Params | Approval |
|---|---|---|---|---|---|---|---|---|---|
| `CONSUMER_ORDER_CONFIRMED` | CONSUMER | UTILITY | ENFORCED | The seller confirms a shopper's order. | ORDER_UPDATES_OPT_IN (ORDER_UPDATES) | TEMPLATE_REQUIRED | `{seller}: your order {reference} is confirmed. Reply STOP to stop order messages.` | {{1}}=seller, {{2}}=reference | NOT SUBMITTED (suppressed) |
| `CONSUMER_ORDER_READY` | CONSUMER | UTILITY | ENFORCED | The seller marks a pickup order ready. | ORDER_UPDATES_OPT_IN (ORDER_UPDATES) | TEMPLATE_REQUIRED | `{seller}: your order {reference} is ready for pickup. Reply STOP to stop order messages.` | {{1}}=seller, {{2}}=reference | NOT SUBMITTED (suppressed) |
| `CONSUMER_ORDER_DISPATCHED` | CONSUMER | UTILITY | ENFORCED | The seller dispatches a delivery order. | ORDER_UPDATES_OPT_IN (ORDER_UPDATES) | TEMPLATE_REQUIRED | `{seller}: your order {reference} is on its way. Reply STOP to stop order messages.` | {{1}}=seller, {{2}}=reference | NOT SUBMITTED (suppressed) |
| `CONSUMER_ORDER_CANCELLED` | CONSUMER | UTILITY | ENFORCED | An order is cancelled by the seller, by the shopper, or by hold expiry. | ORDER_UPDATES_OPT_IN (ORDER_UPDATES) | TEMPLATE_REQUIRED | `{seller}: your order {reference} was cancelled. Reply STOP to stop order messages.` | {{1}}=seller, {{2}}=reference | NOT SUBMITTED (suppressed) |
| `CONSUMER_OPT_OUT_CONFIRMATION` | CONSUMER | SERVICE | ENFORCED | A shopper replies STOP. | ONE_OFF_REPLY | SESSION_ONLY | `You will not get any more order messages from TradePal Africa. Reply START if you want them again.` | - | not needed (session reply) |
| `CONSUMER_OPT_IN_CONFIRMATION` | CONSUMER | SERVICE | ENFORCED | A shopper replies START after STOP. | ONE_OFF_REPLY | SESSION_ONLY | `Order messages from TradePal Africa are on again for this number.` | - | not needed (session reply) |
| `CONSUMER_UPDATES_STARTED` | CONSUMER | SERVICE | ENFORCED | A shopper sends UPDATES <code> from the number they gave at checkout. | ONE_OFF_REPLY | SESSION_ONLY | `You will now get WhatsApp updates about order {reference} from {seller}. Updates only, no marketing. Reply STOP any time.` | - | not needed (session reply) |
| `CONSUMER_UPDATES_UNMATCHED` | CONSUMER | SERVICE | ENFORCED | A shopper sends UPDATES <code> and the code does not match that number. | ONE_OFF_REPLY | SESSION_ONLY | `We could not match that code to this phone number. Open your order page and tap the link again, from the phone number you gave when you ordered.` | - | not needed (session reply) |
| `CONSUMER_UPDATES_BLOCKED` | CONSUMER | SERVICE | ENFORCED | A shopper who sent STOP earlier sends UPDATES <code>. | ONE_OFF_REPLY | SESSION_ONLY | `You stopped messages from TradePal Africa earlier. Reply START first, then tap the link on your order page again.` | - | not needed (session reply) |
| `MERCHANT_CONFIRMATION_REPLY` | MERCHANT | SERVICE | REPLY | A merchant answers YES, NO or a number to a pending confirmation or clarification. | ONE_OFF_REPLY | SESSION_ONLY | free text | - | not needed (session reply) |
| `MERCHANT_DEVICE_CODE` | MERCHANT | AUTHENTICATION | REPLY | A merchant sends /connect to link a phone for offline drafts. | ONE_OFF_REPLY | SESSION_ONLY | `Your one-time code to connect this phone is {code}. It works once and expires in {minutes} minutes. Do not share it.` | - | not needed (session reply) |
| `MERCHANT_REPLY` | MERCHANT | SERVICE | LEGACY | Any reply to a merchant's message (commands, parsed entries, errors). | ONE_OFF_REPLY | SESSION_ONLY | free text | - | legacy: outside this register's control |
| `MERCHANT_SUBSCRIPTION_LAPSE` | MERCHANT | UTILITY | LEGACY | A paid subscription lapses. | MERCHANT_RELATIONSHIP | TEMPLATE_OUTSIDE_WINDOW | provider template from `WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME` | - | legacy: outside this register's control |
| `MERCHANT_RENEWAL_REMINDER` | MERCHANT | UTILITY | LEGACY | An admin sends a renewal reminder (Phase 6 admin action). | MERCHANT_RELATIONSHIP | SESSION_ONLY | free text | - | legacy: outside this register's control |
| `MERCHANT_WEEKLY_DIGEST` | MERCHANT | UTILITY | LEGACY | The weekly business digest. | MERCHANT_RELATIONSHIP | TEMPLATE_OUTSIDE_WINDOW | provider template from `WHATSAPP_WEEKLY_DIGEST_TEMPLATE_NAME` | - | legacy: outside this register's control |
| `MERCHANT_PAYMENT_RECEIVED` | MERCHANT | UTILITY | LEGACY | A payment request the merchant created is paid. | MERCHANT_RELATIONSHIP | TEMPLATE_OUTSIDE_WINDOW | provider template from `WHATSAPP_PAYMENT_RECEIVED_TEMPLATE_NAME` | - | legacy: outside this register's control |
| `MERCHANT_PAYMENT_CONFIRMED` | MERCHANT | UTILITY | LEGACY | A collection is confirmed. | MERCHANT_RELATIONSHIP | TEMPLATE_OUTSIDE_WINDOW | provider template from `WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_NAME` | - | legacy: outside this register's control |
| `MERCHANT_STAFF_ADDED` | MERCHANT | UTILITY | LEGACY | An owner adds a staff member. | MERCHANT_RELATIONSHIP | TEMPLATE_OUTSIDE_WINDOW | provider template from `WHATSAPP_STAFF_ADDED_TEMPLATE_NAME` | - | legacy: outside this register's control |
| `MERCHANT_DELETION_RESOLUTION` | MERCHANT | UTILITY | LEGACY | A data-deletion request is resolved. | MERCHANT_RELATIONSHIP | TEMPLATE_OUTSIDE_WINDOW | provider template from `WHATSAPP_DELETION_RESOLUTION_TEMPLATE_NAME` | - | legacy: outside this register's control |
| `UNSUPPORTED_COUNTRY_NOTICE` | CONSUMER | SERVICE | LEGACY | Someone outside the launch countries messages TradePal first. | ONE_OFF_REPLY | SESSION_ONLY | free text | - | legacy: outside this register's control |

## Notes per class

- `CONSUMER_ORDER_CONFIRMED`: Names the seller and the order reference. Carries no order link, pickup code or amount. Never marketing.
- `CONSUMER_ORDER_READY`: Never contains the handover code.
- `CONSUMER_ORDER_DISPATCHED`: Never contains the handover code.
- `CONSUMER_ORDER_CANCELLED`: Says only that the order was cancelled. Refund amounts and debt or collection language are never included.
- `CONSUMER_OPT_OUT_CONFIRMATION`: A reply inside the window the shopper just opened. Sent even though the number is now blocked: it is the only message allowed after STOP.
- `CONSUMER_OPT_IN_CONFIRMATION`: A reply inside the window the shopper just opened.
- `CONSUMER_UPDATES_STARTED`: A reply inside the window the shopper just opened. It is what makes the consent VERIFIED. Names the seller and the order reference.
- `CONSUMER_UPDATES_UNMATCHED`: A reply inside the window the sender just opened; reveals nothing about any order.
- `CONSUMER_UPDATES_BLOCKED`: Tells them to send START first. A STOP is never undone by a link.
- `MERCHANT_CONFIRMATION_REPLY`: Free text inside the 24-hour window the merchant just opened. Text comes from the i18n catalog (confirm.*, clarify.*).
- `MERCHANT_DEVICE_CODE`: One-time code, single use, short expiry. Sent only as a reply to the merchant's own command.
- `MERCHANT_REPLY`: Free text from `messageDispatcher.reply`. Registered merchants only.
- `MERCHANT_SUBSCRIPTION_LAPSE`: Account status notice to the merchant. Not debt collection.
- `MERCHANT_RENEWAL_REMINDER`: Plain text; Meta may refuse it outside the 24-hour window. Not recorded anywhere except the admin audit log.
- `MERCHANT_WEEKLY_DIGEST`: The merchant's own numbers only.
- `MERCHANT_PAYMENT_RECEIVED`: To the merchant, never to the payer.
- `MERCHANT_PAYMENT_CONFIRMED`: To the merchant, never to the payer.
- `MERCHANT_STAFF_ADDED`: Goes to the new staff member's number, which is registered as a merchant row when it is added.
- `MERCHANT_DELETION_RESOLUTION`: Answer to the merchant's own request.
- `UNSUPPORTED_COUNTRY_NOTICE`: One fixed reply to a person who wrote first. Nothing stored about the sender.
