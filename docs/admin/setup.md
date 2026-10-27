# Admin console: setup and day-to-day access

Everything here is for the deployment owner. No step creates a password for you, and no step prints a secret. Replace the `<…>` placeholders yourself.

## 1. Switches (names only; set values in the deployment environment, never in a file)

| Variable | What it does | Default |
|---|---|---|
| `ADMIN_CONSOLE_ENABLED` | Master switch. The admin API is mounted only when this is exactly `true`; otherwise every `/admin` path is an ordinary 404 | off |
| `ADMIN_MODULE_*` (`MERCHANTS`, `STAFF`, `AUDIT`, `HEALTH`, `SUBSCRIPTIONS`, `MODERATION`, `ORDERS`, `WHATSAPP`, `PAYMENTS`, `REFUNDS`, `CONFIG`, `REPORTS`) | Per-module switches (read by the module code as it is built; each also needs the master switch) | off |
| `ADMIN_REFUND_EXECUTION_ENABLED` | Refund execution stays off until `true` (and needs the Refunds module on) | off |
| `ADMIN_MFA_ENFORCE` | Second factor for everyone. On unless set to `false` (emergency only) | on |
| `ADMIN_MFA_ENCRYPTION_KEY` | 64 hex characters: encrypts authenticator secrets. **Must be set before anyone can enrol**; keep it out of source control and back it up with your other secrets (losing it means every person re-enrols) | unset |
| `ADMIN_SESSION_ABSOLUTE_MINUTES`, `ADMIN_SESSION_IDLE_MINUTES`, `ADMIN_REAUTH_MINUTES`, `ADMIN_PRE_MFA_MINUTES` | Session rules (defaults 720, 30, 10, 15) | defaults |
| `ADMIN_FRONTEND_PUBLIC_URL` | Where invitation links point | unset |
| `ADMIN_FRONTEND_ORIGINS` | Browser origins allowed to call the API (existing) | unset |
| `ADMIN_BOOTSTRAP_ALLOWED` | Lets the two commands in sections 3 and 4 run. Set it **only on the command line for that one run** (as shown below); never leave it in the Railway variables | unset |

Generate the encryption key on your own machine and put it straight into the Railway variable, for example `openssl rand -hex 32`, without pasting it into a chat or a file.

## 2. Local run

```bash
cp .env.example .env                  # then fill your own local values
npm install
npx prisma migrate deploy            # against your LOCAL database only
ADMIN_CONSOLE_ENABLED=true ADMIN_MFA_ENCRYPTION_KEY=<64 hex> ADMIN_JWT_SECRET=<your secret> npm run dev:server
cd admin-frontend && cp .env.example .env && npm install && npm run dev    # http://localhost:5173
```

Set `ADMIN_FRONTEND_ORIGINS=http://localhost:5173` for the API. The first person needs an account: section 3.

## 3. First owner (a command run with deployment credentials, never a web page)

These commands talk to the production database through its **public** address, which only someone with Railway access can fetch. (`railway run` hands a process the private address, which a laptop cannot reach.) The address is read into the command without being printed:

```bash
DB="$(railway variables -s Postgres -e production --json | jq -r .DATABASE_PUBLIC_URL)"
```

An account must exist first. Create it without putting the password on the command line:

```bash
read -rs ADMIN_NEW_PASSWORD && export ADMIN_NEW_PASSWORD        # type the password, nothing is shown
DATABASE_URL="$DB" npx tsx scripts/createAdminUser.ts <email> "<name>" SUPPORT
unset ADMIN_NEW_PASSWORD
```

Then promote it to platform owner. The command refuses unless `ADMIN_BOOTSTRAP_ALLOWED=true` is set for the run, requires the identity typed twice, does nothing if the person is already an owner, and writes an audit row and a security event with actor `system:bootstrap`:

```bash
DATABASE_URL="$DB" ADMIN_BOOTSTRAP_ALLOWED=true \
  npx tsx scripts/bootstrapOwner.ts --identity <staff-id-or-exact-email> --confirm <the same value again>
unset DB
```

`ADMIN_BOOTSTRAP_ALLOWED` is set on the command line for that one run only, so there is nothing to remove from the server afterwards. If you do put it in the Railway variables, remove it as soon as you are done. The new owner is made to set up an authenticator at first sign-in.

Two owners already exist in production (created 2026-07-23 and 2026-08-01); they only need the second-factor step the first time they sign in after the console is switched on.

## 4. Authenticator (second factor) and recovery

- **First sign-in**: after the password the console shows a setup key (and a link for phones). Add it to an authenticator app, enter the first 6-digit code, then **save the 8 recovery codes**: they are shown once, each works once, and only their hashes are stored.
- **Each sign-in**: password, then the 6-digit code. A code works once (a stolen, already-used code is refused) and five wrong tries in ten minutes lock the attempts for a while.
- **Lost phone**: use a recovery code on the same screen. Make new codes straight afterwards (a fresh confirmation is needed).
- **Lost phone and no codes**: an owner verifies the person out of band, then runs, on the server:

  ```bash
  DB="$(railway variables -s Postgres -e production --json | jq -r .DATABASE_PUBLIC_URL)"
  DATABASE_URL="$DB" ADMIN_BOOTSTRAP_ALLOWED=true \
    npx tsx scripts/resetAdminMfa.ts --identity <staff-id-or-exact-email> --confirm <the same value again>
  unset DB
  ```

  This removes that person's authenticator and codes, ends their sessions, writes an audit row (actor `system:bootstrap`), and makes them enrol again. There is no public bypass.

## 4b. WhatsApp codes (an alternative second step)

Staff can get their sign-in code in a WhatsApp message instead of using an authenticator app. It is **off** until all of this is true:

1. A Meta **Authentication** message template exists and is approved in WhatsApp Business Manager (nothing in this repo creates or submits it). Suggested: name `tradepal_admin_code`, language English, category Authentication, body "{{1}} is your verification code." with the **copy code** button, code expiry 5 minutes, security recommendation on. The code sends the one-time code into both the body and the button, as Meta requires.
2. `WHATSAPP_ADMIN_CODE_TEMPLATE_NAME` (and `WHATSAPP_ADMIN_CODE_TEMPLATE_LANGUAGE` if it is not `en`) are set on the server, and the existing `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are present.
3. `ADMIN_WHATSAPP_CODES_ENABLED=true`.

If the switch is on but the template or credentials are missing, the server logs one warning at start and the option is simply not shown.

How it behaves: at first-time setup the person chooses an authenticator app or WhatsApp (type the number with its country code, receive a code, enter it). A person who already has an app can add WhatsApp from **Account security** (the console asks for password and a current code first). At sign-in they choose either way. A code is six digits, lasts 5 minutes, works once, only in the sign-in that asked for it, and allows 5 wrong tries. Recovery codes work for either kind of person. Turning WhatsApp off needs an authenticator app on the account, so nobody is locked out. A second-factor reset (`scripts/resetAdminMfa.ts`) removes the number too.

Limits on sending (so this cannot be used to message strangers): 3 codes per account per 10 minutes, 10 per account per day, 3 first-time proofs per number per hour, and never to a number on the STOP block list.

## 5. Staff: invitations, roles, accounts

Owners use the console (Staff access) or the API:

| Action | API | Notes |
|---|---|---|
| Invite | `POST /admin/staff/invitations` `{email, role}` | The link is shown **once** to the owner; send it yourself. It works once, expires in 72 hours, and is tied to that email. The code does not send email |
| Resend | `POST /admin/staff/invitations/:id/resend` | The old link stops working |
| Revoke | `POST /admin/staff/invitations/:id/revoke` | |
| Change a role | `PUT /admin/staff/:id/role` `{role, reason}` | Not your own. The last active owner cannot be demoted (the database refuses) |
| Disable / enable | `POST /admin/staff/:id/disable` or `/enable` `{reason}` | Disabling ends the person's sessions at once |
| End someone's sessions | `POST /admin/staff/:id/revoke-sessions` `{reason}` | |
| Hand over ownership | `POST /admin/staff/ownership-transfers` `{toAdminId}`, then the other person `POST …/:id/accept` | Both need a recent confirmation; one open transfer per owner; expires in 24 hours |
| Security events | `GET /admin/security-events` | Owners and the auditor role |

Every one of these needs a confirmation (password + authenticator code) no older than 10 minutes; the console asks for it when needed.

## 6. Admin-site hosting note

The console is a static site. Its `vercel.json` sends every path to the app (fixes the 404 on direct links such as `/login`). The live site is `https://admin.tradepalafrica.com` (also reachable at the older `admin-frontend-pipe-field-os-pro.vercel.app` address).
