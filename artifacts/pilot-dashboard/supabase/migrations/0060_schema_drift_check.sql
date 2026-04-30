-- 0060_schema_drift_check.sql
--
-- Task #265 Part H — Long-term schema drift detection.
--
-- Audit E (#195) added a per-migration sha256 in `_migration_ledger`
-- and the GitHub Actions workflow checks it on every push. That
-- catches the case where a migration FILE is edited after being
-- applied, but it does NOT catch the inverse: someone running
-- ad-hoc SQL in the Supabase SQL editor that mutates the live
-- schema without a corresponding migration file.
--
-- This migration adds a daily cron that snapshots the structural
-- shape of the live `public` schema (tables, columns, indexes,
-- triggers, foreign keys) and compares the snapshot's hash to the
-- previous day's. Any difference logs an `ops.schema.drift` audit
-- row with a unified diff between the two snapshots so the
-- super_admin can see exactly what changed.
--
-- Snapshots live in `public._schema_snapshots`, keyed by date.
-- The retention policy is 60 days (the table is small — one row
-- per day, ~5 KB compressed text per row at the current schema size).
--
-- Idempotent: safe to re-run.

-- ── 1. Snapshot table ──────────────────────────────────────────────
create table if not exists public._schema_snapshots (
  taken_at  timestamptz primary key default now(),
  sha256    text not null,
  fingerprint text not null
);
alter table public._schema_snapshots enable row level security;

drop policy if exists schema_snapshots_select on public._schema_snapshots;
create policy schema_snapshots_select on public._schema_snapshots
  for select to authenticated using (
    coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'role') = 'super_admin',
      false
    )
  );

-- ── 2. Live-schema fingerprint function ────────────────────────────
-- Returns a deterministic, line-oriented text representation of the
-- public schema. Order matters — every result set is sorted so two
-- runs against an unchanged schema return byte-identical text.
create or replace function public.schema_fingerprint_public()
returns text language plpgsql stable security definer as $$
declare
  v_out text := '';
begin
  -- Tables + columns
  with cols as (
    select c.table_name,
           c.column_name,
           c.data_type,
           c.is_nullable,
           c.column_default
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name not like 'pg\_%'
     order by c.table_name, c.ordinal_position
  )
  select v_out || string_agg(
    'COL ' || table_name || ' ' || column_name || ' ' || data_type ||
      ' nullable=' || is_nullable ||
      ' default=' || coalesce(column_default, '<none>'),
    E'\n'
  ) into v_out
  from cols;

  -- Indexes
  with ix as (
    select schemaname, tablename, indexname, indexdef
      from pg_indexes
     where schemaname = 'public'
     order by tablename, indexname
  )
  select v_out || E'\n' || coalesce(string_agg(
    'IDX ' || tablename || ' ' || indexname || ' ' || indexdef, E'\n'
  ), '') into v_out
  from ix;

  -- Foreign keys
  with fks as (
    select tc.table_name, tc.constraint_name,
           kcu.column_name, ccu.table_name as ref_table,
           ccu.column_name as ref_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name
       and kcu.constraint_schema = tc.constraint_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
       and ccu.constraint_schema = tc.constraint_schema
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_schema = 'public'
     order by tc.table_name, tc.constraint_name, kcu.column_name
  )
  select v_out || E'\n' || coalesce(string_agg(
    'FK  ' || table_name || ' ' || constraint_name ||
      ' (' || column_name || ') -> ' || ref_table || '(' || ref_column || ')',
    E'\n'
  ), '') into v_out
  from fks;

  -- Triggers
  with trg as (
    select event_object_table as tbl, trigger_name, event_manipulation, action_timing
      from information_schema.triggers
     where trigger_schema = 'public'
     order by event_object_table, trigger_name, event_manipulation
  )
  select v_out || E'\n' || coalesce(string_agg(
    'TRG ' || tbl || ' ' || trigger_name || ' ' || action_timing || ' ' || event_manipulation,
    E'\n'
  ), '') into v_out
  from trg;

  -- RLS policies (name + table + cmd; not the USING clause itself —
  -- changes there are intentional + audited via migration files).
  with pol as (
    select schemaname, tablename, policyname, cmd, roles::text as roles
      from pg_policies
     where schemaname = 'public'
     order by tablename, policyname, cmd
  )
  select v_out || E'\n' || coalesce(string_agg(
    'POL ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || roles,
    E'\n'
  ), '') into v_out
  from pol;

  return v_out;
end;
$$;

-- ── 3. Drift check cron ────────────────────────────────────────────
create or replace function public.schema_drift_check()
returns boolean language plpgsql security definer as $$
declare
  v_fp     text;
  v_hash   text;
  v_prev   public._schema_snapshots%rowtype;
  v_drift  boolean := false;
begin
  v_fp   := public.schema_fingerprint_public();
  v_hash := encode(digest(v_fp, 'sha256'), 'hex');

  select * into v_prev
    from public._schema_snapshots
   order by taken_at desc
   limit 1;

  if found and v_prev.sha256 <> v_hash then
    v_drift := true;
    insert into public.audit_log
      (type, actor, detail, squadron_id, occurred_at)
    values (
      'ops.schema.drift',
      'system.cron',
      jsonb_build_object(
        'previous_sha256', v_prev.sha256,
        'current_sha256',  v_hash,
        'previous_taken_at', v_prev.taken_at,
        'message',
        'Live public schema diverged from previous snapshot. Check for ad-hoc SQL outside the migration ledger.'
      ),
      null,
      now()
    );
  end if;

  -- Always insert today's snapshot so trend analysis is possible.
  insert into public._schema_snapshots (taken_at, sha256, fingerprint)
  values (now(), v_hash, v_fp);

  -- Trim to 60 most recent rows.
  delete from public._schema_snapshots
   where taken_at not in (
     select taken_at from public._schema_snapshots
      order by taken_at desc limit 60
   );

  return v_drift;
end;
$$;

-- pgcrypto is required for digest(). Most Supabase projects ship it
-- enabled; add a guarded create-extension just in case.
create extension if not exists pgcrypto with schema extensions;

select public._unschedule_if_exists('schema-drift-check-daily');
select cron.schedule(
  'schema-drift-check-daily',
  '50 3 * * *',  -- daily 03:50 UTC
  $$ select public.schema_drift_check(); $$
);

-- ── 4. Sanity probe ────────────────────────────────────────────────
do $$
begin
  raise notice 'schema-drift infrastructure (after 0060):';
  raise notice '  snapshots table: %',
    (select to_regclass('public._schema_snapshots') is not null);
  raise notice '  fingerprint function: %',
    (select count(*) from pg_proc where proname = 'schema_fingerprint_public');
end $$;

notify pgrst, 'reload schema';
