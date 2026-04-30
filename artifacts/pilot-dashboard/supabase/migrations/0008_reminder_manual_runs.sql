-- Track manual "Run now" invocations of notify-currency-expiry so they
-- show up alongside pg_cron-driven runs in the dashboard's recent-runs
-- table. The edge function writes one row per manual trigger after the
-- HTTP call to notify-currency-expiry returns; reminder_schedule_status()
-- unions them with cron.job_run_details so ops can verify the wiring
-- end-to-end without waiting for the next 06:00 UTC tick.

create table if not exists public.reminder_manual_runs (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  status          text not null,
  return_message  text,
  actor           text
);

create index if not exists reminder_manual_runs_started_at_idx
  on public.reminder_manual_runs (started_at desc);

revoke all on table public.reminder_manual_runs from public;
grant select, insert on table public.reminder_manual_runs to service_role;
grant usage, select on sequence public.reminder_manual_runs_id_seq to service_role;

-- Replace status helper so its `runs` array merges cron + manual runs,
-- keyed off the most recent 10 events overall. Manual rows are emitted
-- with negative runids so the React table's `key={r.runid}` stays unique
-- without colliding with cron.job_run_details.runid.
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
  v_runs jsonb := '[]'::jsonb;
  v_http jsonb := '[]'::jsonb;
  v_manual jsonb := '[]'::jsonb;
begin
  -- 1. Recent HTTP outcomes (pg_net), if the table exists.
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

  -- 2. Recent manual runs (always available, no extension required).
  select coalesce(jsonb_agg(r order by r.start_time desc), '[]'::jsonb)
    into v_manual
  from (
    select (-id)::bigint        as runid,
           started_at            as start_time,
           ended_at              as end_time,
           status                as status,
           return_message        as return_message
      from public.reminder_manual_runs
     order by started_at desc
     limit 10
  ) r;

  -- 3. Recent cron runs (only if pg_cron is installed).
  if to_regclass('cron.job') is null then
    return jsonb_build_object(
      'enabled', false,
      'extensionMissing', true,
      'runs', v_manual,
      'httpResults', coalesce(v_http, '[]'::jsonb)
    );
  end if;

  execute $sql$
    select jobid, schedule, active
      from cron.job
     where jobname = 'notify-currency-expiry-daily'
     limit 1
  $sql$ into v_jobid, v_schedule, v_active;

  if v_jobid is not null then
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
  end if;

  -- Merge cron + manual runs, sort by start_time, keep newest 10 overall.
  with combined as (
    select value as r
      from jsonb_array_elements(coalesce(v_runs, '[]'::jsonb)) as value
    union all
    select value as r
      from jsonb_array_elements(coalesce(v_manual, '[]'::jsonb)) as value
  ),
  ordered as (
    select r from combined
    order by (r->>'start_time') desc nulls last
    limit 10
  )
  select coalesce(jsonb_agg(r order by (r->>'start_time') desc nulls last), '[]'::jsonb)
    into v_runs
    from ordered;

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

revoke all on function public.reminder_schedule_status() from public;
grant execute on function public.reminder_schedule_status() to service_role;
