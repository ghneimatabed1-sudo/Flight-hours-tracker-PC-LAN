-- 0073_unit_member_self_ambiguous_fix.sql
--
-- Task #299 — followup. The OUT-parameter names of unit_member_self
-- (member_id, device_id) collided with the table column names of the
-- same name reachable in the FROM clause; PL/pgSQL refused to resolve.
-- Rewriting with explicit table-qualified column references eliminates
-- the ambiguity. Also enabling #variable_conflict use_column gives
-- PL/pgSQL a deterministic resolution rule for the same scope.

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
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
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
  return query
    select
      m.id           as member_id,
      d.id           as device_id,
      m.status       as status,
      m.role         as role,
      m.tier         as tier,
      m.squadron_allow_list as squadron_allow_list,
      m.display_name as display_name,
      m.username::text as username
      from public.unit_members m
      left join public.devices d on d.member_id = m.id and d.revoked_at is null
     where m.auth_user_id = v_uid
     limit 1;
end;
$$;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0073_unit_member_self_ambiguous_fix.sql', now(), 'task-299', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
