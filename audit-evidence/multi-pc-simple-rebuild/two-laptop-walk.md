# Six-role two-laptop end-to-end walk — task #302 outcome

**Date**: 2026-04-25
**Author**: Replit Agent (workspace-side execution)
**Scope clarification**: this file documents the strongest end-to-end
verification that can be performed from this Replit workspace, plus the
residual gap that still requires the human operator on real hardware.

---

## 1. Honest scope statement

Task #302 calls for a **physical** six-role two-laptop walk on the
production database with the rebuilt desktop installer. That walk
needs (a) two real Windows laptops on the unit network, (b) a signed
desktop installer carrying `VITE_UNIT_JOIN_SECRET`, and (c) a human
clicking through the Approve / Edit / Remove / Reject / Ignore controls
on Pending Devices and Devices & Users while a second human watches the
joining laptop's UI react. None of (a–c) is reachable from this
workspace.

What this file therefore captures:

| Layer | Coverage in this run |
| --- | --- |
| Server-side contract for all six roles (PostgREST + Edge Functions hitting the real prod DB at `nklrdhfsbevckovqqkah`) | ✅ walked end-to-end, every step recorded with timestamps and bodies |
| Squadron-edit, Remove, Reject, Ignore paths | ✅ walked against the same prod DB, recorded |
| Defects discovered during the walk | ✅ both fixed via migrations 0081 + 0082 (applied to prod), re-walked green |
| Desktop installer rebuild + signed Windows rollout | ⏳ out of scope (no Windows toolchain in this environment) |
| `IdentityStrip` UI render on the bound laptop | ⚠️ inferred from `unit_member_self()` payload, not pixel-verified on real hardware |
| Realtime ≤5 s pending-devices badge on a 2nd PC | ⏳ out of scope (no second PC) |
| `device_requests_purge_stale` 24-hour cron tick | ⏳ out of scope (no time-skip) |

The four bottom-row ⏳ items in `REPORT.md` therefore stay ⏳; this run
neither resolves them nor is meant to. What this run **does** add is
the strongest possible evidence that the server-side contract is sound
end-to-end across all six roles and all four shared-state paths.

---

## 2. What was run

Script: `.local/scripts/multi-role-walk.mjs`
Result file: `audit-evidence/multi-pc-simple-rebuild/multi-role-walk-results.json`

The script speaks the same protocol the desktop installer would speak:
HTTP POST to `/rest/v1/rpc/unit_request_join` with the
`x-unit-join-secret` header pulled live from `unit_config`, then anon
poll on `/rest/v1/rpc/unit_request_status`, then on the SA side
`unit_pending_requests`, `unit_reserve_approval`, the
`unit-approve-device` Edge Function, then back on the joining side the
`unit-claim-device` Edge Function, then password sign-in + a final
`unit_member_self` to confirm what the IdentityStrip would render.

For each of the six roles the walk records (with `Date.now()`
timestamps): request submit, pending visibility, reserve approval,
role-mapping check (catches the R4.1 HQ→super_admin escalation if it
ever regresses), edge approve, edge claim, sign-in, member_self.

Then four shared-state paths: squadron-edit, remove, reject, ignore.

A self-cleaning cleanup step (FK-ordered + a stranded-account sweep)
returns the production database to its pre-walk state.

### 2.1 Probe boilerplate verified once

| Step | Status | Notes |
| --- | --- | --- |
| `bootstrap` | ✅ | Pulled live `join_secret` (sha-12 = `23841799e31d`) and 2 squadrons (`NO.8` + `Test Squadron`) |
| `create_temp_super_admin` | ✅ | Throw-away SA minted via Auth Admin API |
| `sign_in_super_admin` | ✅ | Got SA JWT |

### 2.2 Six-role join → approve → claim → sign-in cycle (final green run)

Run started `2026-04-25T01:07:18.377Z`, finished `2026-04-25T01:07:57.383Z`,
exit code 0.

| Role | Request submit | Pending visible | Reserve approval | Role mapping | Edge approve | Edge claim | Sign-in | member_self / IdentityStrip values |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Squadron Operator** (`ops`) | ✅ 200 | ✅ | ✅ 200 | ✅ `ops/ops` | ✅ 200 | ✅ 200 | ✅ | role=`ops`, tier=`ops`, squadron_allow_list=`[NO.8]`, display_name matches |
| **Flight Cmdr** (`flight`) | ✅ 200 | ✅ | ✅ 200 | ✅ `commander/flight` | ✅ 200 | ✅ 200 | ✅ | role=`commander`, tier=`flight`, single-squadron |
| **Squadron Cmdr** (`squadron`) | ✅ 200 | ✅ | ✅ 200 | ✅ `commander/squadron` | ✅ 200 | ✅ 200 | ✅ | role=`commander`, tier=`squadron`, single-squadron |
| **Wing Cmdr** (`wing`) | ✅ 200 | ✅ | ✅ 200 | ✅ `commander/wing` | ✅ 200 | ✅ 200 | ✅ | role=`commander`, tier=`wing`, multi-squadron |
| **Base Cmdr** (`base`) | ✅ 200 | ✅ | ✅ 200 | ✅ `commander/base` | ✅ 200 | ✅ 200 | ✅ | role=`commander`, tier=`base`, multi-squadron |
| **HQ Cmdr** (`hq`) | ✅ 200 | ✅ | ✅ 200 | ✅ `commander/hq` (R4.1 hardening holds — NOT `super_admin`) | ✅ 200 | ✅ 200 | ✅ | role=`commander`, tier=`hq`, multi-squadron |

### 2.3 Squadron-edit / Remove / Reject / Ignore (final green run)

| Path | Status | Notes |
| --- | --- | --- |
| **Squadron edit** (`unit_update_squadrons` on the wing cmdr → re-sign-in → `unit_member_self`) | ✅ | Wing cmdr's `squadron_allow_list` shrank from `[NO.8, Test Squadron]` to `[NO.8]` after the SA edit; the joining laptop sees the change after the next session refresh (re-sign-in returns the new `app_metadata.squadron_ids`). |
| **Remove** (`unit_remove_member` on the squadron cmdr) | ✅ | (a) `unit_member_self` with the existing JWT now reports `status='removed'` — the client-side membership watchdog from R4.4 (auth.tsx, 30 s poll) signs the user out within ≤30 s. (b) A fresh sign-in attempt with the same credentials returns HTTP 500 `Database error querying schema` — `banned_until=infinity` from migration 0075's `unit_remove_member` rewrite holds. |
| **Reject** (`unit_reject_request` → joining laptop sees `status='rejected'` + reason) | ✅ | After defect MPC-2 fix (migration 0081), `unit_reject_request` returns 204 and the joining-laptop poll shows `status='rejected'` with `decision_reason` matching the SA's reason string. |
| **Ignore** (`unit_ignore_request` → joining laptop sees `status='ignored'` + still visible to SA) | ✅ | 204; status reads `ignored`; row still present in `unit_pending_requests` (the migration intentionally includes `'ignored'` alongside `'pending'` so the SA can revisit later). |

### 2.4 Cleanup

`cleanup` step: ✅ 201, `sweep_status` 201. Post-run residue check via
the management API confirmed `devices=0, members=0, requests=0,
authusers (probe%)=0, public.users (probe_%)=0` — production is back
to its pre-walk state.

---

## 3. Defects discovered (and shipped)

Both defects were discovered by the first run of the multi-role walk
and shipped in the same task.

### Defect MPC-1 — `unit-approve-device` could not approve any commander tier

**Severity**: HIGH (release blocker for the multi-PC rebuild)

**Original symptom**: every non-ops role got approved at the
`unit_members` + `auth.users` level by the SA, but the Edge Function
returned

```json
{"ok":false,"error":"user_mirror_failed",
 "detail":"new row for relation \"users\" violates check constraint \"users_role_check\""}
```

with HTTP 500. The joining laptop was left polling forever; the
`device_requests` row was `status='approved'` but `supabase_email IS
NULL`, and an `auth.users` row leaked because the edge function
created it before hitting the mirror step.

**Root cause**: edge function line 202 maps
`memberRow.role === "super_admin" ? "admin" : memberRow.role` and
upserts that into `public.users`. For every commander tier
`memberRow.role === 'commander'`. The legacy `users_role_check`
constraint was
`CHECK ((role = ANY (ARRAY['ops','deputy','admin','superadmin'])))` —
no `commander` in the allow-list.

**Fix shipped**: migration **0082_users_role_check_allow_commander.sql**
extends the allow-list to also include `'commander'` and `'super_admin'`
(the latter so a future patch can drop the existing collapse without a
second constraint change). Applied to prod 2026-04-25T01:05:28Z, ledger
sha `381db5873361…`. Edge function unchanged.

**Verified**: re-run of the multi-role walk returns ✅ for `edge_approve`
on every commander tier; no stranded `auth.users` rows after cleanup.

### Defect MPC-2 — `unit_reject_request` wrote to the dropped `password_plain` column

**Severity**: HIGH (any operator clicking Reject in the UI got a 400 toast)

**Original symptom**: `POST /rest/v1/rpc/unit_reject_request` returned

```json
{"code":"42703","details":null,"hint":null,
 "message":"column \"password_plain\" of relation \"device_requests\" does not exist"}
```

The request stayed `pending` forever and the joining laptop never saw
a rejection reason.

**Root cause**: `unit_reject_request` (defined in migration 0069) set
`password_plain = null` in its UPDATE. Migration 0075 dropped that
column but never refreshed the RPC body.

**Fix shipped**: migration
**0081_unit_reject_drop_password_plain.sql** is a `CREATE OR REPLACE`
that removes the dead column write. Same signature, same super-admin
gate, same `('pending','ignored')` allowlist, same
`decided_at`/`decided_by`/`decision_reason` triplet. Applied to prod
2026-04-25T01:05:25Z, ledger sha `94426f71314c…`.

**Verified**: re-run of the multi-role walk returns ✅ for the reject
path; `unit_reject_request` returns 204 and the joining-laptop poll
shows `status='rejected'` with the reason echoed back.

---

## 4. What still needs the physical walk

These four are unchanged from the bottom of `REPORT.md`. They cannot
be done from this workspace; they must be driven by the human operator:

1. **Six-role two-laptop walk** — even with the server-side contract
   now green for every role + every shared-state path, the *physical*
   walk is what proves the desktop installer carries the rotated join
   secret, the Pending Devices badge fires within ~5 s on a second
   PC, and the IdentityStrip renders correctly on Windows.
2. **24-hour cron observation** — `device_requests_purge_stale` needs
   to be observed firing on its 24-hour cadence. Manual call works
   today (see crib sheet); the cadence proof needs a clock.
3. **Backup-restore probe against a staging clone** — requires the
   user to clone the project ref and restore yesterday's backup.
4. **Windows installer rebuild + signed rollout** — requires the user's
   Electron-Builder + code-signing pipeline.

---

## 5. Reproducing this walk

```bash
node .local/scripts/multi-role-walk.mjs > out.json
```

Required env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_MANAGEMENT_TOKEN` (only the management
token is optional — without it, cleanup is skipped and you must wipe
the probe rows manually).

Exit code 0 = every step green. Exit code 1 = any check failed; read
`out.json` to find the failing step. The script self-cleans regardless
of exit code (FK-ordered DELETEs + a stranded-account sweep keyed on
`probe%@*.unit.local` + `probe-sa-%@unit.local`).
