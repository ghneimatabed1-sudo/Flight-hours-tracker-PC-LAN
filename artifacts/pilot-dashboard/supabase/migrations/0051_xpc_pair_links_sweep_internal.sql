-- 0051_xpc_pair_links_sweep_internal.sql
--
-- Task #167 — Fix the silent failure in the weekly cross-PC pair cleanup.
--
-- Background
-- ----------
-- Migration 0043 scheduled two weekly jobs that both call
-- `public.xpc_pair_links_sweep(90)`:
--
--   • xpc-pair-links-sweep-weekly  (created by 0043)
--   • xpc-pair-sweep-weekly        (operator-created on prod prior to
--                                   the audit; lives in cron.job only)
--
-- The function body, however, immediately raises 'sweep is super_admin
-- only' when `xpc_is_super_admin()` returns false. pg_cron runs jobs
-- as the database superuser, NOT a logged-in JWT-bearing user, so the
-- claim check always fails and every weekly tick records a failure
-- row in `cron.job_run_details` while leaving xpc_pair_links untouched.
--
-- The function comment in 0038 already flags this as deferred follow-up
-- #139 ("xpc_pair_links_sweep_internal callable only by the service
-- role"). Audit E (2026-04-25) defect D-01 confirmed the sweep has
-- never successfully cleaned a pair link in production.
--
-- Resolution
-- ----------
-- 1. Add `public.xpc_pair_links_sweep_internal(int)` — same body as the
--    interactive sweep MINUS the super-admin guard. SECURITY DEFINER
--    so it can read+write across the registry. EXECUTE is locked down:
--    only the `postgres` role (which pg_cron runs as) and the Supabase
--    `service_role` may call it; `authenticated` and `anon` are
--    explicitly REVOKEd, so a logged-in client cannot bypass the guard
--    by calling the internal function directly via PostgREST.
--
-- 2. Re-point both weekly cron jobs at the new internal function.
--    Done by name (drop-then-re-schedule), so re-running this migration
--    is a no-op. If `xpc-pair-sweep-weekly` does not exist in cron.job
--    on a given environment (it does not exist in any prior migration
--    file — it was created by hand on production) the unschedule helper
--    is a no-op and the schedule call recreates it cleanly.
--
-- 3. The interactive `public.xpc_pair_links_sweep(integer)` is left
--    completely untouched. The Connection Map's "Run Sweep Now" button
--    still calls it, the super-admin guard is still in place, and any
--    human caller without the JWT claim still gets the 'sweep is
--    super_admin only' error — no behaviour change for the dashboard.
--
-- Verification (manual, post-apply)
-- ---------------------------------
-- After applying, run a one-shot every-minute job to prove pg_cron
-- can now invoke the internal function without raising:
--
--   select cron.schedule(
--     'now-test-xpc-sweep-internal',
--     '* * * * *',
--     $$ select public.xpc_pair_links_sweep_internal(90); $$);
--   -- wait one minute, then:
--   select status, return_message
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job
--                    where jobname = 'now-test-xpc-sweep-internal')
--    order by start_time desc limit 1;
--   -- expect status = 'succeeded'
--   select cron.unschedule('now-test-xpc-sweep-internal');
--
-- The same probe against the existing weekly jobs (now re-pointed)
-- will show 'succeeded' from the next Sunday onward.
--
-- Idempotency
-- -----------
-- * `create or replace function` for the internal function.
-- * `_unschedule_if_exists` is the same helper migration 0032 / 0043
--   already use; safe on missing names.
-- * `cron.schedule` with the same (jobname, schedule, command) is what
--   0043 itself does on every re-run.
-- * The migration ledger insert is `on conflict do nothing`.

-- ─── 1. Internal sweep function (no super-admin guard) ─────────────────
--
-- Body matches `public.xpc_pair_links_sweep(int)` from migration 0038
-- exactly EXCEPT for the `xpc_is_super_admin()` check at the top.
-- Keeping the body in lockstep matters: any future change to the
-- interactive sweep's behaviour (new cleanup step, changed retention
-- window) MUST be mirrored here, and vice-versa, so the two cleanup
-- surfaces (operator-button, weekly cron) stay observably identical.

create or replace function public.xpc_pair_links_sweep_internal(
  p_inactive_days int default 90
) returns table(revoked_count int, expired_count int)
language plpgsql security definer set search_path = public
as $$
declare
  v_revoked int := 0;
  v_expired int := 0;
begin
  -- NO super-admin gate here. This function is callable only by the
  -- `postgres` role (pg_cron context) and the `service_role`. The
  -- REVOKE / GRANT block below is what actually enforces that — RLS
  -- is irrelevant at the function-execute layer.

  -- 1. time-bound expiries (cross_squadron_ops, etc.)
  with rev as (
    update public.xpc_pair_links
       set revoked_at = now(),
           revoked_reason = 'auto: time-bound expiry'
     where revoked_at is null
       and expires_at is not null
       and expires_at < now()
       and not permanent
     returning a_pc_id, b_pc_id, kind
  )
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, kind, justification)
    select 'sweep_revoked', a_pc_id, b_pc_id, kind, 'time-bound expiry' from rev;
  get diagnostics v_expired = row_count;

  -- 2. inactivity sweep — `permanent` checkbox bypasses this.
  with rev as (
    update public.xpc_pair_links
       set revoked_at = now(),
           revoked_reason = format('auto: no activity in %s days', p_inactive_days)
     where revoked_at is null
       and not permanent
       and last_activity_at < now() - make_interval(days => p_inactive_days)
     returning a_pc_id, b_pc_id, kind
  )
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, kind, justification)
    select 'sweep_revoked', a_pc_id, b_pc_id, kind,
           format('inactive %s days', p_inactive_days) from rev;
  get diagnostics v_revoked = row_count;

  -- 3. expired one-shot codes (housekeeping; not security-critical).
  delete from public.xpc_pair_codes where expires_at < now() - interval '1 hour';

  -- 4. registry pruning — PCs whose `last_seen` heartbeat is older
  -- than the same inactivity window are clearly retired hardware.
  declare
    pruned_id text;
  begin
    for pruned_id in
      select id from public.xpc_registry
       where last_seen is not null
         and last_seen < now() - make_interval(days => p_inactive_days)
    loop
      delete from public.xpc_user_pcs where pc_id = pruned_id;
      delete from public.xpc_registry where id = pruned_id;
      insert into public.xpc_pair_audit (action, target_pc_a, kind, justification)
        values ('registry_pruned', pruned_id, null,
                format('no heartbeat in %s days', p_inactive_days));
    end loop;
  end;

  return query select v_revoked, v_expired;
end;
$$;

-- Lock down EXECUTE: only the database owner (which pg_cron uses) and
-- the Supabase service role may call this function. Public, anon, and
-- authenticated are explicitly refused — a logged-in client that tried
-- to call this via PostgREST would get an HTTP 404 (PostgREST hides
-- functions it has no execute on).
revoke all on function public.xpc_pair_links_sweep_internal(int) from public;
revoke all on function public.xpc_pair_links_sweep_internal(int) from anon;
revoke all on function public.xpc_pair_links_sweep_internal(int) from authenticated;
-- service_role is the JWT used by Edge Functions and the SDK
-- service-key clients; granting here means future server-side code can
-- invoke the sweep on demand without forging a super-admin JWT.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.xpc_pair_links_sweep_internal(int) to service_role';
  end if;
end $$;

-- ─── 2. Re-point the two weekly cron jobs ──────────────────────────────
--
-- We call `_unschedule_if_exists` then `cron.schedule` for each name,
-- exactly as migration 0043 does. The schedule strings preserve the
-- existing prod cadence (both jobs ran on Sundays — see
-- audit-evidence-2026-04-24/8.json: jobid 14 at "30 3 * * 0" and
-- jobid 7 at "0 4 * * 0"). If the operator-created job is absent on
-- a given environment, the unschedule helper is a no-op and the
-- schedule call simply creates it.

select public._unschedule_if_exists('xpc-pair-links-sweep-weekly');
select cron.schedule(
  'xpc-pair-links-sweep-weekly',
  '30 3 * * 0',  -- Sunday 03:30 UTC (unchanged from 0043)
  $$ select public.xpc_pair_links_sweep_internal(90); $$
);

select public._unschedule_if_exists('xpc-pair-sweep-weekly');
select cron.schedule(
  'xpc-pair-sweep-weekly',
  '0 4 * * 0',  -- Sunday 04:00 UTC (preserved from the operator-created
                -- entry captured in audit-evidence-2026-04-24/8.json
                -- jobid 7, schedule "0 4 * * 0", command
                -- "select public.xpc_pair_links_sweep(90)").
  $$ select public.xpc_pair_links_sweep_internal(90); $$
);

-- ─── 3. Sanity probe so the migration log shows the new wiring ─────────
do $$
declare r record;
begin
  raise notice 'pg_cron jobs after 0051 (xpc pair sweeps):';
  for r in
    select jobname, schedule, command from cron.job
     where jobname in ('xpc-pair-sweep-weekly', 'xpc-pair-links-sweep-weekly')
     order by jobname
  loop
    raise notice '  • % @ % => %', r.jobname, r.schedule, r.command;
  end loop;
end $$;

-- ─── 4. Migration ledger ───────────────────────────────────────────────
insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0051_xpc_pair_links_sweep_internal.sql', now(), 'task-167', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
