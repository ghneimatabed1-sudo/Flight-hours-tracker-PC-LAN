-- ============================================================================
-- 0051_xpc_messages_retention_backstop.sql
-- ============================================================================
--
-- Task #169 — Stop the cross-PC chat table from growing forever when
-- messages stay unread.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 0032 scheduled `xpc-purge-archived-messages` to delete
-- `xpc_messages` rows where ALL of the following hold:
--   • read_at is not null    (recipient opened it)
--   • in_history = true      (recipient moved it to History)
--   • sent_at < now() - 3 months
--
-- Audit E (2026-04-25, defect D-08) flagged that this gates the entire
-- purge on the recipient's behaviour. If a message is never read — most
-- commonly because the recipient PC was retired, re-imaged, or simply
-- never signed in to that conversation again — it never satisfies any
-- of those three conditions and lives on the table forever.
--
-- Sized against a 15-year deployment with 30 messages/day per chatty
-- PC, the worst case is millions of "stuck" rows per PC. Realistic
-- ops workloads are smaller, but the unbounded-growth shape is real
-- and is the exact failure mode this audit window was created to
-- catch.
--
-- WHAT CHANGES
-- ------------
-- `public.xpc_purge_archived_messages()` is replaced (CREATE OR
-- REPLACE; cron job unchanged) with a function that runs TWO deletes
-- under one umbrella:
--
--   (A) The original 3-month archived-and-read sweep — unchanged
--       semantics, still deletes only rows the recipient finished
--       with.
--
--   (B) A new 2-year hard-ceiling backstop — deletes any row whose
--       `sent_at` is older than 2 years REGARDLESS of `read_at` or
--       `in_history`. This is the safety valve: an unread or
--       not-archived message that has been sitting on the central
--       table for 2 full years is, by policy, gone.
--
-- The function returns the COMBINED row count so cron-monitoring
-- dashboards continue to read a single integer from
-- `cron.job_run_details`.
--
-- WHY 2 YEARS
-- -----------
-- - Long enough that an offline / re-imaged PC coming back from a
--   reasonable outage (hardware refresh, base relocation, an admin
--   away on rotation) still finds its inbox intact.
-- - Short enough that the table cannot accumulate more than ~2y of
--   per-PC traffic, bounding worst-case row counts to (msgs/day × 730)
--   per PC even in pathological never-read scenarios.
-- - Documented in `.local/reports/MAINTENANCE_RUNBOOK.md` R-06 so
--   operators can answer "where did my old unread message go?" with
--   a one-line policy citation.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- - The cron schedule (`xpc-purge-archived-messages` @ 03:15 UTC daily,
--   plus the weekly belt-and-braces from migration 0043) is preserved.
--   pg_cron continues to call the same function name.
-- - The 3-month archive cutoff is preserved exactly — any tooling that
--   relies on the existing semantics ("once a recipient archives a
--   message, expect it gone after 3 months") continues to work.
-- - RLS on `xpc_messages` is unchanged. The function runs SECURITY
--   DEFINER (as it always has) so the daily cron sweep deletes across
--   tenants regardless of who happens to be schedule-owner.
--
-- IDEMPOTENCY
-- -----------
-- - Function uses CREATE OR REPLACE.
-- - The verification block (below) uses a sentinel-prefixed id and
--   ALWAYS cleans up its own row on both success and failure paths.
-- - Re-running this migration is a no-op.
-- ============================================================================

-- ─── 1. Replace the purge with a 3-month + 2-year backstop hybrid ────────
create or replace function public.xpc_purge_archived_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  archived_deleted integer := 0;
  backstop_deleted integer := 0;
begin
  -- (A) Original 3-month archived-and-read sweep. Unchanged semantics.
  delete from public.xpc_messages
   where in_history = true
     and read_at is not null
     and sent_at < now() - interval '3 months';
  get diagnostics archived_deleted = row_count;

  -- (B) 2-year hard ceiling. Catches anything that the recipient
  --     never opened or never archived, so the table cannot grow
  --     forever even when one side of a conversation has gone dark.
  delete from public.xpc_messages
   where sent_at < now() - interval '2 years';
  get diagnostics backstop_deleted = row_count;

  return archived_deleted + backstop_deleted;
end;
$$;

-- ─── 2. Verification: 2-year-old unread + un-archived row is removed ─────
-- Inserts a sentinel-tagged fixture matching the task's done-criteria
-- (sent_at = 2 years ago, read_at = null, in_history = false), runs the
-- purge, and asserts the row is gone. The fixture id is unique per run
-- (clock_timestamp suffix) so concurrent re-applies don't collide, and
-- the `EXCEPTION WHEN OTHERS` arm guarantees the fixture is deleted
-- even if the assertion fails or the function raises.
do $$
declare
  fixture_id text := '__retention_backstop_fixture_'
                     || extract(epoch from clock_timestamp())::text;
  remaining  integer;
begin
  begin
    insert into public.xpc_messages (
      id, thread_id,
      from_pc_id, from_pc_name, from_tier, from_user,
      to_pc_id,   to_pc_name,   to_tier,
      subject, body, priority,
      sent_at, read_at, in_history
    ) values (
      fixture_id, fixture_id,
      '__BACKSTOP_FIXTURE__', '__BACKSTOP_FIXTURE__', 'squadron', 'migration-0051',
      '__BACKSTOP_FIXTURE__', '__BACKSTOP_FIXTURE__', 'squadron',
      '0051 backstop test', '0051 backstop test', 'normal',
      now() - interval '2 years 1 day', null, false
    );

    perform public.xpc_purge_archived_messages();

    select count(*) into remaining
      from public.xpc_messages
     where id = fixture_id;

    if remaining > 0 then
      raise exception
        '0051 backstop check failed: fixture row (sent 2y+1d ago, '
        'unread, not-archived) was not deleted by '
        'xpc_purge_archived_messages()';
    end if;

    raise notice
      '0051 backstop check OK: 2-year-old unread + un-archived '
      'fixture row was deleted as expected.';
  exception when others then
    -- Defense-in-depth: scrub the fixture even on failure so a botched
    -- migration cannot leave sentinel rows lying around.
    delete from public.xpc_messages where id = fixture_id;
    raise;
  end;
end $$;

-- ─── 3. Migration ledger ─────────────────────────────────────────────────
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0051_xpc_messages_retention_backstop.sql', now(), 'task-169', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
