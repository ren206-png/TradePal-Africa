# Security checks (Phase 8)

Automated, repeatable, and read from the real route tables, so a route added later is covered without anyone editing a list. **This is not a human penetration test and not a dependency audit** (see "Not done").

## Admin API (`tests/securityAdminRoutes.test.ts`, scenario 27)

Every admin route (found by walking the router; over 100) is called with: no token, a malformed header, garbage, a token signed with the wrong secret, an expired token, a Basic scheme, a token carrying a **merchant's** claims, a token with no role, a token with a merchant role name, a logged-out token, a disabled admin's token. All are refused (401, or 4xx). Further:
- the read-only analyst is refused (403) on **every** write; support is refused on the owner-only controls;
- hostile ids (SQL fragments, path traversal, NUL, markup, 5,000 characters, template syntax) and hostile query strings never give a 500 and never echo markup;
- no response contains a password hash, token hash, signing secret or access token;
- login answers identically for an unknown address and a wrong password;
- an admin token is useless on the phone API and a phone token is useless on the admin API; no platform role name carries any merchant permission.

## Public surfaces (`tests/securityPublic.test.ts`)

The storefront, marketplace, phone page and API and the provider webhooks: hostile path parameters and POST bodies (form and JSON, including prototype-pollution shapes) never give a 500 or a stack trace; webhooks refuse unsigned or forged requests without telling an attacker anything; pages carrying a secret are `no-store` and `noindex`; no permissive CORS on the phone API; guessed order links all look alike.

## Found and fixed in this phase

1. **A removed, disabled or demoted admin kept their old power until their token expired (12 hours).** The auth middleware trusted the token. It now re-reads the account on every request (role from the database), and an admin can be **disabled** (`AdminUser.disabledAt`, `scripts/disableAdmin.ts`); a disabled admin cannot log in and their token stops working on the next request. There was no way to disable an admin at all before.
2. **A NUL character (`%00`) anywhere in a path, query or body caused a database error and a 500** on the storefront, marketplace and other routes (Postgres refuses it in text). All public and admin routers now refuse it with a 400 before any query. (Not applied to the Meta/Flutterwave/legacy pawaPay webhooks, to leave their behaviour unchanged; a NUL in a WhatsApp message body would still fail the JSON insert, as before.)
3. `canMerchant` / `canPlatform` threw a TypeError for an unknown role; they now return false.
4. Cost-bearing reports (margin, stock value, cash flow, payment reconciliation) are not readable by a sales clerk.

## Not done / known limits

- No human penetration test. No fuzzing beyond the fixed hostile strings above. No dependency vulnerability audit was run.
- Admin login is rate-limited per email address only, in memory, per process; there is no per-address limit and no multi-factor step. Admin tokens last 12 hours and are not bound to a device.
- The phone token is held in IndexedDB; script injection on the page could read it. The page's content policy allows only its own script and the page builds no HTML from data (asserted), which reduces but does not remove that risk.
- The STOP handler and block list use the unscoped database client by design; row-level security is still inert in production (the role step has not been taken).
- Webhook signature checking for pawaPay billing has never seen a real callback (Phase 6).
