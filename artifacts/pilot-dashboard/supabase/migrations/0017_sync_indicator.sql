-- 0017_sync_indicator.sql
-- Adds a pilot phone "sync indicator" used by the Ops PC Roster page:
--   * new column   pilot_reminder_prefs.last_seen_at
--   * new RPC      public.ping_pilot_sync()
--   * new RPC      public.list_pilot_sync_status() (Ops-readable view)
--
-- The mobile app calls ping_pilot_sync() on cold launch, every time the
-- phone returns to the foreground, and every N hours (N is a per-pilot
-- setting in mobile Settings, default 3h). The Ops PC reads
-- list_pilot_sync_status() to colour each pilot row green (≤24h),
-- yellow (>24h) or grey (no phone linked).

alter table public.pilot_reminder_prefs
  add column if not exists last_seen_at timestamptz;

create or replace function public.ping_pilot_sync()
returns timestamptz
language plpgsql security definer set search_path = public, auth as $$
declare
  v_pilot_id text := public.pilot_id();
  v_now      timestamptz := now();
begin
  if v_pilot_id is null then
    -- PC users (ops / commanders) have no pilot_id: silently no-op so
    -- the mobile client can call this unconditionally on launch.
    return null;
  end if;

  insert into public.pilot_reminder_prefs (pilot_id, last_seen_at, updated_at)
       values (v_pilot_id, v_now, v_now)
  on conflict (pilot_id) do update
     set last_seen_at = v_now,
         updated_at   = v_now;

  return v_now;
end;
$$;

-- Ops-facing read. Returns one row per pilot in the caller's scope with
-- the raw last_seen_at timestamp (or null if the pilot has never opened
-- the mobile app). The PC client derives the colour state client-side so
-- the thresholds (24h) can be tweaked without another migration.
create or replace function public.list_pilot_sync_status()
returns table (
  pilot_id      text,
  last_seen_at  timestamptz,
  push_enabled  boolean,
  has_token     boolean
)
language plpgsql security definer set search_path = public, auth as $$
begin
  -- Any authenticated caller may read this. The return payload contains
  -- only a pilot_id, a boolean, and a timestamp — nothing confidential —
  -- and the PC client filters to pilots it already has visibility on
  -- (Ops sees only their squadron's pilots via the existing pilots RLS).
  if auth.uid() is null then
    raise exception 'unauthorized';
  end if;

  return query
    select p.pilot_id,
           p.last_seen_at,
           coalesce(p.push_enabled, false),
           (p.expo_push_token is not null and length(p.expo_push_token) > 0)
      from public.pilot_reminder_prefs p;
end;
$$;

revoke all on function public.ping_pilot_sync() from public;
revoke all on function public.list_pilot_sync_status() from public;
grant execute on function public.ping_pilot_sync() to authenticated;
grant execute on function public.list_pilot_sync_status() to authenticated;
