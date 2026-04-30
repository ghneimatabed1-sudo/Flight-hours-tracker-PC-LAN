-- Migration 0080 — close the HQ → super_admin privilege escalation
-- in unit_reserve_approval.
--
-- Code review round 4 caught this: in 0075 the role mapping reads
--
--     elsif v_req.requested_role = 'hq' then
--       v_role := 'super_admin'; v_tier := 'hq';
--
-- That means any laptop that files a join request with role='hq' and
-- then gets approved through the normal Pending Devices flow becomes
-- a SECOND super admin. The super_admin role is supposed to be
-- mintable ONLY by the one-shot bootstrap edge function
-- (`unit-super-admin-setup`) and by an existing super admin via a
-- direct unit_members write. This migration rewrites the mapping so
-- HQ joiners become role='commander', tier='hq' (the same shape every
-- other commander tier follows).
--
-- The function body is otherwise IDENTICAL to the 0075 version — same
-- request lock, same squadron-count validation, same insert order,
-- same return shape — so existing callers and the
-- `unit-approve-device` edge function are unaffected.
--
-- Idempotent: `create or replace function`.

create or replace function public.unit_reserve_approval(
  p_request_id uuid,
  p_squadron_names_override text[]
) returns table (
  member_id uuid,
  device_id uuid,
  username text,
  display_name text,
  role text,
  tier text,
  squadron_allow_list text[],
  primary_squadron_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  v_req         public.device_requests%rowtype;
  v_role        text;
  v_tier        text;
  v_final_squads text[];
  v_primary_sq  text;
  v_primary_sq_id uuid;
  v_member_id   uuid;
  v_device_id   uuid;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  select * into v_req from public.device_requests where id = p_request_id for update;
  if not found then
    raise exception 'request_not_found' using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request_not_pending' using errcode = '22023';
  end if;
  -- Map requested role → (DB role, tier).
  --
  -- Round 4 fix: HQ joiners are commanders at the HQ tier, NOT super
  -- admins. The super_admin role is reserved for one-shot bootstrap
  -- via `unit-super-admin-setup` (gated by
  -- unit_super_admin_setup_allowed). Promoting an arbitrary join
  -- request to super_admin would let any laptop with the join secret
  -- escalate to the highest privilege tier just by ticking the "HQ"
  -- radio in JoinSetup.
  if v_req.requested_role = 'ops' then
    v_role := 'ops'; v_tier := 'ops';
  else
    -- Every other role-name we accept (flight / squadron / wing /
    -- base / hq) becomes a commander at that tier.
    v_role := 'commander'; v_tier := v_req.requested_role;
  end if;
  v_final_squads := coalesce(p_squadron_names_override, v_req.requested_squadron_names);
  if coalesce(array_length(v_final_squads, 1), 0) = 0 then
    raise exception 'squadrons_required' using errcode = '22023';
  end if;
  if v_role in ('ops') or v_tier in ('flight', 'squadron') then
    if coalesce(array_length(v_final_squads, 1), 0) > 1 then
      raise exception 'single_squadron_only_for_role' using errcode = '22023';
    end if;
  end if;
  v_primary_sq := v_final_squads[1];
  select id into v_primary_sq_id from public.squadrons where name = v_primary_sq limit 1;
  insert into public.unit_members
    (username, display_name, role, tier, squadron_allow_list, primary_squadron_id, status)
    values
    (v_req.username, v_req.display_name, v_role, v_tier, v_final_squads, v_primary_sq_id, 'active')
    returning id into v_member_id;
  insert into public.devices
    (member_id, display_name, fingerprint, originating_ip, approved_by)
    values
    (v_member_id, v_req.display_name, v_req.fingerprint, v_req.originating_ip, auth.uid())
    returning id into v_device_id;
  update public.device_requests
     set status = 'approved',
         decided_at = now(),
         decided_by = auth.uid(),
         member_id = v_member_id,
         device_id = v_device_id
   where id = p_request_id;
  return query
    select v_member_id, v_device_id, v_req.username::text, v_req.display_name,
           v_role, v_tier, v_final_squads, v_primary_sq_id;
end;
$$;

revoke all on function public.unit_reserve_approval(uuid, text[]) from public;
grant execute on function public.unit_reserve_approval(uuid, text[]) to authenticated, service_role;

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0080_fix_hq_privilege_escalation.sql', null, 'task-299-review')
on conflict (filename) do nothing;
