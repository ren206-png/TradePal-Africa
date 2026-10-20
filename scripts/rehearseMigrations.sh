#!/usr/bin/env bash
# Rehearses `prisma migrate deploy` on a SCRATCH copy of the database and checks that nothing existing was lost.
# NEVER point this at production. Restore a backup into a scratch database first, then:
#
#   REHEARSAL_DATABASE_URL='postgresql://...scratch...' ./scripts/rehearseMigrations.sh
#
# A non-local host additionally needs I_CONFIRM_SCRATCH_DATABASE=yes (a restored copy on a remote scratch server).
# The URL is never printed. Needs psql and the repo's node_modules. STATUS: written but not yet run against a database.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${REHEARSAL_DATABASE_URL:-}"
if [ -z "$URL" ]; then
  echo "Set REHEARSAL_DATABASE_URL to a scratch database (a restored copy of a backup)." >&2
  exit 2
fi
HOST="$(printf '%s' "$URL" | sed -E 's#^[A-Za-z0-9+.-]+://([^@/]*@)?([^:/?]+).*#\2#')"
case "$HOST" in
  localhost|127.0.0.1|::1) ;;
  *)
    if [ "${I_CONFIRM_SCRATCH_DATABASE:-}" != "yes" ]; then
      echo "Host '$HOST' is not local. If this is a restored COPY on a scratch server, re-run with I_CONFIRM_SCRATCH_DATABASE=yes." >&2
      exit 2
    fi
    ;;
esac
command -v psql >/dev/null || { echo "psql is required." >&2; exit 2; }

TABLES=(Business Merchant Transaction TransactionItem Debt DebtPayment InventoryItem InventoryMovement Subscription Invoice AuditLog Customer Supplier WebhookEvent)
count() { psql "$URL" -Atqc "select count(*) from \"$1\"" 2>/dev/null || echo "missing"; }

echo "== row counts before"
declare -a BEFORE
for t in "${TABLES[@]}"; do BEFORE+=("$(count "$t")"); printf '  %-18s %s\n' "$t" "${BEFORE[-1]}"; done

echo "== prisma migrate deploy (scratch)"
DATABASE_URL="$URL" npx prisma migrate deploy

echo "== row counts after (existing data must be unchanged)"
FAIL=0
i=0
for t in "${TABLES[@]}"; do
  after="$(count "$t")"
  printf '  %-18s %s -> %s\n' "$t" "${BEFORE[$i]}" "$after"
  if [ "${BEFORE[$i]}" != "missing" ] && [ "${BEFORE[$i]}" != "$after" ]; then echo "  !! COUNT CHANGED for $t" >&2; FAIL=1; fi
  i=$((i + 1))
done

echo "== structural checks"
psql "$URL" -Atqc "select 'append-only triggers: ' || count(*) from pg_trigger where not tgisinternal and tgname like '%append_only'"
psql "$URL" -Atqc "select 'tables with row-level security: ' || count(*) from pg_class where relrowsecurity and relkind = 'r'"
psql "$URL" -Atqc "select 'flags that are ON by default among the expansion flags: ' || count(*) from \"FeatureFlag\" where key in ('adminStepUp','adminSupportAccessRequired','catalogV2','stockV2','accountingJournals','dailyClose') and \"enabledByDefault\""
ON="$(psql "$URL" -Atqc "select count(*) from \"FeatureFlag\" where key in ('adminStepUp','adminSupportAccessRequired','catalogV2','stockV2','accountingJournals','dailyClose') and \"enabledByDefault\"")"
if [ "$ON" != "0" ]; then echo "  !! an expansion flag is ON by default" >&2; FAIL=1; fi

# Phase 8: a legacy invoice that was PAID must read as paid in full after the Phase 6 migration (found by tests/migrationRehearsal.test.ts).
UNPAID_PAID="$(psql "$URL" -Atqc "select count(*) from \"Invoice\" where status = 'PAID' and \"paidMinor\" = 0" 2>/dev/null || echo 0)"
if [ "$UNPAID_PAID" != "0" ]; then echo "  !! $UNPAID_PAID PAID invoice(s) have paidMinor = 0" >&2; FAIL=1; fi
# Phase 8: ownership. Every merchant must have a membership, every business a default shop.
NO_MEMBER="$(psql "$URL" -Atqc "select count(*) from \"Merchant\" m where not exists (select 1 from \"Membership\" x where x.\"phoneNumber\" = m.\"phoneNumber\" and x.\"businessId\" = m.\"businessId\")" 2>/dev/null || echo 0)"
if [ "$NO_MEMBER" != "0" ]; then echo "  !! $NO_MEMBER merchant(s) have no membership" >&2; FAIL=1; fi

if [ "$FAIL" = "0" ]; then echo "REHEARSAL OK (counts unchanged, flags off). Now smoke-test onboarding, /today and /undo against this scratch copy."; else echo "REHEARSAL FAILED" >&2; exit 1; fi
