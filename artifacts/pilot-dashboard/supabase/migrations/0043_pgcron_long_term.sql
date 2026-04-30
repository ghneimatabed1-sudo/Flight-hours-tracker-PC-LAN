-- 0043_pgcron_long_term.sql
--
-- Task #145 (3/4) — Three pg_cron jobs that keep the system clean
-- across 15 years of unattended operation.
--
-- Migration 0032 already scheduled three daily purges (xpc_messages,
-- pilot_link_codes, audit_log) and a daily inactive-PC sweep. This
-- migration adds:
--
--   • xpc-pair-links-sweep-weekly — calls xpc_pair_links_sweep(90) once a
--     week. Revokes stale pair links AND expires time-bound
--     cross_squadron_ops links. Without this the pair table grows
--     unboundedly across personnel turnover.
--
--   • xpc-purge-archived-messages-weekly — same purge function as the
--     existing daily job, kept on a weekly schedule too as belt-and-
--     braces (the daily job is fine but if it ever fails to schedule
--     after a Supabase upgrade, the weekly tick keeps the table from
--     growing). Idempotent.
--
--   • backup-completed-daily — emits an audit_log row tagged
--     "ops.backup.completed" once a day. The off-Supabase backup itself
--     is configured separately (Supabase project → Backups), but the
--     audit row gives operators a one-line "yes the backup ran" signal
--     they can grep for from inside the dashboard's Audit Log page
--     without leaving the app.
--
-- Re-running this migration is a no-op — every job is unscheduled by
-- name first, then re-scheduled.

-- pg_cron must NOT live in the public schema (the Supabase security
-- advisor flags any extension installed in public). On a fresh
-- Supabase project, our preferred home is the dedicated `extensions`
-- schema; on legacy projects (including this one) Supabase originally
-- installed it into `pg_catalog`, and moving it would unschedule every
-- existing job — too destructive to do here.
--
-- Strategy: try to install into `extensions`, then assert the resulting
-- schema is anything OTHER than public. Fail loudly if it ended up in
-- public so the operator can manually drop+recreate before any cron
-- job is registered.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Fresh install: put it in the right place from the start.
    create extension pg_cron with schema extensions;
  end if;
end $$;

do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_cron';
  if v_schema is null then
    raise exception 'pg_cron is not installed at all.';
  elsif v_schema = 'public' then
    raise exception
      'pg_cron is installed in the public schema, which the Supabase '
      'security advisor forbids. Run as superuser: '
      '  drop extension pg_cron cascade; '
      '  create extension pg_cron with schema extensions; '
      'then re-apply this migration.';
  else
    raise notice 'pg_cron schema check OK (installed in %).', v_schema;
  end if;
end $$;

-- Reuse the helper from 0032.
-- (No-op create: idempotent restart.)
create or replace function public._unschedule_if_exists(job_name text)
returns void language plpgsql as $$
begin
  perform cron.unschedule(jobid)
    from cron.job
   where jobname = job_name;
end;
$$;

-- ── 1. Weekly pair-links sweep ──────────────────────────────────────
select public._unschedule_if_exists('xpc-pair-links-sweep-weekly');
select cron.schedule(
  'xpc-pair-links-sweep-weekly',
  '30 3 * * 0',  -- Sunday 03:30 UTC
  $$ select public.xpc_pair_links_sweep(90); $$
);

-- ── 2. Weekly archive purge (belt + braces vs. the daily 0032 job) ──
select public._unschedule_if_exists('xpc-purge-archived-messages-weekly');
select cron.schedule(
  'xpc-purge-archived-messages-weekly',
  '35 3 * * 0',  -- Sunday 03:35 UTC
  $$ select public.xpc_purge_archived_messages(); $$
);

-- ── 3. Daily backup-completed audit ping ────────────────────────────
-- audit_log.squadron_id is nullable; system-wide events leave it NULL
-- so the Audit Log viewer renders them as cross-squadron. Operators
-- can grep for type='ops.backup.completed' to confirm the daily
-- backup window elapsed without leaving the dashboard.
create or replace function public.ops_backup_audit_ping()
returns void language plpgsql security definer as $$
begin
  insert into public.audit_log (type, actor, detail, squadron_id, occurred_at)
    values (
      'ops.backup.completed',
      'system.cron',
      jsonb_build_object(
        'note', 'Daily Supabase backup window elapsed.',
        'scheduled_by', 'pg_cron'
      ),
      null,
      now()
    );
end;
$$;

select public._unschedule_if_exists('ops-backup-audit-ping');
select cron.schedule(
  'ops-backup-audit-ping',
  '0 4 * * *',  -- daily 04:00 UTC, after Supabase's automatic backup window
  $$ select public.ops_backup_audit_ping(); $$
);

-- Sanity probe so the migration log shows the new entries clearly.
do $$
declare r record;
begin
  raise notice 'pg_cron jobs registered after 0043:';
  for r in
    select jobname, schedule from cron.job
     where jobname in (
       'xpc-pair-links-sweep-weekly',
       'xpc-purge-archived-messages-weekly',
       'ops-backup-audit-ping'
     )
     order by jobname
  loop
    raise notice '  • % @ %', r.jobname, r.schedule;
  end loop;
end $$;

notify pgrst, 'reload schema';
