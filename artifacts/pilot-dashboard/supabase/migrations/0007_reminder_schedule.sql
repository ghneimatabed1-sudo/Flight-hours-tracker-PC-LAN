-- One-click pg_cron schedule for the daily currency-expiry reminder push.
--
-- 0005_pilot_reminders.sql shipped the table layout plus a *commented* cron
-- template that ops had to paste in by hand (project ref + service role
-- bearer). This migration replaces that manual step with three SECURITY
-- DEFINER helpers callable by the service role from the
-- `manage-reminder-schedule` edge function:
--
--   reminder_schedule_status()  → JSON describing whether the daily job is
--     enabled, its cron expression, and the last 10 cron runs.
--   set_reminder_schedule(url, bearer, cron) → (re)creates the schedule.
--   clear_reminder_schedule()  → removes the schedule.
--
-- pg_cron / pg_net are enabled inside a DO block guarded with `if not
-- exists`, then swallowed if the role lacks superuser. On Supabase both
-- extensions are available out of the box; on a stripped-down local
-- database the helpers themselves return a friendly `extension_missing`
-- flag rather than crashing the page.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension pg_cron;
    exception when others then
      -- swallow: the helpers report extension_missing at runtime
      null;
    end;
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    begin
      create extension pg_net;
    exception when others then
      null;
    end;
  end if;
end $$;

-- ── Status ────────────────────────────────────────────────────────────────
create or replace function public.reminder_schedule_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobid bigint;
  v_schedule text;
  v_active boolean;
  v_runs jsonb;
  v_http jsonb := '[]'::jsonb;
begin
  -- pg_net response table is named `_http_response`. Surface the last 10
  -- HTTP outcomes from net._http_response unconditionally — pg_net's
  -- `http_request_queue` only holds pending rows (processed entries are
  -- removed), so we cannot filter by URL after the fact. This app uses
  -- pg_net only for the daily currency-expiry push, so the recent
  -- responses there are the ones ops cares about. We surface them even
  -- when the cron job has been disabled or recreated, so historical
  -- outcomes remain visible.
  if to_regclass('net._http_response') is not null then
    begin
      execute $sql$
        select coalesce(jsonb_agg(r order by created desc), '[]'::jsonb)
          from (
            select id,
                   status_code,
                   error_msg,
                   created,
                   left(coalesce(content, ''), 500) as content_preview
              from net._http_response
             order by created desc
             limit 10
          ) r
      $sql$ into v_http;
    exception when others then
      v_http := '[]'::jsonb;
    end;
  end if;

  if to_regclass('cron.job') is null then
    return jsonb_build_object(
      'enabled', false,
      'extensionMissing', true,
      'runs', '[]'::jsonb,
      'httpResults', coalesce(v_http, '[]'::jsonb)
    );
  end if;

  execute $sql$
    select jobid, schedule, active
      from cron.job
     where jobname = 'notify-currency-expiry-daily'
     limit 1
  $sql$ into v_jobid, v_schedule, v_active;

  if v_jobid is null then
    return jsonb_build_object(
      'enabled', false,
      'extensionMissing', false,
      'runs', '[]'::jsonb,
      'httpResults', coalesce(v_http, '[]'::jsonb)
    );
  end if;

  execute format($sql$
    select coalesce(jsonb_agg(r order by start_time desc), '[]'::jsonb)
      from (
        select runid, start_time, end_time, status, return_message
          from cron.job_run_details
         where jobid = %L
         order by start_time desc
         limit 10
      ) r
  $sql$, v_jobid) into v_runs;

  return jsonb_build_object(
    'enabled', coalesce(v_active, false),
    'extensionMissing', false,
    'jobid', v_jobid,
    'schedule', v_schedule,
    'runs', coalesce(v_runs, '[]'::jsonb),
    'httpResults', coalesce(v_http, '[]'::jsonb)
  );
end;
$$;

-- ── Enable ────────────────────────────────────────────────────────────────
create or replace function public.set_reminder_schedule(
  p_function_url text,
  p_service_key text,
  p_cron text default '0 6 * * *'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_command text;
  v_jobid bigint;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron not installed';
  end if;
  if p_function_url is null or length(trim(p_function_url)) = 0 then
    raise exception 'bad_url';
  end if;
  if p_service_key is null or length(trim(p_service_key)) = 0 then
    raise exception 'bad_bearer';
  end if;

  v_command := format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type','application/json','Authorization', %L), body := '{}'::jsonb);$cmd$,
    p_function_url,
    'Bearer ' || p_service_key
  );

  -- Idempotent: drop any prior schedule with the same name.
  execute $sql$
    select cron.unschedule(jobid)
      from cron.job
     where jobname = 'notify-currency-expiry-daily'
  $sql$;

  execute format(
    $sql$select cron.schedule(%L, %L, %L)$sql$,
    'notify-currency-expiry-daily', p_cron, v_command
  ) into v_jobid;

  return jsonb_build_object('ok', true, 'jobid', v_jobid, 'schedule', p_cron);
end;
$$;

-- ── Disable ───────────────────────────────────────────────────────────────
create or replace function public.clear_reminder_schedule()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if to_regclass('cron.job') is null then
    return jsonb_build_object('ok', true, 'removed', 0);
  end if;
  execute $sql$
    select cron.unschedule(jobid)
      from cron.job
     where jobname = 'notify-currency-expiry-daily'
  $sql$;
  return jsonb_build_object('ok', true);
end;
$$;

-- ── Recent reminder log ───────────────────────────────────────────────────
-- Joins the dedupe log with pilot names so the dashboard can show "who got
-- notified" without exposing any other pilot columns. Bounded at 100 rows.
create or replace function public.recent_reminder_log()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  select coalesce(jsonb_agg(row order by row.sent_at desc), '[]'::jsonb)
    into v_out
  from (
    select n.sent_at,
           n.pilot_id,
           coalesce(p.name, p.id) as pilot_name,
           p.arabic_name as pilot_name_ar,
           n.currency_key,
           n.expiry_date,
           n.threshold_days
      from pilot_currency_notifications n
      left join pilots p on p.id = n.pilot_id
     order by n.sent_at desc
     limit 100
  ) row;
  return v_out;
end;
$$;

revoke all on function public.reminder_schedule_status()         from public;
revoke all on function public.set_reminder_schedule(text, text, text) from public;
revoke all on function public.clear_reminder_schedule()          from public;
revoke all on function public.recent_reminder_log()              from public;
grant execute on function public.reminder_schedule_status()      to service_role;
grant execute on function public.set_reminder_schedule(text, text, text) to service_role;
grant execute on function public.clear_reminder_schedule()       to service_role;
grant execute on function public.recent_reminder_log()           to service_role;
