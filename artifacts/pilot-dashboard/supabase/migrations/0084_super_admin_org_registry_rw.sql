-- Task #env-hardening: allow Super Admin to manage org registry rows
-- (bases, wings, squadrons) from the dashboard without service-role keys.
--
-- Why:
-- - `admin/Squadrons` previously wrote only to localStorage because `squadrons`
--   had no INSERT/UPDATE/DELETE policies for authenticated users.
-- - Multi-PC flows read squadrons from Supabase, so local-only writes caused
--   cross-device desync.
--
-- Scope:
-- - Adds super-admin-only write policies on:
--     public.bases
--     public.wings
--     public.squadrons
-- - Read policies remain unchanged.

begin;

-- bases -----------------------------------------------------------------------
drop policy if exists bases_super_admin_write on public.bases;
create policy bases_super_admin_write
  on public.bases
  for all
  to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

comment on policy bases_super_admin_write on public.bases is
  'Super Admin can create/update/delete base registry rows.';

-- wings -----------------------------------------------------------------------
drop policy if exists wings_super_admin_write on public.wings;
create policy wings_super_admin_write
  on public.wings
  for all
  to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

comment on policy wings_super_admin_write on public.wings is
  'Super Admin can create/update/delete wing registry rows.';

-- squadrons -------------------------------------------------------------------
drop policy if exists squadrons_super_admin_write on public.squadrons;
create policy squadrons_super_admin_write
  on public.squadrons
  for all
  to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

comment on policy squadrons_super_admin_write on public.squadrons is
  'Super Admin can create/update/delete squadron registry rows.';

commit;
