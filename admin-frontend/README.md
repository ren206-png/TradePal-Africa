# TradePal Admin Frontend

A minimal Vite + React + TypeScript single-page app for the internal ops team,
talking to the existing `/admin/*` JSON API exposed by the main backend
(`src/admin/adminRoutes.ts`). This package is standalone — it has its own
`package.json` and is not part of the backend's TypeScript project or test
suite.

## What it covers

- **Login** (`POST /admin/login`) — stores the returned JWT in
  `localStorage` and attaches it as `Authorization: Bearer <token>` on every
  subsequent request.
- **Businesses** — paginated list, and a detail page showing a business's
  merchants.
- **Deletion requests** — paginated list, filterable by status
  (PENDING/COMPLETED/REJECTED).
- **Audit logs** — paginated list, optionally filtered by business ID.
- **Mobile money alerts** — paginated list, filterable by status and business
  ID; renders `amountMinor` (a serialized bigint) as a decimal amount for
  display only.
- **Merchant phone number changes** (`POST /admin/merchants/:id/phone-number`)
  — the one write action, only rendered/enabled for admins whose role is
  `SUPER_ADMIN` or `SUPPORT`, mirroring the backend's `requireAdminRole` gate.
  This is a UI-level convenience only; the backend independently enforces the
  same RBAC rule, so hiding the button client-side is not the security
  boundary.

Logging out calls `POST /admin/logout` (best-effort) to revoke the JWT
server-side, then always clears local state regardless of whether that call
succeeds.

## Running it

```bash
cp .env.example .env       # point VITE_API_BASE_URL at your backend if it's not on localhost:3000
npm install
npm run dev                # starts the Vite dev server
```

The backend (`npm run dev:server` from the repo root) must be running and
reachable at `VITE_API_BASE_URL` (defaults to `http://localhost:3000`) for
login and data requests to succeed. Since the backend and this frontend are
served from different origins in development, the backend also needs
`ADMIN_FRONTEND_ORIGINS` set to this app's dev origin (e.g.
`http://localhost:5173`) in its `.env` — see the root `.env.example` and the
CORS setup in `src/server.ts`. Unset/empty means no cross-origin browser
access is allowed, so requests from here will fail until it's configured.

## Known gaps / not built

- **No automated tests** for this package (no Vitest/RTL setup) — the rest of
  the repo has strong test coverage; this package currently only has
  `tsc -b` (typecheck) and `vite build` as verification, run manually, not
  wired into any CI step.
- **No token refresh** — if the JWT expires mid-session, the next API call
  will 401 and surface as a generic error on whatever page the admin is on,
  rather than redirecting to `/login` automatically.
- **No production deployment config** (Dockerfile, static hosting config,
  etc.) — this is dev-only scaffolding for now.
