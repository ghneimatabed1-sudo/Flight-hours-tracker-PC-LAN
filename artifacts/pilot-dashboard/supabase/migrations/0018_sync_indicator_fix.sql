-- 0018_sync_indicator_fix.sql
-- Fixes two issues in 0017_sync_indicator.sql found during code review:
--
-- 1. ping_pilot_sync() would fail for any pilot who did not already have a
--    pilot_reminder_prefs row, because that table has `squadron_id not null`
--    (from 0005) with no default. The original insert only supplied
--    (pilot_id, last_seen_at, updated_at) and hit a NOT NULL violation
--    silently — mobile clients swallow the error, so the Ops roster dot
--    would stay grey forever for those pilots.
--
-- 2. list_pilot_sync_status() was a SECURITY DEFINER function granted to
--    every authenticated user, with no squadron/pilot filtering. That
--    exposed sync metadata (last-seen timestamps + push-enabled flag) for
--    every pilot in every squadron to anyone who could sign in — including
--    pilot mobile users. Client-side filtering on the PC does not mitigate
--    this. Here we scope the returned rows to the caller's own squadron
--    (for ops/command users) or to the caller's own pilot row (for pilot
--    mobile users), using the existing public.squadron_id() / pilot_id()
--    JWT helpers so the rules match the rest of the RLS model.

-- ── ping_pilot_sync (fixed) ──────────────────────────────────────────
create or replace function public.ping_pilot_sync()
returns timestamptz
language plpgsql security definer set search_path = public, auth as $$
declare
  v_pilot_id    text        := public.pilot_id();
  v_squadron_id uuid;
  v_now         timestamptz := now();
begin
  -- PC users (ops / commanders) have no pilot_id — silently no-op so the
  -- mobile client can call this unconditionally on launch.
  if v_pilot_id is null then
    return null;
  end if;

  -- Bind the ping to the actual pilot row owned by the caller. This also
  -- rejects a stolen / forged JWT that claims a pilot_id not bound to
  -- auth.uid().
  select squadron_id
    into v_squadron_id
    from public.pilots
   where id = v_pilot_id
     and auth_user_id = auth.uid();

  if v_squadron_id is null then
    raise exception 'unauthorized pilot binding' using errcode = '28000';
  end if;

  insert into public.pilot_reminder_prefs
              (pilot_id, squadron_id, last_seen_at, updated_at)
       values (v_pilot_id, v_squadron_id, v_now, v_now)
  on conflict (pilot_id) do update
     set last_seen_at = v_now,
         updated_at   = v_now;

  return v_now;
end;
$$;

-- ── list_pilot_sync_status (fixed) ───────────────────────────────────
-- Ops / command users: return every pilot in their squadron (joined on
--   pilots.squadron_id to cover pilots who have never opened the app
--   and therefore have no prefs row yet — those rows show has_token=false
--   and last_seen_at=null, which the PC renders as the grey "no phone"
--   dot).
-- Pilot mobile users: return only their own row (they never need to see
--   other pilots' sync state).
create or replace function public.list_pilot_sync_status()
returns table (
  pilot_id      text,
  last_seen_at  timestamptz,
  push_enabled  boolean,
  has_token     boolean
)
language plpgsql security definer set search_path = public, auth as $$
declare
  v_pilot_id    text := public.pilot_id();
  v_squadron_id uuid := public.squadron_id();
begin
  if auth.uid() is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  if v_pilot_id is not null then
    -- Pilot mobile caller — see your own status only.
    return query
      select pr.pilot_id,
             pr.last_seen_at,
             coalesce(pr.push_enabled, false),
             (pr.expo_push_token is not null and length(pr.expo_push_token) > 0)
        from public.pilot_reminder_prefs pr
       where pr.pilot_id = v_pilot_id;
    return;
  end if;

  if v_squadron_id is null then
    -- No squadron binding (e.g. anonymous service role token): return
    -- nothing. Super admins with a squadron_id claim still work.
    return;
  end if;

  -- Ops / commander caller — every pilot in their squadron, including
  -- pilots who have never opened the mobile app (left join → null row).
  return query
    select p.id                                                      as pilot_id,
           pr.last_seen_at,
           coalesce(pr.push_enabled, false)                           as push_enabled,
           (pr.expo_push_token is not null
              and length(pr.expo_push_token) > 0)                     as has_token
      from public.pilots p
 left join public.pilot_reminder_prefs pr on pr.pilot_id = p.id
     where p.squadron_id = v_squadron_id;
end;
$$;

revoke all on function public.ping_pilot_sync()         from public;
revoke all on function public.list_pilot_sync_status()  from public;
grant execute on function public.ping_pilot_sync()         to authenticated;
grant execute on function public.list_pilot_sync_status()  to authenticated;
