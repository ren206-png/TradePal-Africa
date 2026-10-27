# Admin console: security notes

Status: **complete for this task (Phases 2 to 4).** Nothing here has been deployed, and nothing has been reviewed by a person outside this project; a human penetration test has not been done.

## Access boundaries (as built in Phase 2)

| Boundary | How it is enforced | Where |
|---|---|---|
| Two separate staff and merchant worlds | Different tables (`AdminUser` vs memberships), different role names, every staff permission is `admin:`-prefixed, no platform role holds a merchant permission | `src/auth/permissions.ts`, `tests/permissions.test.ts` |
| Who the caller is | A signed token whose id is a server-side session row; the account and role are re-read from the database on every request; a disabled account fails on its next request | `src/admin/authMiddleware.ts` |
| An admin token is only an admin token | Admin audience claim (`tradepal-admin`) on every token; a token for any other audience is refused; the session row's audience is fixed to `admin` by a database check | `src/admin/auth.ts`, migration `20261102000000` |
| Session lifetime | Absolute 12 h, idle 30 min, a half-open sign-in (password but no second factor yet) ends after 15 min; all configurable; ended sessions are refused | `src/admin/adminSessions.ts`, `tests/adminSignIn.test.ts` |
| Second factor | TOTP via `otplib` v13; secret encrypted at rest (AES-256-GCM); a used code is refused (replay guard moved atomically); 8 single-use recovery codes stored as bcrypt hashes; until the factor is done only enrolment, challenge, session info and sign-out are reachable | `src/admin/mfa.ts`, `authMiddleware.ts` (`requireMfaComplete`) |
| Recent re-authentication | Staff and ownership changes need password + second factor within 10 min (`requireRecentReauth`) | `authMiddleware.ts`, `staffAdmin.ts` |
| Brute force | Per-email (5 per 15 min), per caller address (30 per 15 min, set in `server.ts`), per admin for second-factor and re-auth attempts (5 per 10 min); Redis-backed when `RATE_LIMIT_BACKEND=redis` so the limits hold across instances, otherwise per process (single replica today) | `adminAuthRoutes.ts`, `server.ts` |
| No account enumeration | Identical 401 for unknown email, wrong password and disabled account; invitation tokens answer the same for unknown, used, revoked and expired | `tests/adminSignIn.test.ts`, `tests/adminStaff.test.ts` |
| The owner cannot be lost | Database trigger refuses to delete, disable or demote the last active owner, serialized with an advisory lock; verified under real parallel connections | migration `20261102000000`, `tests/adminFoundation.test.ts` |
| Master switch | `ADMIN_CONSOLE_ENABLED` unset or not exactly `true`: nothing is mounted; every `/admin` path is the application's ordinary 404, byte for byte (modulo the echoed path) | `src/admin/mount.ts`, `tests/adminStaff.test.ts` |
| Cache | Every admin response carries `Cache-Control: no-store`, `Pragma: no-cache` | `mount.ts` |

## What the records never contain

Security events and audit rows hold no password, code, token, secret, recovery code, or raw address. The caller's address, user agent and the email that was tried are stored only as keyed hashes (key derived from `ADMIN_JWT_SECRET`). `tests/adminSignIn.test.ts` ("contains no password, code, token…") checks the event table after a full run of sign-ins.

## Audit design

Sensitive staff changes write their audit row in the **same transaction** as the change (`staffAdmin.ts`). The audit table is append-only through a **database trigger** (`AuditLog_append_only`), not through database grants: the trigger refuses UPDATE and DELETE (and TRUNCATE is blocked) for every role, including the application role. It is a strong control against accidents and application bugs; it is not "tamper-proof": a database superuser can still disable a trigger.

## Deviations from the brief, and why

1. **Bearer token in the browser, not a cookie.** The console is a static site on another origin from the API. A cookie would add cross-site request handling for no gain, and the server-side session row still gives revocation, idle timeout and the re-auth window. Cost: a script injected into the console page could read the token (the console uses no third-party scripts and `helmet` sets security headers on the API; the static site's own headers are Vercel defaults and have not been hardened here).
2. **Invitation emails are not sent by this code.** The owner is shown the link once and delivers it. Rationale: nothing sends a real invitation during development, and no email sender for staff exists yet. When one is wired, it must receive the link, not store it.
3. **Authenticator setup shows a setup key and a link, not a QR image**, to avoid adding another dependency. Authenticator apps accept a typed key.
4. **Roles keep their existing names**; the brief's names are labels (see `permission-matrix.md`).

## Known limits

- In-memory limiters reset when the server restarts and are per process unless `RATE_LIMIT_BACKEND=redis`.
- Denied-access events are written for every 401/403 with no throttle; a flood would fill the table (add a per-address sample if this is ever seen).
- The first-owner and reset commands trust whoever can fetch the production database address (Railway access); that is the intended boundary. The gate variable is meant to be set per run, not stored on the server.


## Phase 3 and 4 additions

| Area | What was done | Where |
|---|---|---|
| Least privilege for newer roles | The old open read routes now need a named permission for a role added after the original four; the original four keep their access | `requireLegacyAccess` in `platformGuards.ts`, pinned by `tests/adminModules.test.ts` |
| Module switches | Off by default; an off or unknown module is a 404; every route is mapped to a module in one place | `src/admin/moduleGate.ts` |
| Two-person refunds | Frozen payload and hash; a different approver; self-approval and edits refused by the database; execution off by default; actor, role and hash re-checked at run time; money rules stay in the billing code | `src/admin/refundRequests.ts`, `tests/adminRefunds.test.ts` |
| Atomicity | Staff changes, invitations, ownership transfers and every refund step write the audit row **in the same transaction** as the change. The one exception is refund execution: the provider call cannot share a database transaction, so the order is "call the billing code (which reserves funds and allows one refund in flight per payment), then mark executed"; a crash between the two leaves the request approved and a repeat is refused by the billing code, never doubled | `staffAdmin.ts`, `refundRequests.ts` |
| Input validation | Every admin body, query and path parameter in the new routes is parsed with `zod` and unknown keys are rejected; the older routes keep their own validation | `src/admin/*` |
| Uploads | The admin API accepts no file upload | n/a |
| Environments | Test, staging and production configuration are separate deployments; the console shows an environment badge from the server (`production` is shown in red); seeds and test data are synthetic only | `Layout.tsx`, `/admin/me/permissions` |
| Offline | The admin site has no service worker and queues nothing offline, so no privileged change can be queued on a device | `tests/adminHardening.test.ts` (10 and 11) |
| Site headers | `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and `Cache-Control: no-store` for pages (assets stay cacheable). **No `Content-Security-Policy` is set** (not tuned, and a wrong one would break the console); recommended as follow-up | `admin-frontend/vercel.json` |

## Adversarial self-check (the 14 scenarios)

| # | Scenario | Why it fails | Proof |
|---|---|---|---|
| 1 | A merchant owner edits their own profile data to say `role: platform_owner` | Staff roles live only in the staff table and are written only by the staff services; a correctly signed token that *claims* a higher role is ignored (role is read from the database each request); no other source file writes the staff role | `tests/adminHardening.test.ts` block 1 |
| 2 | A consumer replays an admin URL with a merchant session cookie | Admin uses only a bearer token with the admin audience and a live server session; cookies are ignored; a token for another audience is refused | `adminHardening` 2, `adminSignIn` (wrong audience, no session) |
| 3 | A staff member is revoked while their queued refund waits | Execution re-reads the account, role, permission and role version at run time and refuses; nothing is sent | `adminHardening` 3, `adminRefunds` ("re-checks the person"), `adminStaff` (re-checking a queued action) |
| 4 | Two owners demote each other within 50 ms | The database serializes owner-reducing changes with an advisory lock; exactly one wins, an owner always remains (verified under real parallel connections, 6 rounds through the API and 12 at the database) | `adminHardening` 4 and `adminFoundation` (real Postgres only) |
| 5 | An expired or already-used invitation token is replayed | Single use is claimed atomically; expired, used, revoked and unknown tokens all answer identically | `adminStaff` (invitations) |
| 6 | A payment webhook arrives three times; an admin presses retry twice | The webhook acknowledges a duplicate and applies the payment once; admin replay of a dead callback is 200 once and 409 after; refund execute twice sends one | `tests/paymentWebhook.test.ts`, `tests/adminPayments.test.ts`, `adminRefunds` |
| 7 | `next=//evil.example` on sign-in | The sign-in screen has no redirect parameter at all: it always goes to the console or the authenticator step; the API has no redirect flow | `admin-frontend/src/pages/LoginPage.test.tsx` |
| 8 | A support agent asks for an export of "all" organizations (`org=*`) | A wildcard is a literal that matches nothing; per-business routes answer 403 or 404; a merchant's books need a recorded support-access reason while that flag is on | `adminHardening` 8 |
| 9 | A console toggle tries to enable pawaPay production | Production charging is blocked by the deployment-level activation variable, checked before the flag and the country switch; no admin route writes configuration | `adminHardening` 9, `tests/billingRenewal.test.ts` |
| 10 | The owner signs out and a second person presses Back | The API forbids caching; sign-out wipes the token, profile and authenticator state; pages hold no data once the session state is gone; the site asks browsers not to cache pages | `adminHardening` 10, `AuthContext.test.tsx` |
| 11 | A service worker caches an admin export URL | The admin site has no service worker; exports are never cached (`no-store`) | `adminHardening` 11 |
| 12 | Sign-in attempts spread over two server instances | With `RATE_LIMIT_BACKEND=redis` the count is shared, so two instances together allow no more than one | `adminHardening` 12 (two routers, one shared limiter) |
| 13 | An exported cell containing `=HYPERLINK(...)` | `csvText` prefixes `=`, `+`, `-`, `@`, tab and carriage return, including after leading spaces | `adminHardening` 13, `tests/reports.test.ts`, `tests/adminTransactions.test.ts` |
| 14 | An audit row is updated through the application's database connection | A database trigger refuses UPDATE, DELETE and TRUNCATE on the audit table for every role | `tests/dbProtection.test.ts`, `tests/adminFoundation.test.ts` |

## Known limits (consolidated)

In-memory limiters reset on restart and are per process unless Redis is on; denied-access events are unthrottled; no Content-Security-Policy on the admin site; the audit trigger is not tamper-proof against a database superuser; no human penetration test or dependency audit; `admin:unmask_pii` and `admin:read_whatsapp_conversation` are defined but have no route; invitation links are copied by the owner, not emailed.


## WhatsApp codes (second factor option)

- A WhatsApp code is weaker than an authenticator app: it depends on the phone number (a SIM swap or a hijacked WhatsApp account defeats it) and on Meta delivering the message. It is offered because some staff will not use an app; the Account security page and the setup screen say the app is the stronger choice only where the owner wants to say so. Owners who want to hold staff to the app can leave `ADMIN_WHATSAPP_CODES_ENABLED` off.
- Storage: the number is encrypted with `ADMIN_MFA_ENCRYPTION_KEY` (readable back only as its last four digits); a code is stored only as a keyed hash. Security events hold at most the last four digits, never a code or a full number.
- The first code to a new number proves control of it; until then it is not a factor. Adding a second method to an account that already has one needs a fully signed-in session and a fresh password-plus-code confirmation, so a stolen password alone cannot add the attacker's own phone. (Like the authenticator app, a person with no factor yet can set up the first one with only the password: an attacker who knows a new account's password before its owner has enrolled could enrol first. Invited staff enrol straight after accepting.)
- Codes are bound to the sign-in session, single use, 5-minute expiry, 5 tries; send limits are per account and per new number; a number on the STOP list is never messaged.
- Registered as message class `STAFF_SIGNIN_CODE` (docs/expansion/message-template-register.md); sent through the WhatsApp transport, outside the consumer-consent pipeline because the recipient is staff who gave their own number.
