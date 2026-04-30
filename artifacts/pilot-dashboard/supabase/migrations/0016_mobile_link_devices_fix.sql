-- Fix mobile pilot linking bookkeeping.
--
-- Background: migration 0002 created `pilot_devices` for an opaque-token model
-- (token_hash PK). The mobile app, however, was later switched to use real
-- Supabase Auth sessions (see edge function `link-pilot-device` v6) so each
-- linked device is identified by an `auth.users.id`, not a token. The edge
-- function tried to upsert into pilot_devices with `{pilot_id, user_id, ...}`
-- and `onConflict: "user_id"`, but that column never existed — every link
-- silently failed to record, so the dashboard always showed "NOT LINKED" and
-- "Last sync: Never" even when the phone was actually working.
--
-- This migration:
--   1. Adds `user_id uuid` to pilot_devices and a unique index on it.
--   2. Drops the NOT NULL on token_hash so the auth-based path can insert
--      rows without a token. The opaque-token path (RPCs in 0002) still
--      works for any legacy callers because it always supplies a token_hash.
--   3. Adds an RLS policy that lets a pilot's own auth session read/update
--      their own pilot_devices row (needed by the heartbeat RPC).
--   4. Adds `pilot_heartbeat()` — a SECURITY DEFINER RPC the mobile app
--      calls on every sync. It:
--        a) bumps last_seen_at, and
--        b) backfills a pilot_devices row for already-linked phones whose
--           original link insert was lost to the bug above. Backfill reads
--           pilot_id / squadron_id from the user's app_metadata, which the
--           edge function sets correctly.
--
-- After deploying this migration, every existing linked phone will appear in
-- the dashboard as LINKED on its next sync (within ~15s) — no re-pairing
-- required.

alter table pilot_devices
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- token_hash was the original primary key (opaque-token model). Postgres
-- won't let us drop NOT NULL on a PK column, so demote it: drop the PK,
-- keep the column for legacy callers as a partial unique index, and let
-- the row be identified by either token_hash OR user_id.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.pilot_devices'::regclass
      and contype = 'p'
  ) then
    alter table pilot_devices drop constraint pilot_devices_pkey;
  end if;
end$$;

alter table pilot_devices
  alter column token_hash drop not null;

-- Surrogate PK so PostgREST etc. always have a stable row identifier.
alter table pilot_devices
  add column if not exists id uuid not null default gen_random_uuid();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pilot_devices'::regclass
      and contype = 'p'
  ) then
    alter table pilot_devices add primary key (id);
  end if;
end$$;

create unique index if not exists pilot_devices_token_hash_uniq
  on pilot_devices(token_hash)
  where token_hash is not null;

create unique index if not exists pilot_devices_user_id_uniq
  on pilot_devices(user_id)
  where user_id is not null;

-- Allow a pilot's own auth session to see and bump their own device row.
-- The existing devices_ops_rw policy continues to gate ops staff access by
-- squadron_id; this new policy is additive and pilot-scoped.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'pilot_devices'
      and policyname = 'devices_self_rw'
  ) then
    create policy devices_self_rw on pilot_devices
      for all
      using (user_id is not null and user_id = auth.uid())
      with check (user_id is not null and user_id = auth.uid());
  end if;
end$$;

-- Heartbeat: called by the mobile app on every sync. Updates last_seen_at
-- and, if no row exists yet (legacy phones from before the fix), inserts
-- one using metadata stamped on the auth user by link-pilot-device.
create or replace function public.pilot_heartbeat()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id     uuid := auth.uid();
  v_pilot_id    text;
  v_squadron_id uuid;
begin
  if v_user_id is null then
    return;
  end if;

  update pilot_devices
     set last_seen_at = now(),
         revoked_at   = null
   where user_id = v_user_id;

  if found then
    return;
  end if;

  -- Backfill: read pilot/squadron ids from the auth user's app_metadata.
  select
    raw_app_meta_data->>'pilot_id',
    nullif(raw_app_meta_data->>'squadron_id', '')::uuid
    into v_pilot_id, v_squadron_id
    from auth.users
   where id = v_user_id;

  if v_pilot_id is null or v_squadron_id is null then
    return;
  end if;

  insert into pilot_devices (user_id, pilot_id, squadron_id, linked_at, last_seen_at)
  values (v_user_id, v_pilot_id, v_squadron_id, now(), now())
  on conflict (user_id) do update
    set last_seen_at = excluded.last_seen_at,
        revoked_at   = null;
end;
$$;

revoke all on function public.pilot_heartbeat() from public;
grant execute on function public.pilot_heartbeat() to authenticated;
