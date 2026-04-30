-- 0015_security_advisor_fixes.sql
-- Resolves ALL remaining Supabase Security Advisor findings:
--
-- WARNINGS fixed:
--   1. Function Search Path Mutable — public.squadron_id()
--   2. Function Search Path Mutable — public.pilot_id()
--
-- INFO suggestions fixed:
--   3. RLS Enabled No Policy — public.super_admin_2fa
--   4. RLS Enabled No Policy — public.reminder_manual_runs
--
-- NOT fixable here (Supabase platform issues):
--   - Extension in Public (pg_net) — installed by Supabase, cannot be moved
--   - Leaked Password Protection — must be toggled in Auth > Settings in the dashboard

-- ── 1 & 2: Fix function search paths ─────────────────────────────────────────
-- Empty search_path prevents search_path injection attacks.
-- Both functions only call pg_catalog.current_setting which needs no schema.

create or replace function public.squadron_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb
      #>> '{app_metadata,squadron_id}',
    ''
  ), '')::uuid;
$$;

create or replace function public.pilot_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(coalesce(
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb
      #>> '{app_metadata,pilot_id}',
    ''
  ), '');
$$;

-- ── 3: RLS policy for super_admin_2fa ─────────────────────────────────────────
-- This table is intentionally service_role-only (REVOKE ALL on anon/authenticated
-- already applied in migration 0004). Adding an explicit deny policy satisfies
-- the linter and makes the intent clear. service_role bypasses RLS automatically.

drop policy if exists "block_all_regular_users" on public.super_admin_2fa;
create policy "block_all_regular_users"
  on public.super_admin_2fa
  as restrictive
  for all
  to anon, authenticated
  using (false);

-- ── 4: RLS policy for reminder_manual_runs ────────────────────────────────────
-- Same pattern: service_role-only table. service_role bypasses RLS, so this
-- policy only formalises the existing REVOKE ALL grant restriction.

drop policy if exists "block_all_regular_users" on public.reminder_manual_runs;
create policy "block_all_regular_users"
  on public.reminder_manual_runs
  as restrictive
  for all
  to anon, authenticated
  using (false);
