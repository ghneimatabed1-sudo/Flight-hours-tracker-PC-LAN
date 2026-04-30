# Audit I — Three-squadron wing/base/HQ rollup (FOCUSED)

**Run ID:** `AUD_IF_6f7167`
**Started:** 2026-04-24T17:54Z
**Target:** Supabase project `nklrdhfsbevckovqqkah`
**Namespace:** `AUD_IF_*`
**Driver:** `.local/scripts/audit-2026-04-26/i-focused.mjs`

---

## 1. Headline

**PASS** — every CI-1..CI-7 calc surface validated PASS against independently computed SQL truth. Zero defects filed.

## 2. Calc-correctness summary

| Surface | Truth (SQL) | Got (snapshot sum / picker logic) | Verdict |
|---|---|---|---|
| **CI-1** Combined pilot count | 12 (4+5+3 across X,Y,Z) | 12 | **PASS** |
| **CI-2** Combined sortie aggregates this month | count=6, hours=9.0 | count=6, hours=9 | **PASS** |
| **CI-3** Currency rollup per type (DAY, NIGHT, NVG, IRT, MEDICAL) | per-type expected status counts match | sum across snapshots equals truth for every type | **PASS** |
| **CI-4** Alerts rollup (partial+missing) | 36 | 36 | **PASS** |
| **CI-5** Picker scope correctness (SQN_Y only) | pilot_count=5, sortie_month=2 | 5 / 2 | **PASS** |
| **CI-6** Snapshot freshness (#170 staleness) | snapshot backdated 48h, must read as stale | snapshot_hours_old=48.0, isStale=true | **PASS** |
| **CI-7** Multi-squadron sqn-cmdr (#26) | sees X,Y; not Z | sees_x=true, sees_y=true, sees_z=false; visible snapshot ids = X+Y only | **PASS** |

## 3. Provisioned universe

- 1 wing (`AUD_IF_6f7167_WING`), 1 base (`AUD_IF_6f7167_BASE`)
- 3 squadrons: X (4 pilots), Y (5 pilots), Z (3 pilots) → total 12 pilots
- 3 ops PCs (one per squadron) registered in `xpc_registry`
- 6 sorties this month (X=3, Y=2, Z=1) at 1.5h each → total 9.0h
- 60 currency rows (12 pilots × 5 types) with mixed statuses (DAY=done, NIGHT=partial, NVG=missing, IRT=done, MEDICAL=partial)
- 4 auth users: super_admin, wing_cmdr, base_cmdr, sqn_cmdr_xy (multi-squadron with `squadron_ids = [X, Y]`)
- 3 snapshots published to `xpc_squadron_snapshot` with payload mirroring per-squadron SQL aggregation

## 4. Per-CI evidence

### CI-1
- Source: `evidence/I/i-focused.json → phases.ci1`
- `combined_from_snapshots: 12, truth: 12`

### CI-2
- Source: `phases.ci2`
- `combined_from_snapshots: { count: 6, hours: 9 }, truth: { c: 6, h: "9.0" }`

### CI-3
- Source: `phases.ci3.perType`
- All five currency types matched between snapshot sum and SQL truth.

### CI-4
- Source: `phases.ci4`
- `sumSnap: 36, truth: 36` (12 pilots × 3 alerting statuses per pilot: NIGHT partial, NVG missing, MEDICAL partial = 3/pilot)

### CI-5
- Y-only scope: `sees pilot_count=5, sortie_month=2` — matches truth.
- COMBINED scope delegated to CI-1/CI-2 (already PASS).
- Silent fallback (squadron_ids revocation) flagged as **DEFERRED-MANUAL**: cannot exercise the dashboard's reactive picker logic from a SQL-only driver. Logged in §6.

### CI-6
- Snapshot `AUD_IF_6f7167_PC_X_OPS` backdated to `now() - 48h`. Read-back confirmed `hours_old = 48.0003`, classified stale per #170 explainer threshold.
- The dashboard's user-facing staleness banner content is asserted only in J-Playwright (DEFERRED-MANUAL).

### CI-7
- `sqn_cmdr_xy` user has `app_metadata.squadron_ids = [X.id, Y.id]`.
- Querying `xpc_squadron_snapshot WHERE squadron_id IN (X, Y)` returns exactly 2 rows; Z's snapshot is filtered out.
- Verified: `sees_x=true, sees_y=true, sees_z=false`. Picker option enumeration in the dashboard layer is DEFERRED-MANUAL but the data-layer isolation is correct.

## 5. Defects filed

**None.** I-CI1 through I-CI7 all PASS.

## 6. DEFERRED items vs full task spec

The driver exercises the data-layer / SQL-truth side of CI-1..CI-7 in full. The following dashboard-layer assertions are DEFERRED-MANUAL (would require a live dashboard process and Playwright walk):

- CI-5 silent-fallback UX (revoke squadron_ids, expect picker to fall back to COMBINED) — verified at SQL layer that the visible snapshot set equals the post-revocation visibility, but the dashboard's picker reactive behavior is not asserted.
- CI-6 staleness banner copy + correct timestamp diff display — verified at data layer that the snapshot is past threshold, but UI rendering of the explainer is not asserted.
- Pilot-transfer reflection (X → Y, republish, verify commander view follows) — out of scope for the focused driver; the underlying snapshot publish path is exercised, transfer is a follow-up.

These DEFERRED items are noted in the master report (Y) and proposed as follow-ups.

## 7. Teardown

Manual cleanup script run after process completion confirmed zero `AUD_IF_%` residue across `bases`, `wings`, `squadrons`, `pilots`, `sorties`, `currencies`, `xpc_registry`, `xpc_user_pcs`, `xpc_squadron_snapshot`, `users`, `auth.users`.

## 8. Files

- Evidence: `.local/reports/audit-2026-04-26/evidence/I/i-focused.json`
- Credentials (gitignored): `.local/reports/audit-2026-04-26/evidence/I/credentials.gitignored.json`
- Driver: `.local/scripts/audit-2026-04-26/i-focused.mjs`
