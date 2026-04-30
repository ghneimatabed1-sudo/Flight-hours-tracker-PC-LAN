-- Saved Duty Week rosters.
-- One row per (squadron, start_date). The 7-day roster is stored as a
-- jsonb blob (rows: SavedDutyRow[]). The page archives anything older
-- than 1 year via a hard DELETE on app open (see useDeleteOldDutyWeeks).
--
-- RLS: anchored on the JWT app_metadata.squadron_id claim that the
-- existing 0001_init.sql migration already exposes via public.squadron_id().
-- We compare it against the squadrons.number column (the duty roster is
-- keyed by squadron *number*, not the uuid id) so the policy works even
-- when older clients pass the human-readable number.

create table if not exists saved_duty_weeks (
  id           uuid primary key default gen_random_uuid(),
  squadron     text not null,
  start_date   date not null,
  rows         jsonb not null,
  saved_at     timestamptz not null default now(),
  unique (squadron, start_date)
);

create index if not exists saved_duty_weeks_sqn_start
  on saved_duty_weeks (squadron, start_date desc);

alter table saved_duty_weeks enable row level security;

-- Each squadron only sees its own rosters. The squadron number is read
-- from the user's squadron row keyed by the JWT's squadron_id claim.
drop policy if exists saved_duty_weeks_select on saved_duty_weeks;
create policy saved_duty_weeks_select on saved_duty_weeks
  for select using (
    squadron in (select s.number from squadrons s where s.id = public.squadron_id())
  );

drop policy if exists saved_duty_weeks_write on saved_duty_weeks;
create policy saved_duty_weeks_write on saved_duty_weeks
  for all using (
    squadron in (select s.number from squadrons s where s.id = public.squadron_id())
  ) with check (
    squadron in (select s.number from squadrons s where s.id = public.squadron_id())
  );
