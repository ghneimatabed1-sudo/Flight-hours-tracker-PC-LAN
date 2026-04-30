#!/usr/bin/env bash
# One-shot helper to wipe the operational tables and re-apply the demo seed.
#
# Usage:
#   DATABASE_URL=postgresql://postgres:...@db.<project>.supabase.co:5432/postgres \
#     ./reset-and-reseed.sh
#
# The DATABASE_URL must be the *direct* Postgres connection (service role /
# postgres superuser) because RLS on every table is gated by a JWT claim that
# this script does not have. Do not run this against production unless you
# really want to lose everything.
#
# What this does, in order:
#   1. Truncates pilots, sorties, notams, schedule, audit_log and the
#      mobile-link tables (pilot_link_codes, pilot_devices) -- in dependency
#      order with CASCADE.
#   2. Re-runs migrations 0001 + 0002 (idempotent CREATE IF NOT EXISTS).
#   3. Applies seed.sql produced by generate-seed.mjs.
#
# Re-run generate-seed.mjs first if you've edited mock.ts:
#   node "$(dirname "$0")/generate-seed.mjs"

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  echo "Example:" >&2
  echo "  DATABASE_URL=postgresql://postgres:PWD@db.PROJ.supabase.co:5432/postgres $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS="$HERE/../migrations"
SEED="$HERE/seed.demo.sql"

if [[ ! -f "$SEED" ]]; then
  echo "ERROR: $SEED not found. Run: node $HERE/generate-seed.mjs" >&2
  exit 1
fi

echo "==> Confirming target database"
psql "$DATABASE_URL" -c "select current_database(), current_user, now();" || {
  echo "ERROR: cannot connect with DATABASE_URL" >&2
  exit 1
}

read -r -p "This will TRUNCATE pilots, sorties, notams, schedule, audit_log, pilot_link_codes, pilot_devices and re-seed. Continue? [y/N] " ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

echo "==> Truncating operational tables"
psql "$DATABASE_URL" <<'SQL'
begin;
truncate table
  pilot_link_codes,
  pilot_devices,
  audit_log,
  schedule,
  notams,
  sorties,
  pilots,
  licenses,
  squadrons
restart identity cascade;
commit;
SQL

echo "==> Re-applying migrations"
for m in "$MIGRATIONS"/*.sql; do
  echo "  - $(basename "$m")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"
done

echo "==> Applying seed.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SEED"

echo "==> Done. Quick sanity check:"
psql "$DATABASE_URL" -c "select 'pilots' as t, count(*) from pilots union all select 'sorties', count(*) from sorties union all select 'squadrons', count(*) from squadrons;"
