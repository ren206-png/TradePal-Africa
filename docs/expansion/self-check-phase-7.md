# Phase 7 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (still the same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Delivered: a localization framework (English only); a registry of every outbound message class with a generated, complete template register; a consent register with STOP / START and a platform-wide block list; an enforced send pipeline and order updates to shoppers; conversational confirmations bound to the exact action, amount, person and expiry, with guards and a clarification dialogue; offline drafts with phone sessions, idempotent sync and revalidation; AI-provider billing and authentication failure alerts under their own titles with recorded, checkable delivery; and the admin messaging and consent panel. Everything is **implemented** and **locally tested**. **Nothing is sandbox verified, partner approved, production configured or production activated. No message has been sent to anyone. No template exists in WhatsApp Business Manager, and none is approved.** Everything is OFF: flags `consumerMessaging`, `conversationalConfirmations`, `offlineDrafts`; platform switches `CONSUMER_MESSAGING_ENABLED`, `OFFLINE_DRAFTS_ENABLED` (both unset).

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **105 files / 1184 tests pass** (Phase 6 ended at 100 / 1103) |
| `admin-frontend` `npx vitest run` + `npm run build` | 13 files / 57 tests pass; build succeeds |
| New in Phase 7 | `messaging` 21, `conversation` 22, `offlineDrafts` 17, `aiFailureAlerts` 8, `adminMessaging` 11 (79 backend tests, plus 2 DeepSeek alert cases added to `messageDispatcher`) + 4 frontend |
| Served offline script | `node --check` syntax OK. **Never executed in a browser.** |

## 1. Failure scenarios

### F1. The Phase 7 migration misbehaves on the real database
- Same standing caveat as Phases 1-6: never run on a real server; `scripts/rehearseMigrations.sh` is still unrun against a database. This migration is purely additive (9 new tables, no change to an existing table, no `ALTER TYPE`), with triggers, a partial unique index and RLS policies the Railway role's privileges have not been checked for (PGlite is superuser).
- The STOP handler and the block list read and write consent rows across businesses with the unscoped client by design. If RLS is ever enforced for the app role, those paths need a platform role or they will see nothing.

### F2. A shopper is messaged who should not be
- **Evidence it does not happen by default:** nothing is sent unless the platform switch, the seller's flag, a registered class, an APPROVED template, the shopper's own opt-in for that seller and an unblocked number are all true, and every refusal is recorded with its reason (tested one by one). "The seller may contact me" is not consent. Marketing cannot be granted at checkout (database CHECK) and no marketing class exists.
- **Gap 1 (real): no double opt-in.** The number comes from the checkout form and is not verified. Someone can type another person's number and tick the box; that person then receives order updates naming the seller. Mitigations that exist: the checkout rate limit (10 orders an hour per client), the message names the seller, and the recipient can reply STOP. None of that prevents the first message. Decision for the owner (OPEN-15): a first message that asks the shopper to reply YES before any update, which needs its own approved template.
- **Gap 2: a suppressed or sent decision is final for that event** (its idempotency key is stored). If an order is confirmed before the template is approved, that confirmation is never sent later when the template is approved.
- **Gap 3: the outbound log and the send are not atomic.** `sendMessage` reads for an earlier decision, sends, then writes the record. Two simultaneous calls for the same event could both send. Order transitions are single guarded statements, so the normal path calls once, but concurrent processes were not tested (PGlite serialises sessions).
- **Gap 4: legacy classes are not covered by the new checks.** The older merchant notices (digest, lapse, payment received, staff added, deletion) still send through their own modules. They only ever go to registered merchants, and the register says so, but they do not write `OutboundMessageLog`, are not subject to the block list, and the renewal reminder from the admin panel is a plain text that Meta may refuse outside the 24-hour window.
- **Gap 5: the template register records what a person says the provider approved.** Nothing checks it against Meta. An owner can record an approval with an invented reference; the database only requires that a name and a reference exist. Parameter order is derived from the English wording (`{{1}}`, `{{2}}`…): the real template, written by hand in WhatsApp Manager, must match it or the message reads wrongly.

### F3. A STOP is missed or misapplied
- Tested: whole-message STOP/UNSUBSCRIBE/CANCEL/END/QUIT from a non-merchant with a consent history withdraws every consent with every seller, blocks the number, and is confirmed once; "please stop the delivery" is not a STOP; START restores only what STOP withdrew; an operator block outlasts START; unblocking never re-opts anyone in.
- **Gaps:** (a) a STOP from a number with no consent record is not treated as an opt-out and enters the older path (that path may start onboarding for it, as before); (b) START from an operator-blocked number, or when nothing was withdrawn, gets **no reply** at all (silence, by design, to avoid claiming something untrue); (c) STOP only works over WhatsApp: a shopper who wants out by phone call or at the shop has no route except the seller telling an admin, and the admin panel can block a number but cannot withdraw a consent; (d) the keyword list is English only.

### F4. Something consequential is saved without the person meaning it
- **Evidence:** with `conversationalConfirmations` on, an AI-read entry is previewed and saved only after YES from the same person within 10 minutes, bound by a digest to the exact entry; YES is re-checked (person active, business not suspended, digest, currency, stock tracking, quota) and the claim and the entry are one transaction; a stale, repeated or late YES saves nothing; one open question per person; a duplicate delivery never proposes twice; injection, a large amount and an invented amount need a code that only appears in the preview; a foreign or old/new currency saves nothing; ambiguous stock items ask which one; an unknown product is shown as new; a spoken YES does not confirm; an unavailable model or an unreadable reply saves nothing.
- **Gap 1 (the largest): this is per business and OFF by default. With it off, the older rule (auto-log at confidence 0.7 or higher) is unchanged for everyone.** Scenario 21 therefore holds only for businesses that have the flag on; scenario 25 (flags off = identical) holds for everyone else. P9 (re-measuring confidence through DeepSeek) is still not done, so there is no evidence what the 0.7 threshold means for the current model.
- **Gap 2: the injection check is a deny-list.** It catches common phrasings ("ignore all previous instructions", embedded SQL, tags, "confirm automatically") and misses paraphrases: "disregard what you were told earlier", "forget your rules" and "drop the price table" all passed in a probe; it does not read other languages or Krio. It also has a false positive ("update stock set to 5" demands a code). The real protection is that a human confirmation is required and the entry is a structured value, not that every attack is recognised.
- **Gap 3:** the amount-in-message check only reads digits (not "five thousand"), so a spoken or worded amount escalates to a code more often than needed. The large-amount rule is relative (10 times the business's largest entry once there are five or more) or an absolute 1,000,000 major units with little history, which is arbitrary for each currency.
- **Gap 4:** a message that contains two entries ("sold bread for 1500 and bought flour for 8000") still yields ONE parsed intent; the preview shows only that one and the other is silently dropped, exactly as before, but the person is now asked to approve something that is not all they said.
- **Gap 5 (behaviour change under the flag):** with the flag on, a bare "yes", "ok", "no", "stop" or "cancel" with nothing pending now answers "nothing waiting for your confirmation" instead of going to the AI parser.
- **Gap 6: concurrency.** YES twice at the same instant is protected by a guarded claim inside the transaction and tested only sequentially.
- **Gap 7:** undo remains the existing `/undo` (a reversal); a confirmed entry cannot be un-confirmed.

### F5. Offline drafts lose, duplicate or wrongly record a sale
- **Evidence:** syncing the same draft or batch again changes nothing; a draft records no money until confirmed online; a changed price, short stock, a wrong total, a clock ahead, an old draft, no permission, a removed person, a suspended business all show as conflicts or refuse; accepting a conflict is explicit; a confirmed draft takes catalog stock out in the same transaction (a shortage the person accepted goes through and is recorded with who approved it); one business's phone cannot see or settle another's drafts; the code works once, expires in 10 minutes, is stored hashed; logout/disconnect ends sessions at once.
- **Gap 1 (found and fixed in this phase): a confirmed draft originally recorded the sale without taking stock out.** It now calls the stock service for catalog lines. Free-text lines (no SKU) still touch no stock and are never price-checked, as with a sale typed in chat.
- **Gap 2: the page has never run in a browser or on a phone.** Its script passes a syntax check and its served text is asserted (textContent only, no localStorage, a service worker that caches two files and never sees `/m/api`), but the queue, the service worker lifecycle, the install/offline behaviour and the wipe on logout were never executed. A bug there could lose a draft or leave data on a phone.
- **Gap 3:** the device token and the queue sit in IndexedDB (not localStorage or cookies), so a script injection on the page could read them. The page's policy allows only its own script, and the server escapes nothing into it (there is no server-rendered data), but this is not a hardened vault. Anyone holding an unlocked phone with an unexpired session can read the drafts on it; only the shared-phone mode deletes them after each sync.
- **Gap 4:** the draft is immutable after the first sync; to correct one, discard it and write another. The phone's clock is untrusted input (checked for being ahead or very old, nothing else).
- **Gap 5:** a draft's customer or item names are free text; nothing matches them to existing customers. A credit sale creates or reuses a customer by name through the same path as chat.

### F6. The alert actually reaches no one
- **Evidence:** four distinct titles (billing and authentication, per provider); a DeepSeek 402 or 401 alerts while Anthropic keeps serving merchants; a refused send does not use up the dedupe window; every attempt is recorded; a channel check sends a labelled test; system health shows the last proven delivery and warns when there is none in seven days or the latest failed.
- **Gap 1: "delivered" means the email service accepted the message and returned an id.** It does not prove arrival in an inbox, and no bounce or delivery webhook is wired. Nobody has run the channel check against the real service.
- **Gap 2:** there is no second channel. When email is down or unconfigured the failure is recorded and visible in the panel, but nothing else is tried and nobody is paged. The external heartbeat monitor and a verified sender remain owner actions.
- **Gap 3:** only the API server and the worker record deliveries; the digest and expiry workers' alerts still go out unrecorded. Repeated identical incidents are deduped in memory per process for 15 minutes, as before.

### F7. Localization is mistaken for done
- English only. French and Krio are registered with status MISSING and have no text; nothing is machine-translated and no dialect string was written. Only the messages added in this phase use the catalog; every older message is inline English. Key coverage is reported with a caveat that comprehension and quality are not measured. There is no language preference per person or business that selects a locale yet (the code accepts one; nothing supplies it).

### F8. Existing behaviour regressed
- With every new flag off the earlier suites pass unchanged. Two deliberate changes to existing behaviour, both disclosed: the AI-provider incident titles changed (the one test pinning the old text was updated; routine "call failed" noise keeps its title), and `reportIncident` now records its outcome and no longer lets a refused email use up the dedupe window. `/help` lists `/connect` only when both the flag and the platform switch are on.

## 2. Master-prompt scenarios

| # | Scenario | Phase 7 status |
|---|---|---|
| 6 | Duplicate WhatsApp delivery and repeated confirmation create no duplicate transactions | locally tested (a re-delivered message, a repeated YES, a late YES; sequential, real interleaving unproven) |
| 17 | Offline drafts sync once; conflicts visible; stale prices/stock revalidated | locally tested at the API; the page was never run on a device |
| 20 | Consumer messaging honors opt-in, opt-out, business identity, templates, windows | locally tested with a recording transport; nothing real sent; no template approved |
| 21 | Prompt injection, ambiguous units/currency, unknown product, unavailable model, inaccurate transcript cannot silently execute | locally tested **for businesses with the flag ON**; the older auto-log remains for everyone else (F4 gap 1) |
| 26 | AI billing/auth failure alerts under its own title through a channel verified to deliver | locally tested; "delivered" = accepted by the email service |
| 25 | Existing behaviour identical with flags off | locally tested |
| 27-30 | Admin routes reject non-admins; step-up; audit rows; no hard delete | locally tested for the new panel and tables |

## 3. Owner decisions and actions

1. **OPEN-13: template wording, languages and Meta submission.** Nothing is submitted. The register (`message-template-register.md`) lists exactly what would need approving: four shopper order updates (utility).
2. **OPEN-14: when to turn on conversational confirmations by default,** which depends on re-measuring the confidence threshold through DeepSeek (P9).
3. **OPEN-15: double opt-in for shopper messages** (F2 gap 1). Recommended before `consumerMessaging` is turned on for anyone.
4. Confirm J1-J15 (`decisions.md` C8), especially: a suppressed event is never sent later (J2); no old-to-new currency conversion (J10); the 10-minute expiry and the code rules (J8-J9); the shared-phone session of 8 hours (J12).
5. Add to the activation checklist: `CONSUMER_MESSAGING_ENABLED`, `MESSAGING_LOG_PEPPER` (a secret; without it the phone hashes in the log use a fixed default), `OFFLINE_DRAFTS_ENABLED`, `OFFLINE_PUBLIC_URL`, `TRUST_PROXY`, plus the Phase 4-6 items (`STOREFRONT_ENABLED`, `OPERATIONS_SWEEP_ENABLED`, `OUTBOX_SWEEP_ENABLED`, Redis rate limiting, `HEARTBEAT_ENABLED`).
6. Before any messaging is turned on: update the public notices that deploy with the landing site. The FAQ answer "Will TradePal message my customers?" and the privacy page section "Messages to shoppers" are edited in the repo (`landing/`) but **not deployed**; the old text said TradePal never messages customers.
7. Run the alert channel check against the real email service once, and the offline page on a real low-end phone (airplane mode, sync, logout, shared mode).
8. Run `scripts/rehearseMigrations.sh` on a restored backup or authorise a local Postgres download (carried).
9. Unchanged: OPEN-1..12, heartbeat monitor, alert sender, Railway relink, pawaPay and mobile-money approvals; keep `dailyClose` off.

## 4. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access; **no message sent to anyone** (every send in the tests went to a recording transport or a faked HTTP client); no real money moved; nothing configured in any dashboard. The landing page edits are in the repository only.

AWAITING: APPROVED: PHASE 7
