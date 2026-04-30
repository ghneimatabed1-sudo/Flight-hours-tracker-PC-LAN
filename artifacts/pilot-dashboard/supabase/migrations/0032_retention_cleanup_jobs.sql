-- 0032_retention_cleanup_jobs.sql
-- Three daily server-side cleanup jobs that close the long-term retention
-- picture. Together with the pre-existing xpc-purge-inactive-pcs job and the
-- in-app sortie/device pruning, this makes Hawk Eye's central database fully
-- self-maintaining over a 15-year deployment with zero operator attention.
--
-- Operator-confirmed retention windows (2026-04-23):
--   1. xpc_messages    : delete read+archived rows older than 3 months
--   2. pilot_link_codes: delete dead codes 7 days after expiry
--   3. audit_log       : delete entries older than 1 year
--
-- All three are idempotent — re-running this migration is a no-op.

create extension if not exists pg_cron;

-- Helper to drop a previously-scheduled job (by name) without erroring if it
-- doesn't exist.
create or replace function public._unschedule_if_exists(job_name text)
returns void language plpgsql as $$
begin
  perform cron.unschedule(jobid)
    from cron.job
   where jobname = job_name;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 1. xpc_messages — delete archived chat messages older than 3 months
-- ────────────────────────────────────────────────────────────────────────
-- Conditions:
--   • read_at is not null   (the recipient has opened it)
--   • in_history = true     (the recipient moved it to History)
--   • sent_at < now() - 3 months
-- Anything still in the active inbox or unread is preserved.
create or replace function public.xpc_purge_archived_messages()
returns integer language plpgsql security definer as $$
declare
  deleted integer;
begin
  delete from public.xpc_messages
   where in_history = true
     and read_at is not null
     and sent_at < now() - interval '3 months';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

select public._unschedule_if_exists('xpc-purge-archived-messages');
select cron.schedule(
  'xpc-purge-archived-messages',
  '15 3 * * *',  -- daily 03:15 UTC
  $$ select public.xpc_purge_archived_messages(); $$
);

-- ────────────────────────────────────────────────────────────────────────
-- 2. pilot_link_codes — delete dead one-time codes 7 days after expiry
-- ────────────────────────────────────────────────────────────────────────
-- Codes default to expires_at = now() + 7 days. Once a code has been expired
-- for an additional 7 days (so 14 days total since issuance), it cannot be
-- recovered or re-used and is safe to delete. Active and recently-expired
-- codes are preserved so an admin can see what they just issued.
create or replace function public.pilot_purge_dead_link_codes()
returns integer language plpgsql security definer as $$
declare
  deleted integer;
begin
  delete from public.pilot_link_codes
   where expires_at < now() - interval '7 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

select public._unschedule_if_exists('pilot-purge-dead-link-codes');
select cron.schedule(
  'pilot-purge-dead-link-codes',
  '20 3 * * *',  -- daily 03:20 UTC
  $$ select public.pilot_purge_dead_link_codes(); $$
);

-- ────────────────────────────────────────────────────────────────────────
-- 3. audit_log — delete entries older than 1 year
-- ────────────────────────────────────────────────────────────────────────
-- The audit_log records "who did what, when". Each PC also keeps its own
-- local copy capped at 2,500 entries, so investigators always have a fallback
-- on the originating PC. Centrally we only need the last 12 months for live
-- dispute resolution; anything older lives on the PC that produced it.
create or replace function public.audit_purge_stale_entries()
returns integer language plpgsql security definer as $$
declare
  deleted integer;
begin
  delete from public.audit_log
   where occurred_at < now() - interval '1 year';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

select public._unschedule_if_exists('audit-purge-stale-entries');
select cron.schedule(
  'audit-purge-stale-entries',
  '25 3 * * *',  -- daily 03:25 UTC
  $$ select public.audit_purge_stale_entries(); $$
);

-- ────────────────────────────────────────────────────────────────────────
-- Sanity probe — return current schedule so the migration log shows the
-- four jobs (existing PC purge + the three new ones) all present.
-- ────────────────────────────────────────────────────────────────────────
do $$
declare r record;
begin
  raise notice 'pg_cron jobs registered:';
  for r in
    select jobname, schedule from cron.job
     where jobname in (
       'xpc-purge-inactive-pcs',
       'xpc-purge-archived-messages',
       'pilot-purge-dead-link-codes',
       'audit-purge-stale-entries'
     )
     order by jobname
  loop
    raise notice '  • % @ %', r.jobname, r.schedule;
  end loop;
end $$;
