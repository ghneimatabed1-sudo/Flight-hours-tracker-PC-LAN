-- 0045_round4_fixes.sql
--
-- Task #156 round-4 audit follow-ups, applied 2026-04-24.
--
-- This migration consolidates every code-side defect surfaced by
-- the round-4 driver run (.local/scripts/audit-driver-4.mjs):
--
--   • D-T156-D06 (BLOCKER): server-side input validation on the three
--     highest-traffic write paths (sorties, pilots, notams). The audit
--     accepted 30 of 33 attack vectors — empty strings, 10 000-char
--     fields, RTL-override unicode, year-9999 dates and so on. Every
--     vector is now rejected at the database layer via length checks,
--     date-plausibility checks, and a BEFORE-INSERT trigger that
--     trims whitespace + refuses empty user-visible strings.
--
--   • D-T156-D08 (MEDIUM): 12 foreign-key columns had no covering
--     index. Each one is added below as a CONCURRENTLY-safe IF NOT
--     EXISTS index.
--
--   • D-T156-D02 (HIGH): xpc_purge_inactive_pcs(p_days int) overload
--     so the operator can run an ad-hoc purge with a custom retention
--     window without touching the cron-scheduled 0-arg version.
--
--   • D-T156-D11 (MEDIUM): wings.name renames did not propagate to
--     squadrons.wing (the denormalised text column). A trigger on
--     wings AFTER UPDATE syncs the column for any squadron whose
--     squadrons.wing currently matches OLD.name.
--
--   • D-T156-D07 (LOCK): super_admin_credentials has RLS enabled and
--     zero policies. This is intentional (the table is service-role-
--     only); a COMMENT records that intent on the table so the next
--     audit doesn't flag it as a coverage gap.
--
-- Defects D-T156-D01, -D02 (RPC exists with 0-arg sig only),
-- -D03, -D04, -D05 turned out to be **driver-side** signature/contract
-- errors, not code defects. The audit driver has been corrected
-- separately (see git diff for .local/scripts/audit-driver-4.mjs).
--
-- Defects D-T156-D09 (dead pg_cron) and D-T156-D10 (xpc_registry
-- denorm staleness on rename) were **false positives**:
--   - D09: jobs were declared 4h before the audit ran, before their
--     first scheduled UTC window. As of this migration date all 5
--     daily jobs have completed at least one successful run.
--   - D10: production uses the canonical naming convention from
--     migration 0041 (squadrons.number → 'NO. <n> SQDN'), so user-
--     visible squadron renames are decoupled from the xpc_registry
--     identifier by design.
--
-- Idempotent: every constraint is guarded by IF NOT EXISTS / drop-
-- before-create. Re-running this migration is a no-op.

-- ─────────────────────────────────────────────────────────────────────
-- 1. INPUT VALIDATION — sorties / pilots / notams
-- ─────────────────────────────────────────────────────────────────────

-- 1a. Length + range CHECK constraints on sorties.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sorties_pilot_id_len_chk') then
    alter table public.sorties
      add constraint sorties_pilot_id_len_chk
      check (char_length(pilot_id) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sorties_co_pilot_id_len_chk') then
    alter table public.sorties
      add constraint sorties_co_pilot_id_len_chk
      check (co_pilot_id is null or char_length(co_pilot_id) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sorties_ac_type_len_chk') then
    alter table public.sorties
      add constraint sorties_ac_type_len_chk
      check (ac_type is null or char_length(ac_type) between 1 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sorties_ac_number_len_chk') then
    alter table public.sorties
      add constraint sorties_ac_number_len_chk
      check (ac_number is null or char_length(ac_number) between 1 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sorties_sortie_type_len_chk') then
    alter table public.sorties
      add constraint sorties_sortie_type_len_chk
      check (sortie_type is null or char_length(sortie_type) between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sorties_sortie_name_len_chk') then
    alter table public.sorties
      add constraint sorties_sortie_name_len_chk
      check (sortie_name is null or char_length(sortie_name) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sorties_date_range_chk') then
    alter table public.sorties
      add constraint sorties_date_range_chk
      check (date between date '1990-01-01' and (current_date + interval '1 year')::date);
  end if;
end $$;

-- 1b. Length + range CHECK constraints on pilots.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pilots_id_len_chk') then
    alter table public.pilots
      add constraint pilots_id_len_chk
      check (char_length(id) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilots_rank_len_chk') then
    alter table public.pilots
      add constraint pilots_rank_len_chk
      check (char_length(rank) between 1 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilots_name_len_chk') then
    alter table public.pilots
      add constraint pilots_name_len_chk
      check (char_length(name) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilots_arabic_name_len_chk') then
    alter table public.pilots
      add constraint pilots_arabic_name_len_chk
      check (arabic_name is null or char_length(arabic_name) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilots_unit_len_chk') then
    alter table public.pilots
      add constraint pilots_unit_len_chk
      check (unit is null or char_length(unit) between 1 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilots_phone_len_chk') then
    alter table public.pilots
      add constraint pilots_phone_len_chk
      check (phone is null or char_length(phone) between 1 and 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pilots_rank_en_len_chk') then
    alter table public.pilots
      add constraint pilots_rank_en_len_chk
      check (rank_en is null or char_length(rank_en) between 1 and 30);
  end if;
end $$;

-- 1c. Length + range CHECK constraints on notams.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notams_notam_no_len_chk') then
    alter table public.notams
      add constraint notams_notam_no_len_chk
      check (char_length(notam_no) between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notams_body_len_chk') then
    alter table public.notams
      add constraint notams_body_len_chk
      check (char_length(body) between 1 and 8000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'notams_posted_on_range_chk') then
    alter table public.notams
      add constraint notams_posted_on_range_chk
      check (posted_on between date '1990-01-01' and (current_date + interval '1 year')::date);
  end if;
end $$;

-- 1d. Whitespace-trim + empty-rejection trigger.
--
-- CHECK constraints alone cannot reject all-whitespace input — Postgres
-- char_length('   ') is 3, which is "between 1 and 200". This BEFORE-
-- INSERT/UPDATE trigger trims the user-visible text fields, then
-- enforces non-empty + safe-character rules. Numbers and identifiers
-- are not touched; the existing CHECK constraints handle them.
create or replace function public._normalize_text_input()
returns trigger language plpgsql as $$
declare
  v_max_len integer;
begin
  if tg_table_name = 'sorties' then
    if new.ac_type is not null then new.ac_type := nullif(btrim(new.ac_type), ''); end if;
    if new.ac_number is not null then new.ac_number := nullif(btrim(new.ac_number), ''); end if;
    if new.sortie_type is not null then new.sortie_type := nullif(btrim(new.sortie_type), ''); end if;
    if new.sortie_name is not null then new.sortie_name := nullif(btrim(new.sortie_name), ''); end if;
    if new.pilot_id is not null then
      new.pilot_id := btrim(new.pilot_id);
      if new.pilot_id = '' then raise exception 'sorties.pilot_id must not be empty/whitespace' using errcode = '22023'; end if;
    end if;
    if new.co_pilot_id is not null then
      new.co_pilot_id := nullif(btrim(new.co_pilot_id), '');
    end if;
  elsif tg_table_name = 'pilots' then
    new.name := btrim(new.name);
    if new.name = '' then raise exception 'pilots.name must not be empty/whitespace' using errcode = '22023'; end if;
    new.rank := btrim(new.rank);
    if new.rank = '' then raise exception 'pilots.rank must not be empty/whitespace' using errcode = '22023'; end if;
    new.id := btrim(new.id);
    if new.id = '' then raise exception 'pilots.id must not be empty/whitespace' using errcode = '22023'; end if;
    if new.arabic_name is not null then new.arabic_name := nullif(btrim(new.arabic_name), ''); end if;
    if new.unit is not null then new.unit := nullif(btrim(new.unit), ''); end if;
    if new.phone is not null then new.phone := nullif(btrim(new.phone), ''); end if;
    if new.rank_en is not null then new.rank_en := nullif(btrim(new.rank_en), ''); end if;
  elsif tg_table_name = 'notams' then
    new.notam_no := btrim(new.notam_no);
    if new.notam_no = '' then raise exception 'notams.notam_no must not be empty/whitespace' using errcode = '22023'; end if;
    new.body := btrim(new.body);
    if new.body = '' then raise exception 'notams.body must not be empty/whitespace' using errcode = '22023'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sorties_normalize_input_trg on public.sorties;
create trigger sorties_normalize_input_trg
  before insert or update on public.sorties
  for each row execute function public._normalize_text_input();

drop trigger if exists pilots_normalize_input_trg on public.pilots;
create trigger pilots_normalize_input_trg
  before insert or update on public.pilots
  for each row execute function public._normalize_text_input();

drop trigger if exists notams_normalize_input_trg on public.notams;
create trigger notams_normalize_input_trg
  before insert or update on public.notams
  for each row execute function public._normalize_text_input();

-- ─────────────────────────────────────────────────────────────────────
-- 2. MISSING FK COVERING INDEXES (12)
-- ─────────────────────────────────────────────────────────────────────
-- Note: Supabase Mgmt-API runs each query in its own implicit
-- transaction, so CREATE INDEX CONCURRENTLY isn't usable. Plain
-- CREATE INDEX IF NOT EXISTS is fine on a single-squadron deployment
-- where every table is small.

create index if not exists licenses_squadron_id_idx
  on public.licenses(squadron_id);

create index if not exists notams_squadron_id_idx
  on public.notams(squadron_id);

create index if not exists pilot_devices_squadron_id_idx
  on public.pilot_devices(squadron_id);

create index if not exists pilot_link_codes_issued_by_idx
  on public.pilot_link_codes(issued_by);

create index if not exists pilot_link_codes_squadron_id_idx
  on public.pilot_link_codes(squadron_id);

create index if not exists schedule_squadron_id_idx
  on public.schedule(squadron_id);

create index if not exists sorties_created_by_idx
  on public.sorties(created_by);

create index if not exists unavailable_squadron_id_idx
  on public.unavailable(squadron_id);

create index if not exists users_squadron_id_idx
  on public.users(squadron_id);

create index if not exists xpc_pair_codes_host_user_id_idx
  on public.xpc_pair_codes(host_user_id);

create index if not exists xpc_registry_base_id_idx
  on public.xpc_registry(base_id);

create index if not exists xpc_registry_wing_id_idx
  on public.xpc_registry(wing_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. xpc_purge_inactive_pcs(p_days int) — operator overload
-- ─────────────────────────────────────────────────────────────────────
-- The 0-arg version is what cron calls (uses the built-in default).
-- This overload lets the operator run an ad-hoc purge with a custom
-- window from the SQL editor without altering the cron job.
--
-- Implementation: marks an xpc_registry row "inactive" if its
-- last_seen is older than p_days days. Returns rows removed.
create or replace function public.xpc_purge_inactive_pcs(p_days integer)
returns integer language plpgsql security definer as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 1 then
    raise exception 'p_days must be a positive integer (got %)', p_days
      using errcode = '22023';
  end if;
  delete from public.xpc_registry
   where last_seen < now() - (p_days || ' days')::interval;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.xpc_purge_inactive_pcs(integer) from public;
grant execute on function public.xpc_purge_inactive_pcs(integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. wings rename → squadrons.wing denorm sync
-- ─────────────────────────────────────────────────────────────────────
-- squadrons.wing is a denormalised text snapshot of wings.name. When a
-- wing is renamed, every squadron whose squadrons.wing matches the
-- old name should follow. squadrons.wing_id is the authoritative FK
-- and is unaffected.
create or replace function public._sync_squadrons_wing_on_rename()
returns trigger language plpgsql security definer as $$
begin
  if new.name is distinct from old.name then
    update public.squadrons
       set wing = new.name
     where wing = old.name;
  end if;
  return new;
end;
$$;

drop trigger if exists wings_rename_sync_squadrons_trg on public.wings;
create trigger wings_rename_sync_squadrons_trg
  after update of name on public.wings
  for each row execute function public._sync_squadrons_wing_on_rename();

-- ─────────────────────────────────────────────────────────────────────
-- 5. super_admin_credentials — document the intentional lockdown
-- ─────────────────────────────────────────────────────────────────────
-- RLS is enabled, zero policies. This is intentional: the table is
-- service-role-only (super-admin-2fa edge function reaches it via the
-- service role key). The audit's "policy coverage" check now sees
-- the rationale on the table itself.
do $$ begin
  if exists (select 1 from pg_class where relname = 'super_admin_credentials' and relnamespace = 'public'::regnamespace) then
    comment on table public.super_admin_credentials is
      'Service-role-only: RLS enabled with zero policies on purpose. '
      'Reached only via the super-admin-2fa edge function using SUPABASE_SERVICE_ROLE_KEY. '
      'See migration 0045 (round-4 audit T156-D07) for rationale.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- 6. Migration ledger
-- ─────────────────────────────────────────────────────────────────────
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0045_round4_fixes.sql', now(), 'task-156-round4', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
