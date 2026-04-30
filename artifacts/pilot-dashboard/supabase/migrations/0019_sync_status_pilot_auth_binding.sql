-- 0019_sync_status_pilot_auth_binding.sql
--
-- Hardens `list_pilot_sync_status()` so the pilot branch cannot read
-- another pilot's sync row via a stale/reassigned `pilot_id` JWT claim.
--
-- Context: the RPC runs `SECURITY DEFINER` (so it can join through the
-- `pilots` table even when the pilot role's RLS wouldn't permit it).
-- The ops/commander branch already squadron-scopes via
-- `p.squadron_id = squadron_id()`, but the pilot branch previously
-- trusted `public.pilot_id()` — which reads the JWT's
-- `app_metadata.pilot_id` claim — without re-binding to the session's
-- actual auth user. In the rare case where a pilot token survived a
-- `pilot_id` reassignment, that token could still read the now-orphan
-- row. Unlikely, but trivially fixed by matching the same
-- `pilots.auth_user_id = auth.uid()` binding we added to
-- `ping_pilot_sync()` in 0018.
--
-- After this migration, the pilot branch joins `pilots p` and requires
-- `p.auth_user_id = auth.uid() AND p.id = pr.pilot_id`, so the return
-- row is gated on the DB row, not the JWT claim.

create or replace function public.list_pilot_sync_status()
returns table(
  pilot_id       text,
  last_seen_at   timestamptz,
  push_enabled   boolean,
  has_token      boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_pilot_id    text := public.pilot_id();
  v_squadron_id uuid := public.squadron_id();
begin
  if auth.uid() is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  if v_pilot_id is not null then
    -- Pilot mobile caller — see your own status only. We re-bind to
    -- auth.uid() via the pilots table so a forged / stale pilot_id
    -- claim can't read another pilot's row.
    return query
      select pr.pilot_id,
             pr.last_seen_at,
             coalesce(pr.push_enabled, false)                        as push_enabled,
             (pr.expo_push_token is not null
                and length(pr.expo_push_token) > 0)                   as has_token
        from public.pilots p
        join public.pilot_reminder_prefs pr on pr.pilot_id = p.id
       where p.auth_user_id = auth.uid()
         and p.id = v_pilot_id;
    return;
  end if;

  if v_squadron_id is null then
    -- No squadron binding (anonymous service-role token, etc.): nothing.
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

grant execute on function public.list_pilot_sync_status() to authenticated;
