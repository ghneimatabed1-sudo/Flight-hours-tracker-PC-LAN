-- 0050_squadron_rename_xpc_sync.sql
--
-- Task #173 — Keep PC labels in sync when a squadron is renamed.
--
-- Audit D Phase 6 (evidence/6.json scenario D20) showed that renaming
-- public.squadrons.name does NOT propagate to the denormalised
-- xpc_registry.squadron_name column. After a rename, every Connection
-- Map / forward-picker / message-list surface that reads from registry
-- continued to display the OLD name.
--
-- Migration 0045 (note 4) added the symmetric trigger for wing renames
-- (wings.name -> squadrons.wing) but explicitly closed D-T156-D10 as a
-- false positive on the assumption production used the canonical
-- 'NO. <n> SQDN' identifier from squadrons.number. That assumption no
-- longer holds: operators DO rename squadrons via the admin Squadrons
-- page and expect Connection Map labels to follow.
--
-- This migration installs an AFTER UPDATE OF name trigger on
-- public.squadrons that propagates the new name into every cross-PC
-- denormalised text column whose value still equals the OLD name:
--
--   * xpc_registry.squadron_name
--   * xpc_pair_links.a_squadron, .b_squadron
--   * xpc_messages.from_pc_name, .to_pc_name  (PC display name is the
--     squadron name for squadron-tier PCs; flight PCs use a different
--     label and will not match the OLD squadron name, so they are
--     left alone — equality match is safe)
--
-- The trigger is purely additive and idempotent: re-running this
-- migration drop/creates the function and trigger.
--
-- Acceptance (Audit D Phase 6 D20):
--   rename squadrons.name 'Alpha' -> 'Alpha-Renamed' with 3 referencing
--   PCs in xpc_registry. Re-run the audit:
--     rowsCarryingNewName=3, rowsCarryingOldNameAfter=0.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Patch the pair-link enforcement trigger to honour a per-txn bypass
-- ─────────────────────────────────────────────────────────────────────
-- The pair-link BEFORE UPDATE validator (xpc_pair_links_enforce, see
-- 0038) re-runs the matrix on every UPDATE and rejects non-super-admin
-- writers for kinds that require super_admin (cross_squadron_ops,
-- peer_base). When a non-super-admin operator renames a squadron from
-- the admin Squadrons page, the rename trigger (below) updates the
-- denormalised a_squadron/b_squadron columns on every link involving
-- that squadron — including those super-admin-only kinds — and the
-- enforcer would abort the rename with 42501.
--
-- We add a bypass that the enforcer honours only when BOTH:
--   (a) a transaction-local GUC 'xpc.bypass_pair_validator' is set to
--       'rename' — set by the rename trigger right before its UPDATE
--       and cleared right after, scoped to the current transaction;
--   (b) pg_trigger_depth() >= 2 — i.e. the enforcer is firing because
--       another trigger executed the UPDATE, not because a client
--       called UPDATE/INSERT directly.
--
-- The GUC alone would be exploitable: any authenticated user can call
-- set_config('xpc.bypass_pair_validator', 'rename', true) and then
-- INSERT a forbidden pair link. The pg_trigger_depth() gate closes
-- that hole: a direct client write fires the enforcer at depth=1, but
-- a nested update from inside another trigger fires it at depth>=2.
-- A client cannot forge a nested-trigger context from raw SQL.

create or replace function public.xpc_pair_links_enforce()
returns trigger
language plpgsql
as $$
declare
  resolved text;
begin
  -- Bypass: a squadron-rename trigger is propagating denormalised
  -- column values for an existing, already-validated link. The row
  -- contents (tier/seat/kind) are unchanged from the operator's
  -- perspective — only the denormalised label moves. Skip re-enforcement
  -- only when the GUC marker is set AND we are inside a nested trigger
  -- (depth >= 2). The depth gate prevents a hostile client from setting
  -- the GUC and then issuing a direct INSERT — that would still fire
  -- the enforcer at depth = 1 and fail the bypass check.
  if pg_trigger_depth() >= 2
     and current_setting('xpc.bypass_pair_validator', true) = 'rename' then
    return new;
  end if;

  -- Pass new.kind in as p_kind_hint so a row written by an admin RPC
  -- with explicit peer_sqn intent survives re-validation here. The
  -- matrix only honours the hint when ALL other gates pass (super-admin
  -- + same-tier squadron + different squadron) so this is not an
  -- escape hatch — it just tells validate_pairing the operator's
  -- intent when seat metadata isn't on the row.
  resolved := public.xpc_validate_pairing(
    new.a_tier, new.b_tier,
    new.a_squadron, new.b_squadron,
    new.a_user_seat, new.b_user_seat,
    public.xpc_is_super_admin(),
    new.justification,
    new.expires_at,
    new.kind
  );
  if resolved is null then
    insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, kind, detail)
      values ('validation_rejected', new.a_pc_id, new.b_pc_id, new.kind,
              jsonb_build_object('reason','matrix_forbidden',
                                 'a_tier', new.a_tier, 'b_tier', new.b_tier));
    raise exception 'pairing forbidden by matrix (a_tier=%, b_tier=%)', new.a_tier, new.b_tier
      using errcode = '42501';
  end if;
  if new.kind <> resolved then
    raise exception 'pair kind % does not match matrix verdict %', new.kind, resolved
      using errcode = '42501';
  end if;
  if resolved = 'cross_squadron_ops' and not public.xpc_is_super_admin() then
    raise exception 'cross_squadron_ops links require super_admin'
      using errcode = '42501';
  end if;
  if resolved = 'peer_base' and not public.xpc_is_super_admin() then
    raise exception 'peer_base links require super_admin'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Trigger function
-- ─────────────────────────────────────────────────────────────────────

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
  -- Tell the BEFORE UPDATE enforcer (patched above) to skip matrix
  -- re-checks for this transaction only — see the comment on
  -- xpc_pair_links_enforce above for the rationale. The third arg
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

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Trigger
-- ─────────────────────────────────────────────────────────────────────
drop trigger if exists squadrons_rename_sync_xpc_trg on public.squadrons;
create trigger squadrons_rename_sync_xpc_trg
  after update of name on public.squadrons
  for each row execute function public._sync_xpc_denorm_on_squadron_rename();

-- ─────────────────────────────────────────────────────────────────────
-- 4. Migration ledger + PostgREST cache reload
-- ─────────────────────────────────────────────────────────────────────
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0050_squadron_rename_xpc_sync.sql', now(), 'task-173', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
