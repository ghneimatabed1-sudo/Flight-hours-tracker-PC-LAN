-- 0059_runtime_errors.sql
--
-- Task #265 Part F — Runtime error capture.
--
-- Today, when a runtime UI error happens (e.g. a thrown exception in
-- a React component, an unhandled promise rejection, a render-loop
-- crash), the user sees the error toast / fallback page but no one
-- sees it centrally until an audit walks the page. The F-J-01 defect
-- in the round-2 audit was discovered exactly this way.
--
-- This migration introduces:
--
--   • `public.runtime_errors` table — append-only crash log
--   • `public.runtime_error_capture(...)` RPC — fire-and-forget
--     insert callable from `authenticated` and `anon`
--     (anon is required because the dashboard's pre-mount fatal
--     overlay can run before any session is restored).
--   • `public.runtime_errors_digest()` — daily cron that summarises
--     the prior 24h (count by route + count by error name) into a
--     single `ops.runtime_errors.digest` audit_log row that the
--     super_admin can read from the dashboard's Audit Log page.
--   • `public.runtime_errors_purge()` — daily cron that deletes
--     rows older than 90 days; long-term aggregates live in the
--     digest audit rows.
--
-- Idempotent: safe to re-run.

-- ── 1. Table ────────────────────────────────────────────────────────
create table if not exists public.runtime_errors (
  id           bigserial primary key,
  occurred_at  timestamptz not null default now(),
  app          text not null,                       -- 'dashboard' | 'mobile'
  app_version  text,
  role         text,                                -- super_admin | commander | ops | pilot | guest | anon
  user_id      uuid,                                -- NULL when anon / pre-login
  squadron_id  uuid,
  page         text,                                -- '/sorties' | hash route | mobile screen name
  message      text not null,
  name         text,                                -- error.name (TypeError, ReferenceError, …)
  stack        text,                                -- truncated to 4000 chars at insert time
  user_agent   text,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists runtime_errors_time_idx
  on public.runtime_errors(occurred_at desc);
create index if not exists runtime_errors_app_time_idx
  on public.runtime_errors(app, occurred_at desc);
create index if not exists runtime_errors_squadron_idx
  on public.runtime_errors(squadron_id, occurred_at desc);

alter table public.runtime_errors enable row level security;

-- super_admin reads everything; commander reads their squadron only.
drop policy if exists runtime_errors_select_super on public.runtime_errors;
create policy runtime_errors_select_super on public.runtime_errors
  for select to authenticated using (
    coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'role') = 'super_admin',
      false
    )
  );

drop policy if exists runtime_errors_select_commander on public.runtime_errors;
create policy runtime_errors_select_commander on public.runtime_errors
  for select to authenticated using (
    squadron_id is not null
    and squadron_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb
                        -> 'app_metadata' ->> 'squadron_id')::uuid
    and (nullif(current_setting('request.jwt.claims', true), '')::jsonb
          -> 'app_metadata' ->> 'role') = 'commander'
  );

-- No INSERT/UPDATE/DELETE policy on the table — clients use the RPC.

-- ── 2. Capture RPC ─────────────────────────────────────────────────
-- Single entry point for both apps. Truncates oversized fields at
-- insert time so a runaway stack can never bloat the row.
create or replace function public.runtime_error_capture(
  p_app         text,
  p_app_version text,
  p_page        text,
  p_message     text,
  p_name        text default null,
  p_stack       text default null,
  p_user_agent  text default null,
  p_detail      jsonb default '{}'::jsonb
)
returns bigint language plpgsql security definer as $$
declare
  v_id    bigint;
  v_uid   uuid;
  v_role  text;
  v_sq    uuid;
begin
  if p_app is null or length(trim(p_app)) = 0 then
    raise exception 'runtime_error_capture: app required';
  end if;
  if p_message is null or length(trim(p_message)) = 0 then
    raise exception 'runtime_error_capture: message required';
  end if;

  v_uid  := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'role';
  v_sq   := (nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'squadron_id')::uuid;

  insert into public.runtime_errors
    (app, app_version, role, user_id, squadron_id, page,
     message, name, stack, user_agent, detail)
  values (
    substr(p_app, 1, 32),
    nullif(substr(coalesce(p_app_version, ''), 1, 64), ''),
    coalesce(v_role, 'anon'),
    v_uid,
    v_sq,
    nullif(substr(coalesce(p_page, ''), 1, 256), ''),
    substr(p_message, 1, 1000),
    nullif(substr(coalesce(p_name, ''), 1, 64), ''),
    nullif(substr(coalesce(p_stack, ''), 1, 4000), ''),
    nullif(substr(coalesce(p_user_agent, ''), 1, 512), ''),
    coalesce(p_detail, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.runtime_error_capture(
  text, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.runtime_error_capture(
  text, text, text, text, text, text, text, jsonb)
  to authenticated, anon, service_role;

-- ── 3. Daily digest ────────────────────────────────────────────────
-- Aggregates the last 24h of crashes into a single audit_log row
-- the super_admin can find by filtering for type='ops.runtime_errors.digest'.
create or replace function public.runtime_errors_digest()
returns void language plpgsql security definer as $$
declare
  v_count   integer;
  v_by_app  jsonb;
  v_by_name jsonb;
  v_top     jsonb;
begin
  select count(*) into v_count
    from public.runtime_errors
   where occurred_at >= now() - interval '24 hours';

  select jsonb_object_agg(app, n) into v_by_app
    from (
      select app, count(*) as n
        from public.runtime_errors
       where occurred_at >= now() - interval '24 hours'
       group by app
    ) s;

  select jsonb_object_agg(coalesce(name, '(unknown)'), n) into v_by_name
    from (
      select name, count(*) as n
        from public.runtime_errors
       where occurred_at >= now() - interval '24 hours'
       group by name
       order by 2 desc
       limit 20
    ) s;

  select coalesce(jsonb_agg(jsonb_build_object(
    'message', message,
    'count',   n,
    'last_seen', last_seen
  )), '[]'::jsonb) into v_top
    from (
      select message, count(*) as n, max(occurred_at) as last_seen
        from public.runtime_errors
       where occurred_at >= now() - interval '24 hours'
       group by message
       order by 2 desc
       limit 10
    ) s;

  insert into public.audit_log
    (type, actor, detail, squadron_id, occurred_at)
  values (
    'ops.runtime_errors.digest',
    'system.cron',
    jsonb_build_object(
      'window',   '24h',
      'count',    v_count,
      'by_app',   coalesce(v_by_app,  '{}'::jsonb),
      'by_name',  coalesce(v_by_name, '{}'::jsonb),
      'top_messages', v_top
    ),
    null,
    now()
  );
end;
$$;

select public._unschedule_if_exists('runtime-errors-digest');
select cron.schedule(
  'runtime-errors-digest',
  '5 4 * * *',  -- daily 04:05 UTC, after the size monitor
  $$ select public.runtime_errors_digest(); $$
);

-- ── 4. 90-day purge ────────────────────────────────────────────────
create or replace function public.runtime_errors_purge()
returns integer language plpgsql security definer as $$
declare
  deleted integer;
begin
  delete from public.runtime_errors
   where occurred_at < now() - interval '90 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

select public._unschedule_if_exists('runtime-errors-purge');
select cron.schedule(
  'runtime-errors-purge',
  '10 4 * * *',  -- daily 04:10 UTC, after the digest is computed
  $$ select public.runtime_errors_purge(); $$
);

-- ── 5. Sanity probe ────────────────────────────────────────────────
do $$
declare r record;
begin
  raise notice 'runtime_errors infrastructure (after 0059):';
  raise notice '  table exists: %',
    (select to_regclass('public.runtime_errors') is not null);
  for r in
    select jobname, schedule from cron.job
     where jobname in ('runtime-errors-digest', 'runtime-errors-purge')
     order by jobname
  loop
    raise notice '  cron: % @ %', r.jobname, r.schedule;
  end loop;
end $$;

notify pgrst, 'reload schema';
