-- Migration 0077 — fix unit_remove_member type-cast bug.
--
-- Migration 0075 added `delete from auth.refresh_tokens where user_id =
-- v_auth_user_id;` but `auth.refresh_tokens.user_id` is varchar in the
-- supabase auth schema (legacy), not uuid. Postgres rejects the
-- comparison with `42883: operator does not exist: character varying =
-- uuid`. Cast the uuid to text on the right-hand side.
--
-- This migration is idempotent — `create or replace function` rewrites
-- the body without dropping anything else.

create or replace function public.unit_remove_member(p_member_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_auth_user_id uuid;
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
  if v_auth_user_id is null then
    raise exception 'member_not_found_or_already_removed' using errcode = '22023';
  end if;
  update public.devices
     set revoked_at = now(),
         revoked_reason = p_reason
   where member_id = p_member_id and revoked_at is null;
  if v_auth_user_id is not null then
    -- (1) Garbage password — kills password-grant sign-in attempts.
    -- (2) Strip the role + flag the account banned forever — Supabase's
    --     auth gateway honours banned_until on every refresh.
    -- (3) Delete every live session + refresh token row so any open
    --     access token cannot be refreshed past its (≤1h) expiry.
    update auth.users
       set encrypted_password = '$2a$10$' || md5(random()::text || clock_timestamp()::text),
           raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
             - 'role' - 'tier' - 'squadron_id' - 'squadron_ids'
             || jsonb_build_object('removed', true, 'removed_at', now()),
           banned_until = 'infinity'
     where id = v_auth_user_id;
    delete from auth.sessions where user_id = v_auth_user_id;
    -- auth.refresh_tokens.user_id is varchar (legacy supabase auth
    -- schema). Cast the uuid to text so the comparison succeeds.
    delete from auth.refresh_tokens where user_id = v_auth_user_id::text;
  end if;
end;
$$;

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0077_fix_remove_member_refresh_token_cast.sql', null, 'task-299-review')
on conflict (filename) do nothing;
