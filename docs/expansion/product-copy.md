# Truthful product and help copy (audit)

Every public or in-product statement was compared with what the system does today. Status vocabulary: `docs/expansion/status-matrix.md`. Landing-site edits are made in the repository and **not deployed**.

## Landing site (`landing/`)

| Statement | True today? | Action |
|---|---|---|
| Features: debt book, daily summary, stock tracking, reminders (shown as live); payment links, catalog, mobile-money reconciliation, team access (tagged "Coming soon") | the live ones are pre-expansion features; the "soon" tags match flags that are off | unchanged. **Do not add** storefront, marketplace, reports, trade or offline claims until each is activated: they are `locally tested`, not live |
| FAQ "Will TradePal message my customers?" said "Never" | **false once shopper updates exist** (they are built, off) | rewritten in the repo: replies only to the merchant; the one exception is order updates to a shopper who ticked the box, never marketing, STOP honoured. **Deploy this wording before consumer messaging is turned on** |
| Privacy page | omitted shopper messaging | added "Messages to shoppers" and a new date. **Still to publish at activation (drafts below):** shop orders, subscription payment data, offline drafts, reports |
| Pricing: Free 50 entries; Starter ₦5,000, 1,000 entries, "paid plans open soon" | the legacy plan table has these figures; the expansion's plan versions have **no prices at all** | owner decision: which source is authoritative before billing opens (OPEN-12 and plan prices) |
| "Voice note logging (coming soon)" in Starter | voice exists behind a flag per country/plan | unchanged |
| Terms: "Free plan and a paid Starter plan" | consistent with the above | unchanged |

## Draft copy to publish only when the feature is activated

- **Shop orders (privacy):** "If you order from a shop that uses TradePal, we record your name, phone number, delivery details and what you ordered, for the seller to fulfil your order, and your order link lets you see it. The seller is responsible for your goods and delivery; TradePal provides the shop page and the order record."
- **Subscription payments (privacy):** "When you pay for a TradePal plan by mobile money through pawaPay, pawaPay processes the payment. We keep the last four digits of the number you paid from, the amount and the date, not the full number."
- **Offline drafts (help):** "A draft saved on your phone is not a recorded sale or expense. It becomes one only after you send it and confirm it while online. Disconnecting a phone deletes any drafts that were not sent."
- **Reports (help):** "Reports are bookkeeping summaries from the records you entered. They are not tax filings, not audited, and not a statement of profit. Read the notes under each report."

## In-product copy (reviewed)

| Where | Statement | Verdict |
|---|---|---|
| `/help` | new commands listed only when their flag (and switch) is on | true; a command is never advertised when it would answer "Unrecognized" |
| Sale receipt reply | "TradePal cannot message customers directly" | true for chat receipts (the merchant forwards them); shopper order updates are a separate, off-by-default feature; revisit this line when consumer messaging is activated |
| `/today` | "Net" | with `reportsV2` on it reads "Sales minus expenses (not profit)"; the weekly digest still says "Net" (template wording, OPEN-17) |
| Shop page, online payment | "Pay online (TEST ONLY: no real money)" | true: simulator only, refused in production |
| Shop checkout | separate tick: "Send me WhatsApp updates about this order from TradePal Africa ... no marketing ... reply STOP" | true; shown only when messaging is live for a seller in the basket |
| Order page | refund/cancel messages from the shared policy | true by construction (same function as the backend) |
| Confirmations | "I understood: ... Reply YES to save it" | true: nothing is saved until YES; with the flag off the older auto-log still applies |
| Reports | every report and CSV states its basis and every warning, and "not a tax filing, an audited statement, or a statement of profit" | true |
| Admin console | no "Delete" or "Mark paid" control exists on any financial record | true (tested) |

## Claims we must not make (until evidence exists)
That TradePal is "approved" by Meta, pawaPay or any regulator; that reports are accepted by lenders or tax authorities; that payments are processed for merchants (no merchant provider is connected); that Krio or any local language is supported; that the system has been tested on real phones or networks; that forecasts are accurate.

## Second pass additions (2026-10-20), not yet deployed
- Privacy page (`landing/src/pages/privacy.astro`): the one-message WhatsApp confirmation for shopper updates; removal of shopper personal details 24 months after an order; a new "Deliveries and photos" section (what a courier is given; photos are stored by us and no outside pictures load).
- Seller terms and WhatsApp templates are drafts in `docs/expansion/drafts-for-review/`.
- Deploy these with the shop and messaging activation, not before.
