-- 0058_monthly_close_immutability.sql
--
-- Task #265 Part D — Closed-month immutability (#66).
--
-- Today, ops can in theory edit or delete a sortie that belongs to
-- a month for which the monthly report was already published. That
-- breaks the audit story (the published Form 1/2/3/4 numbers no
-- longer match what's in the database). This migration enforces
-- immutability at the database layer, so even a buggy UI / direct
-- API call cannot rewrite history.
--
-- The annual freeze (12 months) implemented client-side in
-- `src/lib/monthly-close.ts` is a separate, additive layer; the
-- monthly close enforced here is a per-squadron, per-month act
-- the squadron commander or super_admin performs explicitly.
--
-- Schema:
--   monthly_report_close (squadron_id, year_month, closed_at, closed_by, reason)
--   year_month is text "YYYY-MM" — matches what `monthOf(date)` returns
--   in the dashboard.
--
-- Trigger: any UPDATE or DELETE on `sorties` whose `date` falls in a
-- closed month for that squadron is rejected with SQLSTATE 'P0001'
-- and a clear message. INSERT inside a closed month is also rejected
-- (you can't backfill a sortie into a published period).
--
-- Re-open: super_admin only. The `monthly_report_reopen(squadron_id,
-- year_month, reason)` RPC removes the close row AND writes a paired
-- audit_log row with the reason. Closing again later writes another
-- audit row.
--
-- Idempotent: safe to re-run.

-- ── 1. Close table ─────────────────────────────────────────────────
create table if not exists public.monthly_report_close (
  squadron_id  uuid not null references public.squadrons(id) on delete cascade,
  year_month   text not null check (year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  closed_at    timestamptz not null default now(),
  closed_by    uuid references auth.users(id),
  reason       text,
  primary key (squadron_id, year_month)
);
create index if not exists monthly_report_close_year_month_idx
  on public.monthly_report_close(year_month);

alter table public.monthly_report_close enable row level security;

-- Anyone authenticated reads (so the dashboard can render a closed
-- banner). Inserts come from `monthly_report_close_close` RPC, never
-- direct INSERT. Same for delete.
drop policy if exists monthly_report_close_select on public.monthly_report_close;
create policy monthly_report_close_select on public.monthly_report_close
  for select to authenticated using (true);

-- ── 2. Helper: is this (squadron, date) in a closed month? ─────────
create or replace function public.is_month_closed(p_squadron_id uuid, p_date date)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.monthly_report_close
     where squadron_id = p_squadron_id
       and year_month = to_char(p_date, 'YYYY-MM')
  );
$$;

-- ── 3. Trigger: block writes to sorties inside a closed month ──────
create or replace function public._sortie_closed_month_guard()
returns trigger language plpgsql as $$
declare
  v_target_date date;
  v_target_sq   uuid;
  v_role        text;
begin
  -- super_admin always wins (used for forensic correction with audit row).
  v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'role';
  if v_role = 'super_admin' then
    return coalesce(NEW, OLD);
  end if;

  -- For UPDATE: block if either OLD.date OR NEW.date sits in a closed
  -- month (so you can't move a row out of, or into, a closed month).
  if TG_OP = 'INSERT' then
    v_target_date := NEW.date;
    v_target_sq   := NEW.squadron_id;
    if public.is_month_closed(v_target_sq, v_target_date) then
      raise exception
        'Cannot insert sortie dated %  — month % is closed for this squadron. '
        'Re-open via super_admin only.',
        v_target_date,
        to_char(v_target_date, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  elsif TG_OP = 'UPDATE' then
    if public.is_month_closed(NEW.squadron_id, NEW.date)
       or public.is_month_closed(OLD.squadron_id, OLD.date) then
      raise exception
        'Cannot modify sortie — month is closed for this squadron. '
        'Re-open via super_admin only.'
        using errcode = 'P0001';
    end if;
  elsif TG_OP = 'DELETE' then
    if public.is_month_closed(OLD.squadron_id, OLD.date) then
      raise exception
        'Cannot delete sortie dated %  — month % is closed for this squadron. '
        'Re-open via super_admin only.',
        OLD.date,
        to_char(OLD.date, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists sortie_closed_month_guard on public.sorties;
create trigger sortie_closed_month_guard
  before insert or update or delete on public.sorties
  for each row execute function public._sortie_closed_month_guard();

-- ── 4. Close + Re-open RPCs ────────────────────────────────────────
-- Close: commander OR super_admin for that squadron may close.
-- Writes a `monthly.report.close` audit_log row.
create or replace function public.monthly_report_close_close(
  p_squadron_id uuid,
  p_year_month  text,
  p_reason      text default null
)
returns void language plpgsql security definer as $$
declare
  v_uid  uuid;
  v_role text;
  v_sq   uuid;
begin
  if p_squadron_id is null or p_year_month is null then
    raise exception 'monthly_report_close_close: squadron_id and year_month required';
  end if;
  if p_year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'monthly_report_close_close: year_month must be YYYY-MM';
  end if;
  v_uid  := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'role';
  v_sq   := (nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'squadron_id')::uuid;
  if v_role not in ('super_admin', 'commander') then
    raise exception 'Only commander or super_admin may close a month';
  end if;
  if v_role = 'commander' and v_sq is distinct from p_squadron_id then
    raise exception 'Commander may only close months for their own squadron';
  end if;

  insert into public.monthly_report_close
    (squadron_id, year_month, closed_by, reason)
  values
    (p_squadron_id, p_year_month, v_uid, p_reason)
  on conflict (squadron_id, year_month) do nothing;

  insert into public.audit_log
    (type, actor, detail, squadron_id, occurred_at)
  values (
    'monthly.report.close',
    coalesce(v_uid::text, 'unknown'),
    jsonb_build_object(
      'year_month', p_year_month,
      'reason', p_reason,
      'role', v_role
    ),
    p_squadron_id,
    now()
  );
end;
$$;

revoke all on function public.monthly_report_close_close(uuid, text, text) from public;
grant execute on function public.monthly_report_close_close(uuid, text, text)
  to authenticated, service_role;

-- Re-open: super_admin only. Removes the close row AND writes a
-- paired `monthly.report.reopen` audit row that records the reason
-- so the trail is auditable.
create or replace function public.monthly_report_close_reopen(
  p_squadron_id uuid,
  p_year_month  text,
  p_reason      text
)
returns void language plpgsql security definer as $$
declare
  v_uid  uuid;
  v_role text;
begin
  if p_squadron_id is null or p_year_month is null then
    raise exception 'monthly_report_close_reopen: squadron_id and year_month required';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'monthly_report_close_reopen: reason required (>=5 chars) for audit trail';
  end if;
  v_uid  := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'role';
  if v_role <> 'super_admin' then
    raise exception 'Only super_admin may re-open a closed month';
  end if;

  delete from public.monthly_report_close
   where squadron_id = p_squadron_id and year_month = p_year_month;

  insert into public.audit_log
    (type, actor, detail, squadron_id, occurred_at)
  values (
    'monthly.report.reopen',
    coalesce(v_uid::text, 'unknown'),
    jsonb_build_object(
      'year_month', p_year_month,
      'reason', p_reason
    ),
    p_squadron_id,
    now()
  );
end;
$$;

revoke all on function public.monthly_report_close_reopen(uuid, text, text) from public;
grant execute on function public.monthly_report_close_reopen(uuid, text, text)
  to authenticated, service_role;

-- ── 5. Sanity probe ────────────────────────────────────────────────
do $$
begin
  raise notice 'monthly_report_close infrastructure (after 0058):';
  raise notice '  table exists:   %',
    (select to_regclass('public.monthly_report_close') is not null);
  raise notice '  trigger exists: %',
    (select exists (select 1 from pg_trigger where tgname = 'sortie_closed_month_guard'));
end $$;

notify pgrst, 'reload schema';
