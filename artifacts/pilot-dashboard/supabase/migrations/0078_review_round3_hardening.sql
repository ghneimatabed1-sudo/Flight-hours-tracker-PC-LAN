-- Migration 0078 — review round 3 hardening.
--
-- (A) `unit_super_admin_setup_allowed` was only consulting
--     `public.unit_members`. Code review flagged that legacy super-admin
--     state can exist outside that table (e.g. accounts minted by the
--     old commander_accounts / license-key flow whose `app_metadata.role
--     = 'super_admin'` was set directly in `auth.users` without ever
--     populating `unit_members`). On a unit that previously ran the
--     legacy bootstrap, the old predicate would happily mint a SECOND
--     super admin from FirstLaunch. That is an authorization correctness
--     gap. The new predicate also scans `auth.users.raw_app_meta_data`
--     and the legacy `commander_accounts` table (if present) so the
--     answer is "no SA has ever existed in any model" before allowing
--     the anonymous bootstrap edge function to proceed.
--
-- (B) `unit_pending_requests` did not expose `originating_city` even
--     though the column exists on `device_requests`. The Pending Devices
--     UI needs city alongside IP so the super admin can sanity-check the
--     request location before approving.
--
-- Idempotent: `create or replace function` rewrites bodies in place;
-- ledger insert is `on conflict do nothing`.

-- ── (A) Hardened super-admin bootstrap predicate ──────────────────────

create or replace function public.unit_super_admin_setup_allowed()
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_legacy_table_exists boolean;
  v_legacy_count int := 0;
begin
  -- Check 1: any super admin in the new model?
  if exists (
    select 1 from public.unit_members
    where role = 'super_admin' and status = 'active'
  ) then
    return false;
  end if;

  -- Check 2: any auth.users row with role='super_admin' baked into
  -- raw_app_meta_data? This catches accounts minted by the legacy
  -- license-key / commander_accounts flow that never landed in
  -- unit_members. We deliberately ignore `removed=true` flags so a
  -- previously-removed SA still counts as "has ever existed" — the
  -- rationale is that an admin who already chose to run the legacy
  -- flow once should not be able to silently reset the unit by hitting
  -- FirstLaunch.
  if exists (
    select 1 from auth.users
    where coalesce(raw_app_meta_data->>'role', '') = 'super_admin'
  ) then
    return false;
  end if;

  -- Check 3: legacy commander_accounts table (predates the unit_*
  -- model). Only consult it if the table actually exists — a clean
  -- install will have dropped it.
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'commander_accounts'
  ) into v_legacy_table_exists;
  if v_legacy_table_exists then
    execute 'select count(*)::int from public.commander_accounts where coalesce(role, '''') = ''super_admin''' into v_legacy_count;
    if v_legacy_count > 0 then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke all on function public.unit_super_admin_setup_allowed() from public;
grant execute on function public.unit_super_admin_setup_allowed() to anon, authenticated, service_role;

-- ── (B) Expose originating_city on the pending-requests RPC ──────────

drop function if exists public.unit_pending_requests();
create or replace function public.unit_pending_requests() returns table (
  id uuid,
  requested_role text,
  requested_squadron_names text[],
  username text,
  display_name text,
  fingerprint text,
  originating_ip inet,
  originating_city text,
  submitted_at timestamptz,
  status text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  return query
    select dr.id, dr.requested_role, dr.requested_squadron_names,
           dr.username::text, dr.display_name, dr.fingerprint,
           dr.originating_ip, dr.originating_city,
           dr.submitted_at, dr.status
      from public.device_requests dr
     where dr.status in ('pending', 'ignored')
     order by dr.submitted_at desc;
end;
$$;

revoke all on function public.unit_pending_requests() from public;
grant execute on function public.unit_pending_requests() to authenticated, service_role;

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0078_review_round3_hardening.sql', null, 'task-299-review')
on conflict (filename) do nothing;
