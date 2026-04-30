-- Task #137 follow-ups for the squadron table:
--   1. Add a `wing` column so the Setup Wizard can persist the wing
--      identity across PCs (the parent group acronym, e.g. "8 WG").
--   2. Backfill default_aircraft / default_monthly_targets so rows
--      created before migration 0039 land on the new defaults instead
--      of NULL — the SetupGate uses presence of the row (not the
--      column value) to detect upgraded installs and skip the wizard.

alter table squadrons
  add column if not exists wing text;

update squadrons
   set default_aircraft = coalesce(default_aircraft, '[]'::jsonb),
       default_monthly_targets = coalesce(default_monthly_targets, '{}'::jsonb)
 where default_aircraft is null
    or default_monthly_targets is null;


-- Reload PostgREST schema cache so RPCs / new columns become callable
-- via the REST API immediately. See .local/memory/supabase-admin.md and
-- the convention documented in 0041_canon_identity.sql.
notify pgrst, 'reload schema';
