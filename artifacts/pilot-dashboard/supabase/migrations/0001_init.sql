-- RJAF Squadron Ops — initial schema with squadron-isolated RLS.
-- Apply this to the Supabase project before going to production.
--
-- Every operational table carries a squadron_id and has Row Level Security
-- enabled so a JWT issued to one squadron cannot read or write rows that
-- belong to another. The squadron_id comes from the user's JWT
-- app_metadata.squadron_id claim, set by the validate-license edge function
-- when it provisions a Supabase auth user for a freshly activated license.

create extension if not exists "pgcrypto";

-- ── Reference / tenancy ────────────────────────────────────────────────────
create table if not exists squadrons (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  name text not null,
  base text not null,
  created_at timestamptz not null default now()
);

create table if not exists licenses (
  key text primary key,
  squadron_id uuid not null references squadrons(id) on delete cascade,
  bound_fingerprint text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create table if not exists users (
  id uuid primary key references auth.users(id) on delete cascade,
  squadron_id uuid not null references squadrons(id) on delete cascade,
  username text not null,
  display_name text not null,
  role text not null check (role in ('ops','deputy','admin','superadmin')),
  created_at timestamptz not null default now()
);

-- ── JWT helper (declared early so DEFAULTs below can reference it) ────────
create or replace function public.squadron_id() returns uuid
language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,squadron_id}',
    ''
  ), '')::uuid;
$$;

-- ── Operational tables ────────────────────────────────────────────────────
create table if not exists pilots (
  id text primary key,
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  rank text not null,
  name text not null,
  arabic_name text,
  unit text,
  phone text,
  available boolean not null default true,
  data jsonb not null default '{}'::jsonb,  -- hours, expiries, opening balances
  updated_at timestamptz not null default now()
);
create index if not exists pilots_squadron_idx on pilots(squadron_id);

create table if not exists sorties (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  pilot_id text not null,
  co_pilot_id text,
  date date not null,
  ac_type text,
  ac_number text,
  sortie_type text,
  sortie_name text,
  data jsonb not null default '{}'::jsonb, -- day1/day2/dayDual/night*/nvg/sim/actual
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists sorties_squadron_date_idx on sorties(squadron_id, date desc);

-- 6-month training cycle completion per pilot/task.
create table if not exists currencies (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  pilot_id text not null,
  task text not null,
  status text not null check (status in ('done','partial','missing')),
  cycle_start date not null,
  updated_at timestamptz not null default now(),
  unique (squadron_id, pilot_id, task, cycle_start)
);

-- Annual leave breakdown (one row per pilot per year, jsonb of month -> days).
create table if not exists leaves (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  pilot_id text not null,
  year int not null,
  months jsonb not null default '{}'::jsonb,
  unique (squadron_id, pilot_id, year)
);

create table if not exists unavailable (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  pilot_id text not null,
  from_date date not null,
  to_date date not null,
  reason text,
  created_at timestamptz not null default now()
);

-- Standing weekly duty roster (Sun..Thu).
create table if not exists duty_week (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  day text not null,
  main_duty text,
  standby text,
  rcm text,
  effective_from date not null default current_date,
  unique (squadron_id, day, effective_from)
);

-- Daily flight schedule entries.
create table if not exists schedule (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  flight_date date not null default current_date,
  ac text not null,
  config text,
  crew text[] not null default '{}',
  mission text,
  takeoff text,
  land text,
  fuel text,
  created_at timestamptz not null default now()
);

create table if not exists notams (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  notam_no text not null,
  posted_on date not null default current_date,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  squadron_id uuid default public.squadron_id() references squadrons(id) on delete cascade,
  type text not null,
  actor text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists audit_squadron_time_idx on audit_log(squadron_id, occurred_at desc);

-- ── Row Level Security ────────────────────────────────────────────────────
alter table squadrons    enable row level security;
alter table licenses     enable row level security;
alter table users        enable row level security;
alter table pilots       enable row level security;
alter table sorties      enable row level security;
alter table currencies   enable row level security;
alter table leaves       enable row level security;
alter table unavailable  enable row level security;
alter table duty_week    enable row level security;
alter table schedule     enable row level security;
alter table notams       enable row level security;
alter table audit_log    enable row level security;

drop policy if exists sq_select on squadrons;
create policy sq_select on squadrons
  for select using (id = public.squadron_id());

drop policy if exists lic_select on licenses;
create policy lic_select on licenses
  for select using (squadron_id = public.squadron_id());

drop policy if exists users_rw on users;
create policy users_rw on users
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists pilots_rw on pilots;
create policy pilots_rw on pilots
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists sorties_rw on sorties;
create policy sorties_rw on sorties
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists currencies_rw on currencies;
create policy currencies_rw on currencies
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists leaves_rw on leaves;
create policy leaves_rw on leaves
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists unavailable_rw on unavailable;
create policy unavailable_rw on unavailable
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists duty_week_rw on duty_week;
create policy duty_week_rw on duty_week
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists schedule_rw on schedule;
create policy schedule_rw on schedule
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists notams_rw on notams;
create policy notams_rw on notams
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

drop policy if exists audit_select on audit_log;
create policy audit_select on audit_log
  for select using (squadron_id = public.squadron_id());

drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log
  for insert with check (squadron_id is null or squadron_id = public.squadron_id());
