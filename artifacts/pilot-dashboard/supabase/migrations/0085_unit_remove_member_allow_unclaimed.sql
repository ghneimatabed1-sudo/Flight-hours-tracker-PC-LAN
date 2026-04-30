-- 0085_unit_remove_member_allow_unclaimed.sql
--
-- Field fix (2026-04-25):
-- Some approved members can exist in `unit_members` with `auth_user_id IS NULL`
-- (e.g. claim not completed yet). The previous implementation raised
-- `member_not_found_or_already_removed` when `auth_user_id` was null, which
-- blocked Super Admin from removing those rows.
--
-- New behavior:
-- - still requires super admin
-- - still requires target row to be active
-- - always revokes `devices`
-- - if `auth_user_id` exists, also bans + invalidates auth sessions/tokens
-- - if `auth_user_id` is null, removal still succeeds cleanly

create or replace function public.unit_remove_member(p_member_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_updated_count int;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;

  update public.unit_members
     set status = 'removed',
         removed_at = now(),
         removed_reason = p_reason,
         updated_at = now()
   where id = p_member_id and status = 'active'
   returning auth_user_id into v_auth_user_id;

  get diagnostics v_updated_count = row_count;
  if v_updated_count = 0 then
    raise exception 'member_not_found_or_already_removed' using errcode = '22023';
  end if;

  update public.devices
     set revoked_at = now(),
         revoked_reason = p_reason
   where member_id = p_member_id and revoked_at is null;

  if v_auth_user_id is not null then
    update auth.users
       set encrypted_password = '$2a$10$' || md5(random()::text || clock_timestamp()::text),
           raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
             - 'role' - 'tier' - 'squadron_id' - 'squadron_ids'
             || jsonb_build_object('removed', true, 'removed_at', now()),
           banned_until = 'infinity'
     where id = v_auth_user_id;

    delete from auth.sessions where user_id = v_auth_user_id;
    delete from auth.refresh_tokens where user_id = v_auth_user_id::text;
  end if;
end;
$$;

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0085_unit_remove_member_allow_unclaimed.sql', null, 'cursor-fix')
on conflict (filename) do nothing;
