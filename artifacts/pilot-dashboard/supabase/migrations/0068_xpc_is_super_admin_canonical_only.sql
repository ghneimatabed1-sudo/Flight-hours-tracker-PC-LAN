-- 0068_xpc_is_super_admin_canonical_only.sql
--
-- Background — migration 0067 widened public.xpc_is_super_admin() to
-- accept BOTH JWT shapes (canonical role:"super_admin" AND legacy
-- role:"admin" + tier:"hq") so the operator's already-signed-in
-- session kept working without a forced sign-out while v8 of the
-- super-admin-2fa edge function rolled out. v8 mints the canonical
-- shape on every new sign-in (see ensureSuperAdminAuthUser in
-- supabase/functions/super-admin-2fa/index.ts: app_metadata.role =
-- "super_admin"), so once every super-admin PC has signed in at least
-- once after the v8 deploy (April 24, 2026), every live JWT carries
-- the canonical shape and the legacy branch in xpc_is_super_admin()
-- is dead code.
--
-- This migration removes the legacy compatibility branch and restores
-- the single-shape definition originally introduced in migration 0038.
-- Keeping the legacy branch indefinitely would expand the surface for
-- future confusion ("which shape do we accept again?") and re-open
-- the door to a JWT-shape ambiguity bug.
--
-- Operational pre-condition (verified before applying this migration):
--   Every super-admin PC has signed in via super-admin-2fa v8+ at
--   least once after April 24, 2026 — confirmed via the auth.users
--   last_sign_in_at column and the super-admin-2fa function logs.
--   Without this pre-condition, applying this migration would lock
--   any still-legacy session out of every super-admin RPC until the
--   operator signs out and back in.
--
-- The function body is byte-for-byte the original 0038 definition,
-- with the same STABLE volatility, the same return type, and the same
-- grants. PostgREST schema cache is reloaded at the end so the new
-- definition takes effect on the next request without a server
-- restart.

create or replace function public.xpc_is_super_admin()
returns boolean
language sql stable
as $$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb
       -> 'app_metadata' ->> 'role') = 'super_admin',
    false
  );
$$;

revoke all on function public.xpc_is_super_admin() from public;
grant execute on function public.xpc_is_super_admin() to authenticated;

comment on function public.xpc_is_super_admin() is
  'Returns true if the calling JWT identifies the HQ super admin via the '
  'canonical app_metadata.role = "super_admin" claim minted by the '
  'super-admin-2fa edge function (v8+). The legacy role:"admin"+tier:"hq" '
  'compatibility branch added in migration 0067 was removed in 0068 once '
  'every super-admin PC had re-signed in under v8. See migrations 0038 '
  '(original definition) and 0067 (temporary widening) for history.';

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0068_xpc_is_super_admin_canonical_only.sql', now(), 'task-291', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
