-- 0053_pilot_transfer.sql
--
-- Task #26 (capability 3) — Inter-squadron pilot transfer.
--
-- Background: every operational table (pilots, sorties, currencies,
-- leaves, unavailable, pilot_link_codes, pilot_devices) carries a
-- squadron_id and is gated by Row Level Security against the
-- caller's JWT app_metadata.squadron_id claim. A direct
-- "UPDATE pilots SET squadron_id = <other>" from a squadron-scoped
-- session is impossible: the WITH CHECK clause on pilots_rw rejects
-- the post-update row because the new squadron_id no longer matches
-- the caller's claim.
--
-- This migration installs a SECURITY DEFINER RPC that performs the
-- entire transfer atomically:
--   1. Verify the caller is allowed to initiate (super_admin OR
--      currently scoped to the source squadron).
--   2. Re-home the pilot row + every pilot-keyed satellite row
--      (sorties, currencies, leaves, unavailable, pilot_link_codes,
--      pilot_devices) to the destination squadron in one transaction.
--   3. Write a paired audit_log entry on BOTH squadrons capturing
--      the move so each side has a permanent forensic record.
--
-- The RPC bypasses RLS by virtue of SECURITY DEFINER, so we re-check
-- authority inside the function body — never rely on RLS being the
-- only gate for a definer routine.
--
-- Acceptance: after calling
--   select public.transfer_pilot('P017', '<destination uuid>');
-- the pilot row, every sortie referencing them, and their
-- currencies/leaves/unavailable rows are all stamped with the new
-- squadron_id; one audit_log row per side records the move with the
-- pilot id, prior + new squadron, and the actor.

-- ─────────────────────────────────────────────────────────────────
-- Wrapper so the existence-check below is unambiguous.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.transfer_pilot(
  p_pilot_id text,
  p_to_squadron uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_from_squadron uuid;
  v_caller_squadron uuid := public.squadron_id();
  v_is_super boolean := public.xpc_is_super_admin();
  v_actor text := nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,username}',
    current_setting('request.jwt.claims', true)::jsonb ->> 'email',
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  ), '');
  v_moved jsonb;
  v_sortie_count integer := 0;
  v_currency_count integer := 0;
  v_leave_count integer := 0;
  v_unavail_count integer := 0;
  v_link_count integer := 0;
  v_device_count integer := 0;
begin
  if p_pilot_id is null or length(trim(p_pilot_id)) = 0 then
    raise exception 'pilot_id is required' using errcode = '22023';
  end if;
  if p_to_squadron is null then
    raise exception 'destination squadron is required' using errcode = '22023';
  end if;

  -- Look up the pilot's current squadron. We deliberately bypass the
  -- caller's RLS context (definer) so a super-admin transfer also works
  -- when the caller isn't sitting on the source squadron.
  select squadron_id into v_from_squadron
    from public.pilots
   where id = p_pilot_id
   for update;

  if v_from_squadron is null then
    raise exception 'pilot % not found', p_pilot_id using errcode = 'P0002';
  end if;

  if v_from_squadron = p_to_squadron then
    raise exception 'pilot % already in squadron %', p_pilot_id, p_to_squadron
      using errcode = '22023';
  end if;

  -- Authority gate. Either the caller is a super-admin, or they are
  -- currently scoped to the source squadron (the squadron that owns
  -- the pilot today). This matches the operational reality: an ops
  -- officer at the losing squadron initiates the transfer; HQ staff
  -- can do it from anywhere.
  if not (v_is_super or v_caller_squadron = v_from_squadron) then
    raise exception 'caller (squadron %) cannot transfer pilot owned by squadron %',
      v_caller_squadron, v_from_squadron
      using errcode = '42501';
  end if;

  -- Verify the destination squadron exists. Fails with a clear message
  -- if the caller passes a stale id.
  if not exists (select 1 from public.squadrons where id = p_to_squadron) then
    raise exception 'destination squadron % does not exist', p_to_squadron
      using errcode = 'P0002';
  end if;

  -- Re-home every pilot-keyed satellite table FIRST. We update the
  -- satellites before the pilot row itself so any FK-enforced cascade
  -- check (none today, but cheap insurance) sees a consistent view.
  update public.sorties
     set squadron_id = p_to_squadron
   where pilot_id = p_pilot_id
     and squadron_id = v_from_squadron;
  get diagnostics v_sortie_count = row_count;

  -- A pilot can also appear as the co-pilot on a sortie owned by the
  -- source squadron. Move those references too so the new squadron
  -- sees the full flying record on day one.
  update public.sorties
     set squadron_id = p_to_squadron
   where co_pilot_id = p_pilot_id
     and squadron_id = v_from_squadron;

  update public.currencies
     set squadron_id = p_to_squadron
   where pilot_id = p_pilot_id
     and squadron_id = v_from_squadron;
  get diagnostics v_currency_count = row_count;

  update public.leaves
     set squadron_id = p_to_squadron
   where pilot_id = p_pilot_id
     and squadron_id = v_from_squadron;
  get diagnostics v_leave_count = row_count;

  update public.unavailable
     set squadron_id = p_to_squadron
   where pilot_id = p_pilot_id
     and squadron_id = v_from_squadron;
  get diagnostics v_unavail_count = row_count;

  -- Mobile-link tables: only present in deployments that ran 0002.
  -- Wrap in a guard so the RPC stays usable on minimal installs.
  if to_regclass('public.pilot_link_codes') is not null then
    update public.pilot_link_codes
       set squadron_id = p_to_squadron
     where pilot_id = p_pilot_id
       and squadron_id = v_from_squadron;
    get diagnostics v_link_count = row_count;
  end if;

  if to_regclass('public.pilot_devices') is not null then
    update public.pilot_devices
       set squadron_id = p_to_squadron
     where pilot_id = p_pilot_id
       and squadron_id = v_from_squadron;
    get diagnostics v_device_count = row_count;
  end if;

  -- Finally re-home the pilot row itself.
  update public.pilots
     set squadron_id = p_to_squadron,
         updated_at  = now()
   where id = p_pilot_id;

  v_moved := jsonb_build_object(
    'pilotId', p_pilot_id,
    'fromSquadron', v_from_squadron,
    'toSquadron', p_to_squadron,
    'sorties', v_sortie_count,
    'currencies', v_currency_count,
    'leaves', v_leave_count,
    'unavailable', v_unavail_count,
    'linkCodes', v_link_count,
    'devices', v_device_count
  );

  -- Paired audit entries — one per squadron — so each side has a
  -- permanent forensic record visible to its own RLS context. We
  -- write the squadron_id explicitly because we're in a definer
  -- context and the column DEFAULT (which reads the JWT claim) would
  -- otherwise stamp both rows with the caller's claim, hiding the
  -- destination row from the destination squadron.
  insert into public.audit_log (squadron_id, type, actor, detail) values
    (v_from_squadron, 'pilot.transfer.out', v_actor, v_moved),
    (p_to_squadron,   'pilot.transfer.in',  v_actor, v_moved);

  return v_moved;
end;
$$;

revoke all on function public.transfer_pilot(text, uuid) from public, anon;
grant execute on function public.transfer_pilot(text, uuid) to authenticated;

-- Refresh PostgREST so the new RPC shows up under /rest/v1/rpc/.
notify pgrst, 'reload schema';

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0053_pilot_transfer.sql', now(), 'task-26', null)
on conflict (filename) do nothing;
