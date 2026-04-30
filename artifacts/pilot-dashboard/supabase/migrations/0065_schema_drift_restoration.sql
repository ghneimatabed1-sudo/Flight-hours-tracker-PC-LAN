-- 0065_schema_drift_restoration.sql
-- Round 4 AA3 — schema-drift findings (audit_log.action +
-- reminder_schedules) called out in MASTER-GO-NO-GO.
--
-- Background
-- ──────────
-- Two long-standing schema-drift gaps surfaced again during the round-4
-- audit walk:
--
-- 1. `audit_log.action` — the dashboard's Admin → Audit Log page (and
--    several future log analyzers we want to ship) want a plain TEXT
--    `action` column for the verb. The original 0001_init.sql audit_log
--    table only has a `type` column carrying the same data ("verb +
--    namespace", e.g. `super_admin.2fa.enrolled`). Every existing edge
--    function writes to `type`. Adding `action` as an additional TEXT
--    column lets future writers populate either column (or both) and
--    gives BI/dashboards a stable name for the verb without forcing a
--    rewrite of every edge function in one go.
--
--    Backfill choice: copy `type` into `action` for every existing row.
--    `type` IS the verb already; the migration is therefore lossless
--    for any reader that only knows `action`. Documented in the
--    backfill UPDATE below. Future writers SHOULD set `action` directly
--    when they're ready; legacy writers continue to set `type` only and
--    the next monthly job (out of scope here) can re-backfill if
--    required.
--
-- 2. `reminder_schedules` — the dashboard exposes a Reminders Schedule
--    page (admin/RemindersSchedule.tsx) that drives the daily currency
--    expiry email job. Today the page talks to the
--    `manage-reminder-schedule` edge function which writes pg_cron
--    state directly — no application table exists. The schema-drift
--    expectation calls for a dedicated `reminder_schedules` table so
--    operators can keep multiple named schedules (e.g. one per
--    squadron, one for the wing roll-up, one ad-hoc) without
--    overloading pg_cron's job table. This migration creates the
--    minimal forward-compatible shape — id, name, cron, target_url,
--    enabled, created_at/updated_at, created_by — locked down to
--    super_admin via RLS. The existing edge function continues to
--    drive pg_cron unchanged; the new table is the future home and
--    closes the schema-drift finding.
--
-- Both blocks below are idempotent — the migration is safe to re-run
-- and `IF NOT EXISTS` guards every DDL.

-- ── 1. audit_log.action column + lossless backfill ────────────────────

alter table public.audit_log
  add column if not exists action text;

-- Backfill: copy `type` into `action` for every row that doesn't yet
-- have an action. This is a pure forward-compat write — readers of
-- `type` are unaffected; readers of `action` now see the same verb.
update public.audit_log
   set action = type
 where action is null;

-- Index that mirrors the existing `audit_squadron_time_idx` shape so
-- future queries that filter on action+occurred_at are not full scans.
create index if not exists audit_action_time_idx
  on public.audit_log(action, occurred_at desc);

-- ── 2. reminder_schedules table + RLS ─────────────────────────────────

create table if not exists public.reminder_schedules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  cron         text not null,                 -- standard `M H * * *` syntax
  target_url   text,                          -- nullable so a schedule can
                                              -- exist before its target is
                                              -- known (e.g. created from a
                                              -- template)
  enabled      boolean not null default true,
  squadron_id  uuid references public.squadrons(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   text                            -- actor name / username; nullable
                                              -- because system-created rows
                                              -- have no human author.
);

create unique index if not exists reminder_schedules_name_uidx
  on public.reminder_schedules(name);

create index if not exists reminder_schedules_squadron_idx
  on public.reminder_schedules(squadron_id);

alter table public.reminder_schedules enable row level security;

-- Elevated-role read/write. The predicate accepts the established
-- elevated-role triple — `super_admin`, `superadmin` (legacy spelling
-- still present in some seed data), and `admin` — matching the
-- existing role matrix used elsewhere in this schema (audit_log,
-- license_keys, etc.). The `manage-reminder-schedule` edge function
-- calls in with the service-role key (which bypasses RLS), so the
-- function continues to work regardless. UI-driven reads/writes from
-- a normal authenticated session are blocked unless the JWT carries
-- `app_metadata.role` set to one of those three values.
drop policy if exists reminder_schedules_select on public.reminder_schedules;
create policy reminder_schedules_select on public.reminder_schedules
  for select to authenticated
  using (public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin'));

drop policy if exists reminder_schedules_insert on public.reminder_schedules;
create policy reminder_schedules_insert on public.reminder_schedules
  for insert to authenticated
  with check (public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin'));

drop policy if exists reminder_schedules_update on public.reminder_schedules;
create policy reminder_schedules_update on public.reminder_schedules
  for update to authenticated
  using (public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin'))
  with check (public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin'));

drop policy if exists reminder_schedules_delete on public.reminder_schedules;
create policy reminder_schedules_delete on public.reminder_schedules
  for delete to authenticated
  using (public.xpc_caller_role() in ('super_admin', 'superadmin', 'admin'));

-- updated_at touch trigger so callers don't have to remember to bump
-- it on every UPDATE.
create or replace function public.reminder_schedules_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists reminder_schedules_touch on public.reminder_schedules;
create trigger reminder_schedules_touch
  before update on public.reminder_schedules
  for each row execute function public.reminder_schedules_touch_updated_at();

-- ── 3. Ledger row ────────────────────────────────────────────────────

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0065_schema_drift_restoration.sql', now(), 'task-280', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
