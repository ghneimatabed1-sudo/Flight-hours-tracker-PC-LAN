-- 0052_backfill_ledger_sha256.sql
--
-- Task #195 — Backfill the `sha256` column on every existing row in
-- public._migration_ledger so the drift-warning code path in the
-- GitHub Actions migration workflow has something to compare against.
--
-- Why this is needed
-- ──────────────────
-- The ledger schema (introduced in 0044_migration_ledger.sql) was
-- designed so the workflow can warn when a previously-applied
-- migration file is later edited on disk: it hashes each file at apply
-- time and stores the hash in `sha256`, then on every subsequent run
-- compares the on-disk hash to the recorded one and fails the job on
-- any mismatch.
--
-- However, every row currently in production has `sha256 = NULL`:
--
--   • The 40 retroactive rows seeded by 0044_migration_ledger.sql
--     (filenames 0001…0040) were inserted with an explicit `null`
--     because nobody hashed the historical files when seeding.
--   • The four `task-145` rows in the same file (0041…0044) were also
--     `null` for the same reason.
--   • Migrations 0045_round4_fixes.sql … 0050_squadron_rename_xpc_sync.sql
--     each contain their own self-insert into the ledger with
--     `sha256 = null` and `on conflict (filename) do nothing`. The
--     workflow's later insert was supposed to overwrite that NULL via
--     `on conflict do update set sha256 = excluded.sha256`, but the
--     original (Task #145) version of the workflow piped its ledger
--     curl to `> /dev/null` and never checked for failure, so any
--     transient HTTP error left the row at NULL forever. The status
--     check landed in Task #145 fix-up, but by then the rows were
--     already there and the workflow's `if filename in ledger: skip`
--     short-circuit means it will never revisit them.
--
-- Result: the drift-warning code path has had NOTHING to compare
-- against for the entire life of the ledger. We just spent Task #168
-- chasing three ghost ledger rows that this exact mechanism was meant
-- to surface earlier.
--
-- What this migration does
-- ────────────────────────
-- For every .sql file in artifacts/pilot-dashboard/supabase/migrations/
-- that exists on disk at the time this migration was authored, set
-- `_migration_ledger.sha256` = the SHA-256 of the file's bytes — but
-- ONLY for rows where sha256 is currently NULL.
--
--   • `where sha256 is null` keeps the migration idempotent on re-run
--     and, more importantly, does NOT mask future drift: if a future
--     workflow run has correctly recorded a non-NULL hash, we leave
--     it alone so the drift-warning compare still works.
--   • Filenames that are not present in the ledger (e.g. ghosts that
--     were already cleaned up in 0051_reconcile_ghost_ledger.sql, or
--     files added between this migration being authored and applied)
--     produce a no-op update.
--   • This file (0052_backfill_ledger_sha256.sql) is intentionally NOT
--     in the list — the workflow inserts its own ledger row with the
--     correct hash immediately after applying this migration.
--
-- Verification after apply
-- ────────────────────────
--   select count(*) from public._migration_ledger where sha256 is null;
--     -- expected: 0 (or only rows whose .sql file is missing on disk;
--     --            those should be cleaned up the same way 0051 did)
--
-- After this migration:
--   • Re-running the GitHub Actions workflow on an unchanged repo
--     produces zero drift warnings.
--   • Editing any previously-applied migration file produces the
--     existing drift warning the next time the workflow runs.

update public._migration_ledger set sha256 = 'be8384bbbbd874a7f4c95beeab9c7d9d4235e1887d24a2d0756618014c24333b' where filename = '0001_init.sql' and sha256 is null;
update public._migration_ledger set sha256 = '6a91b8393924537b2bc0aace91af869020a6f7d2806cbfdaf48ec1b2c3cb0a11' where filename = '0002_mobile_link.sql' and sha256 is null;
update public._migration_ledger set sha256 = '7610483147f74ed9575a550d587c3bf1d0d4e84b917d6b35ab1027884ca0095e' where filename = '0003_pilot_self_rls.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'f3572cbc992066f31c593971d51c0263af3e781430a54d1f6da421ea6af0d223' where filename = '0004_super_admin_2fa.sql' and sha256 is null;
update public._migration_ledger set sha256 = '8a1c05baba728e619ac18abd768e384c0ecb0aaccec140cee73e24facab38c3d' where filename = '0005_pilot_reminders.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'b40e33d2776202db5e4581342fc41360d42b5050cecc8ce447c5cb97a6411bd3' where filename = '0006_super_admin_recovery_codes.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'f038351e3afa8999a7c8637c8cf2dcdd882b7f4ee1fa9801d855a920a419b5a0' where filename = '0007_reminder_schedule.sql' and sha256 is null;
update public._migration_ledger set sha256 = '5dae4f2973e78065c45249c9b2e37f4855b6a0fe248172b644d6a705f4e7d238' where filename = '0008_reminder_manual_runs.sql' and sha256 is null;
update public._migration_ledger set sha256 = '7596fa56c53ce2b0b0c5b874bbbcb5a08fa0fd583cd02674d1fb06760d6c2b3a' where filename = '0009_saved_duty_weeks.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'd2b7a2d7ace50d592555a56d83db91ba0d18fcc0086288c96fc097990a87979a' where filename = '0010_cross_pc.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'a90a218be4a57c6fe48668cd695b686c66a7d4b2a23be4b5e1481b2720527c03' where filename = '0011_alerts.sql' and sha256 is null;
update public._migration_ledger set sha256 = '762ebd33514be55ec2e2c554b7f3119ad51969424aed4019f8b9a357d6489c88' where filename = '0012_alert_notam_priority.sql' and sha256 is null;
update public._migration_ledger set sha256 = '4b9dce363c1a219f18fd81d9c9949d07ac65b6bdba148a7844c66e14f9b1e8a7' where filename = '0013_schedule_program.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'cf6cb107118c7b1c4e036c707b5cea76bcd629fd71ef05948ea397594b6dae0b' where filename = '0014_security_hardening.sql' and sha256 is null;
update public._migration_ledger set sha256 = '321e6b0a25918cd42c3b62b45903370bef0da881a076142ce3c3c1b8d16541f8' where filename = '0015_security_advisor_fixes.sql' and sha256 is null;
update public._migration_ledger set sha256 = '81a2b77b2bf8750571a89677c1db620e01e134506bb9405ef0bdd868d9fbad06' where filename = '0016_mobile_link_devices_fix.sql' and sha256 is null;
update public._migration_ledger set sha256 = '1d23c873568b9cf0aa88f51f97d06ef27888965888ede5095fc74700d585615b' where filename = '0017_sync_indicator.sql' and sha256 is null;
update public._migration_ledger set sha256 = '15704912ce75138482c58ecbafb3c883302a5898ff65afb95d6109500a1ad1c3' where filename = '0018_sync_indicator_fix.sql' and sha256 is null;
update public._migration_ledger set sha256 = '2cc423a82ec518f2f6239a47b15462f99c9cb021236e58c25b88ffc5115b0739' where filename = '0019_sync_status_pilot_auth_binding.sql' and sha256 is null;
update public._migration_ledger set sha256 = '7af0452b76c516b305aea1f3e0452d678a367bde2b7718ad2577047178068803' where filename = '0020_pilot_devices_unique_constraints.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'f68d5a2a4c3c62ac9f9d64e2c296a300627e65e9abacfa1fe13e578bf0299ca2' where filename = '0021_pilots_military_number_unique.sql' and sha256 is null;
update public._migration_ledger set sha256 = '19aa492fb8171c9e6974c7b3311e251a1a6801848219831613d18da18da5c9ef' where filename = '0022_pilot_auth_binding_and_nvg.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'c8639b3e5e7f351308542104fc494010a5e9888b9857ed6a2c950ccfc9ae785f' where filename = '0023_xpc_registry_scoped_visibility.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'db095aa0cfc06d303ff3202bdd8901ef2d2aba433281144dd9467bf309d3c97e' where filename = '0024_xpc_registry_directory_visibility.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'ad5f84ae4d8ea459fae1063d679cce3d4836b6c90992a1f3d1dca01b670a5d93' where filename = '0025_xpc_registry_anon_directory.sql' and sha256 is null;
update public._migration_ledger set sha256 = '4c27f309ec6972e8fd0c425886909b324fdde18707a748a1bbea4c2b0a042675' where filename = '0026_license_registry.sql' and sha256 is null;
update public._migration_ledger set sha256 = '9917de65557599a078c44113e75f5bc06b97647dea244435a07559760637a50f' where filename = '0027_schedule_share_dismissal.sql' and sha256 is null;
update public._migration_ledger set sha256 = '25458650c7471edd1e0d7a19addb25bee1a69a96139d5a656156f047a1ffb09f' where filename = '0028_widen_tier_constraints.sql' and sha256 is null;
update public._migration_ledger set sha256 = '2259417c6a977edc29232a485281f2746de7f24c95d6c7ac0f06819338d69366' where filename = '0029_widen_schedule_delete_policy.sql' and sha256 is null;
update public._migration_ledger set sha256 = '248747b0b6717e8834c35bb14264e6bbd597064457622e58eae6b7b565f26645' where filename = '0030_backfill_app_metadata.sql' and sha256 is null;
update public._migration_ledger set sha256 = '3a40c1d19e1a082a2f524cde8375e80b784fcfb4739967ec30f1792cd39b6390' where filename = '0031_pilots_rank_en.sql' and sha256 is null;
update public._migration_ledger set sha256 = '218eff8a5bac440c40f32bd602cdda205b41a27aec82b9170e18288478909179' where filename = '0032_retention_cleanup_jobs.sql' and sha256 is null;
update public._migration_ledger set sha256 = '802009e4831dd8464df946271c55f6334ac624d8602455b9bd8300bab98786bc' where filename = '0033_fix_schedule_update_with_check.sql' and sha256 is null;
update public._migration_ledger set sha256 = '960c005cd85cc6b4634db9df7c8433f3637776ccf032e8b8db5136f10ea2a2d5' where filename = '0034_robust_schedule_insert_rls.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'b123e2e57386c2cefa0391c29ab42be28cebb6873167fa74cc9f58c2fbd83ce6' where filename = '0035_xpc_universal_autoclaim_rls.sql' and sha256 is null;
update public._migration_ledger set sha256 = '948b12c6ddb2fa51ae25f04b7c46f84c65015ee83fe9fd3b3fc196622ec93532' where filename = '0036_xpc_bulletproof_rls.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'ef61d690285453a7fcbac65ca01a7bee334e7c0bc39936d3b30dfd9234656dfe' where filename = '0037_org_chart_hierarchy.sql' and sha256 is null;
update public._migration_ledger set sha256 = '5c69572c256f63a322aedcee49ffe0c874ca40a76bff7c5fe936f1c81d86c66c' where filename = '0038_xpc_pair_links.sql' and sha256 is null;
update public._migration_ledger set sha256 = '0df71005d60890c7766840b024b3f5f3f98c311f9259388b8a66d6c145df1479' where filename = '0039_sender_identity_and_squadron_defaults.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'a005209b1bf64f0048a9c3a012f00fe1bf76b59b5ec296186066077d2e6ba6d4' where filename = '0040_backfill_squadron_defaults.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'd77547942e776495e6e34393be120dc69a5c197cdd66382bf651624cec0d2c85' where filename = '0041_canon_identity.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'ce9d84a987285dd1e4fed88e7debf5c051c5a6cecfb9b903ca5f40c9354134ba' where filename = '0042_prod_data_backfill.sql' and sha256 is null;
update public._migration_ledger set sha256 = '9a802de903244f0875fcce0a6768abd746c7974b06e8352fc656c8d9d3e6427c' where filename = '0043_pgcron_long_term.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'b929772093b0bfe4ddca887f35e5533819a2181e389f211a7a486ae7cc7d8cca' where filename = '0044_migration_ledger.sql' and sha256 is null;
update public._migration_ledger set sha256 = '40a963e837ef8ed3724f755d8582b6ea3b7102488e8dd819fe8474998b32ae39' where filename = '0045_round4_fixes.sql' and sha256 is null;
update public._migration_ledger set sha256 = '240caf1ff5d1cdc2942156e3db125f1eda5277877ecad0b1b7479ea848637c22' where filename = '0046_fix_xpc_admin_create_pair.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'fcab8e57c4995514300b845379be92054934c03b98309c0e337d72c4362516c2' where filename = '0047_backfill_ops_public_users.sql' and sha256 is null;
update public._migration_ledger set sha256 = '43321785b66c8acbb140b47d00e434e68062484840f00817e1c72856c1449133' where filename = '0048_fix_xpc_redeem_pair_code.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'b9cbc2859bc7cfc91ba3bca0123bca93264bb3f23615a8bfe636b2bb6fbce626' where filename = '0049_xpc_messages_logical_seat_select.sql' and sha256 is null;
update public._migration_ledger set sha256 = '12fc6954ca61da951e05ecc5dc3ef68f1d015fe0a33e709c4df3677dd8980f87' where filename = '0050_squadron_rename_xpc_sync.sql' and sha256 is null;
update public._migration_ledger set sha256 = '6ca2c27ecadb09a969851fef16cf326f250b6162c3786ffa5d72d0df79776e1e' where filename = '0051_pilot_rls_lockdown.sql' and sha256 is null;
update public._migration_ledger set sha256 = 'f8699efe2715c97521d0be15aeb5d1cc155c34ad1656004479237445e02488cc' where filename = '0051_reconcile_ghost_ledger.sql' and sha256 is null;
update public._migration_ledger set sha256 = '97f3513323c654b263a21a2bc0b9ae145047b05e179aeb4ae3bea4ae5dd9253e' where filename = '0051_xpc_messages_retention_backstop.sql' and sha256 is null;
update public._migration_ledger set sha256 = '663dd7c0c7004b25868aef06407089511a99a968ae00a9b128cba62e806026b2' where filename = '0051_xpc_pair_links_sweep_internal.sql' and sha256 is null;

notify pgrst, 'reload schema';
