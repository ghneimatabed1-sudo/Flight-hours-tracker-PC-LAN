-- 0056_audit_log_archive.sql
--
-- Task #265 Part B — Audit log retention strategy.
--
-- Before this migration, `audit_log` rows older than 1 year were
-- DELETED outright by the daily `audit-purge-stale-entries` cron
-- (see 0032). That worked for the first year of operation but
-- destroys the long compliance trail the user expects to keep across
-- a 15-year service life.
--
-- New policy (operator-confirmed 2026-04-27):
--   • HOT  — last 2 years live in `public.audit_log` (queryable from
--            the dashboard's Audit Log page).
--   • COLD — older rows are MOVED into `public.audit_log_archive`
--            on a daily cron. Same schema, no RLS-readable from the
--            dashboard; super_admin can SELECT from it via the SQL
--            editor for forensic work.
--
-- Plus a size monitor: a daily cron emits an `ops.audit_log.size`
-- audit row with current row count and rough byte size, and emits an
-- additional `ops.audit_log.alert` row if either threshold is
-- breached. Operators grep the Audit Log page for those types.
--
-- Idempotent: safe to re-run.

-- ── 1. Archive table ────────────────────────────────────────────────
create table if not exists public.audit_log_archive (
  id           bigint primary key,
  squadron_id  uuid,
  type         text not null,
  actor        text,
  detail       jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null,
  archived_at  timestamptz not null default now()
);
create index if not exists audit_log_archive_squadron_time_idx
  on public.audit_log_archive(squadron_id, occurred_at desc);
create index if not exists audit_log_archive_type_idx
  on public.audit_log_archive(type);

alter table public.audit_log_archive enable row level security;

drop policy if exists audit_log_archive_select on public.audit_log_archive;
create policy audit_log_archive_select on public.audit_log_archive
  for select to authenticated using (
    coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'role') = 'super_admin',
      false
    )
  );
-- No INSERT/UPDATE/DELETE policy — only the security-definer
-- archive function (running as table owner) writes to this table.

-- ── 2. Archive sweep function ──────────────────────────────────────
-- Move rows whose occurred_at is older than 2 years from audit_log
-- into audit_log_archive, in a single statement so the move is
-- transactionally atomic. CTE-based delete-with-returning + insert
-- avoids the classic dual-write race.
create or replace function public.audit_log_archive_sweep()
returns integer language plpgsql security definer as $$
declare
  moved integer;
begin
  with deleted as (
    delete from public.audit_log
     where occurred_at < now() - interval '2 years'
     returning id, squadron_id, type, actor, detail, occurred_at
  )
  insert into public.audit_log_archive
    (id, squadron_id, type, actor, detail, occurred_at)
  select id, squadron_id, type, actor, detail, occurred_at
    from deleted;
  get diagnostics moved = row_count;
  return moved;
end;
$$;

-- ── 3. Replace the old delete cron with the archive sweep ──────────
-- 0032 scheduled `audit-purge-stale-entries` to DELETE rows >1y old.
-- Unschedule it and replace with the archive sweep. The sweep runs
-- on a 2-year window, so any row 1y < age < 2y stays in audit_log
-- (which is what the new HOT policy demands).
select public._unschedule_if_exists('audit-purge-stale-entries');
select public._unschedule_if_exists('audit-log-archive-sweep');
select cron.schedule(
  'audit-log-archive-sweep',
  '25 3 * * *',  -- daily 03:25 UTC (same slot the old delete cron held)
  $$ select public.audit_log_archive_sweep(); $$
);

-- ── 4. Size monitor ────────────────────────────────────────────────
-- Thresholds are deliberately conservative for a 20-squadron deployment.
-- If the live `audit_log` ever crosses 5,000,000 rows or 2 GiB on disk
-- the monitor logs an alert row that the dashboard's Audit Log page
-- surfaces to the super_admin. We log the size every day regardless
-- (one row per day) so trend analysis is possible.
create or replace function public.audit_log_size_monitor()
returns void language plpgsql security definer as $$
declare
  v_rows  bigint;
  v_bytes bigint;
  v_alert boolean := false;
  v_threshold_rows  bigint := 5000000;       -- 5M rows
  v_threshold_bytes bigint := 2147483648;    -- 2 GiB
begin
  select count(*) into v_rows from public.audit_log;
  select pg_total_relation_size('public.audit_log'::regclass) into v_bytes;

  insert into public.audit_log
    (type, actor, detail, squadron_id, occurred_at)
  values (
    'ops.audit_log.size',
    'system.cron',
    jsonb_build_object(
      'rows', v_rows,
      'bytes', v_bytes,
      'thresholds', jsonb_build_object(
        'rows', v_threshold_rows,
        'bytes', v_threshold_bytes
      )
    ),
    null,
    now()
  );

  if v_rows > v_threshold_rows or v_bytes > v_threshold_bytes then
    v_alert := true;
  end if;

  if v_alert then
    insert into public.audit_log
      (type, actor, detail, squadron_id, occurred_at)
    values (
      'ops.audit_log.alert',
      'system.cron',
      jsonb_build_object(
        'rows', v_rows,
        'bytes', v_bytes,
        'message',
        'audit_log exceeds retention threshold; review archive cron and consider manual sweep'
      ),
      null,
      now()
    );
  end if;
end;
$$;

select public._unschedule_if_exists('audit-log-size-monitor');
select cron.schedule(
  'audit-log-size-monitor',
  '40 3 * * *',  -- daily 03:40 UTC, after the archive sweep
  $$ select public.audit_log_size_monitor(); $$
);

-- ── 5. Sanity probe ────────────────────────────────────────────────
do $$
declare r record;
begin
  raise notice 'audit-log retention jobs (after 0056):';
  for r in
    select jobname, schedule from cron.job
     where jobname in (
       'audit-log-archive-sweep',
       'audit-log-size-monitor'
     )
     order by jobname
  loop
    raise notice '  • % @ %', r.jobname, r.schedule;
  end loop;
  raise notice 'audit_log_archive table exists: %',
    (select to_regclass('public.audit_log_archive') is not null);
end $$;

notify pgrst, 'reload schema';

-- Self-insert into the migration ledger (Audit AA1 — Round 4).
-- This file was originally numbered 0056_audit_log_archive.sql and
-- shipped without a self-insert; the apply workflow's own ledger
-- write picked up the slack on the live row. After the AA1 prefix
-- surgery renumbered the file to 0062 and the live ledger row was
-- updated to match, we add this self-insert so any future operator
-- pasting the file through the SQL editor (i.e. without the apply
-- workflow's surrounding ledger logic) still records the apply. The
-- on-conflict clause makes this a no-op on every subsequent run; the
-- apply workflow's own ledger update will overwrite the NULL sha
-- with the disk hash on the next CI run (Task #195 self-heal).
insert into public._migration_ledger (filename, applied_by, sha256)
values ('0062_audit_log_archive.sql', 'manual-task-AA1', null)
on conflict (filename) do nothing;
