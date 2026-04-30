-- 0051_reconcile_ghost_ledger.sql
--
-- Task #168 — Remove three "ghost" rows from public._migration_ledger
-- whose .sql files no longer exist on disk.
--
-- Background (Audit E, defect D-02 — .local/reports/audit-2026-04-25/
-- E-15-year.md): production's ledger has 49 rows but supabase/migrations/
-- only contains 46 .sql files. The diff is three rows that were
-- recorded as applied during Task #145 but were renamed/superseded
-- before the final files were committed. The ledger was never updated
-- to drop the old filenames, so any future tool that cross-checks
-- ledger ↔ disk (e.g. the GitHub Actions workflow's hash-drift warning
-- in 0044) will throw, and the next operator who eyeballs the ledger
-- cannot tell which migration is the canonical one.
--
-- The three ghosts and their replacements:
--
--   • 0041_identity_normalization_and_automation.sql
--       superseded by 0041_canon_identity.sql
--       (same slot — the original draft bundled the data backfill into
--       one file; we split it so 0041 sets up triggers + indexes
--       idempotently and 0042 does the one-shot data cleanup).
--
--   • 0042_canon_strip_squadron_suffix.sql
--       superseded by 0042_prod_data_backfill.sql
--       (same slot — the suffix-stripping became one of several
--       canonicalisation steps inside the broader prod data backfill).
--
--   • 0043_canon_scope_and_merge_safety.sql
--       superseded by 0043_pgcron_long_term.sql
--       (the scope-and-merge-safety logic moved up into the BEFORE
--       INSERT/UPDATE triggers in 0041_canon_identity.sql, freeing the
--       0043 slot for the long-term pg_cron jobs that actually had to
--       go in last).
--
-- Safety:
--   • Uses an exact-filename whitelist via WHERE filename IN (...).
--   • Re-running this migration is a no-op (the rows are already gone
--     after the first apply; the DELETE simply matches zero rows).
--   • Does NOT touch the canonical 0041/0042/0043 rows — those have
--     different filenames (0041_canon_identity.sql etc.) and are
--     unaffected by the IN list.
--
-- After applying, the invariant from the ledger schema holds again:
--   select count(*) from public._migration_ledger
--     = (number of .sql files in supabase/migrations/)
-- (with the usual off-by-one for THIS file once the workflow records
--  it; the workflow inserts its own ledger row on success.)

delete from public._migration_ledger
where filename in (
  '0041_identity_normalization_and_automation.sql',
  '0042_canon_strip_squadron_suffix.sql',
  '0043_canon_scope_and_merge_safety.sql'
);

notify pgrst, 'reload schema';
