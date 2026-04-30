-- 0071_unit_complete_approval_service_role_check.sql
--
-- Task #299 — followup to 0069. unit_complete_approval allows two
-- callers: the super-admin (caller-side JWT) OR the Edge Function
-- running with the service role key. The first version of the
-- function checked `current_setting('request.jwt.claim.role')`, which
-- is only populated when PostgREST attaches a real JWT — the service
-- role key bypasses JWT verification entirely, so that GUC is empty
-- and the check rejected the legitimate Edge Function call.
--
-- The correct probe for "is this PostgREST connection running as the
-- service role?" is `current_user` / `session_user`, which PostgREST
-- switches to the matching DB role for every request.

create or replace function public.unit_complete_approval(
  p_request_id     uuid,
  p_auth_user_id   uuid,
  p_supabase_email text,
  p_supabase_password text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_caller_role text;
begin
  v_caller_role := coalesce(current_setting('role', true), '');
  if not public.xpc_is_super_admin() and v_caller_role <> 'service_role' then
    raise exception 'super_admin_or_service_role_required (caller_role=%)', v_caller_role
      using errcode = '42501';
  end if;
  update public.unit_members
     set auth_user_id = p_auth_user_id,
         updated_at = now()
   where id = (select member_id from public.device_requests where id = p_request_id);
  update public.device_requests
     set supabase_email = p_supabase_email,
         supabase_password = p_supabase_password,
         password_plain = null  -- clear once Supabase has it
   where id = p_request_id;
end;
$$;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0071_unit_complete_approval_service_role_check.sql', now(), 'task-299', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
