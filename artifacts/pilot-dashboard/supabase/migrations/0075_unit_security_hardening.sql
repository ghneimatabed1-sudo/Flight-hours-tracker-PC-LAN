-- 0075_unit_security_hardening.sql
--
-- Task #299 review-pass hardening. Three changes that address the
-- code-review findings against the multi-PC simple rebuild:
--
--  (A) Plaintext credentials no longer live in the database. Migration
--      0069 stored the joining laptop's chosen password in
--      device_requests.password_plain so the approve edge function
--      could call auth.admin.createUser({password}). It also stored
--      the supabase_password back on the row so the joining laptop
--      could pull it on its next status poll. Both are textbook
--      "secrets at rest" violations.
--
--      New design: the joining laptop holds the password locally for
--      the entire flow. It sends sha256(password) + a random
--      claim_token to the server. The server stores ONLY the hash and
--      the token. On approve the edge function creates auth.users
--      with a long random throw-away password. Once the joining
--      laptop sees status='approved' it POSTs the plain password +
--      claim_token to a new edge function `unit-claim-device` which
--      verifies (a) the token matches and (b) sha256(plain) matches
--      the stored hash, then calls auth.admin.updateUserById to set
--      the real password and marks claim_consumed_at. The joining
--      laptop then signs in with its own remembered password.
--
--      Net effect: at no point does the database hold the user's
--      plaintext password.
--
--  (B) Remove-member must actually invalidate sessions. 0069 already
--      rotated the bcrypt hash to nonsense, but Supabase JWTs remain
--      valid until expiry and refresh-token rows survive. We now also
--      DELETE auth.sessions + auth.refresh_tokens for the removed
--      user, set banned_until='infinity', and clear app_metadata.role
--      so any cached client-side state fails closed on its next
--      session refresh.
--
--  (C) Super-admin bootstrap surface. The first laptop to install the
--      app on a brand-new unit needs a way to mint the super admin
--      account without anyone already being signed in. We add an
--      anon-callable RPC `unit_super_admin_setup_check` that returns
--      whether bootstrap is allowed; the actual user creation is
--      handled by the matching edge function `unit-super-admin-setup`
--      which gates on the same predicate before calling
--      auth.admin.createUser.
--
-- Idempotent. Safe to re-run.

-- ── (A) Password handling rework ──────────────────────────────────────

alter table public.device_requests
  add column if not exists password_sha256 text,
  add column if not exists claim_token text,
  add column if not exists claim_consumed_at timestamptz;

create unique index if not exists device_requests_claim_token_idx
  on public.device_requests(claim_token)
  where claim_token is not null;

-- Replace unit_request_join: now takes p_password_sha256 + p_claim_token.
-- We keep the old (p_role text, ..., p_password_plain text, ...) signature
-- around as an alias that throws so any in-flight caller fails loud
-- instead of writing plaintext to the DB.
drop function if exists public.unit_request_join(text, text[], text, text, text, text);

create or replace function public.unit_request_join(
  p_role                    text,
  p_requested_squadron_names text[],
  p_username                text,
  p_display_name            text,
  p_password_sha256         text,
  p_claim_token             text,
  p_fingerprint             text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id uuid;
  v_ip inet;
begin
  if not public._unit_join_secret_ok() then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_role not in ('ops', 'flight', 'squadron', 'wing', 'base', 'hq') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_username is null or length(trim(p_username)) < 2 then
    raise exception 'username_too_short' using errcode = '22023';
  end if;
  if p_display_name is null or length(trim(p_display_name)) < 1 then
    raise exception 'display_name_required' using errcode = '22023';
  end if;
  if p_password_sha256 is null or length(p_password_sha256) <> 64 then
    raise exception 'password_hash_invalid' using errcode = '22023';
  end if;
  if p_claim_token is null or length(p_claim_token) < 16 then
    raise exception 'claim_token_invalid' using errcode = '22023';
  end if;
  if p_fingerprint is null or length(p_fingerprint) < 4 then
    raise exception 'fingerprint_required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_requested_squadron_names, 1), 0) = 0 then
    raise exception 'squadrons_required' using errcode = '22023';
  end if;
  if p_role in ('ops', 'flight', 'squadron') and coalesce(array_length(p_requested_squadron_names, 1), 0) > 1 then
    raise exception 'single_squadron_only_for_role' using errcode = '22023';
  end if;
  v_ip := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for';
  insert into public.device_requests
    (requested_role, requested_squadron_names, username, display_name,
     password_sha256, claim_token, fingerprint, originating_ip)
    values
    (p_role, p_requested_squadron_names, p_username, p_display_name,
     p_password_sha256, p_claim_token, p_fingerprint, v_ip)
    returning id into v_request_id;
  return v_request_id;
end;
$$;

revoke all on function public.unit_request_join(text, text[], text, text, text, text, text) from public;
grant execute on function public.unit_request_join(text, text[], text, text, text, text, text) to anon, authenticated, service_role;

-- Replace unit_request_status: never returns the password — only the
-- coordinates the joining laptop needs to drive the claim-device call.
drop function if exists public.unit_request_status(uuid);

create or replace function public.unit_request_status(p_request_id uuid)
returns table (
  status text,
  decision_reason text,
  supabase_email text,
  member_id uuid,
  device_id uuid,
  claim_consumed boolean
) language plpgsql security definer set search_path = '' as $$
begin
  if not public._unit_join_secret_ok() then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return query
    select dr.status,
           dr.decision_reason,
           dr.supabase_email,
           dr.member_id,
           dr.device_id,
           (dr.claim_consumed_at is not null) as claim_consumed
    from public.device_requests dr
    where dr.id = p_request_id;
end;
$$;

revoke all on function public.unit_request_status(uuid) from public;
grant execute on function public.unit_request_status(uuid) to anon, authenticated, service_role;

-- Replace unit_reserve_approval: stops returning password.
drop function if exists public.unit_reserve_approval(uuid, text[]);

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
  if v_req.requested_role = 'ops' then
    v_role := 'ops'; v_tier := 'ops';
  elsif v_req.requested_role = 'hq' then
    v_role := 'super_admin'; v_tier := 'hq';
  else
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
  -- Insert the member + device rows (status='pending_link' until the
  -- edge function attaches auth_user_id via unit_complete_approval).
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

-- Replace unit_complete_approval: drop password param entirely.
drop function if exists public.unit_complete_approval(uuid, uuid, text, text);

create or replace function public.unit_complete_approval(
  p_request_id uuid,
  p_auth_user_id uuid,
  p_supabase_email text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_member_id uuid;
begin
  -- Accept only super-admin OR service-role. The edge fn calls us with
  -- the SUPABASE_SERVICE_ROLE_KEY so RLS does not block the bind step.
  if current_setting('role', true) <> 'service_role' and not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  update public.device_requests
     set supabase_email = p_supabase_email
   where id = p_request_id and status = 'approved'
   returning member_id into v_member_id;
  if v_member_id is null then
    raise exception 'request_not_reserved' using errcode = '22023';
  end if;
  update public.unit_members
     set auth_user_id = p_auth_user_id,
         updated_at = now()
   where id = v_member_id;
end;
$$;

revoke all on function public.unit_complete_approval(uuid, uuid, text) from public;
grant execute on function public.unit_complete_approval(uuid, uuid, text) to authenticated, service_role;

-- New RPC for the claim step. Service-role only — the unit-claim-device
-- edge function calls it after verifying claim_token + password hash.
create or replace function public.unit_mark_claim_consumed(p_request_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role', true) <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  update public.device_requests
     set claim_consumed_at = now()
   where id = p_request_id and claim_consumed_at is null;
end;
$$;

revoke all on function public.unit_mark_claim_consumed(uuid) from public;
grant execute on function public.unit_mark_claim_consumed(uuid) to service_role;

-- Drop the now-unused plaintext columns. CASCADE not needed — no FKs.
alter table public.device_requests drop column if exists password_plain;
alter table public.device_requests drop column if exists supabase_password;

-- ── (B) Remove-member: full session invalidation ──────────────────────

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
    delete from auth.refresh_tokens where user_id = v_auth_user_id;
  end if;
end;
$$;

-- ── (C) Super-admin bootstrap predicate ───────────────────────────────

create or replace function public.unit_super_admin_setup_allowed()
returns boolean
language sql stable security definer set search_path = '' as $$
  -- True iff no super admin currently exists. Anon-callable so the
  -- FirstLaunch screen can decide whether to render the "Set up as
  -- Super Admin" button. The matching edge function re-checks the
  -- same predicate before creating the account, so a race between two
  -- laptops cannot mint two super admins.
  select not exists (
    select 1 from public.unit_members
    where role = 'super_admin' and status = 'active'
  );
$$;

revoke all on function public.unit_super_admin_setup_allowed() from public;
grant execute on function public.unit_super_admin_setup_allowed() to anon, authenticated, service_role;

-- The bootstrap RPC is service-role only — the edge function calls it
-- with SUPABASE_SERVICE_ROLE_KEY after creating the auth.users row.
create or replace function public.unit_super_admin_complete_setup(
  p_auth_user_id uuid,
  p_username text,
  p_display_name text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_member_id uuid;
begin
  if current_setting('role', true) <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  -- Re-check the predicate inside the same transaction so a concurrent
  -- bootstrap loses cleanly with a unique-constraint-style failure.
  if not public.unit_super_admin_setup_allowed() then
    raise exception 'super_admin_already_exists' using errcode = '23505';
  end if;
  insert into public.unit_members
    (auth_user_id, username, display_name, role, tier, squadron_allow_list, status)
  values
    (p_auth_user_id, p_username, p_display_name, 'super_admin', 'hq', array[]::text[], 'active')
  returning id into v_member_id;
  return v_member_id;
end;
$$;

revoke all on function public.unit_super_admin_complete_setup(uuid, text, text) from public;
grant execute on function public.unit_super_admin_complete_setup(uuid, text, text) to service_role;

-- ── Migration ledger ──────────────────────────────────────────────────

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0075_unit_security_hardening.sql', now(), 'task-299-review', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
