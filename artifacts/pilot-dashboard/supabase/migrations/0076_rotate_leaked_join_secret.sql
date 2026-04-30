-- 0076_rotate_leaked_join_secret.sql
--
-- Task #299 review-pass. The original 0070 migration shipped with the
-- live join-secret value baked into the source file as a literal. The
-- value was applied to production before review caught the leak. This
-- migration rotates the secret on any environment where the leaked
-- value is still in use, replacing it with a cryptographically random
-- 32-byte value. Idempotent — on environments that never saw the
-- leaked value (e.g. fresh installs after 0070 was edited) this is a
-- no-op.
--
-- Operational follow-up:
--   • The new value lives only in the database and must be baked into
--     the next desktop installer build's VITE_UNIT_JOIN_SECRET.
--   • Use unit_get_join_secret() (super-admin only, defined below) to
--     surface the value once for the installer-build operator. The
--     RPC is intentionally not exposed in any UI surface — it is
--     called from the runbook procedure ONLY.
--   • Use unit_rotate_join_secret() to roll the secret forward in the
--     future (e.g. when an installer leaks).

-- The leaked literal we are rotating away from.
do $$
declare
  v_leaked text := 'df1422de631c80ee2e756f3ba132457ac1adb14cf060ed8020dfb39cb0460032';
  v_current text;
begin
  select value into v_current from public.unit_config where key = 'join_secret';
  if v_current = v_leaked then
    update public.unit_config
       set value = encode(gen_random_bytes(32), 'hex'),
           updated_at = now()
     where key = 'join_secret';
  end if;
end $$;

-- Super-admin RPC to read the current secret. Returns the raw value so
-- the installer-build operator can copy it into VITE_UNIT_JOIN_SECRET.
-- Audited by access logs — every call is recorded by the
-- _device_request_audit + Postgres role audit pipeline.
create or replace function public.unit_get_join_secret()
returns text
language plpgsql security definer set search_path = '' as $$
declare v_value text;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  select value into v_value from public.unit_config where key = 'join_secret';
  return v_value;
end;
$$;
revoke all on function public.unit_get_join_secret() from public;
grant execute on function public.unit_get_join_secret() to authenticated, service_role;

-- Super-admin RPC to rotate the secret. Returns the new value so the
-- caller can capture it for the next installer build. Atomic.
create or replace function public.unit_rotate_join_secret()
returns text
language plpgsql security definer set search_path = '' as $$
declare v_new text;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  v_new := encode(gen_random_bytes(32), 'hex');
  update public.unit_config
     set value = v_new, updated_at = now()
   where key = 'join_secret';
  if not found then
    insert into public.unit_config (key, value) values ('join_secret', v_new);
  end if;
  return v_new;
end;
$$;
revoke all on function public.unit_rotate_join_secret() from public;
grant execute on function public.unit_rotate_join_secret() to authenticated, service_role;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0076_rotate_leaked_join_secret.sql', now(), 'task-299-review', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
