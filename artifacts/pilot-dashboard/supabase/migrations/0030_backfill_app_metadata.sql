-- 0030_backfill_app_metadata.sql
--
-- v1.1.73 — Critical Bug 1 root-cause fix.
--
-- Background: provision-user stamps app_metadata.{squadron_id, role,
-- squadron_number} on every newly-created Supabase auth user so the
-- caller-side allowlist in provision-user (and every RLS policy that
-- reads auth.jwt() -> 'app_metadata') can identify the squadron the
-- caller belongs to. Auth users created BEFORE provision-user started
-- doing this stamping (or restored from a backup that pre-dates it)
-- have empty app_metadata, so the very next call to provision-user
-- from those accounts fails with `no_squadron_in_token` / `forbidden`
-- and surfaces as the dreaded "Add User → Server error" banner.
--
-- This one-shot backfill walks every public.users row and copies its
-- squadron_id + role into the matching auth.users.raw_app_meta_data
-- field whenever those keys are missing. It is idempotent (re-running
-- it is a no-op) and safe to ship in every environment because the
-- COALESCE keeps any other unrelated app_metadata keys intact.
UPDATE auth.users AS au
SET raw_app_meta_data =
      COALESCE(au.raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object(
           'squadron_id',     pu.squadron_id::text,
           'role',            pu.role,
           'squadron_number', LOWER(COALESCE(s.number::text, 'rjaf'))
         )
FROM public.users AS pu
LEFT JOIN public.squadrons AS s ON s.id = pu.squadron_id
WHERE pu.id = au.id
  AND pu.squadron_id IS NOT NULL
  AND (
       au.raw_app_meta_data IS NULL
    OR au.raw_app_meta_data->>'squadron_id' IS NULL
    OR au.raw_app_meta_data->>'squadron_id' = ''
    OR au.raw_app_meta_data->>'role' IS NULL
    OR au.raw_app_meta_data->>'role' = ''
  );
