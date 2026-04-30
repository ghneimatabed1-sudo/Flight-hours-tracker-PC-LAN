# AGENTS.md — READ THIS FIRST

> **You are an AI agent (Replit Agent, Cursor, Claude Code, Aider, Cline, anything).**
> **This file is the 60-second briefing. Read it in full before touching any code.**
> If you skip it, you will repeat bugs that have already cost the operator time.

---

## What this project is

**Hawk Eye** (Arabic: عين الصقر) — flight-hours management system for the **Royal Jordanian Air Force (RJAF)**.
- **In production at NO.8 SQDN, King Abdullah II Airbase.** Real pilots, real sorties, real money.
- **pnpm monorepo** with three artifacts:
  - `artifacts/pilot-dashboard/` — React + Vite + Electron Windows desktop app (the main product, ~95% of complexity).
  - `artifacts/pilot-mobile/` — Expo React Native app for individual pilots.
  - `artifacts/api-server/` — small Express helper.
- **Backend:** Supabase (Postgres + REST + Auth). Project ref derived from `SUPABASE_URL`. Service-role key + Mgmt API token are in env.
- **Releases:** PC `.exe` published automatically by GitHub Actions to the **public** repo `Flight-hours-tracker-Releases`. Installed PCs auto-update by polling that repo. Source repo is `Flight-hours-tracker-PC`.
- **Designed for zero maintenance** across 15-20+ squadrons surviving personnel turnover. Operator wants to never have to babysit it.

## Mandatory reading before any change

1. **`DOMAIN.md`** — what every page, role, report, and number actually means in operational terms (Squadron Cmdr vs Wing Cmdr vs Base Cmdr, Monthly Report Forms 1-4, sortie definition, hour calculation, schedule chain, guest pilots, currency rules). **The functional encyclopedia.**
2. **`replit.md`** — full project overview, brand assets, and the **Domain Logic Memory** protocol.
3. **`.local/memory/README.md`** + the matching file in `.local/memory/` for the area you're touching. **These are the operator's settled rules — never re-decide them, never guess from code alone.**
4. **`.local/HAWK-EYE-OVERNIGHT-MASTER-REPORT.md`** — what was built, every version v1.1.75→present, what the simulation harness covers.

## Absolute do-nots (each one has bitten us; don't relearn)

1. **Never test RLS policies with the service-role key.** Service role bypasses RLS, so every test passes and every real user fails. Use the anon key + a real signed-in session, OR use the audit script (below).
2. **Never write an UPDATE/ALL RLS policy without an explicit `WITH CHECK`.** Postgres silently reuses `USING` for the new row → "new row violates row-level security policy" (error 42501) the moment any UPDATE changes a column referenced by USING. Real bug, v1.1.89, took down all schedule-forwarding for every role. Default to `with check (true)` and let application code (in `src/lib/cross-pc.ts`) gate transitions.
3. **Never use `psql "$DATABASE_URL"` for migrations.** `DATABASE_URL` points to the Replit-local Postgres, NOT Supabase. **Apply migrations via the Supabase Management API:**
   ```js
   const REF = process.env.SUPABASE_URL.match(/https:\/\/([^.]+)/)[1];
   await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
     method: "POST",
     headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
     body: JSON.stringify({ query: sql })
   });
   ```
4. **Never bump the dashboard version manually expecting it to drive a release.** The CI workflow `dashboard-windows-installer.yml` auto-bumps the patch above the latest published release. Just push to `main` — bump only if you intentionally want a minor/major bump.
5. **Never edit `artifact.toml` or `.replit` directly** — use the artifact skills.
6. **Never hardcode squadron names.** Every operator deploys their own squadron. The system is squadron-portable; preserve that.
7. **Never delete data without an explicit operator request.** Even "looks orphaned" rows might be backups for a PC that's been offline.
8. **Never let `DOMAIN.md` go stale.** It is a contract with the operator. After ANY change that affects what a page does, what a role sees, what a number means, what a report contains, or how a flow works (schedule chain, guest pilots, currency, sortie fields, hour calc, role permissions, menu items, etc.) — open `DOMAIN.md` in the same change, update the affected section, and commit it together with the code. Same applies to `.local/memory/<area>.md` for the area touched. Documentation drift is a bug.

## Safety nets you can run any time

| Command | What it checks |
|---|---|
| `node .local/tests/rls-policy-audit.mjs` | Scans every public.* policy for the WITH-CHECK gap. Exit 0 = safe, 1 = problem, names the table. |
| `node .local/tests/cross-pc-e2e.mjs` | Runs the full Squadron→Wing→Base→HQ chain + messages across the live Supabase. ~30 checks. |
| `node .local/tests/guest-pilot-e2e.mjs` | Hosting Ops → Home Ops guest-pilot handoff (pending → accept/reject/edit/backfill). 8 checks. |
| `pnpm --filter @workspace/pilot-dashboard exec tsx supabase/tests/test-pilot-transfer-rpc.ts` | Inter-squadron pilot transfer via the `transfer_pilot` RPC (migration 0053). Asserts pilot + sorties + currencies/leaves/unavailable/link_codes/devices all re-home, paired audit rows land, authority gate rejects foreign-squadron callers, super-admin works from anywhere, and the UI predicates from `pilot-transfer-policy.ts` (the same module Roster.tsx + PilotDetail.tsx import) still match. 11 checks. |
| `pnpm --filter @workspace/pilot-dashboard exec tsx .local/tests/full-simulation.ts` | 11-surface calculation engine simulation. ~115 checks. |

**After any change that touches RLS, schema, or cross-PC code, re-run the relevant tests above.**

## Architecture in 6 lines

- Each Squadron PC = one Electron app, talks to Supabase with the **anon key** + a Supabase Auth session bound to that PC's claimed `pc_id`s.
- `xpc_my_pc_ids()` returns the array of `pc_id`s the signed-in user owns; every cross-PC RLS policy references it.
- Schedule chain: row in `xpc_schedule_shares` with `current_tier` and `current_pc_id` moves through Squadron → Wing → Base → HQ; statuses: `draft|submitted|reviewed|approved|rejected|held|edited`.
- Messages: `xpc_messages` between any two PCs; archive after 3 months by `purge_archived_messages()`.
- Guest pilots: hosting squadron logs sortie → row in `xpc_pending` with `home_squadron_id` → home Ops sees pending → accepts → hours flow into home pilot's totals via `computePilotTotals()`.
- 4 daily Supabase pg_cron jobs (purge inactive PCs, archived messages, dead link codes, audit log) — see migration `0032_retention_cleanup_jobs.sql`.

## When in doubt

- **Ask the operator** before any destructive action, before changing settled domain rules, or before re-architecting.
- **Speak plain English** in chat (the operator is non-technical). Save jargon for code comments.
- **Update `replit.md`** for architecture changes. **Update or create a `.local/memory/<area>.md`** for any new domain rule the operator settles. **Append to this file** for any new "do not" you learn the hard way.

---

## Memory-update protocol — do this WITHOUT being asked

Every commit that changes behaviour MUST also update memory in the same commit. The operator should never have to say "update your memory". Treat this as part of the work, not a follow-up.

**Checklist before every `git commit`:**
1. Did this change affect what a page does, what a role sees, what a number means, what a report contains, or how a flow works? → Open **`DOMAIN.md`** and update the matching section. Add a "v1.x.xx — what changed" line in the relevant subsection if the contract moved.
2. Did this change settle a new operator-stated rule, fix a previously-mysterious bug, or alter a settled feature? → Open or create **`.local/memory/<area>.md`** and append a Change Log entry with the date.
3. Did this change introduce a new "do not" the next agent must avoid? → Append it to the **Absolute do-nots** list in this file (with the version that introduced the lesson).
4. Did this change touch architecture (new tables, new tiers, new artifacts, new external services)? → Update **`replit.md`** Architecture section.
5. Are migrations involved? → Add the migration number + one-line summary to the **Recent fixes** list below.

**Default commit-message footer template (use it):**
```
DOMAIN.md updated: §X.Y (or N/A — explain why)
.local/memory/<area>.md updated: yes (or N/A — explain why)
AGENTS.md do-nots updated: yes (or N/A — explain why)
```

If any of those four say N/A, that's fine — but you must consciously decide N/A, not silently skip.

---

## Recent fixes — concrete lessons (most recent first)

### LAN session teardown parity (2026-04-26) — Settings actions must follow transport

- `releaseLicense` / `resetThisPC` now end LAN sessions and avoid cloud-registry deletion attempts when LAN mode is active.
- `Settings.tsx` disables the release-license action in LAN mode and explains why.
- `logout` now always clears any cached LAN token locally so shared PCs cannot inherit stale session headers after sign-out.
- **Lesson:** migration parity includes destructive/teardown actions, not only happy-path sign-in and reads.

### LAN startup guard (2026-04-26) — stale cloud join state no longer hijacks login

- In `App.tsx`, LAN session mode is now evaluated before cloud join/waiting routes for unsigned users.
- Stale `joinPending*` localStorage state is cleared in LAN mode so operators always land on LAN login.
- **Lesson:** migration flags must control startup state recovery too, not only route/page visibility.

### LAN migration UX guard (2026-04-26) — Reminders admin surfaces fail closed

- `RemindersSchedule.tsx` and `ReminderLog.tsx` now detect `VITE_LAN_SESSION_LOGIN` and show explicit “cloud-only for now” messaging while disabling refresh/mutation controls.
- Moved those warnings into i18n keys (`lanOnlyReminderSchedule`, `lanOnlyReminderLog`) so Arabic and English operators get the same migration-state message.
- **Lesson:** during staged migration, unsupported surfaces should stay visible but must be operationally honest — never invite actions that cannot succeed on LAN transport.

### LAN route guardrails (2026-04-26) — deep-link cloud setup pages fail closed

- `SuperAdminSetup.tsx` and `JoinSetup.tsx` now short-circuit with LAN-mode notices and direct users to `/login` when `VITE_LAN_SESSION_LOGIN` is enabled.
- **Lesson:** routing defaults are not enough — cloud-only pages must explicitly defend against manual deep links during LAN migration.

### LAN session lifecycle hardening (2026-04-26) — idle/logout paths must be transport-aware

- `auth.tsx` now bypasses the Supabase membership watchdog in LAN session mode and performs LAN logout/token cleanup during inactivity-triggered sign-out.
- **Lesson:** replacing login is not enough; all background session code (watchdogs, idle timers, explicit logout) must switch to LAN transport too, or hidden Supabase coupling remains.

### Ops shell logout visibility (2026-04-26) — no hidden sign-out on compact layouts

- Added a persistent sidebar logout action in `Layout.tsx` so sign-out is available even when the topbar account cluster is hidden on smaller widths.
- **Lesson:** safety/session controls must not be tied only to breakpoint-specific UI; operators need deterministic logout access on every workstation layout.

### Internal migration Step 6 (2026-04-26) — LAN Audit Log read path

- Added `GET /api/internal/audit-log?limit=` on `api-server` and mounted it under `/api/internal` with the same LAN session gate as other internal routes.
- `useAuditLog` now prefers internal API rows when `VITE_LAN_SESSION_LOGIN` is enabled, preventing LAN-auth sessions from depending on Supabase for the audit page.
- **Lesson:** auth and observability surfaces must migrate together; operators should not see LAN login paired with cloud-only audit history.

### Connections LAN messaging (2026-04-26) — keep ops tooling, drop cloud assumptions

- Added LAN-mode guidance banners to `Connections.tsx` and `admin/ConnectionMap.tsx`; they remain operational in local-network migration mode and now explicitly say so.
- Updated join-code troubleshooting hint to reference “same LAN backend” when LAN session mode is enabled.
- **Lesson:** “remove Supabase” does not mean deleting operator tools — it means preserving workflows while replacing transport/copy underneath.

### LAN diagnostics copy (2026-04-26) — no cloud-first messaging in LAN mode

- `Diagnostic.tsx` now switches backend language/verification to LAN semantics when `VITE_LAN_SESSION_LOGIN` is enabled (internal API health + local identity), and hides the Supabase registry grid in LAN mode.
- **Lesson:** migration mode must change operator-facing diagnostics too, not just transport helpers, or users are forced to mentally translate obsolete cloud wording while troubleshooting LAN issues.

### LAN no-auth migration mode (2026-04-26) — explicit temporary password bypass

- Added `POST /api/internal/auth/lan/dev-session` behind server flag **`HAWK_LAN_DEV_NO_AUTH=1`** to mint operator sessions without password verification (auto-creates `lan_users` row for the requested username).
- Dashboard flag **`VITE_LAN_NO_AUTH=1`** now makes LAN login call that route (still requires `VITE_LAN_SESSION_LOGIN=1` and reachable internal API), with one-click role entry buttons on the login screen (`Super Admin` / `Ops` / `Cmdr`) so bring-up tests can skip username/password typing entirely.
- **Lesson:** if operators request “remove security for now,” ship it behind loud, opt-in flags so migration can proceed fast without permanently hardcoding insecure defaults.

### LAN login entry path (2026-04-26) — skip cloud `FirstLaunch` when `VITE_LAN_SESSION_LOGIN`

- `App.tsx` **Shell** now renders **`LoginGate` immediately** for unsigned-in users when `isLanSessionLoginEnabled()` is true, instead of defaulting to **`FirstLaunch`** (cloud join / unit bootstrap). Stops LAN-only installs from looking like a broken Supabase-first flow.
- **Lesson:** migration flags must change **routing and copy**, not only the auth implementation — operators judge the product by the first screen they see.

### Windows + Vite / Rollup (2026-04-26) — `pnpm-workspace.yaml` must not stub Win32 natives

- **`Cannot find module '@rollup/rollup-win32-x64-msvc'`** (and similar for `@tailwindcss/oxide-win32-*`, `lightningcss-win32-*`) was caused by **overrides** in `pnpm-workspace.yaml` that replaced those optional packages with `'-'` (Replit/Linux install trimming). Removed those **Rollup** overrides and the **Win32** stubs for Oxide + LightningCSS so **Windows `pnpm install` + `vite dev`** resolve the correct native binaries.
- **Lesson:** cross-platform “trim optional deps” overrides must **never** blank out the **current host’s** platform packages, or local Windows dev silently breaks while Linux CI still passes.

### Windows + `pnpm install` (2026-04-26) — preinstall no longer needs `sh`

- Root `preinstall` used `sh -c '…'`, which **fails on stock Windows** (`'sh' is not recognized`). Replaced with `node ./scripts/preinstall.mjs` (same pnpm-only guard + lockfile cleanup).
- **Lesson:** any root install hook must be **Node-or-CMD–friendly** so operator PCs can clone and `pnpm install` without Git-Bash-only dependencies.

### Internal migration Step 6 (2026-04-25) — pilot roster read + operator-plain status

- Added `GET /api/internal/pilots`; `usePilots` prefers internal rows when the LAN API returns at least one pilot (hybrid safety), else Supabase.
- **`PROGRAM-STATUS.md`** now opens with an **“In everyday words”** section for non-technical readers (what still uses the internet vs internal, what “empty reply” means in human terms).
- Lesson: roster reads are safety-critical — same **non-empty** guard as the Super Admin squadron list until internal-only cutover is explicit.

### Internal migration Step 6 + Step 11 scaffold (2026-04-25) — squadrons registry + runbook

- Added `GET /api/internal/squadrons` and `fetchInternalSquadronsList()`; `refreshSquadronsFromDb` prefers internal only when the list is **non-empty** so hybrid installs cannot be wiped by an empty LAN DB.
- Added `squadronsFromRemoteRows` + `tests/squadron-remote-rows.test.ts`. Started **`docs/internal-migration/STEP-11-rollout-rollback.md`** (cutover checkpoints, NO-GO triggers, rollback actions).
- Lesson: for **registry-scale** reads, require a positive signal (non-empty list) or a dedicated “internal primary” flag before replacing a populated cloud mirror.

### Internal migration Step 6 expansion (2026-04-25) — squadron defaults read path

- Added `GET /api/internal/squadron-airframes?number=` returning Setup Wizard columns from `squadrons` (`base`, `wing`, `default_aircraft`, `default_monthly_targets`).
- `hydrateSquadronDefaultsFromDb` now tries the internal API first, then Supabase; shared pure merge `mergeSquadronsRemoteRowIntoDefaults` + `tests/squadron-defaults-merge.test.ts`.
- Lesson: duplicate the **exact** merge semantics once (internal + cloud row shape), test the merge, and keep both transports behind one function.

### Internal migration Step 6 — sorties list read + write/read alignment (2026-04-25)
- **`GET /api/internal/sorties`** (optional `?limit=`, default 500) returns recent sortie rows from internal Postgres — same ordering as the dashboard’s Supabase `sorties` query.
- When **`VITE_INTERNAL_WRITES`** is on and the internal API base is available, **`useSorties`** reads from that endpoint first so the ops log does not split between cloud reads and LAN writes; if the read fails, it falls back to Supabase.
- **Lesson:** any table that can be written on the internal path must have a matching internal read (or explicit single-source-of-truth flag), or operators see “saved” data vanish from the screen.

### Internal migration Step 6+ — base-LAN operator sessions on `api-server` (2026-04-26)
- Added first **non-Supabase** session layer for the private base network: `lan_users` + `lan_sessions` in Postgres, with routes `POST /api/internal/auth/lan/bootstrap` (gated by `HAWK_LAN_BOOTSTRAP_TOKEN` on empty DB), `POST /api/internal/auth/lan/login`, `GET /api/internal/auth/lan/me`, `POST /api/internal/auth/lan/logout`. Optional hard gate: `HAWK_INTERNAL_SESSION_AUTH=required` enforces `x-hawk-lan-session` on `/api/internal/*` data routes.
- Dashboard internal fetch helper can attach the token from `localStorage` (`rjaf.lanSessionToken`) when present (LAN login UI to follow).
- **Lesson:** “remove Supabase” is not one switch — it is **Auth + data + authorization** moved together; session tokens must exist before you can safely lock down LAN APIs.

### Internal migration Step 5 reliability expansion (2026-04-25) — monthly-report + join/fault anchors
- Added `tests/monthly-report-forms.test.ts` and wired it into the dashboard pipeline as `test:monthly-report`; covers Form 1 blank status + totals, Form 3 IRT→IF + percentage math, Form 4 next-month defaults/suggest helper, and six-month seat attribution flags.
- Added `tests/join-lifecycle.test.ts` and `tests/fault-injection.test.ts`; wired into `pnpm run test` as `test:join-lifecycle` and `test:fault-injection`.
- **Lesson:** migration confidence needs both happy-path parity tests and fail-closed tests (disabled transport, malformed cache, misconfigured endpoints), not only render smoke.

### Internal migration Step 6 kickoff (2026-04-25) — first internal data-plane endpoint
- Added `api-server` route `GET /api/internal/pilot-options` returning schedule-safe pilot identifiers (`flightName` → `callSign` → `id`) from DB.
- `FlightProgram` and `ScheduleChain` now consume internal pilot options when available, with roster fallback intact.
- Lesson: migrate by surface with explicit fallback + tests, not big-bang swaps.

### Internal migration smart UX (2026-04-25) — schedule crew uses flight name
- Flight schedule composers (`FlightProgram` + `ScheduleChain`) now store/display crew using roster **flight name** (fallback call-sign, then pilot id), not full personal name.
- Added `src/lib/schedule-names.ts` + `tests/schedule-names.test.ts`; wired into dashboard test pipeline as `test:schedule-names`.
- Lesson: operator-facing schedule artifacts should speak in tactical identifiers (flight names), not long roster names.

### Internal migration smart guardrails (2026-04-25) — Add Sortie consistency analyzer
- Added `src/lib/add-sortie-smart.ts` and integrated it into `AddSortie.tsx` to block impossible entries (instrument total > sortie time) and surface warnings for high-risk mismatches before save.
- Added `tests/add-sortie-smart.test.ts`; wired into dashboard test pipeline as `test:sortie-smart`.
- Lesson: "smart app" means pre-save consistency checks + clear operator feedback, not hidden silent autocorrections.

### Internal migration Step 5 reliability pass (2026-04-25) — route button sweep + test pipeline
- **`tests/button-sweep.test.ts`** now mounts role routes and clicks discovered controls in jsdom to catch click-time failures beyond first paint; wired into `pnpm run test` as `test:buttons`.
- **Scope note:** commander data-grid routes `/dashboard/pilots` and `/dashboard/currencies` stay under `sidebar-smoke` first-render coverage in this suite; keep dedicated browser-level tests for those richer grid interactions.
- **Lesson:** first-render smoke is necessary but not sufficient; keep a second gate that actually clicks controls.

### Internal migration Steps 4–5 + guest UI actions (2026-04-25) — Matrix, status doc, Accept/Reject/Drop test
- **`docs/internal-migration/STEP-4-parity-matrix.md`** — GO/NO-GO parity rows (DOMAIN ↔ code ↔ tests). **`PROGRAM-STATUS.md`** — checklist through Step 12; Steps 6–12 explicitly **not started** (internal API data plane, auth implementation, cutover).
- **`tests/guest-pending-actions.test.ts`** — offline jsdom exercise of **Pending Approvals** **Accept**, **Reject** (reason + Send rejection), **Drop**; runs in `pnpm run test` via `test:guest-pending`. **`Layout` `Card`** now spreads `HTMLAttributes<HTMLDivElement>` so `data-testid` on cards reaches the DOM (fixes silent loss of test hooks on Pending / Guest backfill / Diagnostic cards).
- **Lesson:** “Every button” starts with **high-risk workflows** + **DOM truth** for `data-testid`; layout primitives must forward ARIA/test props.

### Internal migration Step 3 (2026-04-25) — Internal API health + Vite proxy
- **`api-server` reachability from the dashboard:** `src/lib/internal-migration.ts` resolves `GET /api/healthz`; **Connection Diagnostic** shows pass/fail when `VITE_INTERNAL_API_URL` is set or in **dev** (same-origin proxy `__hawk_eye_internal_api` → `INTERNAL_API_PROXY_TARGET`, default `http://127.0.0.1:3847`). **Production** direct LAN URLs require that origin in `index.html` **connect-src** (or same-origin reverse proxy) — see `docs/internal-migration/STEP-3-internal-api-kickoff.md`.
- **Lesson:** keep internal-LAN checks on the same code path as operator diagnostics; do not hide migration plumbing in ad-hoc curl-only scripts.

### Internal migration — GitHub allowed (2026-04-25, superseding earlier note)
- **GitHub is OK** (push, PR, repo changes) when useful for the migration. Operator rescinded the temporary “no GitHub” line. See `docs/internal-migration/README.md` (VCS callout).

### Internal migration — operator authorization to reshape (2026-04-25)
- Operator authorized **redesign / reshape / recode** where Supabase-shaped code blocks a clean **internal Custom API + Postgres** target — not only `VITE_SUPABASE_URL` replacement. Parity is proven via DOMAIN + program GO/NO-GO gates, not adapter theater. See `docs/internal-migration/README.md` § *Redesign, reshape, and recode* and Cursor plan *Decisions*.

### Internal migration Step 2 (2026-04-25) — Auth/security *design* spec (no code change)
- Added `docs/internal-migration/STEP-2-auth-security-spec.md` — **target** model: **install / application password only** for all roles; **remove** from the eventual implementation: Super Admin TOTP/2FA path (`super-admin-2fa` + Login TOTP UI), standalone TOTP storage, **per-PC role lock** (`rjaf.pcRoleLock`), **failed-attempt lockout** (`rjaf.fails` / `rjaf.lockUntil`), and **client join secret** (`VITE_UNIT_JOIN_SECRET` / `x-unit-join-secret`) in favor of **internal-network** server controls. **Keep:** role-based data visibility, **non-blocking** `audit_log`, session lock (privacy) and idle timeout as user prefs. **Open:** master recovery hash, mobile alignment — close before Step 10 hard cut.
- **Lesson:** spec before code so internal API and login simplification do not fight each other.

### Internal migration Step 1 (2026-04-25) — Baseline inventory (no behavior change)
- Added `docs/internal-migration/STEP-1-baseline-inventory.md` + `docs/internal-migration/README.md` as the **Step 1** deliverable for the internal-LAN (Custom API + Postgres) program: map of all Supabase/internet touchpoints (env, edge functions, REST/RPC, `from()` tables, mobile, Electron updater, CSP), plus pointers to the parity contract (`DOMAIN.md`, `calculations.ts`, `monthly-report.ts`, `cross-pc.ts`, `Layout`/`HQLayout`, `sidebar-smoke.test.ts`). Cites gap: **HQ commander** persona not in default sidebar-smoke `PERSONAS` — add when building the full per-role deep matrix.
- **Lesson:** treat this file as the checklist for endpoint replacement; do not re-invent scope from memory.

### v1.1.126 (2026-04-25) — Super Admin overview de-mocked + role-hardening audit artifacts
- `src/pages/admin/Overview.tsx` no longer imports seed `mockData.pilots` / `mockData.licenseKeys`; it now reads pilot counts + expiry status from `usePilots()` (shared data layer) so the Super Admin overview reflects live squadron state instead of local seed drift.
- Added audit evidence + role-flow matrix under `audit-evidence/2026-04-25/full-role-reliability/` as the baseline for future role-regression passes.
- **Lesson:** any admin surface that summarizes operational state must consume the same Supabase-backed hooks as ops/commander pages; seed arrays are acceptable only for explicit demo-only paths.

### v1.1.96 (2026-04-23) — Wing→Base forward + Base.approve final archive
- Operator-stated chain (DOMAIN.md §7.1) is now wired end-to-end: ops→sqn→wing→base→base.approve = final archive. Wing.approve without Base forward is also valid (saves the day for that squadron).
- The Wing→Base forward UI was already in `ScheduleChain.tsx:651-700`; the only blocker was a `throw` in `cross-pc.ts:1659` saying "Wing tier shares are terminal". Removing it opened the path.
- **Lesson:** before adding new UI, search for what's already wired. The UI was complete a release earlier and just needed the back-end transition unblocked.

### v1.1.95 (2026-04-23) — Bulletproof RLS + audit_log was the real killer
- The persistent 42501 the operator kept hitting after Wing edit-bounce was NOT the schedule_shares policy — it was the `audit_log` INSERT policy. `audit_log WITH CHECK` required `squadron_id = squadron_id()`, where `squadron_id()` reads `app_metadata.squadron_id` from the JWT. Wing-tier and most ops users have no such claim → function returned NULL → comparison flipped to NULL → treated as FALSE → 42501. The audit insert fires immediately AFTER the schedule update inside `useDecideSchedule`, so the failure surfaced as if the schedule write had been rejected.
- Migration `0036_xpc_bulletproof_rls.sql`: dropped sentinel guards on all `xpc_*` WITH CHECK; relaxed `audit_log` INSERT WITH CHECK to bare `auth.uid() IS NOT NULL`.
- `recordAuditEvent()` now swallows + logs failures so audit problems can never again masquerade as a real-action failure.
- **Lesson:** when an action does N writes and ONE fails, the user's toast names the LAST failed table — but the FIRST failure could be N-1 steps earlier. Always trace every write in a mutation, not just the named one. And audits must NEVER throw.

### v1.1.94 (2026-04-23) — Universal autoclaim trigger across xpc_* tables
- Migration `0035_xpc_universal_autoclaim_rls.sql`: BEFORE INSERT/UPDATE triggers on `xpc_schedule_shares`, `xpc_messages`, `xpc_pending`, `xpc_squadron_snapshot` auto-claim the actor's PC seat in `xpc_user_pcs` so the row is immediately visible to them via `xpc_my_pc_ids()`.

### v1.1.93 (2026-04-23) — Initial robust insert (was insufficient on its own — see 1.1.95)
- Migration `0034_robust_schedule_insert_rls.sql`: first attempt at autoclaim. Necessary but not sufficient — see v1.1.95 for the real root cause.

**When you ship a new version, append a short entry above. This list is the running changelog the next agent reads first.**
