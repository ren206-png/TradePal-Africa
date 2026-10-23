# Merchant sales-payment provider matrix (first draft)

Date: 2026-10-20 · Phase 0 · documentation-based only (nothing sandbox-verified)
Scope: providers that could collect **merchant sales** (B2B invoices, B2C checkout) and settle to the selling merchant. **pawaPay is excluded by decision 5** (subscriptions only) and appears below only for context.
Legend: **C** confirmed in cited documentation · **Cond** conditional on a stated requirement · **U** unknown / not stated in the cited source. Every cell cites a source in §Sources. Where a page was silent the cell says U, not an inference.

## 1. Summary

**No provider is established.** On current evidence none of the candidates can be activated for Sierra Leone merchant sales without a commercial arrangement the owner has not yet made. Per §12 the plan is: complete the adapter contract and a deterministic simulator, enable manual recorded payment methods with evidence labels, keep live online checkout unavailable, and ask the owner for the provider decision below.

## 2. Candidates

| Capability | Orange Money Web Payment | Afrimoney (Africell SL) merchant payments | Flutterwave (already in code) | pawaPay (context only; not eligible) |
|---|---|---|---|---|
| Sierra Leone listed | **C** — listed among available countries [S1][S2] | **C** — Afrimoney merchant payments exist for customers [S4] | **U/negative** — Sierra Leone appears for **bank payouts**, not for mobile-money **collections** [S6] | **C** — lists **Orange** for Sierra Leone [S5]; no Afrimoney |
| Merchant onboarding | **Cond** — Orange Money merchants only; sign up in an Orange store; "fully KYA compliant"; local operator contact [S1][S2] | **U** — customer steps only; merchant requirements not stated [S4] | **Cond** — account + KYC/approval for the product [S6] | account + contract (not in scope) |
| Programmatic API for online checkout | **Cond** — "restricted ecosystem with limited API exposure", central-bank approval; full docs provided by the operator after onboarding [S1][S2] | **U** — no API / online checkout stated [S4] | **C** for supported countries; **not shown for SL mobile money** [S6] | **C** (v2 deposits) [S5][S7] |
| Create payment / status / callback endpoints | **U** — not on the page [S1] | **U** [S4] | **C** generally (hosted checkout, verify transaction — used in repo) | **C** [S7] |
| Callback authentication | **U** [S1][S2] | **U** | repo uses `verif-hash` header + transaction re-verification (`src/flutterwave/signature.ts`, `webhookRoute.ts`) | **C** RFC 9421 signed callbacks, optional, dashboard-enabled [S8] |
| Refunds | **U** [S1][S2] | **U** | **U** (not evaluated) | **C** refund endpoint exists [S9] |
| Settlement destination / timing | **U** [S2] | **U** [S4] | **U** for merchant sub-accounts (repo has none; funds would land in TradePal's account) | n/a |
| Fees | **U** — "speak to your local Orange operator" [S2] | **U** — merchant tariff not published (P2P/cash-out only) [S4] | **U** | n/a |
| Limits | **U** | **U** | **U** | **C** per operator via active-conf [S10] |
| Sandbox | **U** — "can be tested prior to going live"; details by email at go-live [S1][S2] | **U** | **C** (test keys) | **C** (sandbox base URL + token) [S11] |
| Customer experience | USSD OTP typed into the web payment page [S1] | USSD `*161#` → Merchant Payments → amount + reference + PIN [S4] | card / MoMo where supported | PIN prompt on the phone [S9] |

## 3. What this means for the build

1. **No candidate is verifiably usable in Sierra Leone today.** Orange Money is the most plausible (listed for SL, but restricted access, operator onboarding, undocumented API). Afrimoney shows a customer-facing merchant flow but no integration path. Flutterwave's SL support appears to be bank payouts only.
2. **Adapter contract and simulator are unblocked** (capabilities, create checkout, status, callback verify/normalise, refunds, settlement evidence; unsupported operations return explicit capability errors).
3. **Manual evidence-labelled payments** (cash, "mobile money received", bank transfer) are the only live path until a provider is approved; a forwarded SMS or screenshot is a *proposed* match, never provider-confirmed evidence (§11).
4. **Money-flow rule for any chosen provider:** settles to the selling merchant under that merchant's own arrangement; TradePal never pools merchant proceeds. The existing Flutterwave merchant-paylink code violates this (single TradePal credential, no sub-account) and stays quarantined.

## 4. Decisions needed from the owner (do not infer)

- Which provider(s) to approach for Sierra Leone merchant sales (candidates: Orange Money via a merchant/integrator arrangement; Afrimoney merchant acquiring if Africell offers an API) and who holds the commercial relationship.
- Whether merchants contract directly (their own credentials stored encrypted per merchant, TradePal only integrates) or via an integrator/aggregator that settles to merchants.
- Whether Flutterwave remains in scope for subscriptions only, merchant sales (needs sub-accounts), both, or neither.
- Liberia and Guinea: separate arrangements; pawaPay's page lists MTN/Orange for Liberia, nothing for Guinea or Gambia [S5]. Proximity is not interoperability.

## Sources (fetched 2026-10-20)

- [S1] Orange Money Web Payment — https://developer.orange.com/apis/om-webpay
- [S2] Orange Money Web Payment FAQ — https://developer.orange.com/apis/om-webpay/faq
- [S4] Africell Sierra Leone Afrimoney merchant payments — https://www.africell.sl/afrimoney_services/merchant-payments/
- [S5] pawaPay markets — https://www.pawapay.io/markets
- [S6] Flutterwave mobile money / Sierra Leone docs (search result summary) — https://developer.flutterwave.com/docs/mobile-money/ , https://developer.flutterwave.com/docs/sierra-leone
- [S7] pawaPay docs — https://docs.pawapay.io/v2/docs/welcome
- [S8] pawaPay signatures — https://docs.pawapay.io/v2/docs/signatures
- [S9] pawaPay implementation considerations — https://docs.pawapay.io/v2/docs/what_to_know
- [S10] pawaPay active configuration — https://docs.pawapay.io/v2/api-reference/toolkit/active-configuration
- [S11] pawaPay go-live — https://docs.pawapay.io/v2/docs/going_live

Caveat: sources describe products and policies; they do not certify readiness or authorise a funds flow. Re-check current documentation and account capabilities at implementation time. The Flutterwave Sierra Leone finding came from a search summary of Flutterwave's own docs and should be confirmed in the Flutterwave dashboard before any decision rests on it.

## 5. Phase 5: how each capability maps onto the adapter contract (`src/payments/adapter.ts`)

Status vocabulary: **C** confirmed in cited documentation, **Cond** conditional on a stated requirement, **U** unknown. "Built" means the adapter operation exists in the contract and is exercised against the simulator only.

| Adapter operation | Contract | Orange Money Web Payment | Afrimoney merchant payments | Flutterwave (SL mobile money) | Simulator (built, tests only) |
|---|---|---|---|---|---|
| `createPayment` (accepted = PENDING, never paid) | built | **U** (docs after onboarding) | **U** (no API stated) | **U** for SL collections | yes |
| `getStatus` (authenticated lookup) | built | **U** | **U** | **C** generally (verify transaction); not shown for SL | yes |
| `receiveCallback` (authenticate, normalise) | built | **U** scheme | **U** | **C** `verif-hash` header + re-verification: a WEAK scheme, so a callback is only a hint and the status endpoint decides | yes (HMAC, STRONG) |
| `refund` / `getRefundStatus` | built | **U** | **U** | **U** | yes |
| `settlementReport` (pull) | built as an optional capability | **U** | **U** | **U** | deliberately NOT supported: returns a capability error, so that path is exercised |
| Merchant arrangement, destination, secrets | `ProviderConnection` (one per merchant per provider; `credentialRef` names a server-side secret; no URL or secret field) | merchant onboards with the operator | **U** | account + KYC; settles to TradePal unless sub-accounts | simulated wallet |
| Sandbox | n/a | **U** | **U** | **C** test keys | yes |

**Provider decision still needed from the owner (unchanged from section 4, now with the build waiting on it):** which provider to approach for Sierra Leone merchant sales, who holds the commercial relationship, and whether merchants contract directly (their own credentials, referenced by name) or through an integrator. Until then: **no real adapter is registered** (the production registry is empty), live online checkout is unavailable, and merchants record manual payments with evidence labels. A real adapter is one reviewed change: implement the interface, add its id to the purpose policy table, and register it.

Source freshness: sections 1-4 were fetched 2026-10-20 and not re-fetched in Phase 5; nothing in the Phase 5 build depends on a provider capability being confirmed.
