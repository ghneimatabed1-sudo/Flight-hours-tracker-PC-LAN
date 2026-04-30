# Hotfix v1.1.123 — Join Secret in Installer

**Date:** 2026-04-25
**Task:** #311
**Author:** Replit Agent
**Verdict:** SHIPPED — release `v1.1.123` published, asar bundle verified to contain the join secret.

---

## What broke

v1.1.122 (released earlier today by Task #310) bricked every fresh install:

- New PCs landed on **Pilot Hours Dashboard / "Welcome to your unit's logbook."**
- Both buttons — **"Set up this unit's super admin"** and **"Request to join this unit"** — rendered disabled.
- The red banner read: *"Cloud not reachable from this PC, or this build wasn't issued with a join secret. Both setup and join are disabled."*
- Users could not progress past the welcome screen — i.e. the install was unusable.

## Why it broke (root cause)

Two-part regression spanning two prior tasks:

1. **Task #299** introduced a new client-side gate on `import.meta.env.VITE_UNIT_JOIN_SECRET`:
   - `artifacts/pilot-dashboard/src/lib/unit-join.ts:29` reads it.
   - Line 509: `unitJoinConfigured = Boolean(SUPABASE_URL && ANON_KEY && JOIN_SECRET)` returns `false` when the secret is empty.
   - `artifacts/pilot-dashboard/src/pages/FirstLaunch.tsx:36-39` short-circuits to `cloud.kind = "offline"` whenever `unitJoinConfigured` is `false`, which disables both buttons.

2. **`.github/workflows/dashboard-windows-installer.yml`** was last meaningfully edited by Task #131 (commit `6d340fd`), well **before** Task #299 added the secret. The workflow's `Vite build (renderer)` step never injected `VITE_UNIT_JOIN_SECRET` into the build env, so every installer built since #299 — including v1.1.122 — baked an empty string into the bundle.

The repo Actions secret `VITE_UNIT_JOIN_SECRET` was also missing from GitHub entirely.

## What was changed (the two-part fix)

### Part 1 — Workflow YAML (`.github/workflows/dashboard-windows-installer.yml`)

- **Inject the secret into the renderer build env** (added inside the `Vite build (renderer)` step's `env:` block, alongside the existing Supabase / api-server env vars):
  ```yaml
  VITE_UNIT_JOIN_SECRET: ${{ secrets.VITE_UNIT_JOIN_SECRET }}
  ```
- **New tripwire step `Verify VITE_UNIT_JOIN_SECRET was injected`** that hard-fails the build (with `::error::`) if the secret is empty at build time. Length-only check — never echoes the secret. Mirrors the existing pattern used for `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_SERVER_URL`.
- Comment block above the env line documents exactly what bricked, so the next reader can't accidentally remove it.

These two lines together make it physically impossible to ship another bricked-on-FirstLaunch build: either the secret is present and gets baked in, or the build hard-fails at the verifier step.

### Part 2 — GitHub repo Actions secret

- `VITE_UNIT_JOIN_SECRET` added to `Settings → Secrets and variables → Actions` on `ghneimatabed1-sudo/Flight-hours-tracker-PC` via the GitHub REST API (sealed-box encrypted with the repo's libsodium public key, `PUT /actions/secrets/VITE_UNIT_JOIN_SECRET` returned 201). Updated 2026-04-25T03:18:07Z. Canonical value sourced live from prod `unit_config.join_secret` (the post-rotation value from migration 0076 — **NOT** the leaked predecessor value).
- Confirmed present in the secrets list at task close: 10 secrets total, including `VITE_UNIT_JOIN_SECRET` alongside `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_SERVER_URL`, `RELEASES_PAT`, `INSTALL_PASSWORD`, etc.

## Push & build evidence

| Item | Value |
| --- | --- |
| Local commit (workflow edit) | `d806242` (`Add critical join secret for Windows installer to prevent installation failures`) |
| Push merge commit | `24005da` (`Merge github/main into local main before hotfix v1.1.123 push`) — required because a parallel session had already pushed three duplicate-content commits to `github/main` while the local edit was being prepared; tree-equality verified before merge so the merge was a clean no-conflict fast-merge |
| Push target | `github/main` on `ghneimatabed1-sudo/Flight-hours-tracker-PC` |
| Push result | `0d3104f..24005da  main -> main` |
| Workflow run id | `24921471109` |
| Workflow run number | `228` |
| Workflow run URL | https://github.com/ghneimatabed1-sudo/Flight-hours-tracker-PC/actions/runs/24921471109 |
| Workflow created | 2026-04-25T03:25:17Z |
| Workflow finished | 2026-04-25T03:28:44Z |
| Workflow duration | 207 s (≈3m27s — well under the expected 8–14 min thanks to the electron-builder cache hitting and not re-downloading nsis/winCodeSign) |
| Workflow conclusion | `success` |
| Verifier step | `Verify VITE_UNIT_JOIN_SECRET was injected` — passed (length check non-zero) |

## Release evidence

| Item | Value |
| --- | --- |
| Release repo | `ghneimatabed1-sudo/Flight-hours-tracker-Releases` |
| Tag | `v1.1.123` |
| Release name | `1.1.123` |
| Published at | 2026-04-25T03:28:30Z |
| Release URL | https://github.com/ghneimatabed1-sudo/Flight-hours-tracker-Releases/releases/tag/v1.1.123 |
| `HawkEye-Setup-1.1.123.exe` size | 92,916,176 bytes (~89 MiB) |
| `HawkEye-Setup-1.1.123.exe.blockmap` size | 98,642 bytes |
| `latest.yml` size | 348 bytes |
| `HawkEye-Setup-1.1.123.exe` sha256 | `702c7cf45c309656a50b8887b136717f49c4b6210c5e830ef92ce4040b12a2ae` |

The version `1.1.123` was assigned by the workflow's existing `Auto-bump patch version above latest published release` step (introduced commit `9ff5547`); the source `package.json` still reads `1.1.109`, but the previous live release was `v1.1.122` so the auto-bump produced `v1.1.123`. No manual version bump was required and `package.json` was not edited locally.

## Bundle verification (the actual proof the fix worked)

Process:

1. Downloaded `HawkEye-Setup-1.1.123.exe` from the public Releases repo.
2. Extracted the outer NSIS container with `7z` (provisioned via `nix-shell -p p7zip`).
3. Extracted the inner `app-64.7z` payload to recover `app.asar` (≈84 MB).
4. Used `@electron/asar`'s Node API to extract the renderer bundle `dist/public/assets/index-mLXOIi9o.js` (3,301,734 bytes).
5. Searched the bundle for the first 8 hex chars of the prod join secret (`891f5ea5`).

Result:

- `grep -c` → exactly **1 hit** in the renderer bundle (single occurrence is correct: `unit-join.ts` is the only consumer, and Vite inlines the env value at one place).
- The surrounding context (with the secret itself REDACTED) reads:
  ```
  kah.supabase.co",VITE_UNIT_JOIN_SECRET:"[891f5ea5...REDACTED]
  ```
  — i.e. Vite's `import.meta.env` rewrite produced the literal `VITE_UNIT_JOIN_SECRET:"<value>"` adjacent to the previously-injected `VITE_SUPABASE_URL` host (`...kah.supabase.co`), inside the inlined env object.

The renderer that ships in v1.1.123 therefore has a non-empty `JOIN_SECRET`, so `unitJoinConfigured` evaluates to `true`, and `FirstLaunch.tsx` will render with both buttons enabled (subject to the normal `checkSuperAdminExists` / `listSquadronsForJoin` cloud probes).

**The full secret value was never printed to any log, commit message, or this report.** Only the first 8 chars (`891f5ea5`) were used as a fingerprint for grep, matching the explicit task allowance.

## What this means for installed PCs

- Existing PCs already on v1.1.122 (the bricked build) auto-update via `electron-updater`'s background poll of the public Releases repo. They will detect `v1.1.123 > v1.1.122`, download `HawkEye-Setup-1.1.123.exe`, and prompt the user to relaunch. After relaunch, FirstLaunch will work normally.
- Any PC that was being freshly installed today and got stuck on the bricked welcome screen can simply re-download the installer from the release page (link above) and re-run it; the new installer will carry the secret, so FirstLaunch will progress past the welcome screen.
- The prod database was not touched. The join secret in `unit_config.join_secret` remains the value rotated under migration 0076 — i.e. the value matches the one now baked into v1.1.123, so the `_unit_join_secret_ok()` server-side check will accept calls from v1.1.123 PCs immediately.

## Constraints honoured

- ✅ Did not print the join secret value anywhere (only the first 8 hex chars `891f5ea5` as a fingerprint, with explicit task allowance).
- ✅ Did not touch any database migration; the prod `unit_config.join_secret` row is untouched.
- ✅ Did not run `db:push`, Drizzle, or any schema-sync command.
- ✅ Did not change the version number manually; the workflow's auto-bump step assigned `v1.1.123`.
- ✅ Did not create or restart any local dev workflow; the local `pilot-dashboard`, `api-server`, `mockup-sandbox`, and `pilot-mobile` workflows are irrelevant to this hotfix and were left alone.
- ✅ Did not touch any other workflow file.
- ✅ Did not touch any client code; the bug was purely in the build pipeline.

## Files changed

- `.github/workflows/dashboard-windows-installer.yml` — `+30` lines (env line + verifier step + comment block). Already committed in `d806242` prior to this task; this task pushed it to GitHub.

## New evidence written

- `audit-evidence/hotfix-1.1.123-join-secret/REPORT.md` — this file.
