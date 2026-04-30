-- 0051_pilot_rls_lockdown.sql
--
-- Audit F (mobile, 2026-04-25) found that the squadron-wide `_rw`
-- policies on the pilot-facing tables (`pilots`, `sorties`, `notams`,
-- `alerts`, `pilot_devices`, `pilot_link_codes`) granted UPDATE/DELETE
-- rights to anyone whose JWT carried `app_metadata.squadron_id` — which
-- includes the per-pilot mobile auth users provisioned by the
-- `link-pilot-device` edge function. The intent has always been
--
--   "ops/admin/deputy/superadmin can read+write everything in their
--    squadron; a pilot signed in on their phone can read everyone in
--    the squadron but only ever write their own row."
--
-- RLS policies are permissive (OR'd together), so the existing narrow
-- `pilots_self_select` / `sorties_self_select` policies were additive
-- only — they widened reads, they did not constrain writes. Result:
-- pilot A's session could `update` or `delete` pilot B's row, and the
-- same for sorties / NOTAMs / alerts / link-codes / devices.
--
-- Live confirmation in the audit:
--   - rls_other_pilot_blocked: false  (pilot A read pilot B by id)
--   - the same policy that allows that read also allows update/delete.
--
-- Fix: scope each broad `_rw` policy to ops sessions only by adding
-- `public.pilot_id() is null` to both the USING and WITH CHECK clauses.
-- Ops/admin/deputy/superadmin JWTs never carry `app_metadata.pilot_id`,
-- so the predicate is true for them and false for any pilot session.
-- The narrow per-pilot read policies (`pilots_self_select`,
-- `sorties_self_select`, `sq_self_select` from migration 0003;
-- `devices_self_rw` from migration 0016) remain in place, so pilots
-- keep the reads they need. To preserve the squadron-NOTAM and
-- squadron-alerts read paths the mobile app relies on, this migration
-- also adds two new SELECT-only policies bound to the pilot's own
-- squadron via the `pilots.auth_user_id = auth.uid()` binding (the
-- same binding the existing pilot self-select policies use, so a
-- revoked phone instantly loses these reads as well).
--
-- The previous `alerts_pilot_read` policy (migration 0011) was
-- `for select using (true)` — every authenticated user could read
-- every alert in the database, ignoring squadron boundaries. The
-- replacement below tightens it to the pilot's own squadron.
--
-- Idempotent: every `create policy` is preceded by `drop policy if
-- exists`, so re-running the migration is safe.
--
-- Negative-case integration test:
--   artifacts/pilot-dashboard/supabase/audit/audit-mobile.mjs
-- provisions two pilots in a fresh squadron, signs pilot A in via
-- real Supabase auth, and asserts that pilot A's UPDATE/DELETE
-- attempts against pilot B's rows in every table touched here are
-- denied (or silently no-op against zero rows under RLS), and that
-- the new alerts read policy no longer leaks across squadrons.
-- Run after applying this migration; exits non-zero on any failure.

-- ── helper: bound pilot's squadron, bypassing RLS ─────────────────────
-- The new pilot SELECT policies need to know the pilot's own
-- squadron, but evaluating "select squadron_id from public.pilots
-- where id = public.pilot_id() and auth_user_id = auth.uid()" inline
-- inside a policy ON public.pilots triggers RLS recursion (the
-- subquery re-evaluates the same policy that called it). Wrapping
-- the lookup in a SECURITY DEFINER helper bypasses RLS for the
-- subquery only — the helper still requires both the JWT pilot_id
-- claim and the auth.uid() binding, so a revoked phone (auth_user_id
-- nulled) still returns NULL and the calling policy fails closed.
create or replace function public.pilot_squadron_for_caller()
returns uuid
language sql
stable
security definer
set search_path = public, auth, pg_catalog
as $$
  select p.squadron_id
    from public.pilots p
   where p.id = public.pilot_id()
     and p.auth_user_id = auth.uid()
   limit 1;
$$;

revoke all on function public.pilot_squadron_for_caller() from public;
grant execute on function public.pilot_squadron_for_caller() to authenticated;

-- ── pilots ────────────────────────────────────────────────────────────
-- Ops-only squadron-wide read+write. Pilots keep SELECT of their own
-- row via `pilots_self_select` (migration 0003), and SELECT of the
-- squadron roster via the new `pilots_pilot_squadron_read` below
-- (preserving the read access the audit identified as intentional
-- for roster display).
drop policy if exists pilots_rw on public.pilots;
create policy pilots_rw on public.pilots
  for all
  using (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  )
  with check (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  );

-- Pilots may SELECT every pilot in their own squadron (roster). The
-- squadron is derived from the caller's bound pilots row, not from
-- the JWT's squadron_id claim, so a pilot whose binding has been
-- revoked instantly loses roster reads as well.
drop policy if exists pilots_pilot_squadron_read on public.pilots;
create policy pilots_pilot_squadron_read on public.pilots
  for select
  using (
    public.pilot_id() is not null
    and squadron_id = public.pilot_squadron_for_caller()
  );

-- ── sorties ───────────────────────────────────────────────────────────
-- Ops-only squadron-wide read+write. Pilots keep SELECT for sorties
-- they flew (P1 or P2) via `sorties_self_select` (migration 0003),
-- and SELECT of squadron-wide sorties via the new
-- `sorties_pilot_squadron_read` below (the audit treated squadron-
-- wide sortie reads from a pilot session as intentional too).
drop policy if exists sorties_rw on public.sorties;
create policy sorties_rw on public.sorties
  for all
  using (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  )
  with check (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  );

drop policy if exists sorties_pilot_squadron_read on public.sorties;
create policy sorties_pilot_squadron_read on public.sorties
  for select
  using (
    public.pilot_id() is not null
    and squadron_id = public.pilot_squadron_for_caller()
  );

-- ── notams ────────────────────────────────────────────────────────────
-- Ops-only squadron-wide read+write.
drop policy if exists notams_rw on public.notams;
create policy notams_rw on public.notams
  for all
  using (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  )
  with check (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  );

-- New: pilots may read NOTAMs scoped to their own squadron. The
-- squadron is derived from the `pilots` row that the JWT's
-- `app_metadata.pilot_id` claim resolves to, AND that row must be
-- bound to the session's `auth.uid()` — so revoking the phone (by
-- nulling `pilots.auth_user_id`) instantly stops NOTAM reads too.
drop policy if exists notams_pilot_read on public.notams;
create policy notams_pilot_read on public.notams
  for select
  using (
    public.pilot_id() is not null
    and squadron_id = public.pilot_squadron_for_caller()
  );

-- ── alerts ────────────────────────────────────────────────────────────
-- Ops-only squadron-wide read+write.
drop policy if exists alerts_rw on public.alerts;
create policy alerts_rw on public.alerts
  for all
  using (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  )
  with check (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  );

-- Replace the over-broad `alerts_pilot_read` (`using (true)` from
-- migration 0011, which leaked alerts across squadrons) with a
-- squadron-scoped pilot SELECT, mirroring `notams_pilot_read` above.
drop policy if exists alerts_pilot_read on public.alerts;
create policy alerts_pilot_read on public.alerts
  for select
  using (
    public.pilot_id() is not null
    and squadron_id = public.pilot_squadron_for_caller()
  );

-- ── pilot_link_codes ──────────────────────────────────────────────────
-- Ops-only. Pilots never read or write this table directly — the
-- `link_pilot_device` SECURITY DEFINER RPC handles consumption on
-- their behalf.
drop policy if exists link_codes_ops_rw on public.pilot_link_codes;
create policy link_codes_ops_rw on public.pilot_link_codes
  for all
  using (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  )
  with check (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  );

-- ── pilot_devices ─────────────────────────────────────────────────────
-- Ops-only squadron-wide read+write. Pilots keep read+write of their
-- OWN device row via `devices_self_rw` (migration 0016), which is
-- scoped to `user_id = auth.uid()`.
drop policy if exists devices_ops_rw on public.pilot_devices;
create policy devices_ops_rw on public.pilot_devices
  for all
  using (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  )
  with check (
    public.pilot_id() is null
    and squadron_id = public.squadron_id()
  );

-- ── Ledger + PostgREST schema reload ─────────────────────────────────
insert into public._migration_ledger (filename, applied_by)
values ('0051_pilot_rls_lockdown.sql', 'task-177')
on conflict (filename) do nothing;

-- This migration was renumbered twice during task-177:
--   * Originally 0047_pilot_rls_lockdown.sql (before upstream landed
--     0047_backfill_ops_public_users on main).
--   * Then 0050_pilot_rls_lockdown.sql (before upstream landed
--     0050_squadron_rename_xpc_sync on main).
--   * Final number 0051, after all current siblings.
-- Sweep both obsolete ledger entries so apply-migrations doesn't
-- emit "in ledger not on disk" warnings for the renamed files.
delete from public._migration_ledger
where filename in (
  '0047_pilot_rls_lockdown.sql',
  '0050_pilot_rls_lockdown.sql'
);

notify pgrst, 'reload schema';
