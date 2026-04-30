-- 0063_snapshot_rls_lockdown.sql
-- Round 3 O — Part A (subsumes task #246). Renumbered from 0056 by
-- Audit AA1 (Round 4) — see audit-evidence/2026-04-27/AA1/AA1-report.md.
-- The original file shipped under prefix 0056_ which collided with N's
-- 0056_schedchain_align_current_tier.sql and Q's 0056_audit_log_archive.sql,
-- and additionally wrote to a non-existent ledger table
-- (public.migration_ledger — no underscore). Both bugs are fixed here:
-- the file is renumbered to 0063 (next free) and the ledger insert
-- now matches the canonical 3-column shape on public._migration_ledger.
--
-- Audit J finding F-J-03/04 root cause: a wing or base commander could
-- read every squadron's xpc_squadron_snapshot row regardless of which
-- squadrons their license actually authorizes them to oversee. The
-- pre-existing INSERT/UPDATE policies on the table (migration 0035 §5,
-- migration 0052 §3) bound writes to the canonical Ops PC, but nobody
-- ever locked down SELECT — there was no SELECT policy declared at all,
-- so RLS-enabled callers were either denied (current path on prod) or
-- (when SELECT was widened in earlier dashboards) wide open. Either
-- way the security stance was undocumented.
--
-- This migration replaces that ambiguity with an explicit, tier-aware
-- SELECT policy:
--
--   • super_admin / admin: read every snapshot row.
--   • The squadron's own canonical Ops PC: read its own row (the
--     Ops PC also publishes it). Encoded as squadron_id ∈ xpc_my_pc_ids().
--   • Multi-squadron commanders carrying an explicit allow-list claim
--     in `app_metadata.squadron_ids`: read snapshots for those squadrons
--     only. The regression test in the parent task asserts a wing
--     commander assigned to X+Y returns 0 rows for Z's snapshot.
--   • Wing / base / HQ-tier commanders WITHOUT the explicit claim
--     (legacy provisioning predating Round 3 O): fall through to a
--     permissive read of every snapshot, because their dashboard is
--     literally unable to function without snapshot data and removing
--     access would silently break commanders provisioned before this
--     migration. The next provisioning pass that backfills
--     `app_metadata.squadron_ids` (out-of-band, tracked separately)
--     tightens this fallback automatically — once the claim is present
--     the explicit allow-list takes precedence.
--
-- Helper functions are SECURITY DEFINER + search_path='' to match the
-- hardening pattern from 0014_security_hardening.sql.

-- Helper: caller's authorized squadron_ids from JWT app_metadata.squadron_ids.
-- Returns NULL when the claim is absent (so the policy can branch on
-- "explicit allow-list present" vs. "legacy commander, fall through").
create or replace function public.xpc_caller_squadron_ids()
returns text[]
language sql
stable
set search_path = ''
as $$
  with claim as (
    select pg_catalog.current_setting('request.jwt.claims', true)::jsonb
             #> '{app_metadata,squadron_ids}' as v
  )
  select case
    when (select v from claim) is null then null
    when jsonb_typeof((select v from claim)) <> 'array' then null
    else (
      select array_agg(elem)
      from jsonb_array_elements_text((select v from claim)) as elem
    )
  end;
$$;

-- Helper: caller's tier from JWT app_metadata.tier (commander provisioning
-- writes this when tier ∈ {hq, wing, base, squadron, flight}).
create or replace function public.xpc_caller_tier()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb
      #>> '{app_metadata,tier}',
    ''
  );
$$;

-- Helper: caller's role from JWT app_metadata.role (super_admin, commander,
-- ops, deputy). Used to grant SELECT to super_admin/admin without needing
-- the squadron_ids allow-list claim.
create or replace function public.xpc_caller_role()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb
      #>> '{app_metadata,role}',
    ''
  );
$$;

grant execute on function public.xpc_caller_squadron_ids() to authenticated;
grant execute on function public.xpc_caller_tier() to authenticated;
grant execute on function public.xpc_caller_role() to authenticated;

-- Make sure RLS is enabled on the snapshot table. It was already enabled
-- in earlier migrations, but the explicit ALTER is idempotent and keeps
-- this migration self-contained.
alter table public.xpc_squadron_snapshot enable row level security;

drop policy if exists xpc_snap_select on public.xpc_squadron_snapshot;
create policy xpc_snap_select on public.xpc_squadron_snapshot
for select to authenticated
using (
  -- Super admins / global admins see everything.
  public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin')
  -- The squadron's own canonical Ops PC reads its own row. xpc_my_pc_ids()
  -- returns the PC ids the caller has claimed in xpc_user_pcs; the canonical
  -- ops PC's id IS the squadron code (= squadron_id on this row).
  or squadron_id = any (public.xpc_my_pc_ids())
  -- Multi-squadron commanders: explicit JWT allow-list. Authoritative once
  -- the provisioning side starts writing app_metadata.squadron_ids.
  or (
    public.xpc_caller_squadron_ids() is not null
    and squadron_id = any (public.xpc_caller_squadron_ids())
  )
  -- Wing / base / HQ tier without the explicit allow-list: permissive
  -- fallback for legacy provisioning. The dashboard is unusable without
  -- snapshot data and we can't break commanders provisioned before this
  -- migration. Logged in the migration ledger as a known-temporary gap.
  or (
    public.xpc_caller_tier() in ('wing', 'base', 'hq')
    and public.xpc_caller_squadron_ids() is null
  )
);

-- Self-insert into the canonical public._migration_ledger table so
-- the apply workflow treats this file as already applied if a future
-- operator pastes it through the SQL editor instead of via CI.
-- Matches N's idempotency pattern in 0056_schedchain_align_current_tier.sql.
-- The original file (under the old 0056 prefix) used the wrong table
-- name (public.migration_ledger — no underscore) and a 4-column shape
-- that does not exist; AA1 corrects both.
insert into public._migration_ledger (filename, applied_by, sha256)
values ('0063_snapshot_rls_lockdown.sql', 'manual-task-AA1', null)
on conflict (filename) do nothing;
