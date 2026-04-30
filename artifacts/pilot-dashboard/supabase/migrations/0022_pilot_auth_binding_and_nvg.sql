-- 0022_pilot_auth_binding_and_nvg.sql
--
-- Two related fixes for the pilot reminder-prefs persistence bug that
-- caused "Push notifications" to silently revert to OFF every time a
-- pilot left and re-entered the Reminders screen, and caused the
-- dashboard's notify-alert leg to never find a push token (so squadron
-- commander alerts only appeared when the pilot opened the app).
--
-- Bug 1 (root cause): link-pilot-device set `app_metadata.pilot_id` on
-- the auth user but never set `pilots.auth_user_id`. The save RPC
-- (save_pilot_reminder_prefs from migration 0005) requires both
-- `pilot_id()` from the JWT AND a row in `pilots` whose
-- `auth_user_id = auth.uid()`. Without the binding the RPC raises
-- 'unauthorized'; the mobile client swallows that error (best-effort
-- background sync) so the toggle appeared to save locally but never
-- reached Supabase. On the next load the RPC returned the older
-- (or empty) row → push_enabled=false.
--
-- The edge function is being updated in the same release to set
-- `pilots.auth_user_id` on every new pair. This migration backfills
-- the binding for every pilot who already paired, by joining the
-- `pilots` table to `auth.users` via the `app_metadata.pilot_id`
-- claim that link-pilot-device has stamped onto the auth user since
-- v1.
--
-- Bug 2 (latent): the `save_pilot_reminder_prefs` whitelist allowed
-- the keys ('day','night','irt','medical','sim') but the mobile app
-- and the rest of the dashboard treat NVG as a first-class currency.
-- A pilot who set an NVG threshold would also have had the RPC
-- raise 'bad_currency_key' (also swallowed). Add 'nvg' to the
-- whitelist so the validator accepts every currency the UI exposes.

-- ──────────────────────────────────────────────────────────────────────
-- Backfill: bind every paired pilot to their auth user.
-- ──────────────────────────────────────────────────────────────────────
update public.pilots p
   set auth_user_id = u.id
  from auth.users u
 where p.auth_user_id is null
   and (u.raw_app_meta_data ->> 'pilot_id') = p.id;

-- ──────────────────────────────────────────────────────────────────────
-- Re-create save_pilot_reminder_prefs with 'nvg' in the whitelist. The
-- function signature and security model are unchanged — only the IN
-- clause for v_key is widened.
-- ──────────────────────────────────────────────────────────────────────
create or replace function public.save_pilot_reminder_prefs(
  p_thresholds jsonb,
  p_push_enabled boolean,
  p_expo_push_token text,
  p_platform text
) returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  v_pilot_id text := public.pilot_id();
  v_squadron uuid;
  v_key text;
  v_arr jsonb;
  v_day int;
begin
  if v_pilot_id is null then
    raise exception 'unauthorized';
  end if;
  select squadron_id into v_squadron from pilots
   where id = v_pilot_id and auth_user_id = auth.uid();
  if v_squadron is null then
    raise exception 'unauthorized';
  end if;

  if jsonb_typeof(coalesce(p_thresholds, '{}'::jsonb)) <> 'object' then
    raise exception 'bad_input';
  end if;

  -- Whitelist currency keys (now includes 'nvg') and validate threshold values.
  for v_key, v_arr in select * from jsonb_each(coalesce(p_thresholds, '{}'::jsonb)) loop
    if v_key not in ('day','night','nvg','irt','medical','sim') then
      raise exception 'bad_currency_key';
    end if;
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'bad_threshold_array';
    end if;
    for v_day in select (jsonb_array_elements(v_arr))::text::int loop
      if v_day < 0 or v_day > 365 then
        raise exception 'bad_threshold_value';
      end if;
    end loop;
  end loop;

  insert into pilot_reminder_prefs (
    pilot_id, squadron_id, thresholds, push_enabled,
    expo_push_token, platform, updated_at
  ) values (
    v_pilot_id, v_squadron, coalesce(p_thresholds, '{}'::jsonb),
    coalesce(p_push_enabled, false),
    nullif(trim(coalesce(p_expo_push_token, '')), ''),
    nullif(trim(coalesce(p_platform, '')), ''),
    now()
  )
  on conflict (pilot_id) do update
     set thresholds       = excluded.thresholds,
         push_enabled     = excluded.push_enabled,
         expo_push_token  = excluded.expo_push_token,
         platform         = excluded.platform,
         updated_at       = now();
end;
$$;

revoke all on function public.save_pilot_reminder_prefs(jsonb, boolean, text, text) from public;
grant execute on function public.save_pilot_reminder_prefs(jsonb, boolean, text, text) to authenticated;
