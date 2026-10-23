# pawaPay audit and activation checklist

Date: 2026-10-20 · Phase 0 (read-only) · Repo commit `86a072d`
Status vocabulary: implemented / locally tested / sandbox verified / partner approved / production configured / production activated.

## 1. Verdict

| Question | Answer |
|---|---|
| Is there pawaPay code? | Yes: ~900 lines across `src/pawapay/`, `src/domain/pawapayCollection.ts`, wiring in `server.ts`, `worker.ts`, `paymentRequestExpiryWorker.ts`, `commandRouter.ts`. |
| What does it do? | **Merchant → customer** mobile-money collection (`/collect <customer> <amount> <phone>`): the customer gets a PIN prompt; on success a sale payment is recorded on the *merchant's* ledger. |
| Is that the allowed use? | **No.** Owner decision 5: pawaPay is *exclusively* for businesses paying TradePal subscriptions. The existing code is the one use that decision forbids. |
| Is pawaPay used for subscriptions today? | **No.** Subscription checkout is Flutterwave (`src/domain/payments.ts:103,219`). No pawaPay code touches `Subscription`, `Invoice` or entitlements. |
| Status | implemented + locally tested (`tests/pawapayCollection.test.ts`, pass). **Not** sandbox verified, partner approved, configured or activated. |
| Data at risk | None: `PawaPayDeposit` has **0 rows** in production; `PAWAPAY_API_TOKEN` is set on **no** production service. |

## 2. Call sites (non-test)

| File | Role |
|---|---|
| `src/pawapay/client.ts` | HTTP client; paths `POST /deposits` (:196), `GET /deposits/{id}` (:238), `GET /active-conf` (:296); bearer token; default **sandbox** base URL unless `PAWAPAY_API_BASE_URL` set. API generation: **v2** (`…/v2`, header comment lines 3-4). |
| `src/pawapay/countries.ts` | currency → pawaPay alpha-3 country (SLE→SLE, LRD→LBR, GMD→GMB). |
| `src/pawapay/webhookRoute.ts` | `POST /webhooks/pawapay` handler (mounted in `src/server.ts:165-172`, only when a token exists). |
| `src/domain/pawapayCollection.ts` | `initiatePawaPayCollection` (:108), `settlePawaPayDeposit` (:280), `reconcilePendingPawaPayDeposits` (:462); active-config cache keyed by base URL (:60-68). |
| `src/commands/commandRouter.ts:829` | `handleCollect`, gated by `customerPaymentLinks` flag (off) and `ctx.pawapay` being configured. |
| `src/paymentRequestExpiryWorker.ts` | reconciles pending deposits before expiring requests. |
| `src/config/paymentsEnv.ts:72-85` | `PAWAPAY_API_TOKEN`, `PAWAPAY_API_BASE_URL`. |
| `src/db/tenantScope.ts` | `PawaPayDeposit` is tenant-scoped. |
| `prisma` | `PawaPayDeposit` (1:1 with `PaymentRequest`), migration `20260820000000_pawapay_deposits`. |

## 3. Credential and callback handling

- Credential source: env `PAWAPAY_API_TOKEN` (server + workers), never logged by the client. No signing key material exists in the code.
- Callback route: `POST /webhooks/pawapay`. **Does not verify** the documented RFC 9421 `Signature` / `Signature-Input` / `Content-Digest` headers. Instead, for terminal statuses it re-fetches the deposit from pawaPay's authenticated API and acts on that (`webhookRoute.ts:14-23`, `pawapayCollection.ts:295`). Unknown deposit ids return 200; unexpected errors return 500 so pawaPay retries (documented: up to 8 attempts over ~25 min, 200 required).
- Documented requirements not implemented: signature verification, `created`/`expires` replay check, key fetch from the public-keys endpoint and rotation handling, dashboard "signed callbacks" enablement, use of `signatureConfiguration` from active-conf (docs: `signedCallbacks`, `signedRequestsOnly`), the separate provider-availability endpoint (pawaPay recommends checking it before each payment), and the documented `DELAYED` operation status (the client type only models `OPERATIONAL | CLOSED`, `client.ts:96`).
- Implemented and correct: the provider's active-conf entry must be `OPERATIONAL` before initiating (`pawapayCollection.ts:139`); `decimalsInAmount` `NONE` vs `TWO_PLACES` is honoured when formatting the amount (`pawapayCollection.ts:147`, `client.ts:97`) with tests for both (`tests/pawapayCollection.test.ts:209,246`). Amount is sent as a major-unit decimal string; conversion is tested.
- Idempotency: caller-generated `depositId` stored *before* the call (`client.ts:188-190`), conditional `updateMany` claim on settlement, DB unique on `PawaPayDeposit.paymentRequestId`.

## 4. Provider-coverage claim to correct

`src/pawapay/client.ts:7-9` comments list `AFRIMONEY_SLE` and `ORANGE_SLE` as Sierra Leone providers. pawaPay's public markets page lists **only Orange** for Sierra Leone (fetched 2026-10-20), and the owner's appendix says not to assume Afrimoney. The comment is unverified and should not drive behaviour; the code already resolves providers from `GET /active-conf` per account, which is the correct source of truth. Action: treat the comment as stale and verify against the account's active configuration once a token exists.

## 5. Conflict with decisions and safe migration proposal

Conflicts: decision 5 (pawaPay exclusively for subscriptions), decision 7 (subscription and merchant-sales money stay separate). Also, `/collect` credits a *merchant* sale to the merchant ledger while the money lands in TradePal's pawaPay account — there is no settlement-to-merchant path.

Proposed migration (additive; nothing deleted; **needs owner approval, Phase 1**):

1. Add a `purpose` discriminator (`PLATFORM_SUBSCRIPTION | MERCHANT_SALE`) to the payment domain types; server-side validation derives it from the code path, never from request input.
2. Make the pawaPay adapter accept **only** `PLATFORM_SUBSCRIPTION`; a `MERCHANT_SALE` attempt must fail closed with a typed error. Negative test with a forged purpose (scenario 14).
3. Quarantine `/collect`: remove it from `/help` (already flag-gated), hard-lock its flag off via a purpose guard, keep the code and tests (history preserved) behind a clearly named module boundary. No data migration (0 rows).
4. Build the subscription path separately in Phase 6 (plan versions, invoices, billing attempts, idempotent period allocation, entitlement events, refunds for subscription charges only).
5. Treat Flutterwave's two uses the same way: split subscription vs merchant-sale purposes and keep merchant paylinks disabled until proceeds can settle to the merchant under an approved arrangement.

## 6. Activation checklist (all items open; none authorise production use)

| # | Condition | Owner of action | Status |
|---|---|---|---|
| 1 | pawaPay account approved for the subscription use case; contract/KYC complete | Owner | **Pending** (application not yet answered) |
| 2 | Sandbox token created; sandbox base URL configured in a non-production environment | Owner | Not started |
| 3 | Active configuration retrieved for SL (and LR/GM if used); operators, limits, decimals recorded in `merchant-provider-matrix.md` | Engineering after #2 | Not started |
| 4 | Signed callbacks enabled in the dashboard; RFC 9421 verification + digest + replay check implemented and tested; key rotation handled | Engineering + owner (dashboard) | Not implemented |
| 5 | Subscription purpose boundary + negative tests (scenarios 13-16) green | Engineering | Not started |
| 6 | Sandbox end-to-end: success, failure, timeout, duplicate callback, late success | Engineering | Not started |
| 7 | Production token + `PAWAPAY_API_BASE_URL` set per environment; fail closed on environment/account mismatch | Owner | Not started |
| 8 | Controlled live verification (per operator: SIM, wallet, balance; PIN within ~1-20 s) per pawaPay go-live page | Owner | Not started |
| 9 | Production feature flag created, default off; tested in production before market launch (pawaPay recommendation) | Owner | Not started |
| 10 | Owner activation conditions met and recorded in `decisions.md` | Owner | Not started |

Sources: pawaPay docs fetched 2026-10-20 — signatures, what_to_know, going_live, active-configuration, markets (URLs in `merchant-provider-matrix.md` §Sources).

## 7. Phase 6 status (subscriptions through pawaPay)

Date: 2026-10-20 · all items **implemented** and **locally tested** against an in-memory reading of pawaPay's documentation; **none** sandbox verified, partner approved, production configured or production activated.

**API version and reuse (section 13 asks for a migration-cost assessment before any rewrite).** The existing client targets pawaPay v2 and works, so it was extended, not replaced: `getAvailability`, `initiateRefund`, `checkRefundStatus`, `getPublicKeys`, `pawaPayEnvironmentOf` and the account's `signatureConfiguration` were added. Migration cost avoided: nil. The quarantined merchant collection code and its `/webhooks/pawapay` route are unchanged.

**What was built**: versioned plans and country prices; customer-authorised renewal invoices and charges; callbacks verified per RFC 9421 + Content-Digest; an authenticated lookup before any entitlement; idempotent allocation to invoice and period; the entitlement matrix and its history; refunds of subscription charges; reconciliation; the admin subscriptions panel; owner commands; a per-country new-charge switch. See `decisions.md` C7.

**pawaPay documentation used (fetched 2026-10-20)** and where it is silent:
- Signatures (`/v2/docs/signatures`): headers `Signature: sig-pp=:<base64>:`, `Signature-Input`, `Signature-Date`, `Content-Type`, `Content-Digest` (sha-256 or sha-512); covered components `@method`, `@authority`, `@path`, `signature-date`, `content-digest`, `content-type`; parameters `alg`, `keyid`, `created`, `expires` (sample window 60 s); algorithms `rsa-pss-sha512`, `rsa-v1_5-sha256`, `ecdsa-p256-sha256`, `ecdsa-p384-sha384`; keys from `GET /v2/public-key/http` returning `[{id, key (PEM)}]`. **Silent on**: key rotation, replay or clock-skew rules, verification pseudocode, how `keyid` relates to the key endpoint's `id`. Our choices: require `@method`, `@authority`, `@path` and `content-digest`; require `created` and `expires`; 60 s skew; maximum lifetime 10 minutes; one key refresh (at most every 30 s) on an unknown `keyid`; `@authority` and path come from OUR configuration, never the Host header.
- Callbacks (`what_to_know`): up to 8 deliveries over about 25 minutes, 200 OK required, 10 s to connect and 30 s to answer, respond immediately and process asynchronously, callback handlers must be idempotent, resend available for 90 days. Our route answers 200 after persisting and the inbox handler is idempotent.
- Refunds (`/v2/docs/refunds`): `POST /v2/refunds` with `refundId`, `depositId`, optional `amount` and `currency`; statuses ACCEPTED/REJECTED on initiation; status values ACCEPTED, ENQUEUED, PROCESSING, IN_RECONCILIATION, COMPLETED, FAILED; partial refunds allowed up to the deposit; one refund at a time per deposit (`REFUND_IN_PROGRESS`); recheck cycle suggested after 15 minutes; on HTTP 500 do not assume failure. The page names the status check `/payouts/{id}` in prose while the API reference says `GET /v2/refunds/{refundId}`: **we use the API reference path; verify in the sandbox.**
- Active configuration: top-level `companyName` and `signatureConfiguration { signedRequestsOnly, signedCallbacks }`; the schema says `minAmount`/`maxAmount`, an example says `minTransactionLimit`/`maxTransactionLimit`: both are accepted until a sandbox settles it.
- Availability (`GET /v2/availability`): `OPERATIONAL | DELAYED | CLOSED` per provider and operation. We refuse a new charge unless `OPERATIONAL` (the DELAYED behaviour is documented for payouts only; refusing is the conservative reading).

**Dashboard configuration required before activation** (nothing here has been done): enable signed callbacks; set the DEPOSIT and REFUND callback URLs to `https://<public host>/webhooks/pawapay/billing` (not the older `/webhooks/pawapay`); allow pawaPay's callback addresses if IP allow-listing is used (the list is on their page, not reproduced here); create sandbox and production tokens separately.

**Environment variables** (all unset by default, which means billing is unavailable): `PAWAPAY_API_TOKEN`, `PAWAPAY_API_BASE_URL` (`https://api.sandbox.pawapay.io/v2` or `https://api.pawapay.io/v2`), `PAWAPAY_ENVIRONMENT` (`SANDBOX` or `PRODUCTION`, must match the URL and `NODE_ENV`), `PAWAPAY_BILLING_CALLBACK_AUTHORITY` (our public host, exactly as in the dashboard URL), `PAWAPAY_BILLING_PRODUCTION_ACTIVATED=true` (production only, set by the owner when the conditions below are met), `PAWAPAY_REQUIRE_SIGNED_CALLBACKS` (default on). Also the per-business flags `pawapayBilling` and `subscriptionEntitlements`, and the per-country switch in the admin console (default off).

**Activation checklist, updated** (still: nothing authorises production use):

| # | Condition | Status |
|---|---|---|
| 1 | pawaPay account approved for the subscription use case | **Pending** (owner) |
| 2 | Sandbox token; sandbox base URL in a non-production environment | Not started (owner) |
| 3 | Active configuration retrieved for SL (and LR/GM if used); operators, limits, decimals recorded | Not started (needs #2) |
| 4 | Signed callbacks enabled in the dashboard; RFC 9421 verification, digest, window checks and key rotation implemented and tested | **Verification implemented and locally tested** (vectors made by an independent signer in the test, not captured from pawaPay); dashboard step pending (owner) |
| 5 | Subscription purpose boundary and negative tests (scenarios 13-16) green | **Done locally** |
| 6 | Sandbox end to end: success, failure, timeout, duplicate callback, late success | Not started (needs #2); the same scenarios pass against the in-memory fake |
| 7 | Production token and URL per environment; fail closed on environment or account mismatch | **Guards implemented and tested**; credentials pending (owner) |
| 8 | Controlled live verification per operator (SIM, wallet, balance, PIN within ~1-20 s) | Not started (owner) |
| 9 | Production feature flag exists, default off; tested in production before launch | **Flags and switch exist, default off**; production test pending |
| 10 | Owner's activation conditions met and recorded in `decisions.md` | Not started (owner) |
