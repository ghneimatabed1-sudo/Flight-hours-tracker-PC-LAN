-- Production seed for Hawk Eye / RJAF pilot dashboard.
--
-- Intentionally empty: a fresh deployment must start with NO squadron
-- rows so each PC runs the in-app Setup Wizard (`/setup/squadron`) on
-- first launch and writes its own squadron identity, aircraft, and
-- monthly-target defaults to the `squadrons` table — see migration
-- 0039 (`default_aircraft`, `default_monthly_targets` jsonb columns).
--
-- The previous 4-squadron demo block has been moved to `seed.demo.sql`
-- in the same directory and is only loaded by the dev/preview reseed
-- helpers (`reset-and-reseed.sh`, `db-seed.mjs`) when explicitly
-- requested. Production deployments must NOT run the demo seed.

begin;
commit;
