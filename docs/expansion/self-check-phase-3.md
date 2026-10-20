# Phase 3 self-check

Date: 2026-10-20 · branch `expansion/phase-1` (still the same local branch; **not pushed, not merged, nothing deployed, no migration run against any database except the in-process test database**) · status vocabulary per master prompt section 0.11.

Delivered: B2B trade (partners, explicit links, shared wholesale catalog, purchase and sales orders with quotes, held stock, shipments, goods receipts, invoices, credit notes, payment tracking, trade credit rules, the merchant-payment simulator), the reorder engine (Tier 1 rules and suggestions; Tier 2 shadow forecasting; nightly-style scoring; the per-merchant promotion gate), merchant WhatsApp commands, the admin reorder and forecasting panel, trade views in the admin, the demo path, and docs. Everything is **implemented** and **locally tested**; nothing is sandbox-verified, partner-approved, production-configured or production-activated. New flags, all default OFF: `tradeOrders`, `reorderRules`, `reorderForecastShadow`, `reorderForecastLive`.

## 0. Test evidence

| Suite | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean |
| Backend `npx vitest run` | **83 files / 944 tests pass** (Phase 2 ended at 75 / 879). The contention-sensitive suites (`tradeRules`, `tradeFlow`, `stockV2`, `forecast`) were run three more times in a row, all passing |
| `admin-frontend` `npx vitest run` + `npm run build` | 8 files / 40 tests pass; build succeeds |
| New in Phase 3 | `tradeFlow` 5, `tradeRules` 21, `reorderTier1` 10, `forecast` 13, `adminReorder` 6, `tradeCommands` 4, `tradeSetupCommands` 3, `demoPath` 1 (63 backend tests) + 4 frontend; `stockV2` +2 (partial shipments keep the hold; composable transactions) |
| Demo | `npx tsx scripts/demoWholesale.ts` runs the whole path and prints each step; pinned by `tests/demoPath.test.ts` |

## 1. Failure scenarios

### F1. The Phase 3 migration misbehaves on the real database
- Same standing caveat as Phases 1-2: never run on a real server (no Postgres or Docker available here); `scripts/rehearseMigrations.sh` is the required step and has still never been run against a database.
- Specific to this migration: it contains no `ALTER`/`DROP` of existing columns and no `ALTER TYPE` (searched), but it **does add two guard triggers to the existing `FeatureFlag` and `BusinessFeatureFlag` tables** (they refuse to switch the forecast gate on except through its function). They fire only for that one flag key, so existing rows and flags are untouched, but a mistake here would affect flag writes, so it deserves the rehearsal.

### F2. The two businesses' copies of a document drift apart
- **By design this is eventual consistency:** a change on one side reaches the other by outbox event. **Production must run with `OUTBOX_SWEEP_ENABLED=true`** or no trade event is ever delivered (the merchant commands also deliver inline as a fast path, which hides this in demos). Add this to the activation checklist.
- **Evidence it converges:** handlers set state from the source row instead of adding to it and are guarded by unique counterpart ids; a test replays every handler twice over all processed events and asserts no document, payment, journal or stock row changed. Price changes between "send" and delivery reject the buyer's request with a reason instead of guessing.
- **Not tested:** a crash injected between the two steps of one handler (the design tolerates it because each step is idempotent, but it was reasoned, not exercised); handler failures that exhaust retries go to the dead-letter queue and raise an incident, but there is no admin button to replay them yet (the replay functions exist from Phase 1).

### F3. Overselling or double-holding under real concurrency
- A trade acceptance racing a consumer reservation for the last units, and the partial-shipment hold logic, pass on the in-process database. **PGlite serialises sessions, so true interleaving of two real connections is still unproven** (same caveat as Phase 2, F2).

### F4. The books on the two sides disagree, or money is double counted
- **Evidence for consistency:** both sides' trial balances stay balanced through the whole scenario; invoices sum to the order total exactly (cumulative rounding); the retailer's booked payable (660,000 less the 9,167 short credit) equals what the invoices say is owing; a payment cannot push an invoice past what remains owing (guarded update plus a database CHECK).
- **Known gaps:** (a) if a buyer reports a payment AND the seller separately records the same receipt, the seller can confirm both and apply a duplicate as long as the invoice still has room. Only a person catches this; no duplicate detection exists. (b) Credit notes cover short delivery only; damaged goods stay payable and price disputes or returns have no workflow yet (Phase 4 returns), so those would be settled outside the system. (c) The buyer's payable is receipt-based, so paying before receiving leaves a debit balance on Payables.

### F5. A credit limit is exceeded
- The limit and overdue rules are checked at acceptance and an override needs the owner and a reason (audited, tested). **The check is not atomic across concurrent acceptances**: two simultaneous accepts for the same customer can each pass and together exceed the limit. Exposure counts unpaid invoices and accepted-unshipped value, not quotes that are holding stock.

### F6. A forecast reaches a merchant who should not see it, or the gate is bypassed
- **Evidence it does not:** with the gate closed, suggestions are Tier 1 only, the live hook returns null, and the merchant-facing output contains none of the forecast fields (tested); no merchant command or API reads predictions. The gate opens only through one function; the generic flag tools, the global default, and direct SQL are all refused (tested, the last by a database trigger); every attempt including rejected ones is recorded with the metrics at the time; closing is always allowed.
- **Limits:** the trigger is an integrity guard, not a security boundary against someone with database superuser access who knows its transaction-local marker. Forecasts and scores exist only once the sweep (`OPERATIONS_SWEEP_ENABLED=true`) runs them; it is off by default.

### F7. The forecast is bad and we would not know
- **Honest status: the method's quality on real merchants is unknown.** The demo and tests use synthetic alternating demand, deliberately built so smoothing beats "same as last week" (about 42% lower error in the demo); that says nothing about a real shop. Pilot merchants have a few weeks of history; intermittent demand leaves many zero-demand weeks, which have no percentage error, so few periods may count toward the gate. Stock-out periods are excluded (demand censored). The thresholds are **unset on purpose** (OPEN-6): until the owner sets them nothing can be promoted.

### F8. A link or invitation is abused
- The invitation token is a one-time bearer secret (stored hashed, 7-day expiry, single use, tested: reuse, wrong code, expiry, inviter accepting their own, and a third party reusing a used token all fail). If the token leaks before use, whoever holds it and runs `/join` becomes the linked partner. That grants nothing automatically: the inviter must explicitly share a price list, orders still need acceptance, credit rules apply, and the inviter can unlink at once. TradePal never messages the invited party; the inviter passes the code themselves.

### F9. Prices or units change under an order
- Acceptance freezes terms and the database refuses later edits (tested with direct SQL). A buyer whose unit differs from the supplier's (bottle vs piece) is refused at ordering. A pack size changed after submission is caught when the supplier's side re-resolves the price.

### F10. Parts of the flow are not usable by a merchant yet
Be explicit about what a merchant can and cannot do today (flags permitting): **can**, by WhatsApp command: set reorder rules, see suggestions with their working, make draft orders, add partners, invite/join, set terms, publish items and wholesale prices, share the list, send, accept, ship, receive a whole shipment, list and pay invoices, confirm or reject reported payments. **Cannot, except through services/admin view:** quotes, partial receipts with damaged or short units (the service supports them and the credit-note path derives from them), issuing short-delivery credit notes, renewing an expired hold, and any web/PWA screen. The admin console can view all of it but offers no trade intervention beyond the existing transaction void.

## 2. Master-prompt scenarios

| # | Scenario | Phase 3 status |
|---|---|---|
| 1 | Wholesaler sells to retailer; partial goods receipt updates only received stock; linked records tenant-isolated | locally tested (`tradeFlow`: 40 of 48 units received then the rest; stock 40; AP and invoice figures reconcile; neither side can read the other's rows or costs) |
| 31 | Tier 1 matches the documented arithmetic; draft only, never places or pays | locally tested (exact text and inputs asserted; accepting creates a DRAFT and leaves stock, journals, outbox and payments untouched) |
| 32 | Tier 2 predictions invisible with the gate off; scored vs actuals and vs Tier 1; flipping below threshold rejected; above threshold audited | locally tested |
| 25 | Existing behaviour identical with all new flags off | locally tested: the exact `/help` text and "unrecognized" replies are pinned for every new command, and the whole earlier suite is green |
| 2 | No oversell across channels | locally tested for B2B vs consumer on the in-process database (F3) |
| 28/29 | Admin writes audited; no hard delete on financial tables | locally tested; new trade tables are append-only or delete-protected, and the gate and thresholds are audited |
| 14/13 | Merchant payment routes cannot reach pawaPay; forged purpose refused | the simulator refuses a body claiming `PLATFORM_SUBSCRIPTION` (tested) |

## 3. Owner decisions and actions

1. Confirm E1-E15 (`decisions.md` C4), especially: revenue at shipment and buyer booking at receipt (E5/E6), the 14-day default hold (E4), and `ses-v1` as the starting forecasting method (E11).
2. **OPEN-6: set the promotion thresholds** (minimum scored weeks, minimum improvement over Tier 1) when you are ready. Until then nothing can be promoted.
3. Add to the activation checklist: `OUTBOX_SWEEP_ENABLED=true` and `OPERATIONS_SWEEP_ENABLED=true` (and `HEARTBEAT_ENABLED` on both services) before turning `tradeOrders` or the reorder flags on for anyone.
4. Run `scripts/rehearseMigrations.sh` on a restored backup, or authorise a local Postgres download for a first real-server run (carried from Phase 2).
5. Decide whether quotes, damaged/short receipts and credit notes should get WhatsApp commands now or wait for the web surface (Phase 4/7).
6. Unchanged: OPEN-1..11, heartbeat monitor, alert sender, Railway relink, pawaPay and mobile-money approvals; keep `dailyClose` off.

## 4. What was and was not touched

Nothing pushed, merged, deployed or migrated for real. No credentials read or entered; no production access; no messages sent. The simulator moves no money and contacts no provider.
