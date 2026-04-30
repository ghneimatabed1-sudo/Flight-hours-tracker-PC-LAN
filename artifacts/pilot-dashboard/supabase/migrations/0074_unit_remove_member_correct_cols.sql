-- 0074_unit_remove_member_correct_cols.sql
--
-- Task #299 — followup. unit_remove_member referenced columns that
-- don't exist on unit_members / devices: status_reason, updated_by,
-- revoked_by. The actual schema (see 0069) names them:
--   unit_members: status, removed_at, removed_reason
--   devices    : revoked_at, revoked_reason
-- Rewrite the helper to match.

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
     set status         = 'removed',
         removed_at     = now(),
         removed_reason = p_reason,
         updated_at     = now()
   where id = p_member_id;
  update public.devices
     set revoked_at     = now(),
         revoked_reason = coalesce('member_removed: ' || p_reason, 'member_removed')
   where member_id = p_member_id and revoked_at is null;
  -- We also want the bound auth.users to lose its session pronto.
  -- Edge function callers can do that via admin.signOut; from SQL, the
  -- safest move is to clear app_metadata.role so the next JWT refresh
  -- yields a token that fails xpc_is_super_admin / squadron RLS. We do
  -- that by clearing the auth.users row's app_metadata via a raw SQL
  -- update (the auth.users row itself stays so we keep the audit trail).
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('role', 'removed', 'tier', 'removed', 'squadron_ids', '[]'::jsonb)
   where id = (select auth_user_id from public.unit_members where id = p_member_id);
end;
$$;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0074_unit_remove_member_correct_cols.sql', now(), 'task-299', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
