-- Per-pilot currency expiry reminders.
--
-- Each pilot picks a list of "fire N days before expiry" thresholds for each
-- currency (Day, Night, IRT, Medical, Sim) plus an Expo push token captured
-- from their phone. A daily edge function (notify-currency-expiry) walks the
-- table, computes days remaining for every currency, and sends a push when
-- any threshold matches. The pilot_currency_notifications table dedupes
-- sends per (pilot, currency, expiry, threshold) so the same reminder never
-- fires twice for the same expiry date.

create table if not exists pilot_reminder_prefs (
  pilot_id text primary key references pilots(id) on delete cascade,
  squadron_id uuid not null references squadrons(id) on delete cascade,
  -- JSONB map keyed by currency_key -> int[] of "days before expiry" values.
  --   { "day": [14,7,1], "night": [7], "irt": [], "medical": [30,7], "sim": [] }
  -- Empty array (or missing key) means no reminders for that currency.
  thresholds jsonb not null default '{}'::jsonb,
  push_enabled boolean not null default false,
  expo_push_token text,
  platform text,
  updated_at timestamptz not null default now()
);

create index if not exists pilot_reminder_prefs_squadron_idx
  on pilot_reminder_prefs(squadron_id);
create index if not exists pilot_reminder_prefs_enabled_idx
  on pilot_reminder_prefs(push_enabled)
  where push_enabled and expo_push_token is not null;

-- Dedupe log: one row per fired reminder. Unique constraint guarantees the
-- edge function is idempotent even if pg_cron retries.
create table if not exists pilot_currency_notifications (
  id bigserial primary key,
  pilot_id text not null references pilots(id) on delete cascade,
  currency_key text not null,
  expiry_date date not null,
  threshold_days int not null,
  sent_at timestamptz not null default now(),
  unique (pilot_id, currency_key, expiry_date, threshold_days)
);

create index if not exists pilot_currency_notifications_pilot_idx
  on pilot_currency_notifications(pilot_id);

alter table pilot_reminder_prefs           enable row level security;
alter table pilot_currency_notifications   enable row level security;

-- Ops staff (squadron JWT) can inspect their squadron's prefs / log via the
-- dashboard if needed. The pilot writes/reads their own row through the
-- SECURITY DEFINER RPCs below — no direct policy needed for that path since
-- the RPCs scope by public.pilot_id().
create policy reminder_prefs_ops_rw on pilot_reminder_prefs
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

create policy currency_notifications_ops_read on pilot_currency_notifications
  for select using (
    exists (
      select 1 from pilots p
       where p.id = pilot_currency_notifications.pilot_id
         and p.squadron_id = public.squadron_id()
    )
  );

-- Pilot reads their own prefs via JWT pilot_id claim.
create policy reminder_prefs_self_select on pilot_reminder_prefs
  for select using (
    public.pilot_id() is not null
    and pilot_id = public.pilot_id()
  );

revoke all on pilot_reminder_prefs        from anon;
revoke all on pilot_currency_notifications from anon;
grant select on pilot_reminder_prefs to authenticated;

-- ── RPCs callable by the signed-in pilot ──────────────────────────────────

-- Save the pilot's reminder preferences. Validates that thresholds is a JSON
-- object whose values are int arrays of "days before expiry" (1..365). The
-- Expo push token may be null when push_enabled is false (pilot opted out
-- without granting permissions, or revoked the token).
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

  -- Whitelist currency keys and validate threshold values.
  for v_key, v_arr in select * from jsonb_each(coalesce(p_thresholds, '{}'::jsonb)) loop
    if v_key not in ('day','night','irt','medical','sim') then
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

create or replace function public.get_pilot_reminder_prefs()
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_pilot_id text := public.pilot_id();
  v_row pilot_reminder_prefs%rowtype;
begin
  if v_pilot_id is null then
    raise exception 'unauthorized';
  end if;
  select * into v_row from pilot_reminder_prefs where pilot_id = v_pilot_id;
  if not found then
    return jsonb_build_object(
      'thresholds', '{}'::jsonb,
      'pushEnabled', false,
      'expoPushToken', null,
      'platform', null
    );
  end if;
  return jsonb_build_object(
    'thresholds', v_row.thresholds,
    'pushEnabled', v_row.push_enabled,
    'expoPushToken', v_row.expo_push_token,
    'platform', v_row.platform,
    'updatedAt', v_row.updated_at
  );
end;
$$;

revoke all on function public.save_pilot_reminder_prefs(jsonb, boolean, text, text) from public;
revoke all on function public.get_pilot_reminder_prefs() from public;
grant execute on function public.save_pilot_reminder_prefs(jsonb, boolean, text, text) to authenticated;
grant execute on function public.get_pilot_reminder_prefs() to authenticated;

-- Optional pg_cron schedule. Requires the `pg_cron` and `pg_net` extensions
-- (both available on Supabase by default). The edge function URL and the
-- service-role bearer must be filled in before this trigger is enabled —
-- left commented so a fresh project does not error on apply.
--
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
--
-- select cron.schedule(
--   'notify-currency-expiry-daily',
--   '0 6 * * *',           -- 06:00 UTC every day
--   $$
--     select net.http_post(
--       url := 'https://<project-ref>.functions.supabase.co/notify-currency-expiry',
--       headers := jsonb_build_object(
--         'Content-Type','application/json',
--         'Authorization','Bearer <SUPABASE_SERVICE_ROLE_KEY>'
--       ),
--       body := '{}'::jsonb
--     );
--   $$
-- );
