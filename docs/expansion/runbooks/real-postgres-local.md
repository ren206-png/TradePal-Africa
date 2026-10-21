# Runbook: a real Postgres on this laptop (for the full suite and the migration rehearsal)

Why: the default test database is PGlite, an in-process Postgres with one connection. A real server shows what PGlite cannot: real locks, real parallel connections, a non-superuser owner and real planner behaviour. This is how it was done on 2026-10-20 (all of it in the session's scratch folder, nothing installed system-wide, no production data).

## Start a throw-away server
```bash
# one-time: download the server binaries into a scratch folder (about 40 MB)
mkdir -p ~/pgscratch && cd ~/pgscratch && npm init -y >/dev/null && npm i @embedded-postgres/darwin-arm64
B=~/pgscratch/node_modules/@embedded-postgres/darwin-arm64/native/bin

$B/initdb -D ~/pgscratch/data -U postgres --auth=trust -E UTF8 --locale=C
$B/pg_ctl -D ~/pgscratch/data -l ~/pgscratch/pg.log -w \
  -o "-p 54329 -c listen_addresses=127.0.0.1 -c max_connections=500 -c fsync=off -c timezone=UTC" start
psql postgresql://postgres@127.0.0.1:54329/postgres -c "select version()"
```
`timezone=UTC` matters: Railway runs UTC. `fsync=off` is fine for a scratch server (never use it for real data).

## Run the whole suite on it
```bash
TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:54329/postgres npx vitest run --no-file-parallelism
```
Each test file creates its own database on that server and drops it afterwards. The URL must be a local address (the helper refuses anything else). `tests/realPostgresConcurrency.test.ts` runs **only** in this mode (genuine parallel connections: oversell, order numbering, credit limit, inbox claim, photo limit, bulk-edit batch, courier booking).

## Rehearse the migrations
```bash
psql postgresql://postgres@127.0.0.1:54329/postgres -c "create role app login createdb password 'app'" -c "create database rehearse owner app"
REHEARSAL_DATABASE_URL=postgresql://app:app@127.0.0.1:54329/rehearse ./scripts/rehearseMigrations.sh
```
This applies every migration as an ordinary (non-superuser) owner, like Railway's role. The legacy-data version (3 businesses, 4 merchants, every transaction type, subscriptions, then every expansion migration, then the app) is part of the suite: `tests/migrationRehearsal.test.ts` also runs on the real server in the mode above.

## Stop it
```bash
$B/pg_ctl -D ~/pgscratch/data stop
```
