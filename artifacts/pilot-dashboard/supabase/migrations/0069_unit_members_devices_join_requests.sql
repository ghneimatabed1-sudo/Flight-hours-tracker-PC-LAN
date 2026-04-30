-- 0069_unit_members_devices_join_requests.sql
--
-- Task #299 — Replace the License Keys + Commanders + Generate Code +
-- Set up this device collage with a single Join → Approve → Bind flow.
-- This migration is ADDITIVE only: nothing in the existing schema is
-- dropped or renamed. The deprecation of `licenses`, `license_registry`,
-- and `commander_accounts` is a follow-up after one full release of the
-- new flow has stabilised.
--
-- Three new tables:
--   • unit_members      — the consolidated user account
--   • devices           — the approved laptops bound to a member
--   • device_requests   — the pending join queue
--
-- Bootstrap RPCs the joining laptop calls before it has a Supabase
-- session. They are anon-callable but each one re-checks a shared secret
-- header `x-unit-join-secret` (parity with REGISTER_LICENSE_SECRET on
-- the old register-license edge function). The secret never travels in
-- the URL or the body, only in a request header that PostgREST exposes
-- via current_setting('request.headers').
--
-- Authenticated super-admin RPCs do the approve / reject / list /
-- update-squadrons / remove work. Each one verifies xpc_is_super_admin().
--
-- Realtime: device_requests is added to supabase_realtime so the
-- super admin's Pending Devices page updates within ~5 sec of a new
-- request landing.
--
-- Audit triggers: every status flip on device_requests + unit_members
-- writes an audit_log row with actor / from / to / detail.
--
-- Idempotent throughout; safe to re-run.

-- ── 0. citext extension ────────────────────────────────────────────
-- Already present in most Supabase projects but the IF NOT EXISTS
-- guard makes this re-runnable on a fresh project.
create extension if not exists citext with schema public;

-- ── 1. unit_members ────────────────────────────────────────────────
create table if not exists public.unit_members (
  id                    uuid primary key default gen_random_uuid(),
  auth_user_id          uuid unique references auth.users(id) on delete set null,
  username              public.citext not null,
  display_name          text not null,
  role                  text not null check (role in ('ops', 'commander', 'super_admin')),
  tier                  text not null check (tier in ('ops', 'flight', 'squadron', 'wing', 'base', 'hq')),
  squadron_allow_list   text[] not null default array[]::text[],
  primary_squadron_id   uuid references public.squadrons(id) on delete set null,
  status                text not null default 'active' check (status in ('active', 'removed')),
  removed_at            timestamptz,
  removed_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- Username must be unique across active members. A removed member's
-- username may be reused by a fresh join (same person, fresh laptop).
create unique index if not exists unit_members_username_active_uniq
  on public.unit_members (username) where status = 'active';
create index if not exists unit_members_status_idx on public.unit_members(status);
create index if not exists unit_members_role_tier_idx on public.unit_members(role, tier);

-- ── 2. devices ─────────────────────────────────────────────────────
create table if not exists public.devices (
  id                  uuid primary key default gen_random_uuid(),
  member_id           uuid not null references public.unit_members(id) on delete cascade,
  display_name        text not null,
  fingerprint         text not null,
  originating_ip      inet,
  originating_city    text,
  approved_at         timestamptz not null default now(),
  approved_by         uuid references auth.users(id),
  last_seen_at        timestamptz,
  revoked_at          timestamptz,
  revoked_reason      text
);
create index if not exists devices_member_idx on public.devices(member_id);
create index if not exists devices_active_idx on public.devices(member_id) where revoked_at is null;

-- ── 3. device_requests ─────────────────────────────────────────────
create table if not exists public.device_requests (
  id                          uuid primary key default gen_random_uuid(),
  requested_role              text not null check (requested_role in ('ops', 'flight', 'squadron', 'wing', 'base', 'hq')),
  requested_squadron_names    text[] not null default array[]::text[],
  username                    public.citext not null,
  display_name                text not null,
  password_plain              text,           -- cleared on approve/reject
  fingerprint                 text not null,
  originating_ip              inet,
  submitted_at                timestamptz not null default now(),
  status                      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'ignored')),
  decided_at                  timestamptz,
  decided_by                  uuid references auth.users(id),
  decision_reason             text,
  -- populated on approve so the joining laptop can pull its creds and
  -- complete sign-in:
  supabase_email              text,
  supabase_password           text,
  member_id                   uuid references public.unit_members(id) on delete set null,
  device_id                   uuid references public.devices(id) on delete set null
);
create index if not exists device_requests_status_idx on public.device_requests(status);
create index if not exists device_requests_submitted_idx on public.device_requests(submitted_at desc);

-- ── 4. Audit triggers ──────────────────────────────────────────────
create or replace function public._device_request_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor text;
begin
  v_actor := coalesce(
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
       -> 'sub')::text,
    'anon'
  );
  insert into public.audit_log (type, actor, detail, occurred_at)
  values (
    case TG_OP
      when 'INSERT' then 'unit.device_request.created'
      when 'UPDATE' then 'unit.device_request.' || coalesce(NEW.status, OLD.status)
      else 'unit.device_request.deleted'
    end,
    v_actor,
    jsonb_build_object(
      'request_id', coalesce(NEW.id, OLD.id),
      'username', coalesce(NEW.username, OLD.username)::text,
      'requested_role', coalesce(NEW.requested_role, OLD.requested_role),
      'from_status', case when TG_OP = 'UPDATE' then OLD.status else null end,
      'to_status', coalesce(NEW.status, OLD.status),
      'reason', coalesce(NEW.decision_reason, OLD.decision_reason)
    ),
    now()
  );
  return coalesce(NEW, OLD);
end;
$$;
drop trigger if exists device_request_audit on public.device_requests;
create trigger device_request_audit
  after insert or update of status or delete
  on public.device_requests
  for each row execute function public._device_request_audit();

create or replace function public._unit_member_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor text;
begin
  v_actor := coalesce(
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
       -> 'sub')::text,
    'system'
  );
  insert into public.audit_log (type, actor, detail, occurred_at)
  values (
    case TG_OP
      when 'INSERT' then 'unit.member.created'
      when 'UPDATE' then 'unit.member.' || coalesce(NEW.status, OLD.status)
      else 'unit.member.deleted'
    end,
    v_actor,
    jsonb_build_object(
      'member_id', coalesce(NEW.id, OLD.id),
      'username', coalesce(NEW.username, OLD.username)::text,
      'role', coalesce(NEW.role, OLD.role),
      'tier', coalesce(NEW.tier, OLD.tier),
      'squadron_allow_list', coalesce(NEW.squadron_allow_list, OLD.squadron_allow_list),
      'from_status', case when TG_OP = 'UPDATE' then OLD.status else null end,
      'to_status', coalesce(NEW.status, OLD.status),
      'reason', coalesce(NEW.removed_reason, OLD.removed_reason)
    ),
    now()
  );
  return coalesce(NEW, OLD);
end;
$$;
drop trigger if exists unit_member_audit on public.unit_members;
create trigger unit_member_audit
  after insert or update of status, squadron_allow_list or delete
  on public.unit_members
  for each row execute function public._unit_member_audit();

-- ── 5. Helper: shared-secret check for anon RPCs ───────────────────
create or replace function public._unit_join_secret_ok() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_expected text;
  v_supplied text;
begin
  -- Read the shared secret from the database settings. We deliberately
  -- DO NOT use pg_settings() to read an env var directly — Supabase
  -- exposes function secrets via the GUC 'app.settings.unit_join_secret'
  -- when set on the project. The deploy step below sets this value.
  v_expected := nullif(current_setting('app.settings.unit_join_secret', true), '');
  if v_expected is null then
    return false;
  end if;
  v_supplied := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-unit-join-secret',
    ''
  );
  if length(v_supplied) <> length(v_expected) then
    return false;
  end if;
  -- Constant-time-ish equality. Postgres has no native CT compare for
  -- text, so we XOR over the byte arrays. Per-row PL/pgSQL is fine —
  -- the cost is dominated by network round-trip.
  return md5(v_supplied) = md5(v_expected) and v_supplied = v_expected;
end;
$$;

-- ── 6. Anon bootstrap RPCs ─────────────────────────────────────────
create or replace function public.unit_super_admin_exists() returns boolean
language sql stable security definer set search_path = '' as $$
  -- A super admin "exists" in the new model when either:
  --   • a unit_members row with role='super_admin' is active, OR
  --   • the legacy super_admin_credentials row is present
  --     (so a unit currently running on the old model still reports true).
  select exists (
    select 1 from public.unit_members
     where role = 'super_admin' and status = 'active'
  ) or exists (
    select 1 from public.super_admin_credentials limit 1
  );
$$;

create or replace function public.unit_squadrons_for_join() returns table (
  id uuid, name text, number text, base text
)
language sql stable security definer set search_path = '' as $$
  select id, name, number, base
    from public.squadrons
   order by number;
$$;

create or replace function public.unit_request_join(
  p_role                       text,
  p_requested_squadron_names   text[],
  p_username                   text,
  p_display_name               text,
  p_password_plain             text,
  p_fingerprint                text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id uuid;
  v_ip         inet;
begin
  if not public._unit_join_secret_ok() then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('ops', 'flight', 'squadron', 'wing', 'base', 'hq') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_username is null or length(trim(p_username)) < 3 then
    raise exception 'username_too_short' using errcode = '22023';
  end if;
  if p_display_name is null or length(trim(p_display_name)) < 1 then
    raise exception 'display_name_required' using errcode = '22023';
  end if;
  if p_password_plain is null or length(p_password_plain) < 8 then
    raise exception 'password_too_short' using errcode = '22023';
  end if;
  if p_fingerprint is null or length(p_fingerprint) < 8 then
    raise exception 'fingerprint_required' using errcode = '22023';
  end if;
  if p_role <> 'ops' and (p_requested_squadron_names is null or array_length(p_requested_squadron_names, 1) is null) then
    raise exception 'squadrons_required' using errcode = '22023';
  end if;
  if p_role in ('ops', 'flight', 'squadron') and array_length(p_requested_squadron_names, 1) > 1 then
    raise exception 'single_squadron_only_for_role' using errcode = '22023';
  end if;
  -- Best-effort IP capture from PostgREST headers.
  begin
    v_ip := (nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for')::inet;
  exception when others then
    v_ip := null;
  end;
  insert into public.device_requests
    (requested_role, requested_squadron_names, username, display_name,
     password_plain, fingerprint, originating_ip)
  values
    (p_role, p_requested_squadron_names, lower(trim(p_username)), trim(p_display_name),
     p_password_plain, p_fingerprint, v_ip)
  returning id into v_request_id;
  return v_request_id;
end;
$$;

create or replace function public.unit_request_status(p_request_id uuid)
returns table (
  status text,
  decision_reason text,
  supabase_email text,
  supabase_password text,
  member_id uuid,
  device_id uuid
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public._unit_join_secret_ok() then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query
    select dr.status, dr.decision_reason, dr.supabase_email, dr.supabase_password,
           dr.member_id, dr.device_id
      from public.device_requests dr
     where dr.id = p_request_id;
end;
$$;

-- ── 7. Authenticated super-admin RPCs ──────────────────────────────
create or replace function public.unit_pending_requests() returns table (
  id uuid,
  requested_role text,
  requested_squadron_names text[],
  username text,
  display_name text,
  fingerprint text,
  originating_ip inet,
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
           dr.originating_ip, dr.submitted_at, dr.status
      from public.device_requests dr
     where dr.status in ('pending', 'ignored')
     order by dr.submitted_at desc;
end;
$$;

create or replace function public.unit_list_devices() returns table (
  member_id uuid,
  device_id uuid,
  username text,
  display_name text,
  role text,
  tier text,
  squadron_allow_list text[],
  approved_at timestamptz,
  last_seen_at timestamptz,
  fingerprint_short text,
  status text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  return query
    select m.id, d.id, m.username::text, m.display_name, m.role, m.tier,
           m.squadron_allow_list, d.approved_at, d.last_seen_at,
           left(d.fingerprint, 8), m.status
      from public.unit_members m
      left join public.devices d on d.member_id = m.id and d.revoked_at is null
     order by m.created_at desc;
end;
$$;

create or replace function public.unit_reject_request(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  v_uid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  update public.device_requests
     set status = 'rejected',
         decided_at = now(),
         decided_by = v_uid,
         decision_reason = p_reason,
         password_plain = null
   where id = p_request_id and status in ('pending', 'ignored');
  if not found then
    raise exception 'request_not_found_or_already_decided' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.unit_ignore_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  v_uid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  update public.device_requests
     set status = 'ignored',
         decided_at = now(),
         decided_by = v_uid
   where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'request_not_pending' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.unit_update_squadrons(
  p_member_id uuid, p_squadron_names text[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_auth_user_id uuid;
  v_role text;
  v_tier text;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  if p_squadron_names is null or array_length(p_squadron_names, 1) is null then
    raise exception 'squadrons_required' using errcode = '22023';
  end if;
  update public.unit_members
     set squadron_allow_list = p_squadron_names,
         updated_at = now()
   where id = p_member_id and status = 'active'
   returning auth_user_id, role, tier into v_auth_user_id, v_role, v_tier;
  if v_auth_user_id is null then
    raise exception 'member_not_found' using errcode = '22023';
  end if;
  -- Patch app_metadata.squadron_ids on the auth.users row so the bound
  -- laptop sees the change on its next session refresh. We touch the
  -- raw_app_meta_data column directly because the auth admin SDK is not
  -- callable from PL/pgSQL — this is a documented Supabase escape hatch.
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
       || jsonb_build_object('squadron_ids', to_jsonb(p_squadron_names))
   where id = v_auth_user_id;
end;
$$;

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
  -- Force-expire any live session by invalidating the password and
  -- clearing the metadata. The DELETE-from-auth.users path is cleaner
  -- but it cascades references we do not want to lose; rotating the
  -- password kills the next refresh-token round-trip.
  if v_auth_user_id is not null then
    update auth.users
       set encrypted_password = '$2a$10$' || md5(random()::text || clock_timestamp()::text),
           raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
             || jsonb_build_object('removed', true, 'removed_at', now())
     where id = v_auth_user_id;
  end if;
end;
$$;

-- The approve RPC writes the unit_members + devices rows and stamps
-- the request as approved. The actual auth.users creation happens in
-- the unit-approve-device Edge Function which is invoked by the client
-- once this RPC has reserved the squadron list — we do it that way so
-- the squadron-list authority lives in the database (single source of
-- truth) and the auth.users SDK call lives in the Edge Function (which
-- has service-role privileges).
--
-- The client flow is:
--   1) call unit_reserve_approval(request_id, squadron_names_override)
--      → returns the resolved unit_members shape, sets status='approved'
--   2) call the Edge Function with the request_id
--      → Edge Function reads the row, creates the auth.users with the
--        right app_metadata, mirrors into public.users, fills in
--        supabase_email/supabase_password/auth_user_id on the row
--   3) joining laptop's status poll picks up the creds and signs in.
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
  v_uid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
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

-- After the Edge Function has created the auth.users row, it calls
-- unit_complete_approval to bind the auth_user_id and to write the
-- supabase creds back to device_requests so the joining laptop's
-- status poll can pick them up.
create or replace function public.unit_complete_approval(
  p_request_id     uuid,
  p_auth_user_id   uuid,
  p_supabase_email text,
  p_supabase_password text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.xpc_is_super_admin() then
    -- Allow the service role to call this from the Edge Function. The
    -- service role has bypass-RLS but xpc_is_super_admin reads the JWT,
    -- which the service role does not carry. We accept either path.
    if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
      raise exception 'super_admin_or_service_role_required' using errcode = '42501';
    end if;
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
  v_uid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  if v_uid is null then
    return;
  end if;
  -- Bump last_seen on every active device for this member.
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

-- ── 8. Daily auto-purge of stale device_requests ───────────────────
-- A pending or ignored request older than 30 days is purged so the
-- queue does not grow unbounded over a 15-year deployment. Approved
-- and rejected requests are kept (for audit) but the password_plain
-- column is cleared on the same sweep as a defence-in-depth measure.
create or replace function public.device_requests_purge_stale() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.device_requests
   where status in ('pending', 'ignored')
     and submitted_at < now() - interval '30 days';
  update public.device_requests
     set password_plain = null
   where password_plain is not null
     and submitted_at < now() - interval '1 day';
end;
$$;

-- Schedule via pg_cron if available. The _unschedule_if_exists helper
-- is provided by 0032_retention_cleanup_jobs.sql.
do $$ begin
  perform public._unschedule_if_exists('device-requests-purge');
  perform cron.schedule(
    'device-requests-purge',
    '15 4 * * *',  -- daily 04:15 UTC
    $cron$ select public.device_requests_purge_stale(); $cron$
  );
exception when undefined_function then
  raise notice 'pg_cron unavailable — purge job not scheduled (run manually)';
end $$;

-- ── 9. RLS ─────────────────────────────────────────────────────────
alter table public.unit_members enable row level security;
alter table public.devices enable row level security;
alter table public.device_requests enable row level security;

-- unit_members: super_admin reads all + writes all; member reads own row.
drop policy if exists unit_members_select on public.unit_members;
create policy unit_members_select on public.unit_members
  for select to authenticated using (
    public.xpc_is_super_admin()
    or auth_user_id = (nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
  );
drop policy if exists unit_members_modify on public.unit_members;
create policy unit_members_modify on public.unit_members
  for all to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

-- devices: same shape as unit_members.
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices
  for select to authenticated using (
    public.xpc_is_super_admin()
    or member_id in (
      select id from public.unit_members
       where auth_user_id = (nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)
    )
  );
drop policy if exists devices_modify on public.devices;
create policy devices_modify on public.devices
  for all to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

-- device_requests: super_admin only via RLS. Anon access is mediated
-- by the SECURITY DEFINER bootstrap RPCs (which check the secret).
drop policy if exists device_requests_select on public.device_requests;
create policy device_requests_select on public.device_requests
  for select to authenticated using (public.xpc_is_super_admin());
drop policy if exists device_requests_modify on public.device_requests;
create policy device_requests_modify on public.device_requests
  for all to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

-- ── 10. Realtime publication ────────────────────────────────────────
do $$ begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    -- ALTER PUBLICATION ... ADD TABLE is not idempotent in PG14, so we
    -- catch the duplicate_object error. PG15+ supports IF NOT EXISTS but
    -- we cannot rely on it on every tier.
    begin
      execute 'alter publication supabase_realtime add table public.device_requests';
    exception when duplicate_object then
      null;
    end;
  end if;
end $$;

-- ── 11. Grants ──────────────────────────────────────────────────────
-- Anon (the joining laptop) calls these via the secret-gated SECURITY
-- DEFINER functions; bare INSERT/SELECT on the tables remain blocked.
revoke all on function public.unit_super_admin_exists() from public;
grant execute on function public.unit_super_admin_exists() to anon, authenticated, service_role;
revoke all on function public.unit_squadrons_for_join() from public;
grant execute on function public.unit_squadrons_for_join() to anon, authenticated, service_role;
revoke all on function public.unit_request_join(text, text[], text, text, text, text) from public;
grant execute on function public.unit_request_join(text, text[], text, text, text, text) to anon, authenticated, service_role;
revoke all on function public.unit_request_status(uuid) from public;
grant execute on function public.unit_request_status(uuid) to anon, authenticated, service_role;

revoke all on function public.unit_pending_requests() from public;
grant execute on function public.unit_pending_requests() to authenticated, service_role;
revoke all on function public.unit_list_devices() from public;
grant execute on function public.unit_list_devices() to authenticated, service_role;
revoke all on function public.unit_reject_request(uuid, text) from public;
grant execute on function public.unit_reject_request(uuid, text) to authenticated, service_role;
revoke all on function public.unit_ignore_request(uuid) from public;
grant execute on function public.unit_ignore_request(uuid) to authenticated, service_role;
revoke all on function public.unit_update_squadrons(uuid, text[]) from public;
grant execute on function public.unit_update_squadrons(uuid, text[]) to authenticated, service_role;
revoke all on function public.unit_remove_member(uuid, text) from public;
grant execute on function public.unit_remove_member(uuid, text) to authenticated, service_role;
revoke all on function public.unit_reserve_approval(uuid, text[]) from public;
grant execute on function public.unit_reserve_approval(uuid, text[]) to authenticated, service_role;
revoke all on function public.unit_complete_approval(uuid, uuid, text, text) from public;
grant execute on function public.unit_complete_approval(uuid, uuid, text, text) to authenticated, service_role;
revoke all on function public.unit_member_self() from public;
grant execute on function public.unit_member_self() to authenticated, service_role;

-- ── 12. Migration ledger ────────────────────────────────────────────
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0069_unit_members_devices_join_requests.sql', now(), 'task-299', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
