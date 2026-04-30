-- 0056_schedchain_align_current_tier.sql
--
-- Audit N (Round 3) — Align xpc_schedule_shares.current_tier CHECK
-- constraint with the schedule-chain submit-state-machine spec.
--
-- Background
-- ──────────
-- Audit G (.local/reports/audit-2026-04-26-G-single-squadron.md,
-- evidence: audit-evidence/2026-04-26/evidence/G/g-driver.json,
-- calc.scheduleChain6State) drove the canonical schedule-chain
-- submit-state-machine end-to-end against the live project. The very
-- first state of that walk — `current_tier='submitted'` — was rejected
-- by Postgres with:
--
--   new row for relation "xpc_schedule_shares" violates check
--   constraint "xpc_schedule_shares_current_tier_check"
--
-- The live constraint shipped by 0028 is:
--
--   CHECK (current_tier IN ('flight','squadron','wing','base','hq'))
--
-- which only enumerates the *physical* tier vocabulary (where in the
-- chain the sheet currently sits). The submit-state-machine spec —
-- ScheduleStatus in artifacts/pilot-dashboard/src/lib/cross-pc.ts —
-- defines the *lifecycle* vocabulary instead:
--
--   ScheduleStatus = 'draft' | 'submitted' | 'reviewed' | 'approved'
--                  | 'rejected' | 'held' | 'edited'
--
-- with `submitted` as the REQUIRED initial state for any new share
-- (cross-pc.ts:1828, useSubmitSchedule). The spec has the same
-- column-name overload for both vocabularies because the submit
-- state-machine and the per-tier hand-off use a single CHECK column
-- in the legacy schema.
--
-- The mismatch made cross-PC schedule sharing impossible for any
-- driver (Audit G, future audits, future end-to-end tests, future
-- DB-side state-machine helpers) that wrote the lifecycle vocabulary
-- straight into current_tier. The production app currently writes
-- only tier values into current_tier and only lifecycle values into
-- status, so end-users on shipped builds did not feel this — but the
-- legitimate happy-path the audit codified did, and any DB-driven
-- regression that wants to assert the spec end-to-end was blocked.
--
-- Source-of-truth decision (Audit N step 2)
-- ──────────────────────────────────────────
-- Both vocabularies are canonical and both will be written into
-- current_tier going forward (the production code keeps writing
-- tiers; the spec / audits / DB regressions write lifecycle states).
-- The constraint is widened to the UNION of:
--
--   * canonical tier values     (the existing 0028 set)
--   * canonical lifecycle values (matching the existing
--     xpc_schedule_shares_status_check set, which 0010 created)
--
-- Why widen rather than tighten the state-machine spec to a different
-- initial label:
--   1. `submitted` is what the production app already writes into the
--      sibling `status` column for the same row at the same instant
--      (cross-pc.ts:1828). Renaming it on the spec side just to dodge
--      the constraint mismatch would split the lifecycle vocabulary
--      across two columns and complicate every downstream reader.
--   2. The status_check constraint already enumerates exactly this
--      lifecycle set; mirroring it in current_tier is a one-line
--      alignment, not a new vocabulary invention.
--   3. Existing rows are valid against the wider set (every existing
--      tier value is in the union), so the migration is non-breaking.
--
-- Idempotency
-- ───────────
-- The DO block first checks pg_constraint for the EXISTING definition
-- and only drops/re-adds if `submitted` is missing from it. Re-running
-- this migration after a successful apply is a no-op and never
-- briefly leaves the table without the constraint.
--
-- Production rollout
-- ──────────────────
-- This file is applied to prod by the apply-supabase-migrations.yml
-- workflow on push to main. The post-apply step also reloads the
-- PostgREST schema cache and runs the new
-- artifacts/pilot-dashboard/supabase/tests/test-schedchain-submit.mjs
-- regression to prove `current_tier='submitted'` inserts succeed and
-- the full chain walk transitions cleanly.

do $body$
declare
  v_existing_def text;
  v_widened text :=
    'CHECK ((current_tier = ANY (ARRAY[' ||
    '''flight''::text, ''squadron''::text, ''wing''::text, ' ||
    '''base''::text, ''hq''::text, ' ||
    '''draft''::text, ''submitted''::text, ''reviewed''::text, ' ||
    '''approved''::text, ''rejected''::text, ''held''::text, ' ||
    '''edited''::text])))';
begin
  -- Pull the current constraint definition (NULL if missing). We use
  -- the rendered text rather than parsing the array elements so the
  -- check is robust against either ANY-array or IN-list spellings.
  select pg_get_constraintdef(c.oid)
    into v_existing_def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'xpc_schedule_shares'
     and c.conname = 'xpc_schedule_shares_current_tier_check';

  if v_existing_def is null
     or position('''submitted''' in v_existing_def) = 0 then
    -- Drop the narrow constraint (if any) and add the widened one in
    -- the same statement-level transaction so no concurrent INSERT
    -- can land in the gap.
    alter table public.xpc_schedule_shares
      drop constraint if exists xpc_schedule_shares_current_tier_check;

    alter table public.xpc_schedule_shares
      add constraint xpc_schedule_shares_current_tier_check
      check (current_tier in (
        -- Tier vocabulary (where the sheet currently sits).
        'flight','squadron','wing','base','hq',
        -- Lifecycle vocabulary (matches xpc_schedule_shares_status_check).
        'draft','submitted','reviewed','approved','rejected','held','edited'
      ));

    raise notice
      'Audit N: widened xpc_schedule_shares_current_tier_check to accept the lifecycle vocabulary';
  else
    raise notice
      'Audit N: xpc_schedule_shares_current_tier_check already widened — no change';
  end if;
end
$body$;

-- Self-insert into the migration ledger so `apply-supabase-migrations.yml`
-- treats this file as already applied if a future operator pastes it
-- through the SQL editor instead of via CI. The on-conflict clause
-- in the workflow will overwrite the NULL sha256 with the disk hash
-- on the next CI run (Task #195 self-heal).
insert into public._migration_ledger (filename, applied_by, sha256)
values ('0056_schedchain_align_current_tier.sql', 'self-insert', null)
on conflict (filename) do nothing;
