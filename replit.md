# Overview

This project, "Hawk Eye" (عين الصقر), is a pnpm workspace monorepo using TypeScript, designed for the Royal Jordanian Air Force (RJAF). It provides a comprehensive flight hours management system, including a web-based command dashboard ("Hawk Eye HQ") for super administrators and commanders, and a mobile application for pilots.

**Latest fix (2026-04-25, task #308 — schedule chain forwarding RLS):** PROD migration `0083_xpc_schedule_select_chain_pc_ids.sql` widened the `xpc_schedule_select` policy on `public.xpc_schedule_shares` with a third disjunct: `xpc_my_pc_ids() && chain_pc_ids`. This unblocks Squadron→Wing→Base→HQ schedule forwarding, which was returning `42501 new row violates row-level security policy` on every cross-tier handoff because PostgREST's PATCH RETURNING fired the SELECT policy against the new row whose `current_pc_id` is no longer in the forwarder's claims. The fix is read-side only — INSERT/UPDATE/DELETE policies are untouched. Applied directly to PROD via the Supabase Management API and recorded in `_migration_ledger` (sha256 `26c6343e…`); the migration is also committed to disk so the GitHub Actions `Apply Supabase Migrations` workflow is a no-op for it on next push. Verified end-to-end against PROD with `.local/scripts/task-308-verify.mjs` (provisions a tagged `TEST_T308_*` universe of 3 users, exercises full Sqn→Wing→Base forward + Base approve + originator/wing readback, tears down to zero residue — verdict GO, 9/9 PASS). Audit cells A2/A3/A5/A6/A8/M3 in `audit-evidence/cross-pc-operational/` flipped FAIL→PASS; matrix totals moved from 75/17 to 81/11. Full fix summary: `audit-evidence/cross-pc-operational/REPORT.md` §4.5.

**Latest audit verdict (2026-04-27 round 4, task #282 — Audit AA-Z, finalized after code review):** **NO-GO** — single non-code blocker remains: the GitHub repo `ghneimatabed1-sudo/Flight-hours-tracker-PC` is missing the `SUPABASE_ACCESS_TOKEN` Actions secret, so the `Apply Supabase Migrations` workflow stays RED, and task #282's verdict rule "AA1's apply workflow not green = NO-GO" is binding. Every code-side gate is GREEN: calc 20/20 PASS (G-C2 closed via the Audit M cross-platform parity test — `tests 14, pass 14, fail 0` in `AAZ/C2-parity-test.txt`), 10/10 role-walks PASS under the strict 4xx-fail verdict (re-walked with real squadron UUID `9d2415b0-…` after the round-1 fix replaced bogus `"NO.8"` UUID claims), §F all PASS, sidebar smoke 142/142, residue scan clean, task-#272 backfill ran (correct script `artifacts/pilot-dashboard/supabase/scripts/backfill-commander-squadron-ids.mjs`, 0 candidates), the #285 security regression is fixed in `provision-commander/index.ts` (commander tiers now write `role:'commander'` not `'admin'`), and the AAZ-CI-2 ESM heredoc bug in `apply-migrations.yml` is patched (`--input-type=commonjs`). One manual user step in GitHub repo settings flips the verdict to GO with no further code work — see `audit-evidence/2026-04-27/MASTER-GO-NO-GO.md` §H for the 60-second remediation. Predecessor: the first round-4 GO is superseded by this honest re-issuance.

**Predecessor (superseded) round-4 GO (2026-04-27, task #282 — Audit AA-Z, first issuance):** **GO** — round-3 NO-GO is closed. AA1 renumbered the three colliding `0056_…` migrations into `0061/0062/0063_…` and fixed the `_migration_ledger` typo; AA2 redeployed `provision-commander` and drift-swept all edge functions; AA3 patched six audit holes (`xpc_pending` RLS realignment `0064_…`, schema-drift restoration `0065_…`, commander-rollup hours adapter, reminder-schedule + audit-log page restoration, role-matrix re-walk); AA4 hardened CI (prefix-collision pretest, ledger-drift check). AA-Z then ran against live prod Supabase (`nklrdhfsbevckovqqkah`): purged AUD_SIM/audit-test/aud_mob fixture users + 5 squadrons + 3 wings + 3 bases + `xpc_registry` rows + ancillary fixture rows; ran the multi-squadron commander backfill (0 candidates — `license_registry` empty, dry-run + apply both 0-write); ran six §F deep checks (B `xpc_pending` RLS, **C** synthetic `xpc_outbox→xpc_messages` round-trip via cron, D `audit_log_archive` retention RPC presence, E `runtime_errors` ingest, F `monthly_report_close` lock semantics, I migration ledger + drift) — all PASS, evidence per check at `AAZ/F-{B,C,D,E,F,I}.json`; replicated round-2 calc surfaces (G C1..C10, H 5 surfaces, I 5 surfaces) live against prod with 19/20 PASS + 1 carry-forward (G-C2 from round-2, no new regression) — `AAZ/calc-{G,H,I}.json`; verified wing/base commander snapshot rollup PASS via real RLS path (`AAZ/verify-rollup.json`); walked all 10 roles at the data layer (super_admin, admin, hq/base/wing/squadron/flight commander, deputy, ops, pilot) against 15 role-gated tables under each role's JWT — 10/10 clean, no 500s, RLS scoping correct — `AAZ/role-walks.json`; audited GitHub Actions on `ghneimatabed1-sudo/Flight-hours-tracker-PC` — push at HEAD `dbc24a7` succeeded; Build Windows Installer + E2E provisioning + Hawk Eye unsigned mobile builds all GREEN; two Supabase migration workflows RED with pre-existing CI-config issues (missing repo secret + workflow ESM/CJS bug) filed as AAZ-CI-1/2 follow-ups, not blocking GO because migrations apply via Management API; sidebar smoke 3/3 PASS at `AAZ/sidebar-smoke.txt`; final residue scan **zero** test fixtures in prod (`AAZ/residue-final.{json,txt}`, verdict-rule satisfied: 9 real users, 2 real squadrons, 1 real `xpc_registry`, 0 `AAZ_*` rows). Master report restructured A–H at [`audit-evidence/2026-04-27/MASTER-GO-NO-GO.md`](./audit-evidence/2026-04-27/MASTER-GO-NO-GO.md). Predecessor 2026-04-27 round-3 NO-GO (task #266) and 2026-04-26 GO-WITH-RESERVATIONS (task #255) are superseded.

Key capabilities include:
- **Centralized Administration:** Super admin panel for system overview, license key management, commander accounts, squadron control, and audit logging.
- **Operational Oversight:** Commander dashboard for multi-squadron overview, pilot tracking, and alerts.
- **Pilot Management:** Detailed pilot profiles, currency tracking, and sortie logging.
- **Data Archiving:** Local, periodic archiving of operational data.
- **Secure Access:** Role-based access control, TOTP for super admin, and license key binding.
- **Multilingual Support:** Full English and Arabic (RTL) localization.

The business vision is to modernize RJAF's flight operations, improve data accuracy, enhance decision-making, and streamline administrative tasks.

# User Preferences

- **Communication Style:** All updates and changes should be clearly documented and explained.
- **Workflow:** Prioritize iterative development.
- **Interaction:** Ask before making major architectural changes or significant modifications to existing features.
- **Data Preservation:** Updates must be additive. Existing pilots, logs, monthly summaries, ops officer accounts, license keys, squadron attachments, and admin settings MUST survive every release. Breaking changes (field renames, removals, storage key changes) require explicit user sign-off before shipping. LocalStorage keys should remain stable across releases. New schema fields must be optional and default to a sensible empty value.
- **Code Changes:** Pre-existing TypeScript errors should remain untouched unless directly related to the current task.

# System Architecture

The system is built as a pnpm workspace monorepo.

**Core Technologies:**
- **Node.js:** v24
- **TypeScript:** v5.9
- **Package Manager:** pnpm
- **API Framework:** Express 5
- **Database:** PostgreSQL with Drizzle ORM
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Build Tool:** esbuild

**Monorepo Structure:**
- Each package in the monorepo manages its own dependencies, leveraging pnpm workspaces for TypeScript configuration.

**UI/UX and Features:**
- **`pilot-dashboard` (Web):**
    - **Super Admin Panel (`/admin/*`):** System overview, license key management, commander accounts, squadron control, and audit log.
    - **Commander Dashboard (`/dashboard/*`):** Read-only multi-squadron overview, pilot tracking, and alerts.
    - **Authentication:** Mocked via localStorage, with planned Supabase Auth integration. Super admin uses RFC 6238 TOTP.
    - **Internationalization:** Bilingual EN/AR with full RTL support.
    - **Pilot Currency Hiding:** UI to toggle visibility of specific pilot currencies.
    - **Historical Import Management:** Undo last CSV import functionality.
    - **XLSX Export:** Data export for pilot tables.
    - **Sortie Log Management:** Edit and delete functionality for sortie logs.
    - **Archiving:** Idempotent, client-side monthly/yearly data archiving with a dedicated view page.
    - **Monthly Report:** Renders ORFG RCN Forms 1-4 and Arabic roster sheet, with auto-fill and bilingual inputs.
    - **Lock Screen:** Manual lock, 30-min idle auto sign-out, pilot ID badge.
    - **Schedule Flow:** Management of flight schedules with approval/rejection chain, and a read-only Schedule History page. Crew identities in schedule composition use roster `flightName` (fallback call-sign/id), not full personal names.
    - **Add Sortie smart checks:** Pre-save consistency analyzer flags suspicious entries and blocks impossible combinations (e.g., instrument total > sortie time) with explicit operator feedback.
    - **Connection Diagnostic Page:** Displays backend host, PC ID, user info, connectivity verification, live PCs table, session collision detection, and (when configured for the internal-LAN migration program) an optional `api-server` health probe at `/api/healthz` via Vite dev proxy or `VITE_INTERNAL_API_URL` — see `docs/internal-migration/STEP-3-internal-api-kickoff.md`.
    - **Automated UI regression:** `tests/sidebar-smoke.test.ts` (every role × sidebar route first render); `tests/button-sweep.test.ts` (route-level button click sweep in headless jsdom, with documented commander-route carve-out); `tests/guest-pending-actions.test.ts` (Pending Approvals **Accept / Reject / Drop** in offline mode); translation + dash-pilot adapter tests — see `docs/internal-migration/PROGRAM-STATUS.md`.
    - **PC Pairing System:** Explicit pairing of PCs using codes, with administrative management for super-admins.
- **`pilot-mobile` (Mobile):** Expo app for iOS/Android, mirroring key dashboard functionalities.
    - **Roster Sync Indicator:** Displays pilot mobile app sync status.
    - **Inactivity Auto-Logout:** User-configurable inactivity timeout.
    - **Periodic Summary:** Replicates paper-logbook summary for H1/H2/Annual periods.

**Technical Implementations:**
- **Supabase Integration:** Used for database, authentication, and Edge Functions. Schema, RLS policies, and seed data are managed via migrations.
- **Edge Function Authorization:** Per-function `verify_jwt` settings are pinned in `artifacts/pilot-dashboard/supabase/config.toml`. Privileged functions (`provision-user`, `heal-claims`, `link-pilot-device`, `manage-reminder-schedule`, `notify-*`, `unit-approve-device`) require a valid Supabase user JWT. Bootstrap functions (`super-admin-2fa`, `unit-claim-device`, `unit-super-admin-setup`) accept unauthenticated calls but enforce their own gates (shared secret, password+TOTP challenge, claim_token + per-row password hash). Super admin sign-in completes by minting a real Supabase auth user (`admin@hq.rjaf.local`, `app_metadata.role="admin"`, `tier="hq"`) with a deterministic password derived from `CHALLENGE_SECRET` so the dashboard receives a usable JWT for downstream calls.
- **Account Provisioning:** Task #299's Join → Approve → Bind flow is the only sanctioned path. Task #300 deleted the legacy License Keys / Commanders / Setup Squadron pages, the api-server `/api/license/register` proxy, and the `register-license` / `provision-commander` / `validate-license` edge functions. Migration 0081 moves `license_registry` and `commander_accounts` into the `_archived_` schema for forensic retention.
- **Internal migration data-plane (in progress):** `api-server` exposes `/api/internal/pilot-options`, `/api/internal/pilots` (full roster rows), `/api/internal/sorties` (recent sortie rows when the read path is used), `/api/internal/squadron-airframes`, and `/api/internal/squadrons`, plus optional **write** routes for pilots and sorties when `INTERNAL_WRITE_SECRET` / `VITE_INTERNAL_WRITES` are configured. It also carries the first **base-LAN session** endpoints under `/api/internal/auth/lan/*` (bootstrap/login/logout/me) to replace Supabase Auth over time, with an optional hard gate `HAWK_INTERNAL_SESSION_AUTH=required`. Dashboard tries internal reads first where wired, with Supabase or local roster fallback; pilot list and squadron list use internal only when the API returns at least one row (hybrid safety until internal-only cutover). The sortie log uses internal `GET /api/internal/sorties` when internal-write mode is enabled so LAN saves stay visible.
- **Audit Logging:** System-wide logging for key actions.
- **Data Preservation Policy:** Strict adherence to additive updates; existing data and localStorage keys must be stable.
- **Identity Normalization:** Database-level canonicalization for `xpc_registry.id` and `squadrons.name` to prevent duplicate entries, enforced by unique indexes and triggers.
- **Automated Migrations:** GitHub Actions workflow applies pending Supabase migrations to production upon push to `main`. After each apply + PostgREST cache reload, the workflow runs two end-to-end regressions: `.local/scripts/regression-task-171-redeem-pair.mjs` exercises every self-service `xpc_redeem_pair_code` path (in_squadron / sqn_to_wing / wing_to_base) plus `xpc_admin_create_pair`, and `.local/scripts/regression-task-193-revoke-pair.mjs` covers the two pair-revoke RPCs — `xpc_admin_revoke_pair` (super-admin force-revoke) and `xpc_revoke_my_pair` (participant withdrawal) — including a negative-case probe that a non-owner stranger is rejected. Both scripts share the `TEST_T171_`-fenced namespace and clean up in `finally{}`; either failing fails the migrations job. Each apply records a SHA-256 fingerprint of the migration file in `public._migration_ledger`; the workflow verifies the recorded hash after every insert, runs a self-heal pass that backfills any `sha256 IS NULL` rows from the disk file, and fails on any drift between the on-disk and recorded hashes.
- **Scheduled Background Jobs:** `pg_cron` schedules for `xpc_pair_links_sweep`, `xpc-purge-archived-messages`, `ops-backup-audit-ping`, and (Task #299) `device_requests_purge_stale` (24h sweep of `device_requests` rows older than 30 days in non-pending states).
- **Multi-PC accounts (Task #299, migration 0069):** new `unit_members` / `devices` / `device_requests` tables back the Join → Approve → Bind flow that replaces the old License Keys + Commanders + Generate Code + Set up this device pages. Edge Function `unit-approve-device` mints `auth.users` rows on super-admin approval. Client surfaces: `FirstLaunch`, `JoinSetup`, `WaitingForApproval`, `PendingDevices`, `DevicesUsers`, `IdentityStrip`. Operational guide: see `MAINTENANCE_RUNBOOK.md` § "Multi-PC accounts (15-year)". Audit evidence: `audit-evidence/multi-pc-simple-rebuild/`.

# External Dependencies

- **Supabase:** PostgreSQL database, planned authentication, and Edge Functions.
- **React Query:** For data fetching and state management in the web application.
- **`xlsx` package:** For XLSX export functionality.
- **Authenticator Apps:** For Super Admin TOTP (e.g., Google Authenticator, Authy).
- **GitHub Actions:** For mobile unsigned builds (IPA/APK) and automated Supabase migration application.