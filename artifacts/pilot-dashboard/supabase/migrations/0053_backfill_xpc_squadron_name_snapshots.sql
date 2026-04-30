-- 0053_backfill_xpc_squadron_name_snapshots.sql
--
-- Task #201 — Backfill stale squadron-name snapshots in xpc_pending and
-- xpc_schedule_shares.
--
-- Background: migration 0052 (Task #184) extended the squadron-rename
-- sync trigger so that future renames propagate into:
--
--   * xpc_pending.hosting_squadron_name
--   * xpc_pending.home_squadron_name
--   * xpc_schedule_shares.origin_squadron_name
--
-- But the trigger only fires on UPDATE OF name from the moment it
-- shipped onward. Any squadron that was renamed BEFORE 0052 left
-- stale text in those snapshot columns — so the dashboard's Guest
-- Officer history page and Schedule Chain page continue to display
-- the OLD name on rows that were submitted before the fix landed.
--
-- This migration is the one-shot catch-up: it rewrites every drifted
-- snapshot to the live name in `public.squadrons`. After it runs,
-- both surfaces show the current squadron name on every historical
-- row, including ones submitted before 0052 covered these tables.
--
-- ── Join key ────────────────────────────────────────────────────────
-- Each row carries a `*_squadron_id` text column that holds the
-- squadron-tier PC's canonical id. For squadron-tier PCs (the only
-- kind that fills these columns — flight/wing/base PCs use
-- tier-prefixed ids like "FLIGHT:..." that don't match any squadron),
-- the PC id IS the squadron's display name at registration time.
--
-- Crucially, the rename trigger from 0050/0052 does NOT update
-- `xpc_registry.id` or `xpc_pending.*_squadron_id` or
-- `xpc_schedule_shares.origin_squadron_id` — it only ever rewrites
-- the denormalised *name* columns. So the *_squadron_id values are
-- the ORIGINAL submission-time labels, untouched by any rename.
--
-- We canonicalise both sides through the helpers installed in 0041
-- (`xpc_canon_pc_id` / `squadrons_canon_name`) so that the historical
-- spelling drift case 0042 cleaned up — "NO.8" / "NO. 8 SQDN" /
-- "NO.8 SQDN" all resolving to one squadron — is handled here too.
-- The unique indexes on the canonical form (created at the end of
-- 0042) guarantee at most one matching squadron per row, so the
-- update is deterministic and safe to run as a single SQL statement.
--
-- ── Idempotency ─────────────────────────────────────────────────────
-- The `is distinct from` guard on the SET clause means re-running
-- this migration on an already-clean DB is a no-op. The migration is
-- safe to apply multiple times via the GitHub Actions migration
-- pipeline; the ledger insert at the bottom is `on conflict do nothing`.
--
-- ── Acceptance ──────────────────────────────────────────────────────
-- Pre-state: a squadron renamed before 0052 shipped, with at least one
--   xpc_pending row (status accepted/rejected/edited/pending) and one
--   xpc_schedule_shares row that snapshotted the OLD name.
-- After this migration:
--   * xpc_pending.hosting_squadron_name and .home_squadron_name show
--     the squadron's CURRENT name for every row whose hosting/home
--     squadron id resolves to a row in public.squadrons.
--   * xpc_schedule_shares.origin_squadron_name shows the squadron's
--     CURRENT name for every row whose origin_squadron_id resolves to
--     a row in public.squadrons.
--   * Rows whose *_squadron_id does not canonicalise to any squadron
--     (e.g. flight-tier originators with "FLIGHT:..." ids, or rows
--     for squadrons that have since been deleted) are left alone.

-- ── 1+2+3. Backfill the three drifted snapshot columns and report ───
-- Wrapped in a DO block so we can RAISE NOTICE the per-column update
-- count and the residual-drift count to the migration log. The
-- residual count is the number of rows whose *_squadron_id resolves
-- to a squadron whose live name STILL differs from the snapshot
-- AFTER our update — that should always be 0 immediately post-update.
-- A non-zero residual would mean either (a) a concurrent writer raced
-- us, or (b) the canonicalisation join failed to match — both worth
-- surfacing in the CI log so the operator notices instead of the
-- next ops officer noticing weeks later.
do $$
declare
  hosting_updated  bigint;
  home_updated     bigint;
  origin_updated   bigint;
  hosting_residual bigint;
  home_residual    bigint;
  origin_residual  bigint;
begin
  with upd as (
    update public.xpc_pending p
       set hosting_squadron_name = s.name
      from public.squadrons s
     where public.xpc_canon_pc_id(p.hosting_squadron_id)
           = public.squadrons_canon_name(s.name)
       and p.hosting_squadron_name is distinct from s.name
    returning 1
  )
  select count(*) into hosting_updated from upd;

  with upd as (
    update public.xpc_pending p
       set home_squadron_name = s.name
      from public.squadrons s
     where public.xpc_canon_pc_id(p.home_squadron_id)
           = public.squadrons_canon_name(s.name)
       and p.home_squadron_name is distinct from s.name
    returning 1
  )
  select count(*) into home_updated from upd;

  with upd as (
    update public.xpc_schedule_shares ss
       set origin_squadron_name = s.name
      from public.squadrons s
     where public.xpc_canon_pc_id(ss.origin_squadron_id)
           = public.squadrons_canon_name(s.name)
       and ss.origin_squadron_name is distinct from s.name
    returning 1
  )
  select count(*) into origin_updated from upd;

  -- Residual checks — must be 0 immediately after the updates above.
  select count(*) into hosting_residual
    from public.xpc_pending p
    join public.squadrons s
      on public.xpc_canon_pc_id(p.hosting_squadron_id)
       = public.squadrons_canon_name(s.name)
   where p.hosting_squadron_name is distinct from s.name;

  select count(*) into home_residual
    from public.xpc_pending p
    join public.squadrons s
      on public.xpc_canon_pc_id(p.home_squadron_id)
       = public.squadrons_canon_name(s.name)
   where p.home_squadron_name is distinct from s.name;

  select count(*) into origin_residual
    from public.xpc_schedule_shares ss
    join public.squadrons s
      on public.xpc_canon_pc_id(ss.origin_squadron_id)
       = public.squadrons_canon_name(s.name)
   where ss.origin_squadron_name is distinct from s.name;

  raise notice 'task-201 backfill: xpc_pending.hosting_squadron_name updated=%, residual=%',
    hosting_updated, hosting_residual;
  raise notice 'task-201 backfill: xpc_pending.home_squadron_name updated=%, residual=%',
    home_updated, home_residual;
  raise notice 'task-201 backfill: xpc_schedule_shares.origin_squadron_name updated=%, residual=%',
    origin_updated, origin_residual;
end $$;

-- ── Migration ledger + PostgREST cache reload ───────────────────────
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0053_backfill_xpc_squadron_name_snapshots.sql', now(), 'task-201', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
