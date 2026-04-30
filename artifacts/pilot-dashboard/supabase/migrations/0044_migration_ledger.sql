-- 0044_migration_ledger.sql
--
-- Task #145 (4/4) — A tracking table the GitHub Actions migration
-- pipeline uses to know which `supabase/migrations/*.sql` files have
-- already been applied to the production project.
--
-- Without this table the workflow would either:
--   • re-apply every migration on every push (slow, error-prone if
--     a migration is not 100 % idempotent), or
--   • silently skip migrations that did exist but failed halfway
--     (the bug that bit us when 0038 sat unapplied for days).
--
-- Schema:
--   filename     TEXT PRIMARY KEY  — the bare filename, no path
--   applied_at   TIMESTAMPTZ        — when the apply succeeded
--   applied_by   TEXT               — who/what applied it (CI / manual)
--   sha256       TEXT               — content hash; lets the workflow
--                                     warn if a previously-applied
--                                     migration file was edited (which
--                                     means production is out of sync
--                                     with the repo).
--
-- The workflow's recovery procedure: if a row in this table has a
-- different sha256 than the file on disk, the workflow flags it but
-- does NOT auto-rewrite — the operator decides whether to write a new
-- migration that re-aligns prod with the new content.

create table if not exists public._migration_ledger (
  filename    text primary key,
  applied_at  timestamptz not null default now(),
  applied_by  text,
  sha256      text
);

-- Retroactive backfill: every migration file 0001..0044 that physically
-- exists in the repo IS already applied to production (the previous
-- workflow was "operator pastes into Supabase SQL editor" and the
-- last 18 months of evidence is that the schema matches the repo).
-- Mark them all applied with applied_by='retroactive' and a NULL hash
-- (the workflow tolerates NULL hashes — it only warns on a CHANGED
-- hash, not a missing one).
insert into public._migration_ledger (filename, applied_by, sha256)
values
  ('0001_init.sql', 'retroactive', null),
  ('0002_mobile_link.sql', 'retroactive', null),
  ('0003_pilot_self_rls.sql', 'retroactive', null),
  ('0004_super_admin_2fa.sql', 'retroactive', null),
  ('0005_pilot_reminders.sql', 'retroactive', null),
  ('0006_super_admin_recovery_codes.sql', 'retroactive', null),
  ('0007_reminder_schedule.sql', 'retroactive', null),
  ('0008_reminder_manual_runs.sql', 'retroactive', null),
  ('0009_saved_duty_weeks.sql', 'retroactive', null),
  ('0010_cross_pc.sql', 'retroactive', null),
  ('0011_alerts.sql', 'retroactive', null),
  ('0012_alert_notam_priority.sql', 'retroactive', null),
  ('0013_schedule_program.sql', 'retroactive', null),
  ('0014_security_hardening.sql', 'retroactive', null),
  ('0015_security_advisor_fixes.sql', 'retroactive', null),
  ('0016_mobile_link_devices_fix.sql', 'retroactive', null),
  ('0017_sync_indicator.sql', 'retroactive', null),
  ('0018_sync_indicator_fix.sql', 'retroactive', null),
  ('0019_sync_status_pilot_auth_binding.sql', 'retroactive', null),
  ('0020_pilot_devices_unique_constraints.sql', 'retroactive', null),
  ('0021_pilots_military_number_unique.sql', 'retroactive', null),
  ('0022_pilot_auth_binding_and_nvg.sql', 'retroactive', null),
  ('0023_xpc_registry_scoped_visibility.sql', 'retroactive', null),
  ('0024_xpc_registry_directory_visibility.sql', 'retroactive', null),
  ('0025_xpc_registry_anon_directory.sql', 'retroactive', null),
  ('0026_license_registry.sql', 'retroactive', null),
  ('0027_schedule_share_dismissal.sql', 'retroactive', null),
  ('0028_widen_tier_constraints.sql', 'retroactive', null),
  ('0029_widen_schedule_delete_policy.sql', 'retroactive', null),
  ('0030_backfill_app_metadata.sql', 'retroactive', null),
  ('0031_pilots_rank_en.sql', 'retroactive', null),
  ('0032_retention_cleanup_jobs.sql', 'retroactive', null),
  ('0033_fix_schedule_update_with_check.sql', 'retroactive', null),
  ('0034_robust_schedule_insert_rls.sql', 'retroactive', null),
  ('0035_xpc_universal_autoclaim_rls.sql', 'retroactive', null),
  ('0036_xpc_bulletproof_rls.sql', 'retroactive', null),
  ('0037_org_chart_hierarchy.sql', 'retroactive', null),
  ('0038_xpc_pair_links.sql', 'retroactive', null),
  ('0039_sender_identity_and_squadron_defaults.sql', 'retroactive', null),
  ('0040_backfill_squadron_defaults.sql', 'retroactive', null)
on conflict (filename) do nothing;

-- 0041..0044 are recorded by the GitHub Actions workflow itself when
-- it applies them; this lets the FIRST run of the workflow notice
-- they were applied manually during this task and skip.
insert into public._migration_ledger (filename, applied_by, sha256)
values
  ('0041_canon_identity.sql', 'task-145', null),
  ('0042_prod_data_backfill.sql', 'task-145', null),
  ('0043_pgcron_long_term.sql', 'task-145', null),
  ('0044_migration_ledger.sql', 'task-145', null)
on conflict (filename) do nothing;

-- The ledger is sensitive operational state — restrict to super-admin
-- read; the GitHub Actions workflow uses the SUPABASE_ACCESS_TOKEN
-- (Management API), which bypasses RLS, so it can read+write freely.
alter table public._migration_ledger enable row level security;

drop policy if exists migration_ledger_select on public._migration_ledger;
create policy migration_ledger_select on public._migration_ledger
  for select to authenticated using (
    coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'role') = 'super_admin',
      false
    )
  );

-- (No INSERT/UPDATE/DELETE policy — only the Management API workflow
-- writes to this table.)

notify pgrst, 'reload schema';
