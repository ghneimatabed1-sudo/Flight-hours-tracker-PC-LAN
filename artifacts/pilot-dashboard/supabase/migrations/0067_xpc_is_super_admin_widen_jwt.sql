-- 0067_xpc_is_super_admin_widen_jwt.sql
--
-- Background — operator-reported defect "Reset failed: reset requires
-- super_admin" on the Connection Map even though the operator was signed
-- in with the Super Admin Panel badge visible. Triage uncovered a
-- name-mismatch between the JWT claim minted by the
-- `super-admin-2fa` edge function and the SQL gate that protects every
-- super-admin RPC:
--
--   minted in JWT (super-admin-2fa/index.ts ensureSuperAdminAuthUser):
--     app_metadata: { role: "admin",       tier: "hq", … }
--
--   required by SQL gate (xpc_is_super_admin, defined in 0038):
--     (jwt -> 'app_metadata' ->> 'role') = 'super_admin'
--
-- Result: every super-admin RPC (xpc_admin_reset_pc, xpc_admin_create_pair,
-- xpc_admin_bulk_pair_in_squadron, xpc_pair_links_sweep, …) silently
-- rejected the legitimate super admin's call with errcode 42501.
--
-- Two-part fix:
--   1. THIS MIGRATION widens xpc_is_super_admin() to accept BOTH JWT
--      shapes — the canonical role:"super_admin" and the legacy
--      role:"admin" + tier:"hq" combination. The legacy shape is
--      uniquely identifying (only the HQ super admin has tier="hq" in
--      app_metadata; squadron-tier admins use tier="squadron"), so the
--      widening cannot escalate any squadron-tier admin to super-admin
--      privileges.
--   2. The companion source change to super-admin-2fa/index.ts switches
--      ensureSuperAdminAuthUser to mint role:"super_admin" so future
--      sign-ins produce the canonical JWT shape. Once every PC has
--      signed back in at least once, the legacy branch in this function
--      becomes dead code (kept defensively).
--
-- The widening is applied immediately so the operator's CURRENT signed-in
-- session starts working without requiring a sign-out / sign-in dance. The
-- function is STABLE so PostgREST caches the result for the duration of
-- a request, matching the prior definition.

create or replace function public.xpc_is_super_admin()
returns boolean
language sql stable
as $$
  select coalesce(
    -- Canonical shape (post-fix and going forward).
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb
       -> 'app_metadata' ->> 'role') = 'super_admin'
    or
    -- Legacy shape (pre-fix). Uniquely identified by tier="hq".
    (
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'role') = 'admin'
      and
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'tier') = 'hq'
    ),
    false
  );
$$;

revoke all on function public.xpc_is_super_admin() from public;
grant execute on function public.xpc_is_super_admin() to authenticated;

comment on function public.xpc_is_super_admin() is
  'Returns true if the calling JWT identifies the HQ super admin. Accepts both '
  'the canonical role:"super_admin" claim AND the legacy role:"admin"+tier:"hq" '
  'claim minted by older builds of the super-admin-2fa edge function. The '
  'legacy branch is uniquely safe because tier="hq" is reserved for the HQ '
  'super admin only — squadron-tier admins use tier="squadron". See '
  'migration 0067 for the operator-reported defect this fixed.';

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0067_xpc_is_super_admin_widen_jwt.sql', now(), 'task-289', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
