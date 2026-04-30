-- 0054_squadron_rename_xpc_sync_pending_shares.sql
--
-- Task #184 — Extend the squadron-rename sync trigger to cover the two
-- remaining cross-PC tables that snapshot a squadron name at write
-- time and would otherwise display the OLD name forever after a rename.
--
-- ── Renumbering note (Task #249) ────────────────────────────────────
-- This file originally shipped as `0052_squadron_rename_xpc_sync_pending_shares.sql`
-- but Audit H proved it never reached production: two unrelated migrations
-- shared the `0052_` numeric prefix
-- (`0052_backfill_ledger_sha256.sql` and
-- `0052_xpc_messages_autoclaim_no_recipient_grant.sql`) and the live
-- `_migration_ledger` recorded them as applied while this one stayed
-- absent. Operators kept seeing the OLD squadron name on the Guest
-- Officer history page and the Schedule Chain page after every rename.
--
-- Renumbering to `0054_…` (the next free numeric prefix above the
-- already-applied `0053_*` pair) gives the apply-supabase-migrations
-- workflow a brand-new ledger key, so the next push to `main` runs
-- this migration once and only once. The legacy backfill in
-- `0053_backfill_xpc_squadron_name_snapshots.sql` already corrects
-- snapshots for squadrons renamed before this trigger ships, so we do
-- not need to repeat that work here. A new prefix-collision guard
-- (`scripts/check-migration-prefixes.mjs`) wired into both
-- `.github/workflows/apply-migrations.yml` and
-- `.github/workflows/apply-supabase-migrations.yml` fails the build
-- whenever a new migration introduces a duplicate numeric prefix, so
-- this class of silent drift cannot recur.
--
-- Background: migration 0050 (Task #173) installed
-- public._sync_xpc_denorm_on_squadron_rename as an AFTER UPDATE OF name
-- trigger on public.squadrons. It propagates the new name into the
-- denormalised text columns of:
--
--   * xpc_registry.squadron_name
--   * xpc_pair_links.a_squadron, .b_squadron
--   * xpc_messages.from_pc_name, .to_pc_name
--
-- Two more cross-PC tables also carry denormalised squadron-name
-- snapshots and were missed by 0050:
--
--   * xpc_pending.hosting_squadron_name, .home_squadron_name
--       — guest-officer pending-submission inbox. The dashboard
--         Guest Officer history page reads these strings directly.
--   * xpc_schedule_shares.origin_squadron_name
--       — cross-PC schedule-chain submissions. The Schedule Chain
--         page renders this string in the origin column / header.
--
-- After a rename, both surfaces continued to display the OLD name.
-- This migration extends the existing function to UPDATE those three
-- columns in the same trigger fire, so a rename reaches every
-- audit/history surface in one shot.
--
-- The trigger function is replaced with `create or replace function`,
-- so the trigger binding from 0050 is preserved — no DROP TRIGGER
-- needed. The two new UPDATEs are guarded by the same
-- `where ... = old.name` equality match, so rows that never carried
-- the old name (e.g. ones that pre-date the column or were written
-- with a custom label) are left alone.
--
-- Acceptance:
--   rename squadrons.name 'Alpha' -> 'Alpha-Renamed' with referencing
--   rows in xpc_pending and xpc_schedule_shares. After the rename:
--     * xpc_pending rows where hosting_squadron_name was 'Alpha'
--       now read 'Alpha-Renamed' (same for home_squadron_name).
--     * xpc_schedule_shares rows where origin_squadron_name was
--       'Alpha' now read 'Alpha-Renamed'.
--   Guest Officer history page and Schedule Chain page show the new
--   name immediately on next read.

create or replace function public._sync_xpc_denorm_on_squadron_rename()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Guard: nothing to do unless name actually changed.
  if new.name is not distinct from old.name then
    return new;
  end if;

  -- xpc_registry — every PC that registered itself with the old
  -- squadron display name picks up the new one.
  update public.xpc_registry
     set squadron_name = new.name
   where squadron_name = old.name;

  -- xpc_pair_links — both sides of a paired link carry a denormalised
  -- squadron snapshot. Update both columns in a SINGLE UPDATE so the
  -- BEFORE-UPDATE matrix validator sees the final consistent state.
  -- If we used two separate UPDATEs, an in-squadron pair
  -- (a_squadron = b_squadron = OLD) would briefly have a_squadron = NEW,
  -- b_squadron = OLD, the validator would no longer recognise it as
  -- same-squadron, and the rename would abort with "pairing forbidden".
  --
  -- Tell the BEFORE UPDATE enforcer (patched in 0050) to skip matrix
  -- re-checks for this transaction only — see the comment on
  -- xpc_pair_links_enforce in 0050 for the rationale. The third arg
  -- `true` makes the GUC transaction-local; it auto-clears at COMMIT.
  perform set_config('xpc.bypass_pair_validator', 'rename', true);
  update public.xpc_pair_links
     set a_squadron = case when a_squadron = old.name then new.name else a_squadron end,
         b_squadron = case when b_squadron = old.name then new.name else b_squadron end
   where a_squadron = old.name or b_squadron = old.name;
  perform set_config('xpc.bypass_pair_validator', '', true);

  -- xpc_messages — from_pc_name / to_pc_name are the PC display names
  -- captured at send time. For squadron-tier PCs that equals the
  -- squadron's name, so a rename should follow into chat history.
  -- Flight PCs use a "FLIGHT — <label>" style display and will not
  -- match here, which is intentional. Updated in a single statement
  -- for consistency with the pair-links update above (no validator
  -- gates xpc_messages on update, but a single statement is cheaper).
  update public.xpc_messages
     set from_pc_name = case when from_pc_name = old.name then new.name else from_pc_name end,
         to_pc_name   = case when to_pc_name   = old.name then new.name else to_pc_name   end
   where from_pc_name = old.name or to_pc_name = old.name;

  -- xpc_pending — guest-officer pending-submission inbox. Both the
  -- hosting and home squadron names are snapshotted at submit time
  -- so the Guest Officer history page can render them without a
  -- live join back to public.squadrons. A rename should follow into
  -- pending AND already-decided rows (status accepted/rejected/edited/
  -- deleted) because the history page shows decided rows too. Updated
  -- in a single statement so a self-host edge case
  -- (hosting_squadron_id = home_squadron_id, both names = OLD) flips
  -- atomically.
  update public.xpc_pending
     set hosting_squadron_name = case when hosting_squadron_name = old.name then new.name else hosting_squadron_name end,
         home_squadron_name    = case when home_squadron_name    = old.name then new.name else home_squadron_name    end
   where hosting_squadron_name = old.name or home_squadron_name = old.name;

  -- xpc_schedule_shares — cross-PC schedule-chain submissions
  -- snapshot the origin squadron's display name at submit time so
  -- the Schedule Chain page can render the origin column without a
  -- live join. A rename should follow into every non-terminal AND
  -- terminal status (draft/submitted/reviewed/approved/rejected/
  -- held/edited) — the chain page shows the full history, not just
  -- in-flight rows.
  update public.xpc_schedule_shares
     set origin_squadron_name = new.name
   where origin_squadron_name = old.name;

  return new;
end;
$$;

-- Migration ledger + PostgREST cache reload.
-- Filename in the ledger MUST track the on-disk filename (the apply
-- workflow keys the ledger by basename), so this row uses the
-- post-renumber `0054_…` name from Task #249 even though the trigger
-- logic itself originated in Task #184. The on-conflict clause keeps
-- this idempotent if the file is ever re-applied.
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0054_squadron_rename_xpc_sync_pending_shares.sql', now(), 'task-184', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
