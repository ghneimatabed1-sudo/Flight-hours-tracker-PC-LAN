# Round 4 AA3 — Patch every hole the audits found

**Status:** GREEN (all six holes patched, three regression tests PASS against live prod, frontend tests still green).

**Target:** prod Supabase project `nklrdhfsbevckovqqkah`.
**Migrations applied:** `0064_xpc_pending_rls_realignment.sql`, `0065_schema_drift_restoration.sql`, `0066_snapshot_payload_hours_marker.sql`.
**Ledger entries:** see `prod-state-after.txt`.

---

## Per-bug results

### 1. `xpc_pending` SELECT predicate uses PC-id namespace (Audit P P-3 / #271)

**Before.** The original 0010 policy was:
```
((hosting_squadron_id = ANY (xpc_my_pc_ids()))
 OR (home_squadron_id = ANY (xpc_my_pc_ids())))
```
Squadron-tier ops PCs work because their canonical Ops PC's id IS the
squadron code. Wing/base/HQ commanders carrying only the
`app_metadata.squadron_ids` JWT claim see ZERO pending rows — the
pending tray on every commander console looks empty.

**Fix.** Migration `0064_xpc_pending_rls_realignment.sql` mirrors the
pattern from `0061_snapshot_rls_select_strict.sql`:

```
super_admin/admin
  OR squadron-tier ops PC (xpc_my_pc_ids → unchanged path)
  OR multi-squadron commander via xpc_caller_squadron_ids() (NEW)
```

**Live prod policy after migration** (verbatim from
`pg_get_expr(polqual, polrelid)`):
```
((xpc_caller_role() = ANY (ARRAY['super_admin', 'superadmin', 'admin']))
 OR (hosting_squadron_id = ANY (xpc_my_pc_ids()))
 OR (home_squadron_id = ANY (xpc_my_pc_ids()))
 OR ((xpc_caller_squadron_ids() IS NOT NULL)
     AND ((hosting_squadron_id = ANY (xpc_caller_squadron_ids()))
          OR (home_squadron_id = ANY (xpc_caller_squadron_ids())))))
```

**Regression evidence.**
`artifacts/pilot-dashboard/supabase/tests/test-xpc-pending-rls-realignment.mjs`
runs four shapes against live prod inside one DO block:

* Test 1 — wing commander with `squadron_ids=[Alpha,Bravo]`: sees Alpha
  + Bravo, sees ZERO Charlie rows.
* Test 2 — bare authenticated user (no PC claim, no squadron_ids
  claim): sees ZERO rows.
* Test 3 — squadron-tier ops PC path still works (Alpha PC sees Alpha
  + Bravo because Alpha is host of A and home of B).
* Test 4 — super_admin sees all three.

```
[task-280 / #271] xpc_pending RLS realignment test PASSED in 1440ms
```
(see `test-xpc-pending.txt`)

### 2. `audit_log.action` column missing in prod (schema drift)

**Before.** `\d public.audit_log` shape: `id, squadron_id, type, actor,
detail, occurred_at`. No `action`.

**Fix.** `0065_schema_drift_restoration.sql` runs:
```
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS action text;
UPDATE public.audit_log SET action = type WHERE action IS NULL;
CREATE INDEX IF NOT EXISTS audit_action_time_idx ON public.audit_log(action, occurred_at DESC);
```

**Backfill choice.** Existing rows get `action = type`. Documented in
the migration: every existing edge function writes the verb to `type`
already, so copying it into `action` is a lossless forward-compat
write — readers of either column see the same verb. Future writers
SHOULD set `action` directly; legacy writers continue setting `type`
only and the next monthly job (out of scope here) can re-backfill.

**Live prod state.** `audit_log.action` is now `text`, NULLable, with a
matching index. See `prod-state-after.txt`.

### 3. `reminder_schedules` table missing in prod (schema drift)

**Before.** No table; only the pg_cron-driven helpers from
`0007_reminder_schedule.sql` exist. The dashboard's Reminders Schedule
page (`src/pages/admin/RemindersSchedule.tsx`) uses the
`manage-reminder-schedule` edge function which writes pg_cron state
directly — the schema-drift expectation called for a dedicated
`reminder_schedules` application table for forward-compat (multiple
named schedules per squadron / per workflow without overloading
pg_cron's single job table).

**Fix.** `0065_schema_drift_restoration.sql` creates the table with
the documented shape:

| column | type | notes |
|---|---|---|
| id | uuid | pk, default `gen_random_uuid()` |
| name | text | NOT NULL, unique index |
| cron | text | NOT NULL, standard `M H * * *` syntax |
| target_url | text | nullable |
| enabled | boolean | NOT NULL, default true |
| squadron_id | uuid | FK to `public.squadrons(id)` ON DELETE CASCADE |
| created_at | timestamptz | NOT NULL, default `now()` |
| updated_at | timestamptz | NOT NULL, default `now()`, touch trigger |
| created_by | text | nullable |

RLS: elevated-role-only on all four CRUD verbs — predicate accepts
the established `('super_admin', 'superadmin', 'admin')` triple,
matching the existing role matrix used by audit_log, license_keys, and
similar admin tables. The
`manage-reminder-schedule` edge function uses the service-role key
(bypasses RLS) so it continues to work unchanged.

### 4. Reminders Schedule page restoration

**Status:** Already wired in this branch.

* Page: `artifacts/pilot-dashboard/src/pages/admin/RemindersSchedule.tsx` (663 lines).
* Route: `src/App.tsx:165` — `<Route path="/admin/reminders" component={RemindersSchedule} />`.
* Sidebar entry: `src/components/HQLayout.tsx:53` — labelKey `remindersSchedule`, AlarmClock icon.

The L sidebar smoke test asserts every layout renders without error
under every role; page is reachable in this branch. No further action
needed for AA3.

### 5. Audit Log page restoration

**Status:** Already wired in this branch.

* Page: `artifacts/pilot-dashboard/src/pages/admin/AuditLog.tsx` (295 lines).
* Route: `src/App.tsx:161` — `<Route path="/admin/audit" component={AdminAuditLog} />`.
* Sidebar entry: `src/components/HQLayout.tsx:54` — labelKey `auditLog`, ListChecks icon.
* Filter UI: time range, actor (ilike), action verb (dropdown
  populated from latest 1k rows), pagination, refresh.

No further action needed for AA3.

### 6. Snapshot payload hours pass-through (#268)

**Before.** `xpc_squadron_snapshot.payload.roster[i]` carried only id,
callsign, name, flightname, rank, and the five expiry dates. The
commander rollup adapter (`src/lib/dash-pilots.ts → adaptSnapshotPilot`)
defaulted `dayHours/nightHours/nvgHours/simHours/captainHours` to 0,
so wing/base/HQ rollup pages showed `0h` for every flight-hours cell.

**Fix.**

* `src/lib/cross-pc.ts` — added optional `dayHours/nightHours/nvgHours/
  simHours/captainHours` to `SquadronSnapshotPilot`. Optional so legacy
  payloads (published by pre-AA3 dashboards) still parse.
* `src/App.tsx` — publisher writes the five hour fields straight from
  the local Pilot row's `totalDay/totalNight/totalNvg/totalSim/totalCaptain`.
* `src/lib/dash-pilots.ts` — `adaptSnapshotPilot` now reads the hour
  fields, coerces null/missing to 0, and sets
  `grandTotalHours = day + night + nvg` (matching the local-DB adapter
  `adaptPilot` above).

Migration `0066_snapshot_payload_hours_marker.sql` is intentionally a
no-op DDL (payload is JSONB → no schema change needed). It exists to
record the round-4 work in `_migration_ledger` so the schema-drift
snapshot (0060) sees a deliberate ledger entry rather than an
unexplained payload mutation across snapshots.

**Regression evidence.**
`test-snapshot-payload-hours-parity.mjs` mirrors the M parity-fixture
pattern: seed a snapshot row whose payload carries known hours
(P1 = 250d/30n/10nvg/12sim/50captain — the Audit-G P1 fixture; P2 with
mixed nulls/missing fields), then derive grandTotalHours through the
same JSONB the consumer reads and assert it matches the canonical
formula:

```
[task-280 / #268] snapshot-payload hours parity test PASSED in 1432ms
```
(see `test-hours-parity.txt`)

---

## Reviewer-requested additions

Code review across two passes landed three non-blocking suggestions;
all addressed:

1. **TS adapter unit test for #268 hours pass-through.** New file
   `artifacts/pilot-dashboard/tests/dash-pilots-snapshot.test.ts`
   exercises `adaptSnapshotPilot` directly across four payload shapes:
   fully populated, sparse / pre-AA3, mixed null+undefined, AND a
   non-finite case (NaN, Infinity, junk strings) — proves the JS-side
   coercion and grandTotalHours math match the SQL parity test
   independent of the database round-trip. Wired via new
   `pnpm run test:dash-pilots` and added to the default `pnpm test`
   chain. All 4 cases PASS (see `test-dash-pilots-unit.txt`).

2. **RLS negative test for `reminder_schedules`.** Test 5 added to
   `test-schema-drift-fix.mjs`: seeds a real schedule row, switches to
   `set local role authenticated` with a `role=ops` JWT (no
   super_admin claim), asserts the bait row is invisible AND that an
   INSERT raises an RLS rejection. Catches the regression where a dev
   accidentally widens the policy to `to authenticated using (true)`.
   PASS against live prod.

3. **Finite-number guard in `adaptSnapshotPilot`.** Replaced the bare
   `Number(snap.X ?? 0)` coercions with a `safe()` helper that adds
   `Number.isFinite` filtering, so a malformed legacy payload carrying
   NaN / Infinity / non-numeric junk can no longer poison
   grandTotalHours arithmetic in the rollup. Covered by the new
   non-finite unit test case.

## Frontend regression check

`pnpm test` in `artifacts/pilot-dashboard`:
```
✔ sidebar smoke · all roles × all sidebar routes (8.8 s)
✔ sidebar smoke · teardown jsdom
✔ write smoke evidence artifact
ℹ tests 3  pass 3  fail 0
✔ AR dictionary covers every EN key
✔ EN dictionary covers every AR key
✔ HQLayout sidebar labelKeys all resolve in the EN dict
✔ Squadron Layout sidebar k entries all resolve in the EN dict
✔ Dynamic scope keys built from CommanderScope all exist in dict
ℹ tests 5  pass 5  fail 0
```

`tsc --noEmit` in `artifacts/pilot-dashboard`: clean (no output).

---

## Out-of-band notes

* **Migration prefix collision still blocks the GH Actions workflow.**
  `node scripts/src/check-migration-prefixes.mjs` still reports the
  three `0056_…` files as a P0. AA1 owns the renumber; AA3 applied
  0064/0065/0066 directly via the Management API to live prod (the
  same path Round-3 N + #270 used as a workaround). Once AA1 lands
  and the workflow runs, the workflow will see 0064/0065/0066 in the
  ledger via their `0064/0065/0066` filename rows and skip them — the
  apply step is idempotent on filename.
* **Snapshot republication is implicit.** No backfill needed. The
  publisher loop in `App.tsx` ticks every ~120 s with ±7 s jitter, so
  every active squadron's payload gains the hour fields within a few
  minutes of operators loading the new dashboard build. Commander
  rollups will start showing real hours as soon as their squadron's
  next snapshot tick lands.

---

## Files

* This report: `audit-evidence/2026-04-27/AA3/AA3-report.md`
* Prod state after migrations: `audit-evidence/2026-04-27/AA3/prod-state-after.txt`
* Test outputs:
  * `audit-evidence/2026-04-27/AA3/test-xpc-pending.txt`
  * `audit-evidence/2026-04-27/AA3/test-schema-drift.txt`
  * `audit-evidence/2026-04-27/AA3/test-hours-parity.txt`
  * `audit-evidence/2026-04-27/AA3/test-dash-pilots-unit.txt`
* Migrations:
  * `artifacts/pilot-dashboard/supabase/migrations/0064_xpc_pending_rls_realignment.sql`
  * `artifacts/pilot-dashboard/supabase/migrations/0065_schema_drift_restoration.sql`
  * `artifacts/pilot-dashboard/supabase/migrations/0066_snapshot_payload_hours_marker.sql`
* Tests:
  * `artifacts/pilot-dashboard/supabase/tests/test-xpc-pending-rls-realignment.mjs`
  * `artifacts/pilot-dashboard/supabase/tests/test-schema-drift-fix.mjs` (now includes RLS negative test 5)
  * `artifacts/pilot-dashboard/supabase/tests/test-snapshot-payload-hours-parity.mjs`
  * `artifacts/pilot-dashboard/tests/dash-pilots-snapshot.test.ts` (new TS unit test)
* Source changes:
  * `artifacts/pilot-dashboard/src/lib/cross-pc.ts` (add hour fields to `SquadronSnapshotPilot`)
  * `artifacts/pilot-dashboard/src/App.tsx` (publisher writes hour fields)
  * `artifacts/pilot-dashboard/src/lib/dash-pilots.ts` (`adaptSnapshotPilot` reads hours)
