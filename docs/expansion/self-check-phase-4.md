# Phase 4 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (still the same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Delivered: the consumer storefront on the same inventory and accounting services as B2B: shop set-up, public catalog, basket split per seller, checkout with stock holds, pickup and delivery workflows with a handover code, cancellation and refund policies, returns that restock at original cost, held-payment exceptions (late / over / under / wrong currency), simulator-only online payment, support cases that name the responsible party, the public web pages, the seller's `/store` WhatsApp commands, the admin support-cases panel, payment-exception and store-order views, overview counts, and the expiry sweep. Everything is **implemented** and **locally tested**; nothing is sandbox-verified, partner-approved, production-configured or production-activated. New flags, all default OFF: `storefront`, `storefrontOnlinePayment`; new environment switches, all default OFF: `STOREFRONT_ENABLED`, `STOREFRONT_SIMULATOR_ENABLED`.

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **89 files / 1009 tests pass** (Phase 3 ended at 83 / 944) |
| `admin-frontend` `npx vitest run` + `npm run build` | 9 files / 43 tests pass; build succeeds |
| New in Phase 4 | `storeCheckout` 16, `storeOrders` 19, `storefrontWeb` 16, `adminSupport` 6, `storeCommands` 7, `storeSweep` 1 (65 backend tests) + 3 frontend |

## 1. Failure scenarios

### F1. The Phase 4 migration misbehaves on the real database
- Same standing caveat as Phases 1-3: never run on a real server (no Postgres or Docker available here); `scripts/rehearseMigrations.sh` is the required step and has still never been run against a database.
- Specific to this migration: it is additive (no `ALTER`/`DROP` of existing objects, no `ALTER TYPE`; searched), but it adds 12 tables, a status-guard trigger, no-delete and TRUNCATE guards, RLS policies and two OFF flags. The Railway role's privileges to create functions, triggers and policies are unverified (PGlite is superuser).

### F2. Overselling: two shoppers, or a shopper and a trade order or a till sale, take the last units
- Holds use the same reservation service as B2B, inside the placement transaction; a second shopper for the last units is refused ("not enough in stock") and a B2B-vs-consumer race is tested (scenario 2).
- **Not proven: real interleaving.** PGlite serialises sessions, so two real connections contending for `FOR UPDATE` was never exercised. The concurrent-refund test (guarded `UPDATE ... <= paid`) passes, but on a serialised connection. **Unverified until run against a real Postgres under load.**
- **Not examined:** whether a legacy till sale (the original WhatsApp sale flow) respects consumer holds when `stockV2` is off for a business. The shop requires `stockV2`; keep it on for any business that sells in both places until this is checked.

### F3. A shopper sees another shopper's order, or a seller's private numbers
- Evidence it does not happen: orders are reachable only by a 48-hex secret token (stored hashed, 90-day expiry); guessing an id, order number, phone number, an upper-cased or altered token all give the same 404 (tested through the web). The public catalog is a field projection: no cost, no stock count, no tenant id (tested). The order view never contains cost or other customers. Output is HTML-escaped (tested with script and attribute injection in shop title, about text and search term). Pages that carry a secret are `no-store`, `noindex`, `no-referrer`.
- **Limits:** whoever holds the link IS the buyer (a forwarded link, a shared phone, browser history). The 6-digit handover code only proves the person at the counter also has the link. There is no phone-verified lookup, so a shopper who loses the link cannot recover the order except by phoning the seller. The buyer's phone number is deliberately not echoed on the page, but the seller sees it (and `/store cases` shows the contact for a reported problem).

### F4. Money is wrong: a payment lands on the wrong order, is applied twice, or is lost
- Applied once per (provider, externalId); a replay changes nothing (tested). A payment can never be applied to another seller's order (tested). Late, after-cancel, over, under and wrong-currency payments are HELD as exceptions, never silently applied, and the seller resolves them by refund, re-reserve (only if the stock can be taken again; a cancelled order is never reinstated) or part-payment (scenario 10, tested).
- Refunds are bounded by what was paid (guarded update plus a database CHECK) and once per request.
- **Known gaps:** (a) a wrong-currency payment is held and **not journaled**, so the books do not show that money until a person acts; (b) real payment is **simulator only**; nothing has been tested against a real provider, and the simulator callback route is an HTTP-less inbox path in this phase, not an exposed endpoint; (c) refunds are recorded, not sent: a seller who records a mobile-money refund must actually pay it; (d) there is no reconciliation of provider settlement (Phase 5), so Provider clearing only grows; (e) an admin cannot resolve a payment exception, only the seller can.

### F5. A cancellation or refund promise is not kept
- One policy, shared by page and backend; the order page reports exactly what the backend allows (tested for every status). A cancellation request after confirmation is a request, not a cancellation; a refund request is not a refund; the seller decides. Returns restock at the cost the goods left at.
- **Gaps:** a seller can sit on a request forever (no timeout and no escalation, only the support case route); there is no partial return of some lines in the web form (the web form returns everything remaining, or refunds an amount); no photo evidence; no automatic refund on a failed delivery that was paid online (the seller must refund).

### F6. The public site is abused (flooding, forged posts, oversize bodies)
- Per-client rate limits on reads, writes and checkout (tested); form posts from another origin are refused; bodies over 20 KB are refused; quantities, units and field lengths are validated; a basket holds at most 100 lines. When `RATE_LIMIT_BACKEND` provides Redis the limits are shared across instances; **otherwise they are per process and reset on restart**.
- **Not verified:** behaviour behind the real proxy (set `TRUST_PROXY` or every shopper looks like one address and one limit applies to all), and no CAPTCHA or bot defence exists. Rate limits keyed on address are weak against a determined distributed attacker. Nothing stops someone filling a shop with unconfirmed orders to hold its stock until the hold lapses (60 min online, 48 h pay-on-collection); the seller can cancel them, and the per-address checkout limit is 10 per hour.

### F7. Pages are unusable on a low-end phone or slow link
- Server-rendered HTML, no JavaScript, one inline stylesheet; a 30-item shop page is under 30 KB (tested). **Measured on real devices and real networks: no.** Layout was never viewed on a small screen in this phase; that is Phase 8's measurement work. Images are plain `<img>` from a seller-supplied address and are blocked by the API's default security headers (the helmet CSP allows only the site's own images), so product photos will not show until that is deliberately configured.

### F8. A seller cannot run the shop, or a support case falls through
- The seller can do everything through `/store` commands (set-up, list, orders, confirm, ready, dispatch, hand over with the code, cancel, failed delivery, record payment, decide requests, refunds, held payments, cases). Permissions follow the matrix (a clerk can move orders but not set up or decide refunds; tested). **No web or app screen exists for the seller**; WhatsApp commands are the only interface, and **no message is ever sent to the shopper** (Phase 7), so a shopper learns about progress only by opening their order link.
- Support cases always carry a responsible party and the admin can reassign, annotate and close (audited, step-up, append-only notes, tested). A case does not notify anyone: it shows in the admin panel, the overview count and the seller's `/store cases`. If nobody looks, nothing happens.

### F9. Scale limits that will bite
- The next order number is found by reading every existing order reference for that seller (`nextStoreReference`): fine for the pilot, a hot spot at thousands of orders per seller, and two simultaneous placements for one seller can pick the same number; the unique key makes one fail and the placement retries a few times, then tells that shopper "try again" rather than duplicating (the retry was exercised only on a serialised connection). The public catalog is paginated at 30; search is a simple text match.

### F10. Flags and switches are mis-set in production
- With `STOREFRONT_ENABLED` unset the router is not mounted at all. A shop appears only when its business flag `storefront` is on AND the owner opened it AND the business is active. Online payment additionally needs `STOREFRONT_SIMULATOR_ENABLED=true`, a seller flag, a simulator secret, and `NODE_ENV` not production; the production check is tested explicitly. **The expiry sweep and the outbox sweep must run** (`OPERATIONS_SWEEP_ENABLED`, `OUTBOX_SWEEP_ENABLED`) or holds never lapse and simulator callbacks wait in the inbox; add both to the activation checklist.

## 2. Master-prompt scenarios

| # | Scenario | Phase 4 status |
|---|---|---|
| 10 | Late / duplicate / over / under / wrong-currency payment: never silently applied, always recoverable | locally tested (service level and through the web callback path) |
| 18 | A shopper sees nothing private: no cost, stock numbers, tenant ids; orders reachable only by secret token | locally tested through the web |
| 19 | Pickup and delivery workflows complete: hold, confirm, ready, dispatch, hand over with code, failed delivery, cancellation, refund, return | locally tested (service level, web pages and `/store` commands) |
| 2 | No oversell across channels | locally tested on the in-process database (F2) |
| 25 | Existing behaviour identical with the new flags off | locally tested: `/store` answers "Unrecognized command" and is absent from `/help`; the earlier suites are green |
| 28/29 | Admin writes audited; no hard delete on financial tables | locally tested (support writes audited with correlation id; store tables refuse delete) |
| 14/13 | Merchant payment routes cannot reach pawaPay; subscription money untouched | the simulator still refuses `PLATFORM_SUBSCRIPTION`; no change to `Invoice` or pawaPay code |

## 3. Owner decisions and actions

1. Confirm F1-F13 (`decisions.md` C5), especially: revenue only at hand-over (F4), token-only order access with no shopper accounts (F2), the 60 min / 48 h holds (F3), and that a seller can sit on a request (F5).
2. Add to the activation checklist: `STOREFRONT_ENABLED=true`, `STOREFRONT_PUBLIC_URL`, `TRUST_PROXY`, `OPERATIONS_SWEEP_ENABLED=true`, `OUTBOX_SWEEP_ENABLED=true`, Redis rate limiting (`RATE_LIMIT_BACKEND`), `HEARTBEAT_ENABLED`; keep `STOREFRONT_SIMULATOR_ENABLED` OFF anywhere shoppers are real.
3. Decide whether sellers need a web screen now or can live with WhatsApp commands until the Phase 7 channel work.
4. Decide product photos (host, allowed origins and the security-header change).
5. Run `scripts/rehearseMigrations.sh` on a restored backup, or authorise a local Postgres download for a first real-server run (carried from Phase 2).
6. Unchanged: OPEN-1..11, heartbeat monitor, alert sender, Railway relink, pawaPay and mobile-money approvals; keep `dailyClose` off.

## 4. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access; no messages sent to anyone. The simulator moves no money and contacts no provider.

AWAITING: APPROVED: PHASE 4
