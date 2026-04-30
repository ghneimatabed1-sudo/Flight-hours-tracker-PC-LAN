# DOMAIN.md — What Hawk Eye Actually Does

> **Functional reference for AI agents and humans.**
> Read this to understand WHAT every page, role, and number means in operational terms — not how the code is structured. For "do not break" rules see `AGENTS.md`. For settled per-feature rules see `.local/memory/`.

---

## 1. The big picture

Hawk Eye replaces a stack of paper forms and Excel sheets used by Royal Jordanian Air Force (RJAF) helicopter squadrons. One Squadron deploys it as a small network of Windows PCs (one per role) plus mobile phones for individual pilots. Every PC keeps its own local copy of the squadron's data, talks to a shared Supabase database for cross-PC features, and prints / exports the same paper forms the squadron has always used — now filled in automatically.

A live deployment looks like:

- **1 Operations PC** (the data-entry workhorse)
- **1+ Flight Commander PCs** (one per flight inside the squadron)
- **1 Squadron Commander PC**
- **1 Wing Commander PC** (sees several squadrons)
- **1 Base Commander PC** (sees several wings)
- **1 HQ PC** (sees all bases)
- **N Pilot phones** (mobile app, one per pilot)
- **1 Super Admin PC** (RJAF-wide, license keys, audit, the system itself)

---

## 2. Roles — who is who, and what they do

### 2.1 Operations PC ("Ops")

**The data-entry workhorse of the squadron.** Almost every number in Hawk Eye starts here.

**Daily job:** log every sortie that flew today, log leaves and unavailability, mark Duty Week assignments, build tomorrow's flight program, fill the risk assessment, file NOTAMs, post messages.

**Has access to:** Roster, Sortie Log, Flight Program, Schedule (drafting), Currency, Reminders, Duty Week, Risk Assessment, Coordinating Form, NOTAMs, Nav Routes, PDF Exports, Historical Import, Archives, Assigned Ops Pilots, Settings, Monthly Report. **Does NOT approve schedules** — they only submit them up the chain.

### 2.2 Flight Commander PC

**Subordinate to a specific Squadron Commander.** Each flight inside a squadron has one.

**Daily job:** monitor the pilots in their flight, draft mini-schedules and submit them to the Squadron Commander for approval, exchange messages.

**Has access to:** filtered roster (their flight's pilots), schedule drafting, messages with their Squadron Cmdr.

### 2.3 Squadron Commander PC

**Commands one squadron.** First approver in the schedule chain.

**Daily job:** review the day's flight schedule submitted from Ops or a Flight Cmdr, **approve / reject / hold / edit-and-return**, sign off the Monthly Report, watch the squadron's currency dashboard, message the Wing Cmdr.

**Has access to:** Commander Dashboard (their squadron's snapshot), Pilots, Alerts, Currency, Simulator history, Flight Records, Flight Program (read), Messages, **Final Schedules**, Schedule Chain.

### 2.4 Wing Commander PC

**Commands several squadrons.** Second approver in the schedule chain.

**Daily job:** see incoming approved schedules from each squadron under them, approve and forward to Base, or reject/edit-and-return. Filter the dashboard by squadron to drill into any single one.

**What they monitor:** total pilot strength across their squadrons, who is current/expired, schedules in flight, messages from any of their Squadron Cmdrs.

**Has access to:** same pages as Squadron Cmdr, but with a **squadron picker** at the top to switch between any squadron under them.

### 2.5 Base Commander PC

**Commands several wings.** Third approver in the schedule chain.

**Daily job:** receive schedules from Wings, approve and forward to HQ, or send back. Aggregate visibility over every squadron under their base.

**Has access to:** wing-rolled-up dashboard with the same squadron picker, plus the option to filter by wing.

### 2.6 HQ PC

**Final tier.** Sees everything across all bases. Approves schedules at the top of the chain. The "everything is OK across the air force" view.

### 2.7 Super Admin PC

**Above the operational chain. Manages Hawk Eye itself, not flying.**

**Daily job (rarely daily):** issue or revoke license keys, bind a license to a hardware ID + user, add or remove squadrons from the global directory, manage commander accounts, configure system-wide reminder cadences, override broken Flight→Squadron reporting chains, view the full audit log, manage TOTP for their own 2FA.

**Has access to:** Admin Overview, Devices & Users, Pending Devices, Squadrons, Audit Log, Security (2FA), Reminders Schedule. **Does NOT see flight data** unless they impersonate a squadron, and that action is audited.

### 2.8 Pilot Mobile App (individual pilot, on their phone)

**One install per pilot, paired to their record on the squadron.**

**What they see:** their own monthly hours (Day / Night / NVG, both seats), their own currency status with red/yellow/green warnings, their own simulator history, recent NOTAMs, their personal reminders (medical expiring, IRT expiring, NVG currency lapsing), the duty week roster, half-year (H1/H2) progress bars against annual targets.

**What they CANNOT do:** log new sorties, edit any record, see other pilots' personal totals. Read-only by design — squadron Ops PC owns the truth.

---

## 3. Pages — what every menu item is


| Page                                  | Plain-English purpose                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**                         | At-a-glance squadron health: today's sorties, who's on duty, alerts, expired currencies, schedule status. Different per role (commander view vs ops view).                                                                                                                                                 |
| **Pilot Roster (Pilot Unit Manager)** | The master list of every pilot in the squadron — name (EN/AR), military number, rank, call sign, qualifications, the six "last X flown" dates (Day, Night, NVG, IRT, Medical, Sim), Initial Hours baseline, phone-pair indicator, and currency state. Click a row → full detail page with hour breakdowns. |
| **Sortie Log**                        | Chronological list of every flight ever logged at this squadron. Add / edit / delete (delete is gated by a 12-month "frozen" window — older records require Super Admin authorization). Each row = one sortie.                                                                                             |
| **Flight Program**                    | The digital replacement for the paper "Daily Mission" sheet. Builds tomorrow's flying schedule: flight bands, briefing times, day-ops lead, night-ops lead, lecture, CAPTE, reporting time, A/C needed (main + standby for day and night), NVG slots, day slots.                                           |
| **Schedule (chain view)**             | Where Ops/Flight submits a schedule and watches it travel up Squadron → Wing → Base → HQ. Shows current holder, status, who edited it, what the diff is.                                                                                                                                                   |
| **Final Schedules**                   | Commander-only view of approved schedules ready to execute.                                                                                                                                                                                                                                                |
| **Monthly Report**                    | The big monthly export. See section 5.                                                                                                                                                                                                                                                                     |
| **Currency**                          | Matrix of every pilot vs every currency type (Day, Night, NVG, IRT, Medical, Sim). Color-coded green/yellow/red by days-until-expiry.                                                                                                                                                                      |
| **Reminders**                         | Auto-generated nags: "Pilot X medical expires in 7 days", "Pilot Y NVG currency lost", etc. Configurable cadence per category.                                                                                                                                                                             |
| **Duty Week**                         | Sun–Thu (RJAF work week) assignments: Main Duty pilot, Standby pilot, RCM. In LAN session mode, this reads from internal API `GET /api/internal/duty-week` instead of Supabase.                                                                                                                             |
| **Risk Assessment**                   | Daily mission risk form — weather, crew rest, environment factors. Required before flying.                                                                                                                                                                                                                 |
| **Coordinating Form**                 | Inter-unit coordination paperwork (e.g., when two squadrons share an airspace or asset).                                                                                                                                                                                                                   |
| **NOTAMs**                            | Squadron-relevant Notices to Airmen — local and external. Pushed to pilot phones.                                                                                                                                                                                                                          |
| **Nav Routes**                        | Approved navigation routes for training flights.                                                                                                                                                                                                                                                           |
| **PDF Exports**                       | One-click PDF of any printable form (front sheet, monthly report, schedule, etc.).                                                                                                                                                                                                                         |
| **Audit Log**                         | Every recorded action (who/when/action/details) with search + filter + paging. In LAN migration mode it reads from the internal API (`/api/internal/audit-log`) instead of Supabase so operators can validate local-only flow.                                                                                   |
| **Historical Import**                 | Bulk upload pre-Hawk-Eye CSV/XLSX data. 1-click undo for the most recent import.                                                                                                                                                                                                                           |
| **Archives**                          | Local cold storage of sorties older than 3 years — kept available, removed from the active query path.                                                                                                                                                                                                     |
| **Assigned Ops Pilots**               | Which pilots are currently posted to Ops duty.                                                                                                                                                                                                                                                             |
| **Messages**                          | Tier-to-tier private threads (Flight↔Squadron, Squadron↔Wing, Wing↔Base, Base↔HQ, plus Ops↔Wing). Auto-archive at 3 months.                                                                                                                                                                                |
| **Help & Getting Started**            | In-app onboarding for new operators.                                                                                                                                                                                                                                                                       |
| **Settings**                          | Per-PC config: language (EN/AR), squadron name/branding, printer setup, reminder cadence, link this PC to the squadron, register/revoke phones. Sign-out is always available from the shell (top bar on wide screens, sidebar action on compact screens).                                                                                              |
| **Connection Diagnostic** | In LAN mode, confirms local API reachability (`/api/healthz`) and LAN-session readiness. In cloud mode, still verifies the configured Supabase project + PC registry/heartbeat details. |


**Super Admin only:** Admin Overview, Devices & Users, Pending Devices, Squadrons, Security (2FA), Reminders Schedule.

### 3.1 v1.1.125 wiring and sync hardening (2026-04-25)

- **Squadrons page is now Supabase-backed for real writes.** Super Admin create/edit/delete/toggle now writes to `public.squadrons` and refreshes from DB; localStorage remains only as a cache/fallback for offline visibility.
- **Leaves page is now sync-safe across PCs.** Daily leave actions persist through the active backend path: Supabase in cloud mode, and `/api/internal/unavailable*` in LAN session mode (`GET /unavailable`, `POST /unavailable/upsert-day`, `DELETE /unavailable/day`). This keeps daily leave edits transport-aligned with the current login/backend mode instead of splitting cloud vs LAN behavior.
- **Cross-PC foundation:** a new migration grants Super Admin write RLS over `bases`, `wings`, and `squadrons`, so org-registry changes can be made from the app without service-role credentials.

### 3.2 v1.1.126 full-role reliability hardening (2026-04-25)

- **Super Admin Overview pilot counters are now live-data backed.** The admin overview derives pilot totals and expiry-warning counts from the shared pilot data path instead of static mock arrays, so role-level reliability checks reflect synchronized records.
- **Role-flow reliability matrix added.** `audit-evidence/2026-04-25/full-role-reliability/ROLE_FLOW_MATRIX.md` is now the explicit reference matrix for Ops, Flight, Squadron, Wing, Base, HQ, and Super Admin flow expectations used in regression audits.

### 3.3 v1.1.127 pending-device approval resilience (2026-04-25)

- **Super Admin Pending Devices approval is now idempotent against Auth races/collisions.** The `unit-approve-device` path now recovers when `auth.admin.createUser` races with an existing email by resolving/updating the existing account instead of failing the approval.
- **Approval now uses password-policy-safe placeholder credentials.** The temporary password stamped during approval explicitly satisfies stricter Auth password-class requirements before the joining laptop replaces it during claim.

### 3.4 Internal migration Step 3 — internal API health (2026-04-25)

- **Connection Diagnostic** can show an **Internal API (LAN migration)** card when a health URL is configured: Vite dev uses a same-origin proxy to `__hawk_eye_internal_api`; production can set `VITE_INTERNAL_API_URL` and must allow that origin in CSP `connect-src` for fetches to succeed.
- **Docs:** `docs/internal-migration/STEP-3-internal-api-kickoff.md` describes env vars and a two-terminal smoke test.

### 3.5 Internal migration Steps 4–5 + guest button tests (2026-04-25)

- **Parity matrix** (`docs/internal-migration/STEP-4-parity-matrix.md`) and **program status** (`docs/internal-migration/PROGRAM-STATUS.md`) record what must stay true and what is still to build for the internal-LAN cut.
- **Pending Approvals** — **Accept**, **Reject** (with reason), and **Drop** are covered by an automated offline interaction test (`tests/guest-pending-actions.test.ts`); **`Card`** now forwards attributes like `data-testid` to the DOM so tests and diagnostics match what operators see.

### 3.6 Internal migration reliability sweep — route button clicks (2026-04-25)

- Added `tests/button-sweep.test.ts` and wired it into `pnpm run test` as `test:buttons`. It mounts role routes in jsdom and clicks discovered controls to catch interaction-time crashes that first-render smoke alone cannot detect.
- Two commander dashboard data-grid routes (`/dashboard/pilots`, `/dashboard/currencies`) remain first-render covered by `sidebar-smoke` while deeper click automation for those grids is handled separately in browser-level suites.

### 3.7 Add Sortie smart consistency guardrails (2026-04-25)

- **Add Sortie** now runs a client-side consistency analyzer before save and shows a small “Smart checks” panel. It blocks only clear contradictions (e.g., Instrument total SIM+Actual greater than sortie time) and warns on suspicious patterns (e.g., sortie type/condition mismatch, unusually long time, very high dual share, unusually high same-aircraft count that date).
- Coverage: `tests/add-sortie-smart.test.ts` validates these rules as pure logic (no UI flakiness).

### 3.8 Flight schedule crew naming rule (2026-04-25)

- When composing or editing a flight schedule, pilot/co-pilot selections now save the roster **Flight Name** (not full personal name). If Flight Name is blank, schedule uses call sign; if both are blank, it uses pilot id.
- Coverage: `tests/schedule-names.test.ts` locks this rule (flight name first, never full-name fallback).

### 3.9 Internal data-plane kickoff for schedules (2026-04-25)

- Schedule composers can now consume pilot-options from internal API endpoint `GET /api/internal/pilot-options` (api-server), with local roster-derived fallback preserved.
- Endpoint resolves crew identifiers in this order: `flightName` → `callSign` → `id`.

### 3.10 Internal data-plane — squadron airframe defaults (2026-04-25)

- **`GET /api/internal/squadron-airframes?number=<squadron number>`** returns the same wizard fields the app already reads from Supabase `squadrons` (`base`, `wing`, `default_aircraft`, `default_monthly_targets`). When the internal API is enabled and returns a row, **`hydrateSquadronDefaultsFromDb`** applies it to the PC’s local defaults cache **before** trying Supabase; if the internal API is off or has no row, behaviour stays on the existing Supabase path.
- **Tests:** `tests/squadron-defaults-merge.test.ts` locks the merge rules (empty aircraft list vs populated list, fuel burn, six-month floor from monthly targets).

### 3.11 Internal data-plane — Super Admin squadron registry list (2026-04-25)

- **`GET /api/internal/squadrons`** returns every squadron row (`id`, `number`, `name`, `base`, `wing`) ordered by name — the same shape Super Admin uses when refreshing the squadron list from Supabase.
- **`refreshSquadronsFromDb`** tries this first; it **only** replaces the local mirror when the internal response has **at least one** squadron, so an empty mis-provisioned LAN database cannot wipe a real Supabase-backed org during hybrid operation. If internal is off, errors, or returns an empty list, the app keeps the existing Supabase read path.
- **Tests:** `tests/squadron-remote-rows.test.ts` (`squadronsFromRemoteRows`) locks wing/base/code mapping (including null wing to the UI placeholder).

### 3.12 Internal data-plane — pilot roster (full row) (2026-04-25)

- **`GET /api/internal/pilots`** returns every column the roster needs from the internal database (same information the app used to pull from the internet database).
- The **pilot list on screen** tries this internal path first when the internal server returns **at least one** pilot; otherwise it keeps using the existing internet-database path so an empty test server never hides a real squadron roster.

### 3.13 Internal data-plane — sortie log read when LAN writes are on (2026-04-25)

- **`GET /api/internal/sorties`** returns the most recent sortie rows from the internal database (newest first, capped like the cloud query, default 500).
- When the squadron turns on **internal writes** for the migration (`VITE_INTERNAL_WRITES` plus a working internal API URL or dev proxy), the **sortie list** (`useSorties`) loads from this endpoint first so hours logged on the LAN database stay visible on screen. If that read fails or internal writes are off, behaviour stays on the existing Supabase path.
- **Pilot roster writes** and **sortie create/update/delete** can already target the internal API when the same write flag and optional shared secret are configured — see `docs/internal-migration/STEP-6-internal-api-data-plane.md` and Connection Diagnostic env notes.

### 3.14 Internal base-LAN session API (2026-04-26) — first step off Supabase Auth (api-server)

- The monorepo **`artifacts/api-server`** can host **operator sessions for the private base network** in Postgres tables `lan_users` and `lan_sessions` (no public internet, not Supabase Auth).
- **Bootstrap (one-time, on an empty install):** `POST /api/internal/auth/lan/bootstrap` with a server-side token `HAWK_LAN_BOOTSTRAP_TOKEN` plus the first username/password. This is only for the very first user on a fresh internal database.
- **Sign-in:** `POST /api/internal/auth/lan/login` returns a **session token**; clients may send it as `x-hawk-lan-session` (or `Authorization: Bearer ...`) to internal data routes.
- **Dashboard opt-in:** set `VITE_LAN_SESSION_LOGIN=1` **and** a working internal API base (dev proxy or `VITE_INTERNAL_API_URL`). The normal username/password screen then authenticates against the LAN session API, stores the token in `rjaf.lanSessionToken`, and treats **Supabase Auth as unused** for that build (ops PCs also skip the legacy license-key gate while this flag is on — the LAN session proves the workstation is enrolled for private-network installs).
- **Session lifecycle in LAN mode:** idle timeout logout and explicit shell logout both clear the LAN token and call LAN logout endpoints; they no longer depend on Supabase-only session paths.
- **First screen:** when LAN login is enabled, the app **opens straight on the sign-in form** (no cloud “first launch” / join gate). Sign-in uses **both** username and password in the usual two fields — the same pair you created with LAN bootstrap (or any account in `lan_users`), not the PostgreSQL database password.
- **Route safety:** if a user manually opens cloud bootstrap/join pages while LAN mode is enabled, those screens now show a LAN-mode notice and route them back to `/login` instead of offering cloud-only actions.
- **Startup safety in LAN mode:** if old cloud join-pending keys are still in local storage, the shell now clears them and opens LAN login directly (no accidental `/join/waiting` lock-in).
- **First-launch copy in LAN mode:** the old cloud CTAs are now explicitly labeled as unavailable in LAN mode, and the persistent fallback button is renamed to **LAN sign-in** so operators are not asked to use cloud language on private-network installs.
- **Join-waiting fail-closed in LAN mode:** if someone deep-links to `/join/waiting` during LAN login migration, the app clears stale join-pending data and returns to `/login` instead of showing Supabase approval polling.
- **Reminder admin pages in LAN mode:** schedule/log now call internal API routes (`/api/internal/reminders/status`, `/api/internal/reminders/action`, `/api/internal/reminders/log`) instead of Supabase edge functions, so operators can refresh, enable/disable, and run-now from the LAN backend.
- **Settings lifecycle in LAN mode:** `Release license` is intentionally disabled (LAN sessions are not license-key driven). `Reset this PC` and idle/session teardown now also clear LAN sessions, not only Supabase/browser state.
- **Logout consistency:** explicit Sign out now always clears local LAN session token (and attempts LAN logout when enabled) so next user starts from a clean session.
- **Diagnostic page in LAN mode:** “Connection Diagnostic” now prioritizes LAN health (internal API reachability + workstation identity). The cloud registry table is hidden in LAN mode until cross-PC registry migration is complete, to avoid misleading Supabase-first diagnostics on local-network installs.
- **Connections surfaces in LAN mode:** `Connections` and Super Admin `Connection Map` remain available (they are still operational tools for commander/ops routing), but now show explicit LAN-mode guidance so operators are not told cloud-first troubleshooting steps.
- **Admin Audit Log in LAN mode:** Super Admin audit view now reads internal API audit rows and applies actor/type/date filters locally, so cloud `audit_log` queries are no longer required when LAN login is active.
- **Admin Overview in LAN mode:** pilot-status totals now hydrate from internal pilot rows (`/api/internal/pilots`) instead of cloud `pilots` reads.
- **Pending Devices page in LAN mode:** cloud join approval workflow is fail-closed with explicit LAN copy; it remains visible only as migration tracking UI, because LAN account login replaces cloud pending-device approvals.
- **Devices & Users page in LAN mode:** cloud member/device lifecycle management is fail-closed with explicit LAN migration copy (LAN accounts/sessions are now the active lifecycle source).
- **Squadrons page in LAN mode:** squadron registry writes now stay local/internal in LAN session mode (cloud writeback is skipped), with explicit operator copy on the page.
- **Internal write authz hardening:** pilot/sortie write routes now enforce LAN role and squadron scope when a LAN session user is present (`ops/admin/super_admin` writes only; ops cannot write foreign squadron rows).
- **Internal write audit hardening:** pilot/sortie/reminder write actions now append LAN-local audit events (`internal.pilots.*`, `internal.sorties.*`, `internal.reminders.*`) when `audit_log` is available.
- **Security actions in LAN mode:** super-admin password/recovery flows no longer force cloud edge-function paths when LAN session mode is active, even if cloud env vars are still present.
- **Cross-PC registry in LAN mode (new transport slice):** heartbeat upsert and registry reads now have internal API routes (`/api/internal/xpc/registry/heartbeat`, `/api/internal/xpc/registry`) and dashboard cross-PC hooks (`registerLocalPC`, `useRegisteredPCs`, `useRegisteredPCsIncludingStale`) now prefer these LAN routes whenever LAN session mode is active.
- **Clear all registered PCs in LAN mode:** Super Admin `Clear all registered PCs` now also wipes the **central LAN registry rows** (not only local mirror) through internal API `DELETE /api/internal/xpc/registry`, while preserving the current PC unless explicit include-self wipe is requested.
- **Cross-PC messages in LAN mode (new transport slice):** message thread reads, send, and mark-read now have internal API routes (`/api/internal/xpc/messages`, `/api/internal/xpc/messages/read`) and dashboard message hooks (`useMessages`, `useSendMessage`, `useMarkMessageRead`) now prefer these LAN routes whenever LAN session mode is active.
- **Guest pending handoff in LAN mode (new transport slice):** pending sorties list/read, submit, decision updates, and military-number backfill now have internal API routes (`/api/internal/xpc/pending`, `/api/internal/xpc/pending/update`) and dashboard pending hooks now prefer these LAN routes whenever LAN session mode is active.
- **Schedule chain in LAN mode (new transport slice):** schedule-share list/read, submit, mutation updates, and delete now have internal API routes (`/api/internal/xpc/schedule-shares`, `/api/internal/xpc/schedule-shares/:id`) and dashboard schedule hooks now prefer these LAN routes whenever LAN session mode is active.
- **Commander snapshot rollups in LAN mode (new transport slice):** snapshot publish + read now have internal API routes (`/api/internal/xpc/snapshots`) and dashboard snapshot hooks/probes now prefer these LAN routes whenever LAN session mode is active.
- **Diagnostic registry in LAN mode:** the Connection Diagnostic registry table now reads from internal LAN registry rows in LAN session mode (same stale-window semantics), instead of requiring direct Supabase table reads.
- **Connections + Connection Map pairing in LAN mode (new transport slice):** pairing-code issue/redeem, pair list reads, pair audit reads, admin pair create/revoke/permanent toggle/reset/bulk/sweep are now served by internal LAN API routes (`/api/internal/xpc/pairs/*`) and dashboard `pairs.ts` now prefers these routes whenever LAN session mode is active.
- **Ops board content in LAN mode (new transport slice):** Alerts, NOTAMs, and today’s Schedule now have internal LAN API routes (`/api/internal/alerts`, `/api/internal/notams`, `/api/internal/schedule`) and dashboard hooks prefer these routes whenever LAN session mode is active.
- **Duty-week archive in LAN mode (new transport slice):** saved duty-week history now uses internal LAN API routes (`/api/internal/saved-duty-weeks`, `/api/internal/saved-duty-weeks/old`) so read/save/retention cleanup runs on LAN storage in session mode.
- **Mobile pairing operations in LAN mode (new transport slice):** pilot link status, one-time code issue, device revoke, and roster paired-dot status now use internal LAN API routes (`/api/internal/pilot-links/*`) so mobile-link management no longer depends on cloud table/RPC paths when LAN session mode is active.
- **Monthly Report Defaults in LAN mode:** saving defaults now avoids cloud `squadrons` upsert and stays on LAN/local persistence paths when LAN session mode is active.
- **Users + Reminders overview in LAN mode (new transport slice):** squadron user list/create and pilot reminder overview now use internal LAN API routes (`/api/internal/users`, `/api/internal/reminders/overview`) so those admin/ops surfaces do not query cloud tables in LAN session mode.
- **Historical Import in LAN mode (new transport slice):** CSV import and one-click undo now use internal LAN API routes (`/api/internal/import/history`, `/api/internal/import/undo`) so backfill workflows work without cloud writes in LAN session mode.
- **Pilot transfer in LAN mode (new transport slice):** inter-squadron pilot transfer now uses internal LAN API (`/api/internal/pilots/transfer`) instead of cloud RPC in LAN session mode.
- **Core roster/sortie CRUD in LAN mode:** pilot and sortie read/write hooks now prioritize internal LAN API transport whenever LAN session mode is enabled (not only under the earlier optional internal-write flag).
- **LAN fail-closed reads for pilots/sorties:** in LAN session mode, pilots/sorties views now read internal API only (no silent cloud fallback when internal API is unavailable).
- **LAN data presentation hardening:** internal-backed hooks in LAN mode now avoid temporary mock/demo seed rows (pilots, sorties, users, reminders, audit list, alerts, NOTAMs, duty week, leaves, unavailable, schedule, saved duty weeks) so operators see only real LAN server data.
- **Add Sortie usability hardening:** when squadron aircraft defaults are not configured yet, Add Sortie stays editable and accepts manual A/C type entry (warning banner remains) instead of freezing the full form.
- **LAN auth teardown hardening:** in LAN session mode, logout/reset/idle timeout paths now avoid cloud sign-out calls and use local/internal session teardown only.
- **LAN hardening for background cloud sync paths:** in LAN session mode, dashboard background cloud paths are now disabled for license-registry mirror sync, offline outbox flush, runtime error RPC reporting, and pending-device realtime badge polling to avoid hidden Supabase coupling during LAN operation.
- **LAN hardening for cloud helper wrappers:** in LAN session mode, central Supabase helper wrappers now fail closed (`validateLicenseRemote`, `registerLicenseRemote`, `provisionCommanderRemote`, `resyncSupabaseCreds`) and `recordAuditEvent` skips cloud writes, so accidental LAN-path calls cannot silently reach cloud services.
- **LAN hardening for legacy cloud join path:** `unit-join` RPC/function helpers are now explicitly disabled when LAN session mode is active (`unitJoinConfigured` false + guarded RPC wrappers), preventing accidental cloud join/bootstrap calls during LAN operation.
- **Hardening switch:** when `HAWK_INTERNAL_SESSION_AUTH=required` on the server, all **`/api/internal/*` data routes** require a valid session **except** the `auth/lan/*` routes. When unset/`off` (the default for hybrid migration work), those routes stay open for lab/bring-up (still private LAN, but not a security posture to rely on). The dashboard’s internal client helpers attach `x-hawk-lan-session` from `localStorage` key `rjaf.lanSessionToken` whenever it is set.
- **Temporary no-security bring-up mode (explicit):** set server `HAWK_LAN_DEV_NO_AUTH=1` plus dashboard `VITE_LAN_NO_AUTH=1` (with `VITE_LAN_SESSION_LOGIN=1`) to allow login **without password checks** via `POST /api/internal/auth/lan/dev-session`. This is only for migration/debug sessions and should be removed for real operations.
- In this no-security mode, the login screen shows one-click local entry buttons (**Super Admin / Ops / Cmdr**) so operators can test routes without typing username/password at all.

---

## 4. What a sortie is, exactly

A **sortie** is one logged flight. Fields:

- **Date** + **aircraft type** (UH-60M, Bell 407, AH-1F, MD500, etc.) + **tail number**
- **Crew:** Pilot (P1, usually Captain) + Co-Pilot (P2). Optionally a third (instructor).
- **Sortie type:** MSN (mission), TRG (training), SAR, MEDEVAC, IRT (Instrument Rating Test), Stand Eval, etc. The type drives auto-credit rules (see section 5).
- **Conditions:** Day / Night / NVG (Night Vision Goggles). NVG is tracked **separately** from Night.
- **Times:** Block Off → Takeoff → Landing → Block On (HH:MM 24h). Total time = Landing − Takeoff.
- **Other:** route, mission/duty notes, fuel, ATC use (takeoff + landing airfields), remarks, classification.

**Guest pilots** have no row in this squadron's roster. They're recorded as `pilotExternal: { name, military_number, home_squadron }` and a parallel record is sent to their home squadron's Ops PC for confirmation (see section 7).

---

## 5. How hours are calculated

**Per-seat credit:** both pilots get the full cockpit time. There is no "split". If a sortie is 3.5h, both seats book 3.5h.

**Captain bucket:** only the seat flagged as Captain (usually P1) gets Captain hours.

**Day / Night / NVG bucket:** decided by the sortie's Conditions tag.

- Tagged Day → goes to **Day** bucket.
- Tagged Night → goes to **Night** bucket.
- Tagged NVG → goes to **NVG** bucket. NVG and Night are independent buckets.

**Dual hours (instructor time) — auto-credit rule:** for these six sortie types, the co-pilot's seat is automatically marked Dual:
IRT, Stand Eval, Check Ride, Instructor Upgrade, Mission Qualification, Type Conversion. (Source of truth: `.local/memory/dual-hour-rules.md`.)
Day Dual / Night Dual / NVG Dual are separate buckets from plain Day/Night/NVG.

**Initial Hours:** the lifetime hour total a pilot brought into Hawk Eye when they were first added. Recorded once per pilot per bucket (Day, Night, NVG, total, plus per-aircraft breakdown if known). Combined with logged hours for the **Grand Total** displayed on PDFs and the mobile app. Does NOT influence currency expiry — only logged sorties move currency dates. (Source of truth: `.local/memory/initial-hours.md`.)

**Half-year split (H1 / H2):** Jan–Jun = H1, Jul–Dec = H2. Annual targets are split per half.

**Guest hours:** a guest pilot's hours flow to **their home squadron**, not the hosting one. The hosting squadron credits the local pilot they were paired with for the full cockpit time.

---

## 6. Currency tracking

Each pilot has six "last flown / last passed" dates:

1. Last Day flight
2. Last Night flight
3. Last NVG flight
4. Last IRT (Instrument Rating Test)
5. Last Medical
6. Last Simulator

Each currency has a **window** (e.g. Night = 30 days, Medical = 365). If `today − last > window`, the pilot is **Expired** for that currency and shows red. Yellow at 80% of the window. Green otherwise.

When a sortie is logged, the matching currency dates auto-refresh. (Source of truth: `.local/memory/currency-refresh.md`.)

---

## 7. Schedule chain — how a flight schedule travels up

### 7.1 Operator-stated authoritative chain (v1.1.94, captured verbatim)

The operator described the schedule chain as follows. This is the **contract** the system must satisfy; any divergence in code is a bug.

```
Ops Officer ──draft & send──► Flight Cmdr ──edit-bounce──► Ops
                                  │                         (Ops re-edits, returns)
                                  │ approve
                                  ▼
                              Sqn Cmdr ──edit-bounce──► Flight Cmdr
                                  │
                                  │ approve
                                  ▼
                              Wing Cmdr ──edit-bounce / forward
                                  │
                                  │ approve
                                  ▼
                              Base Cmdr ──FINAL APPROVE──► archived for that
                                                            specific day +
                                                            specific squadron
```

Either **Ops** or **Flight Cmdr** can be the originator. Edit-bounces always return one tier downward. Final storage happens on **Base Cmdr's approve**, not Wing's.

### 7.2 What the code does today (v1.1.94 baseline — known divergences)

The current `useDecideSchedule` enforces a **4-tier** chain `flight | squadron | wing | base` where:

- `flight → squadron` and `squadron → wing` are the only forward hops.
- **Wing tier is terminal** — Wing's Approve releases the sheet to Base/HQ as **read-only viewers** via `canViewFinalSchedules`. Base does not have a separate Approve action.
- **There is no separate "ops" tier**: Ops officers operate the squadron-tier PC. Edit-bounces from Sqn Cmdr land on the squadron PC where the Ops officer sits.

**Reconciled in v1.1.96 — operator confirmed:**

1. **Ops is NOT a separate tier** — one Officer PC per squadron, the Ops officer sits there.
2. **Wing → Base forward + Base Approve = final archive — WIRED** (cross-pc.ts:1659; UI was already present at ScheduleChain.tsx:651-700, only the throw was blocking it).
3. **Wing.approve without Base forward also stays valid** — operator: "if the wing commander didn't want to send it to the base commander, it's OK; it will be saved on that day for that specific squadron."
4. **Wing edit-bounce → Sqn Cmdr** — verified live; root cause of the persistent 42501 was the `audit_log` policy (not the schedule policy), fixed in migration 0036.

**Live-verified end-to-end (5/5) on v1.1.96:** ops submit → sqn→wing → wing→base → base.approve → ops sees final approval.

### 7.3 Common rules at every tier

- **Any participating PC** can view the full history (every action, who did it, when).
- **Reject** sends the sheet back to the originator with a reason.
- **Hold** pauses with a note.
- **Edit** attaches edited rows + bounces one tier down for re-approval (the receiver must accept the diff).
- **Delete** can be issued by any PC that has touched the share (v1.1.60 widening) — wipes from every screen with one click.

---

## 8. Cross-PC / messaging

**Active vs offline:** a PC is "active" if its `xpc_registry.last_seen` is within 90 seconds. Offline PCs are still pingable — messages and shares queue and deliver when they next come online. (Source of truth: `.local/memory/active-pc-visibility.md`.)

**Messages:** plain text threads, sender + recipient. Allowed pairs: any two roles in the chain (Flight↔Squadron, Squadron↔Wing, Wing↔Base, Base↔HQ, Ops↔Wing). Mark-as-read, move-to-history, delete. Auto-purge at 3 months.

**Guest-pilot handoff:**

1. Hosting Ops logs a sortie with a guest pilot (military number + home squadron).
2. A row is inserted into `xpc_pending` for the home squadron.
3. Home Ops PC sees it in their Pending list with the guest's name + military number + which seat they sat in.
4. Home Ops **Accepts** (hours flow into the guest's home totals via the same calc engine), **Rejects** (with reason), **Edits** (corrects hours then accepts), or asks for a **military-number backfill** if the hosting squadron didn't have it.

---

## 9. Monthly Report — what's in it

Generated for any calendar month, with optional manual overrides for the non-flying numbers (lectures, ammo, morale).


| Sheet           | What it shows                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Form 1**      | Per-pilot monthly breakdown: Day / Night / NVG hours per seat, Captain hours, Dual hours, sortie counts, total cockpit time. One row per pilot.                                                 |
| **Form 2**      | Per-pilot currency state at month-end + cumulative lifetime totals (logged + initial hours).                                                                                                    |
| **Form 3**      | Squadron-wide mission totals: GH (general hours), IF (instrument flying), NF (night flying), per-aircraft type. Planned vs achieved.                                                            |
| **Form 4**      | Next month's training plan: hours target per pilot, fuel-burn projection, ammunition requirements per weapon system.                                                                            |
| **Front Sheet** | Day/NVG schedule recap, with the duplex-print rule that ensures Day fills the front and NVG starts on the back (`page-break-after: right`). (Source of truth: `.local/memory/print-system.md`.) |


All sheets export to PDF (printable) and XLSX (editable). The XLSX export is round-trippable — the same file can be re-imported via Historical Import. Aggregation uses the live Sortie Log as the source of truth; no double-bookkeeping.

---

## 10. Where to look for more detail

- `**.local/memory/`** — settled rules per area (dual-hour, initial-hours, multi-squadron, currency-refresh, print-system, release-process, supabase-admin, active-pc-visibility, add-pilot-form, phone-pair-indicator, reminders-wording, user-management). **These override everything else when there's a conflict — they are operator-settled truth.**
- `**.local/HAWK-EYE-OVERNIGHT-MASTER-REPORT.md`** — what was built in each version v1.1.75 → present.
- `**AGENTS.md`** — the must-read briefing on do-nots, test commands, migration recipe.
- `**replit.md`** — full project overview, brand assets, workflow inventory.
- **Code source-of-truth files:**
  - `artifacts/pilot-dashboard/src/lib/cross-pc.ts` — every cross-PC interaction (schedule chain, messages, guest pilots, registry, claims).
  - `artifacts/pilot-dashboard/src/lib/squadron-data.ts` — local squadron state (roster, sorties, currency).
  - `artifacts/pilot-dashboard/src/lib/monthly-report.ts` — Form 1–4 builders.
  - `artifacts/pilot-dashboard/src/pages/` — every page in the menu.

---

**When this document is wrong, fix it.** The instant a domain rule changes, update the matching `.local/memory/<area>.md` file AND this guide. Future agents (and future you) depend on it.