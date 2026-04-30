-- 0061_snapshot_rls_select_strict.sql
-- Task #270 — Stop every signed-in user from being able to read every
-- squadron's published xpc_squadron_snapshot row.
--
-- Background
-- ──────────
-- Migration 0056_snapshot_rls_lockdown.sql attempted to scope SELECT on
-- public.xpc_squadron_snapshot, but it kept a permissive fallback for
-- wing/base/HQ-tier commanders that lacked the explicit
-- `app_metadata.squadron_ids` JWT claim. In production virtually every
-- multi-squadron commander was provisioned BEFORE that claim was wired
-- up, so the fallback fired for the most common commander shape and
-- the policy degenerated to "any authenticated user reads every row"
-- (Audit P phase 4 confirmed this — a commander whose claims covered
-- ALPHA+BRAVO still read CHARLIE's snapshot, breaking the cross-tenant
-- scope-isolation contract).
--
-- This migration drops the permissive fallback and replaces
-- `xpc_snap_select` with a strictly-scoped predicate. After this:
--
--   * super_admin / admin                  : every snapshot row.
--   * caller's claimed PCs                 : squadron_id ∈ xpc_my_pc_ids().
--   * caller carries an app_metadata.squadron_ids allow-list claim
--                                          : squadron_id ∈ that allow-list.
--   * everyone else                        : zero rows.
--
-- The two scoped branches were already present in 0056 — we only remove
-- the permissive wing/base/HQ leg. Squadron-tier ops keep working
-- through `xpc_my_pc_ids()` (their canonical Ops PC's id IS the
-- squadron code). Wing/base/HQ commanders that previously relied on
-- the fallback now need either:
--   (a) `app_metadata.squadron_ids` populated by the provisioning
--       edge function, or
--   (b) one xpc_user_pcs row per squadron under their command (the
--       same mechanism squadron-tier accounts already use).
-- A separate provisioning-backfill task tracks closing that gap; this
-- migration intentionally fails-closed in the meantime — a blank
-- dashboard for an under-provisioned commander is strictly preferable
-- to letting them read another tenant's roster.
--
-- The helper functions installed by 0056 (xpc_caller_role,
-- xpc_caller_squadron_ids, xpc_caller_tier) are reused as-is. We do
-- NOT touch xpc_snap_upsert / xpc_snap_update — those were already
-- correctly scoped via xpc_my_pc_ids() in 0035 and 0052.

-- Defensive: re-assert RLS is enabled. Already enabled by 0035/0056;
-- the ALTER is idempotent and keeps this migration self-contained.
alter table public.xpc_squadron_snapshot enable row level security;

drop policy if exists xpc_snap_select on public.xpc_squadron_snapshot;
create policy xpc_snap_select on public.xpc_squadron_snapshot
for select to authenticated
using (
  -- Super admins / global admins read everything.
  public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin')
  -- The squadron's own canonical Ops PC reads its own row. xpc_my_pc_ids()
  -- returns the PC ids the caller has claimed in xpc_user_pcs; the
  -- canonical Ops PC's id IS the squadron code (= squadron_id on this
  -- row). A wing/base/HQ commander whose provisioning seeds one
  -- xpc_user_pcs row per squadron under command also reads through
  -- this branch.
  or squadron_id = any (public.xpc_my_pc_ids())
  -- Multi-squadron commanders carrying the explicit JWT allow-list:
  -- read snapshots ONLY for the squadrons listed in the claim. With
  -- the permissive fallback gone this is the authoritative path for
  -- multi-squadron oversight — a commander with claims on ALPHA+BRAVO
  -- now reads exactly those two snapshots and zero CHARLIE rows.
  or (
    public.xpc_caller_squadron_ids() is not null
    and squadron_id = any (public.xpc_caller_squadron_ids())
  )
);

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0061_snapshot_rls_select_strict.sql', now(), 'task-270', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
