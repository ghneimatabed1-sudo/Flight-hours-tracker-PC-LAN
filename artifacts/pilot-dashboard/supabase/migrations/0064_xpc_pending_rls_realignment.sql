-- 0064_xpc_pending_rls_realignment.sql
-- Round 4 AA3 — Audit P defect P-3 (#271).
--
-- Background
-- ──────────
-- The original SELECT policy on public.xpc_pending (migration
-- 0010_cross_pc.sql) reads:
--
--   using (
--     hosting_squadron_id = any(public.xpc_my_pc_ids())
--     or home_squadron_id = any(public.xpc_my_pc_ids())
--   )
--
-- xpc_my_pc_ids() returns the PC ids the caller has explicitly claimed
-- in xpc_user_pcs. For the squadron-tier ops PC this works because
-- the canonical Ops PC's id IS the squadron code (= hosting_squadron_id
-- / home_squadron_id on this row). For wing/base/HQ-tier commanders
-- it does NOT — Audit P phase 4 (P-3) confirmed that a multi-squadron
-- commander whose JWT carries `app_metadata.squadron_ids = [Alpha,
-- Bravo]` but who has zero xpc_user_pcs rows reads zero pending
-- guest-sortie requests, even for Alpha and Bravo. Operators see an
-- empty pending tray on every commander console — silently wrong.
--
-- Fix
-- ───
-- Mirror the predicate shape from 0061_snapshot_rls_select_strict.sql.
-- That migration is the canonical pattern for "scope this table to the
-- caller's squadrons". Replace the SELECT policy with:
--
--   • super_admin / admin       → every row.
--   • Squadron's own ops PC      → squadron-id ∈ xpc_my_pc_ids() (kept
--                                  for the canonical Ops PC path; this
--                                  is the only branch that worked
--                                  before this migration).
--   • Multi-squadron commander  → squadron-id ∈ xpc_caller_squadron_ids()
--                                  via app_metadata.squadron_ids JWT
--                                  claim (this is the new branch — it
--                                  closes P-3).
--
-- xpc_pending has TWO squadron-id columns (hosting_squadron_id and
-- home_squadron_id), so the predicate is OR'd across both. A row is
-- visible if either side is in the caller's authorised set — which is
-- the original intent of the 0010 policy ("visible to host AND home").
--
-- Helpers (xpc_caller_role, xpc_caller_squadron_ids) were installed by
-- 0056_snapshot_rls_lockdown.sql and are reused as-is. INSERT, UPDATE,
-- and DELETE policies on xpc_pending stay unchanged — only SELECT was
-- broken.

alter table public.xpc_pending enable row level security;

drop policy if exists xpc_pending_select on public.xpc_pending;
create policy xpc_pending_select on public.xpc_pending
for select to authenticated
using (
  -- Super admins / global admins read every pending request.
  public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin')
  -- Canonical Ops PC path: squadron-tier ops PC's id IS the squadron
  -- code, so xpc_my_pc_ids() naturally covers both columns. This is the
  -- ONLY branch that worked before this migration.
  or hosting_squadron_id = any (public.xpc_my_pc_ids())
  or home_squadron_id    = any (public.xpc_my_pc_ids())
  -- Multi-squadron commanders carrying the JWT allow-list claim. This
  -- is the new branch — closes Audit P P-3 (#271). A wing commander
  -- with squadron_ids=[Alpha,Bravo] now sees pending rows whose
  -- hosting OR home is Alpha or Bravo, and zero rows for Charlie.
  or (
    public.xpc_caller_squadron_ids() is not null
    and (
      hosting_squadron_id = any (public.xpc_caller_squadron_ids())
      or home_squadron_id = any (public.xpc_caller_squadron_ids())
    )
  )
);

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0064_xpc_pending_rls_realignment.sql', now(), 'task-280', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
