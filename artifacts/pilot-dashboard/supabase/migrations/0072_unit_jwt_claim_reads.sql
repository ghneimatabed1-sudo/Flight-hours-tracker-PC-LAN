-- 0072_unit_jwt_claim_reads.sql
--
-- Task #299 — followup to 0069. The original RPCs read the caller's
-- auth.users id via `current_setting('request.jwt.claim.sub')` (the
-- per-claim GUC). Recent PostgREST stops populating the per-claim
-- GUCs by default and only fills the JSON blob at
-- `request.jwt.claims`. The xpc_* family already reads from the JSON
-- blob (visible in pg_get_functiondef('public.xpc_is_super_admin'));
-- the new unit_* family must do the same so that:
--   • unit_reserve_approval records `decided_by`
--   • unit_member_self resolves the calling pilot to a row
-- both work whether or not the per-claim GUC is populated.

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
  primary_squadron_id uuid,
  password_plain text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid           uuid;
  v_req           record;
  v_role          text;
  v_tier          text;
  v_primary_sq_id uuid;
  v_member_id     uuid;
  v_device_id     uuid;
  v_final_squads  text[];
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  -- Read sub from the JSON claims blob (the per-claim GUC is not
  -- populated by current PostgREST). Falls back to per-claim if the
  -- JSON path is empty so we keep working on older PostgREST too.
  v_uid := coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid,
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  );
  select * into v_req from public.device_requests where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'request_not_pending' using errcode = '22023';
  end if;
  v_final_squads := coalesce(p_squadron_names_override, v_req.requested_squadron_names);
  if v_final_squads is null or array_length(v_final_squads, 1) is null then
    raise exception 'squadrons_required' using errcode = '22023';
  end if;
  if v_req.requested_role = 'ops' then
    v_role := 'ops';
    v_tier := 'ops';
  else
    v_role := 'commander';
    v_tier := v_req.requested_role;
  end if;
  if v_tier in ('ops', 'flight', 'squadron') then
    if array_length(v_final_squads, 1) <> 1 then
      raise exception 'single_squadron_only_for_role' using errcode = '22023';
    end if;
    select id into v_primary_sq_id from public.squadrons where name = v_final_squads[1];
  end if;
  insert into public.unit_members
    (username, display_name, role, tier, squadron_allow_list, primary_squadron_id)
  values
    (v_req.username, v_req.display_name, v_role, v_tier, v_final_squads, v_primary_sq_id)
  returning id into v_member_id;
  insert into public.devices
    (member_id, display_name, fingerprint, originating_ip, approved_at, approved_by)
  values
    (v_member_id, v_req.display_name, v_req.fingerprint, v_req.originating_ip, now(), v_uid)
  returning id into v_device_id;
  update public.device_requests
     set status = 'approved',
         decided_at = now(),
         decided_by = v_uid,
         member_id = v_member_id,
         device_id = v_device_id
   where id = p_request_id;
  return query
    select v_member_id, v_device_id, v_req.username::text, v_req.display_name,
           v_role, v_tier, v_final_squads, v_primary_sq_id, v_req.password_plain;
end;
$$;

create or replace function public.unit_member_self() returns table (
  member_id uuid,
  device_id uuid,
  status text,
  role text,
  tier text,
  squadron_allow_list text[],
  display_name text,
  username text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  v_uid := coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid,
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  );
  if v_uid is null then
    return;
  end if;
  update public.devices
     set last_seen_at = now()
   where member_id = (select id from public.unit_members where auth_user_id = v_uid)
     and revoked_at is null;
  return query
    select m.id, d.id, m.status, m.role, m.tier, m.squadron_allow_list,
           m.display_name, m.username::text
      from public.unit_members m
      left join public.devices d on d.member_id = m.id and d.revoked_at is null
     where m.auth_user_id = v_uid
     limit 1;
end;
$$;

-- Same JWT-reading pivot for unit_remove_member, which logs decided_by.
create or replace function public.unit_remove_member(p_member_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  v_uid := coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid,
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  );
  update public.unit_members
     set status = 'removed',
         status_reason = p_reason,
         updated_at = now(),
         updated_by = v_uid
   where id = p_member_id;
  update public.devices
     set revoked_at = now(),
         revoked_by = v_uid,
         revoked_reason = coalesce('member_removed: ' || p_reason, 'member_removed')
   where member_id = p_member_id and revoked_at is null;
end;
$$;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0072_unit_jwt_claim_reads.sql', now(), 'task-299', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
