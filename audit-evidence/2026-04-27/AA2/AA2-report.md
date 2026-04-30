# Round 4 AA2 — Redeploy `provision-commander` (P-1 critical fix)

**Project:** prod Supabase `nklrdhfsbevckovqqkah`
**Parent spec:** `audit-evidence/2026-04-27/MASTER-GO-NO-GO.md` + Audit P (#264) defect P-1
**Sibling tasks:** AA1, AA3, AA4, AA-Z
**Migration prefixes used:** none — this task is deployment-only.
**Status:** ✅ FIXED — `provision-commander` now version 5 with the role guard live; deputy escalation rejected with 403; zero `AUD_FIX_AA2_*` residue in prod; nine other edge functions also brought back in sync.

---

## 0. Summary table

| Topic | Before | After |
|---|---|---|
| `provision-commander` deployed version | 4 | **5** |
| `provision-commander` Supabase `verify_jwt` flag | `false` | **`true`** |
| `provision-commander` `ezbr_sha256` | `d161…0e6a735` | `2477…0258ec3` |
| Deputy minting a commander | 200 OK, new auth user | **403 `forbidden`** |
| No-auth POST to `provision-commander` | 200 OK, new auth user | **401 `Missing authorization header`** |
| `heal-claims` deployment | not deployed (404) | **version 1, ACTIVE, `verify_jwt=true`** |
| Edge functions with `verify_jwt` drift | 4 (`link-pilot-device`, `manage-reminder-schedule`, `notify-currency-expiry`, `provision-user`) | **0** |
| Edge functions with stale source bundles | 9 (see sweep table below) | **0** |
| `AUD_FIX_AA2_*` rows in prod | 0 (created + cleaned in this run) | **0** |

---

## 1. Pre-flight — source has the role guard

`artifacts/pilot-dashboard/supabase/functions/provision-commander/index.ts` lines 99–103:

```ts
const callerRole = (callerUser.app_metadata?.role as string | undefined) ?? "";
const allowedRoles = ["ops", "admin"];
if (!allowedRoles.includes(callerRole)) {
  return reply({ ok: false, error: "forbidden" }, 403);
}
```

`artifacts/pilot-dashboard/supabase/config.toml`:

```toml
[functions.provision-commander]
verify_jwt = true
```

Source is correct. The defect is purely a deploy gap.

---

## 2. Step 1 — live "before" state captured

Evidence: `before.json`.

```text
slug:            provision-commander
version:         4
status:          ACTIVE
verify_jwt:      false       ← Supabase will not pre-validate JWT
ezbr_sha256:     d1613313b6a677f855983756578fad32dcee8be7e17e78aeb013b54470e6a735
body_sha256:     e7b2b514b0dd3c301d60b63ef9c0f245d2f647500a790d27a6f04562117a80be
body_size:       227176 bytes
created_at:      1776515973833 (2026-04-19)
updated_at:      1776515973833 (2026-04-19) — never re-deployed
```

The deployed eszip body was downloaded and inspected. The deployed source has **no `allowedRoles` check, no caller JWT verification, no auth header inspection at all** — `Deno.serve` jumps straight to `body = await req.json()`. Confirmed Audit P P-1 finding.

In-line probes inside Step 1 (no-auth and anon-bearer) **both returned HTTP 200** and minted real auth users:
- `aa2-probe-noauth-should-never-exist@0.rjaf.local` → id `b70255e6-2cd1-41ec-ac1b-5307323985d8`
- `aa2-probe-anon-should-never-exist@0.rjaf.local`  → id `8e2f6335-c357-4b64-aef5-1adcdaf147ee`

Both were torn down in Step 6.

---

## 3. Step 2 — exploit reproduced with a deputy JWT

Evidence: `exploit-before.json`, `state.json`.

1. Provisioned `aud-fix-aa2-deputy@aa2.rjaf.local` (id `9c8415cd-9c13-4a9b-b421-618f87838fac`) via service-role with `app_metadata.role = "deputy"`. (No use of the broken function.)
2. Signed in via `signInWithPassword` → received a real Supabase user JWT (length 939).
3. Sent the deputy JWT to `POST {SUPABASE_URL}/functions/v1/provision-commander` with body:

```json
{
  "username": "aud_fix_aa2_exploit_commander",
  "displayName": "AUD_FIX_AA2 exploit commander",
  "role": "commander",
  "tier": "squadron",
  "squadronNumber": "0",
  "squadronName": "AUD_FIX_AA2 PROBE SQN",
  "squadronBase": "AUD_FIX_AA2 BASE"
}
```

4. **Response:** HTTP **200**

```json
{
  "ok": true,
  "userId": "e583ee52-2765-4a2d-8031-7f2b1d69fc78",
  "supabaseEmail": "aud_fix_aa2_exploit_commander@0.rjaf.local",
  "supabasePassword": "<random>"
}
```

**P-1 is LIVE in production.** A deputy JWT successfully minted an admin-tier auth account.

5. The minted commander auth user was deleted inline in this same step (verified in `exploit-before.json.mintedCommander.deletedImmediatelyByThisStep == true`). The `AUD_FIX_AA2 PROBE SQN` squadrons row and `users` row were also deleted inline.

---

## 4. Step 3 — redeploy via Management API

Evidence: `after.json`.

`POST https://api.supabase.com/v1/projects/nklrdhfsbevckovqqkah/functions/deploy?slug=provision-commander`
- multipart/form-data
- `metadata` part: `{"name":"provision-commander","verify_jwt":true,"entrypoint_path":"index.ts"}` — `verify_jwt` was read from `supabase/config.toml` so the bootstrap functions (`register-license`, `super-admin-2fa`, `validate-license`) cannot accidentally inherit `verify_jwt=true`.
- `file` part: the literal contents of `artifacts/pilot-dashboard/supabase/functions/provision-commander/index.ts`.

Deploy returned **HTTP 201**, polled `GET /functions/provision-commander` until `status === "ACTIVE"`:

```text
slug:            provision-commander
version:         5             (was 4)
status:          ACTIVE
verify_jwt:      true          (was false — runtime now pre-validates JWTs)
ezbr_sha256:     247747e87fc61ea0f777eb9dfb10f642397ae147a231a1607347cfe8b0258ec3 (was d161…)
body_sha256:     1a925ad515681913449c269d3f4d228306020d306ecb89473cf1c9dd3d57e9a8
body_size:       freshly-built eszip
updated_at:      1777061297208
source_has_role_guard_marker: true   (the deployed body now contains "allowedRoles" / "forbidden")
```

---

## 5. Step 4 — re-run the exploit

Evidence: `exploit-after.json`.

Same deputy auth user, same body, three probes:

| Probe | Status | Body |
|---|---|---|
| `deputy_jwt_requesting_commander` | **403** | `{ "ok": false, "error": "forbidden" }` |
| `no_auth_at_all`                   | **401** | `{ "code": "UNAUTHORIZED_NO_AUTH_HEADER", "message": "Missing authorization header" }` |
| `anon_bearer`                      | **401** | `{ "code": "UNAUTHORIZED_INVALID_JWT_FORMAT", "message": "Invalid JWT" }` |

Defensive sweep of `auth.users` for `aud_fix_aa2_after_*` post-attempt: **0 leaked users**. The 401 responses come from the Supabase edge-runtime gate (proof that `verify_jwt=true` is now in effect); the 403 comes from the in-handler `allowedRoles` guard (proof the source matches what's deployed).

**P-1 fully resolved.**

---

## 6. Step 5 — drift sweep across all edge functions

Evidence: `edge-fn-drift.json`, `edge-fn-drift-before.json`, plus `after-<slug>.json` for every redeploy.

### 6.1 Method

For every function listed in the task spec plus the rest declared in `supabase/config.toml`, the deployed eszip body was downloaded and compared against local source by:
1. Normalising both texts (collapse whitespace, commas, semicolons).
2. For each non-trivial source line (>= 25 chars after normalisation; TypeScript-only syntax such as union types and type assertions skipped because they are stripped by Deno's transpiler), checking for verbatim occurrence in the normalised deployed body.
3. Flagging drift if fewer than **90 %** of source lines appeared in the deployed body, OR if `meta.verify_jwt` differed from `config.toml`.

The first invocation used a stricter sentinel-only check that produced false positives; the redeploys it triggered were nevertheless legitimate fixes for `verify_jwt` drift and version lag (see column "First-pass action" below). The script was then revised to use the ratio approach above and re-run for the final clean matrix.

### 6.2 Drift sweep matrix

| Slug | Pre-sweep version | Pre-sweep `verify_jwt` (deployed/config) | First-pass action | Post-sweep version | Post-sweep `verify_jwt` (deployed/config) | Final state |
|---|---|---|---|---|---|---|
| `provision-commander`     | 4  | false / true  | redeployed in Step 3 | 5  | true / true  | clean |
| `register-license`        | 5  | false / false | redeployed (sentinel false-positive, but version-bumped harmlessly) | 6  | false / false | clean |
| `heal-claims`             | (404 — never deployed) | — / true | redeployed in second pass | 1  | true / true  | clean (newly deployed) |
| `link-pilot-device`       | 14 | **false / true** ← real `verify_jwt` drift | redeployed | 15 | true / true  | clean |
| `super-admin-2fa`         | 6  | false / false | redeployed (sentinel false-positive, harmless) | 7  | false / false | clean |
| `manage-reminder-schedule`| 5  | **false / true** ← real `verify_jwt` drift | redeployed | 6  | true / true  | clean |
| `notify-currency-expiry`  | 5  | **false / true** ← real `verify_jwt` drift | redeployed | 6  | true / true  | clean |
| `notify-alert`            | 2  | true / true   | redeployed (sentinel false-positive, harmless) | 3  | true / true  | clean |
| `notify-notam`            | 2  | true / true   | redeployed (sentinel false-positive, harmless) | 3  | true / true  | clean |
| `provision-user`          | 5  | **false / true** ← real `verify_jwt` drift | redeployed | 6  | true / true  | clean |
| `validate-license`        | 5  | false / false | redeployed (sentinel false-positive, harmless) | 6  | false / false | clean |

**Real defects fixed by the sweep (in addition to P-1):**

- **`heal-claims` was not deployed at all** — local source is in `artifacts/pilot-dashboard/supabase/functions/heal-claims/index.ts` and configured for `verify_jwt=true`, but the prod project had no function with that slug (Management API returned 404). Now deployed as version 1.
- **Four functions had `verify_jwt` drift** (`link-pilot-device`, `manage-reminder-schedule`, `notify-currency-expiry`, `provision-user`): the deployed config had `verify_jwt=false`, but `config.toml` requires `verify_jwt=true`. This means callers without a valid Supabase user JWT could reach those handlers and rely solely on each handler's own role enforcement (which is real but not defence-in-depth). Now `true` everywhere they should be.

After the sweep the post-sweep matrix shows every function `drifted=false` and `verify_jwt_drift=false`. See `edge-fn-drift.json.conclusion`:

> "CLEAN — every swept function matches its source on main and has the configured verify_jwt setting."

---

## 7. Step 6 — teardown

Evidence: `teardown.json`.

```text
deletedAuthUsers:
  - 9c8415cd-9c13-4a9b-b421-618f87838fac (aud-fix-aa2-deputy@aa2.rjaf.local)
  - 8e2f6335-c357-4b64-aef5-1adcdaf147ee (aa2-probe-anon-should-never-exist@0.rjaf.local)
  - b70255e6-2cd1-41ec-ac1b-5307323985d8 (aa2-probe-noauth-should-never-exist@0.rjaf.local)
deletedSquadrons:        1   (the lingering "PROBE" / "AUD_FIX_AA2 PROBE SQN" row)
deletedUsersTableRows:   0   (the broken v4 only upserted users when squadron_id was set)
deletedAuditLogRows:     0   (the broken v4 deployed bundle did not have the audit_log insert at the end)

residue.auth_users_remaining:                []
residue.squadrons_remaining:                 []
residue.users_remaining:                     []
residue.audit_log_provision_remaining:       []

cleanResidue: true
```

The Step-2 minted commander (`e583ee52-2765-4a2d-8031-7f2b1d69fc78`) was already deleted inline by Step 2; the residue probe confirms it is also absent from `auth.users`, `users`, and `audit_log`.

---

## 8. Step 7 — git mirror

This file is the git mirror.
- `audit-evidence/2026-04-27/AA2/before.json` — Management-API metadata + body sha256 + role-guard probes for the live v4 bundle.
- `audit-evidence/2026-04-27/AA2/exploit-before.json` — the deputy successfully minting a commander.
- `audit-evidence/2026-04-27/AA2/after.json` — Management-API metadata + body sha256 for the freshly-deployed v5 bundle.
- `audit-evidence/2026-04-27/AA2/exploit-after.json` — the same exploit request now rejected with 403.
- `audit-evidence/2026-04-27/AA2/edge-fn-drift-before.json` — pre-sweep drift matrix for all eleven edge functions.
- `audit-evidence/2026-04-27/AA2/edge-fn-drift.json` — full before / sweep-redeploys / after matrix for the drift sweep.
- `audit-evidence/2026-04-27/AA2/after-<slug>.json` — per-function post-deploy metadata for every function the sweep redeployed.
- `audit-evidence/2026-04-27/AA2/teardown.json` — auth-user / squadrons / users / audit_log cleanup + residue probe.
- `audit-evidence/2026-04-27/AA2/state.json` — IDs of the deputy and the probe-created users (password redacted; auth users no longer exist).

Helper scripts (re-runnable, all read env from `process.env`):
- `.local/scripts/audit-aa2/01-before.mjs`
- `.local/scripts/audit-aa2/02-exploit-before.mjs`
- `.local/scripts/audit-aa2/03-redeploy.mjs <slug>`  — generic; reads `verify_jwt` from `config.toml`
- `.local/scripts/audit-aa2/04-exploit-after.mjs`
- `.local/scripts/audit-aa2/05-drift-sweep.mjs`
- `.local/scripts/audit-aa2/06-teardown.mjs`

---

## 9. Done-looks-like checklist (from task)

- [x] `provision-commander` version in prod ≥ source version on main; code matches (deployed body contains `"allowedRoles"` and `"forbidden"`; `source_has_role_guard_marker = true`).
- [x] The exploit POST returns the expected rejection in the AFTER run (403 `forbidden` for deputy; 401 for no-auth and anon-bearer); saved in `exploit-after.json`.
- [x] All other edge functions either match source OR have been redeployed in this task (see drift sweep table; final state CLEAN; nine other redeploys recorded).
- [x] Zero `AUD_FIX_AA2_*` residue in prod (`teardown.json.cleanResidue == true`).
- [x] `audit-evidence/2026-04-27/AA2/AA2-report.md` in git (this file).

## 10. Out of scope (untouched)

- No source-code changes to any edge function.
- No work in AA1, AA3, AA4, AA-Z.
- No new migrations.
