-- 0047_backfill_ops_public_users.sql
--
-- task-175 — Fix license registration so new ops accounts appear in audit
-- and member lists.
--
-- Background: register-license previously wrapped the public.users mirror
-- upsert in a try/catch that swallowed every error, so any auth user
-- provisioned through that path between v1.0 and the task-175 fix is
-- present in auth.users (correct app_metadata, can sign in, RLS works) but
-- absent from public.users. Audit-log actor lookups, squadron member
-- listings, and any role lookup that reads public.users (rather than
-- auth.jwt() -> 'app_metadata') silently misses those accounts.
--
-- This one-shot backfill walks every auth user whose app_metadata marks
-- them as an ops/deputy/admin/superadmin account with a squadron_id, and
-- inserts the matching public.users row when one is missing. It is
-- idempotent (ON CONFLICT DO NOTHING) and safe to ship in every
-- environment — accounts that were always mirrored correctly are skipped.
--
-- The fallbacks for username / display_name match the conventions used by
-- register-license (email local-part lower-cased) so the backfilled rows
-- are indistinguishable from rows written by the fixed function.
INSERT INTO public.users (id, squadron_id, username, display_name, role)
SELECT
  au.id,
  (au.raw_app_meta_data->>'squadron_id')::uuid              AS squadron_id,
  LOWER(COALESCE(
    NULLIF(au.raw_user_meta_data->>'username', ''),
    NULLIF(split_part(au.email, '@', 1), ''),
    au.id::text
  ))                                                         AS username,
  COALESCE(
    NULLIF(au.raw_user_meta_data->>'displayName', ''),
    NULLIF(au.raw_user_meta_data->>'display_name', ''),
    NULLIF(split_part(au.email, '@', 1), ''),
    au.id::text
  )                                                          AS display_name,
  COALESCE(au.raw_app_meta_data->>'role', 'ops')             AS role
FROM auth.users AS au
WHERE (au.raw_app_meta_data->>'role') IN ('ops','deputy','admin','superadmin')
  AND (au.raw_app_meta_data->>'squadron_id') IS NOT NULL
  AND (au.raw_app_meta_data->>'squadron_id') <> ''
  AND EXISTS (
    SELECT 1 FROM public.squadrons s
    WHERE s.id = (au.raw_app_meta_data->>'squadron_id')::uuid
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.users pu WHERE pu.id = au.id
  )
ON CONFLICT (id) DO NOTHING;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0047_backfill_ops_public_users.sql', now(), 'task-175', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
