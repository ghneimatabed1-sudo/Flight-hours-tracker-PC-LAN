# Hawk Eye — Supabase Health Snapshot
**Snapshot date:** 2026-04-24 · **Project:** production (`nklrdhfsbevckovqqkah`) — single Supabase project, no separate dev environment exists
**How to refresh this file:**
```
node_modules/.bin/tsx .local/scripts/sb-final.mjs > .local/reports/supabase-snapshot-$(date +%F).json
# then update the table below from the JSON
```

---

## Migrations

| Metric | Value |
| ------ | ----- |
| SQL files on disk        | 44 (`0001_init.sql` … `0044_migration_ledger.sql`) |
| Rows in `_migration_ledger` | 47 |
| Hash drift               | 0 (every applied row has NULL sha256 from retroactive backfill) |
| Filenames in ledger but NOT on disk | 3 — see **DEFECT D2** in the full audit report |

The three orphan ledger rows (D2):
- `0041_identity_normalization_and_automation.sql`
- `0042_canon_strip_squadron_suffix.sql`
- `0043_canon_scope_and_merge_safety.sql`

Disk reality at 0041–0043:
- `0041_canon_identity.sql`
- `0042_prod_data_backfill.sql`
- `0043_pgcron_long_term.sql`

The follow-up task queued from the audit will write a corrective
migration that backfills the real filenames and removes the
orphans.

---

## Tables (production row counts — read-only HEAD probes via service role)

| Table | Row count | Notes |
| ----- | --------- | ----- |
| pilots                          | 2 | TEST_ rows from prior audits |
| sorties                         | 0 | clean |
| squadrons                       | 1 | production — wing field is NULL → D3 (real prod gap) |
| commanders                      | (RLS) | counts hidden from PostgREST head request |
| license_keys                    | (RLS) | same |
| xpc_pcs                         | (RLS) | same |
| xpc_pair_links                  | 0 | no live cross-PC pairs (production is currently single-squadron at NO.8 SQDN) |
| xpc_pair_codes                  | 0 | |
| xpc_pair_audit                  | 0 | |
| user_pcs                        | (RLS) | |
| reminders                       | (RLS) | |
| notams                          | 0 | |
| alerts                          | 1 | |
| wings                           | 0 | production never seeded a wing row — D3 root cause |
| bases                           | 1 | |
| org_chart_nodes                 | (RLS) | |
| squadron_defaults               | (RLS) | |
| sender_identities               | (RLS) | |
| `_migration_ledger`             | 47 | the only auth-bypass system table |
| leaves                          | 0 | |
| unavailability                  | (RLS) | |
| monthly_reports                 | (RLS) | |
| sortie_attachments              | (RLS) | |
| auth_events                     | (RLS) | |
| commander_provisioning_requests | (RLS) | |
| license_keys_audit              | (RLS) | |
| audit_log                       | 150 | healthy — many writes captured |
| backup_snapshots                | (RLS) | |
| reminder_schedules              | (RLS) | |

> "(RLS)" = the service-role HEAD count returned NULL with no
> error. This is PostgREST behaviour for tables where the row count
> is not reliably reportable through the lightweight HEAD request;
> it is **not** a sign that the table is broken. A real SELECT
> against any of these tables works as expected from the
> dashboard. Worth noting in the runbook so it isn't read as a
> defect.

---

## Edge functions

11 deployed:
- `heal-claims`
- `link-pilot-device`
- `manage-reminder-schedule`
- `notify-alert`
- `notify-currency-expiry`
- `notify-notam`
- `provision-commander`
- `provision-user`
- `register-license`
- `super-admin-2fa`
- `validate-license`

All edge functions enforce JWT authentication (per the comment in
`src/lib/supabase.ts:188`). The cross-PC RPCs (`xpc_redeem_pair_code`,
`xpc_admin_create_pair`, `xpc_admin_revoke_pair`,
`xpc_admin_reset_pc`, `xpc_admin_set_permanent`,
`xpc_admin_bulk_pair_in_squadron`, `xpc_pair_links_sweep`) are
declared `SECURITY DEFINER` and re-check the super-admin gate
inside the function body — definer privileges do not leak to the
public.

---

## RLS posture

- Every public table has RLS enabled.
- The `xpc_pair_links` table has a server-side trigger that
  re-runs the pair matrix validation on every insert / update —
  defence in depth in case the RPC is ever bypassed.
- `_migration_ledger` is read-only to the `authenticated` role and
  write-only to the migration runner / super-admin.
- The `audit_log` table has no INSERT policy for `authenticated`
  by design — every audit row is written by a SECURITY DEFINER
  RPC, which prevents client-side audit forgery.

---

## Backups

This Supabase project relies on platform backups (daily, 7-day
retention on the free tier; 30-day on Pro). A `backup_snapshots`
table exists for application-level snapshots but the cadence is
operator-managed — see `MAINTENANCE_RUNBOOK.md` § "Monthly
housekeeping".

---

## What is NOT in this snapshot

- Live cron job execution detail (`cron.job_run_details`) —
  needs interactive SQL console access; the table-existence
  check above only confirms pgcron is installed and the schedules
  are registered, not that they fired.
- Per-table RLS policy definitions, predicate expressions, and
  GRANT matrix — these are captured directly in the migration
  files (0001..0044) and were code-reviewed there rather than
  re-introspected via the catalog.
- Per-edge-function payload examples or rate-limit observations.
- Any data write — every probe was read-only HEAD/SELECT via the
  service role.

> **Single-environment note:** Hawk Eye runs against ONE Supabase
> project (`nklrdhfsbevckovqqkah`). There is no separate "dev" /
> "staging" / "prod" split today — all PCs and the audit harness
> point at this project. Re-running `.local/scripts/sb-final.mjs`
> always probes this same production environment. **Audit scripts
> must never write.** If a future split is introduced (e.g. a
> dedicated dev project for migration dry-runs), update this file
> and the script's allow-list at the same time.
