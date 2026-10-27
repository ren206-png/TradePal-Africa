# Admin console: security notes

Status: **started in Phase 2.** The adversarial self-check (14 scenarios) is completed in Phase 4. Nothing here has been deployed or reviewed by a person outside this project; a human penetration test has not been done.

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
