# Performance baseline (Phase 8)

**What this is:** reproducible measurements of the pages a person on a slow link loads, and budgets that fail the build when a page gets heavier. **What it is not:** a measurement on low-end hardware or on a throttled or real mobile network. Nobody has done that. Every timing below is from a fast development machine over loopback against an in-process database, and is NOT what a phone sees.

Reproduce: `npx tsx scripts/perfServer.ts` (synthetic data only), then `npx tsx scripts/perfMeasure.ts http://127.0.0.1:4173 <token printed by the first command>`. Budgets are enforced by `tests/perfBudgets.test.ts`.

## Measured 2026-10-20 (15 runs after one warm-up; loopback; Apple laptop, 11 cores)

| Page | KB uncompressed | KB on the wire | Server time to first byte, median / p95 (ms) | Transfer time of the wire bytes: 2G 50 kbit/s / slow 3G 400 kbit/s / 3G 1.6 Mbit/s (**computed from bytes, not measured**) |
|---|---|---|---|---|
| Shop page, 30 products | 25.7 | 2.8 (gzip) | 41 / 47 | 0.5 s / 0.1 s / 0.0 s |
| Basket (empty) | 1.5 | 1.5 | 0 / 1 | 0.2 s / 0.0 s / 0.0 s |
| Phone page (HTML) | 2.7 | 1.2 (gzip) | 0 / 0 | 0.2 s / 0.0 s / 0.0 s |
| Phone page script | 10.7 | 3.4 (gzip) | 0 / 0 | 0.6 s / 0.1 s / 0.0 s |
| Phone service worker | 0.9 | 0.9 | 0 / 0 | 0.2 s / 0.0 s / 0.0 s |
| Report: sales, this month (JSON) | 2.8 | 2.8 | 14 / 18 | 0.5 s / 0.1 s / 0.0 s |
| Report: sales (CSV) | 1.2 | 1.2 | 14 / 19 | 0.2 s / 0.0 s / 0.0 s |
| Report: inventory valuation (JSON) | 6.0 | 6.0 | 14 / 19 | 1.0 s / 0.1 s / 0.0 s |

In a real browser (the built-in browser pane, unthrottled, 11 cores): the shop page transferred **3,150 bytes** (2,850 body), made **0 further requests**, reached DOMContentLoaded at **69 ms** and load at **80 ms**. The page uses no script and one inline stylesheet.

Admin console bundle (`admin-frontend`, built): **93 KB** of script and **2.8 KB** of CSS, gzip. It is a staff tool; it is not meant for a slow link and has not been tuned for one.

## What changed because of this

Before this phase the shop page went out **uncompressed: 25.7 KB, about 4 seconds on a 2G link**; compressed it is 2.8 KB, about 0.5 seconds (computed). A narrow gzip step now covers only the public catalogue pages and the phone page assets. It is deliberately **not** applied to anything that carries an order link, a pickup code or the basket (compressing a secret next to attacker-influenced text is the BREACH pattern); those pages are small (a basket is 1.5 KB; an order page under 20 KB by budget).

## Budgets (ceilings, enforced in CI; not claims about speed)

Shop page with 30 products: < 32 KB uncompressed and < 5 KB on the wire · basket < 8 KB · order page < 20 KB · phone page < 6 KB · phone script < 20 KB · service worker < 2 KB · admin script < 130 KB and CSS < 6 KB (gzip) · **no third-party host, font, stylesheet or script on any public page** · the shop and basket pages contain no `<script>`.

## Behaviour checked in a real browser (Chrome, 2026-10-20)

The phone page's service worker registers with scope `/m/` and caches exactly `/m/` and `/m/app.js` (nothing else, never an API response). With the server **stopped**, reloading the page still loads it from the cache, still shows the drafts saved on the phone, says "Cannot reach TradePal right now. Your drafts are safe on this phone." and keeps the draft when a send fails. Disconnecting removed the service worker, the caches and the local database. (The built-in browser pane does not support service workers, so this was done in Chrome.) Two defects were found and fixed this way: the draft list stayed blank when the server was unreachable but the phone still reported "online", and disconnecting threw away unsent drafts without warning (it now asks first).

## NOT measured (do not quote as measured)

- Anything on **low-end hardware** (CPU-bound parsing, memory, a 1 GB phone) or on a **throttled / real mobile network**: no tool in this environment could throttle, and no device was available.
- **Usable-content timing** other than the unthrottled DOMContentLoaded above; first-load transfer on a cold cache over a real link; repeated-navigation timing with a warm cache on a phone; reconnect behaviour after a long offline period; failed-request handling mid-sync.
- Server time under **load** or against a real Postgres: the 14-41 ms figures are PGlite on loopback.
- Images: product photos are blocked by the API's security headers, so image weight is not part of any page yet (open since Phase 4).
- The admin console on any connection.
