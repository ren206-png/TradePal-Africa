# DRAFT for your review: WhatsApp message templates to submit to Meta

**Status: drafts only. Nothing has been created in WhatsApp Business Manager, nothing has been submitted to Meta, and no template is approved.** Until a template is approved AND an admin records the approval in the TradePal admin console (Messaging -> templates), the product refuses to send that class of message to a shopper (it is "suppressed" and logged). Shopper messaging is also still switched off (`CONSUMER_MESSAGING_ENABLED` unset, per-seller flag `consumerMessaging` off).

The wording below is exactly what is in the code today (`src/i18n/catalog.ts`, listed in `message-template-register.md`), so what you submit and what the product sends are the same words.

## 1. How a shopper gets messages at all (no template needed for this part)
1. At checkout the shopper ticks: *"I want WhatsApp updates about this order from TradePal Africa, on behalf of the seller. Updates only, no marketing. To start them I will tap a link on my order page and send one WhatsApp message from this number. I can reply STOP at any time."*
2. On their order page they tap **Start updates on WhatsApp**. It opens WhatsApp to TradePal's public number with the text `UPDATES <8-character code>` already typed. They press send.
3. TradePal replies inside the 24-hour window Meta gives after the shopper's own message (a free-form *service* reply, no template): *"You will now get WhatsApp updates about order {reference} from {seller}. Updates only, no marketing. Reply STOP any time."*
4. Only after step 3 may the four order-update templates below be sent, and only for that shopper's orders. STOP stops everything platform-wide; START turns it back on.

The shopper's number is therefore *proven* to be theirs (it sent the message), which is what protects people whose number someone else typed in.

## 2. The four utility templates (submit these)
Category: **UTILITY** (a transaction update, not marketing). Language: **English (en)**. No header, no footer, no buttons, no media. Variables are plain text.

Meta's rules these follow: a template may not start or end with a variable, two variables may not sit side by side, every variable needs a sample, and the text must not be promotional.

| Template name to create (suggested) | Body (exact) | `{{1}}` sample | `{{2}}` sample |
|---|---|---|---|
| `order_confirmed_v1` | `Order update from {{1}}: your order {{2}} is confirmed. Reply STOP to stop order messages.` | `Demo Provisions` | `SO-000012` |
| `order_ready_v1` | `Order update from {{1}}: your order {{2}} is ready for pickup. Reply STOP to stop order messages.` | `Demo Provisions` | `SO-000012` |
| `order_dispatched_v1` | `Order update from {{1}}: your order {{2}} is on its way. Reply STOP to stop order messages.` | `Demo Provisions` | `SO-000012` |
| `order_cancelled_v1` | `Order update from {{1}}: your order {{2}} was cancelled. Reply STOP to stop order messages.` | `Demo Provisions` | `SO-000012` |

Mapping to the code (`src/messaging/registry.ts`): `{{1}}` = the seller's shop name, `{{2}}` = the order reference. Nothing else is ever sent: no amounts, no hand-over code, no order link, no refund details, no "pay now", nothing about debts. A test (`tests/messaging.test.ts`) fails if any order-update wording contains money, a code or collection language.

When Meta approves one: in the admin console, Messaging -> templates, record the **provider template name** (exactly as created) and **where the approval can be checked** (e.g. the Business Manager URL). The database refuses to mark a template approved without both.

Suggested submission order: `order_confirmed_v1` and `order_dispatched_v1` first (most useful), then `order_ready_v1`, then `order_cancelled_v1`.

## 3. Templates that already exist for merchants (check, do not recreate)
These are messages TradePal sends **to merchants** (your customers who use the bookkeeping bot). They send through template names read from environment variables; if a name is unset the system falls back to free text inside the 24-hour window.

| Purpose | Environment variable | Notes |
|---|---|---|
| Weekly business digest | `WHATSAPP_WEEKLY_DIGEST_TEMPLATE_NAME` | 7 body placeholders, one per line of the digest. Line 4 is labelled "Net" in the old way and **"Sales minus expenses (not profit)"** once the business's `reportsV2` flag is on: the label is a *parameter*, so no template change is needed. |
| Subscription lapse | `WHATSAPP_SUBSCRIPTION_LAPSE_TEMPLATE_NAME` | |
| Payment received / confirmed | `WHATSAPP_PAYMENT_RECEIVED_TEMPLATE_NAME`, `WHATSAPP_PAYMENT_CONFIRMED_TEMPLATE_NAME` | |
| Staff added | `WHATSAPP_STAFF_ADDED_TEMPLATE_NAME` | |
| Data deletion resolved | `WHATSAPP_DELETION_RESOLUTION_TEMPLATE_NAME` | |

## 4. Not templates (replies inside the 24-hour window the person opened)
Opt-out confirmation, opt-in confirmation, "updates started", "code not matched", "you stopped messages earlier", the connect-a-phone code, and confirmations of an entry. They need no approval; they are only ever sent in answer to a message the person just sent.

## 5. Things I deliberately did not draft
- **No marketing template of any kind.** There is no marketing class in the product, and a shopper's checkout tick can never grant marketing (a database rule forbids it).
- **No reminders to pay, debt-collection or "your payment is due" templates.**
- **No template in Krio, Pidgin, Swahili, French or any other language** until a named human reviewer has checked a sample (OPEN-9). English only for now.
- **No courier or rider messages to shoppers.** The shopper sees the courier and its status on their order page. If you later want "your parcel is on its way with {courier}", that is a fifth template and a code change.

## 6. Checklist before you submit
- [ ] The WhatsApp Business Account that will send is the one already used for the product.
- [ ] Display name and business verification are complete in Meta Business Settings.
- [ ] You are happy that each message names the seller and carries `Reply STOP`.
- [ ] The landing FAQ and privacy page changes (in `landing/`, not yet deployed) go live **before** shopper messaging is switched on.
- [ ] After approval: record each in the admin console; set `CONSUMER_MESSAGING_ENABLED=true`, `MESSAGING_LOG_PEPPER`, `WHATSAPP_PUBLIC_NUMBER`; turn `consumerMessaging` on for **one** pilot seller; send yourself a test order.
