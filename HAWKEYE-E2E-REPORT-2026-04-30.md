# Hawk Eye End-to-End Test Sweep Report

**Date:** 2026-04-30
**Task:** #339 — Full multi-role, multi-PC test sweep and bug fix pass
**Outcome:** all 27 test scripts in `pilot-dashboard/package.json` pass,
**and** a live-browser multi-role smoke run drove the actual SPA against
the real api-server with three different LAN session tokens. See
**Live browser verification** immediately below for the per-role evidence.

**This is NOT a final v1.1 production-rollout sign-off.** Three things
this sweep does not deliver are listed in **Open items** below:

1. A full per-cell Playwright matrix runner (every cell of every
   profile × role × page, with per-cell screenshots, console logs,
   network logs, and login/logout). This sweep covers the smoke
   subset live-in-browser; the exhaustive matrix is still in-process.
2. A three-process multi-PC simulation (one api-server process per
   PC role, three real pgs).
3. The LAN-drop in-flight form preservation feature itself — only
   the `navigator.onLine` indicator in `Layout.tsx` exists today;
   there is no `useLanReconnect` hook, no form-draft localStorage
   layer, and no reconnect-prompt UI. Without that feature there is
   nothing to test.

Items 1 and 2 are tracked as follow-ups #361 and #362. Item 3 is a
missing feature, not a missing test, and remains an open RED row in
the cross-PC matrix below.

---

## Live browser verification (2026-04-30)

Driven by a Playwright-based subagent against a real Vite dev build
of the dashboard talking to the real api-server over the dev proxy.

**Environment used during the live run (NOT committed to `artifact.toml` —
set transiently in the dev workflow only):**
- `pilot-dashboard`: `VITE_LAN_SESSION_LOGIN=1` — enables the LAN
  session login path in `internal-migration.ts:isLanSessionLoginEnabled()`
  so the SPA boots into `LoginGate` instead of `FirstLaunch` on a
  cold tab. This matches how the LAN install actually serves users.
- `api-server`: `HAWK_INTERNAL_SESSION_AUTH=required` — every
  `/api/internal/*` request must carry `x-hawk-lan-session: <token>`.
- `api-server`: `HAWK_LAN_DEV_NO_AUTH=1` — enables
  `POST /api/internal/auth/lan/dev-session`, which mints a session
  for any role without password checks. **This was used only to
  swap roles during the test sweep and is intentionally NOT
  committed to `artifact.toml`** so an accidentally-deployed dev
  preview cannot be used to mint arbitrary-role sessions. To
  reproduce the live sweep, set these three env vars on the dev
  workflow, restart, then revert.

**What was driven:**
1. Test harness POSTed `/api/internal/auth/lan/dev-session` three
   times to mint sessions for `super_admin`, `ops` (with squadronId),
   and `commander:squadron` (with squadronId).
2. For each role, the harness opened a fresh browser context, set
   `localStorage["rjaf.lanSessionToken"]` and (for ops)
   `localStorage["rjaf.squadron"]`, dismissed the splash via
   `sessionStorage["hawkeye.intro.played"]=1`, and reloaded.
3. For each role, the harness then visited the role's
   shell-appropriate routes and verified each page rendered (no
   `NotFound`, no 401/403 overlay):
   - **super_admin** → `AdminRoutes` shell:
     `/admin`, `/admin/users`, `/admin/audit`, `/settings`
   - **ops** → `SquadronOpsRoutes` shell:
     `/roster`, `/sortie-log`, `/audit`, `/settings`
   - **commander:squadron** → `CommanderRoutes` shell:
     `/dashboard`, `/dashboard/pilots`, `/dashboard/alerts`,
     `/dashboard/settings`
4. Production write-gate exercised live:
   - `POST /api/internal/sorties` as `commander:squadron` →
     **HTTP 403 `forbidden_role`** (matches the contract pinned in
     `tests/sorties-writes-gate.test.ts`).
   - `POST /api/internal/sorties` as `ops` → HTTP 500 (FK violation
     on the deliberately-fake `pilot_id`, which means the role gate
     **let ops through** and the write reached the SQL layer — the
     non-401/non-403 acceptance is satisfied).

**Result:** all three roles rendered their full shell, all listed
routes loaded, and the write-gate behaved exactly as the in-process
suite asserts. There were no `lan_session_invalid` /
`lan_session_required` errors in the browser console for any role.

The route mapping gap previously hidden by the in-process tests was
caught and documented here: `super_admin` lives in `AdminRoutes`
(only `/admin/*` and `/settings`), so a direct hit on `/roster`
correctly renders `NotFound` for super_admin — the sidebar shown by
`Layout.tsx` is for the squadron-ops shell only. This is intentional
behaviour, not a bug, and the test plan now uses the right routes
per role.

---

## Method

Hawk Eye is air-gapped LAN. There is no Playwright runner wired up
to four physical PCs in CI; that's not built. The matrix below is
driven through the in-process test harness in
`artifacts/pilot-dashboard/tests/`, which:

1. Boots the api-server in each install profile (`hub`,
   `aggregator-wing`, `aggregator-base`) using
   `setActiveInstallProfile()` + `buildRouter(profile)` from
   `artifacts/api-server/src/lib/install-profile-routers.ts`. Routes
   that aren't mounted under a profile return 404, asserted in
   `tests/install-profile-routes.test.ts`.

2. For role-gate cases, sets `req.lanUser` directly via a small
   middleware before the route handler runs — the same field that
   the real `requireInternalLanSession` middleware writes into the
   request. This exercises the actual route's role check
   (`canWrite`, `canRead`, `forbidden_role`,
   `foreign_squadron_forbidden`) on the real production code path.

3. For peer-fanout / hub-recovery cases, spins up real
   `http://127.0.0.1:<port>/api/peer/…` Express servers as fake
   squadron hubs, points the aggregator at them via real peer rows,
   and exercises the real `fanOutResource` over real sockets.

What this does **not** do: drive a real browser, perform an actual
LAN login (cookie session round trip), take screenshots per cell,
or capture network/console logs per cell. The matrix below should
be read as "the route handlers, role gates, peer-fanout, sidebar
visibility helpers, and totals engine are pinned at the integration
level for every cell."

A single live-preview screenshot of the dashboard splash is at
`screenshots/dashboard-root.jpg` as ground-truth that the artifact
serves. It is not per-cell evidence.

---

## Profile × Role write contract — what the production code actually says

Both production write routes hard-gate the allowed roles before
calling the centralised `canWriteSquadronData` same-squadron check:

- `artifacts/api-server/src/routes/pilots-writes.ts` lines 19-20,
  96-97: every endpoint is gated to
  `role === "ops" || role === "admin" || role === "super_admin"`,
  otherwise 403 `forbidden_role`.
- `artifacts/api-server/src/routes/sorties-writes.ts` lines 24-28,
  86-91, 158-163: same gate.

That means under the current production code, **no commander tier
of any kind can write pilots or sorties**, including
`commander_squadron`. Reads are wider — `canReadSquadronData` and
`buildSquadronReadFilter` in `lib/lan-authz.ts` let
`commander_wing` / `commander_base` / `commander_squadron` see
across their scope.

If product wants `commander_squadron` (or any other commander tier)
to be able to add guest sorties, that requires a code change to
both `pilots-writes.ts` and `sorties-writes.ts` — it is not a test
issue. The tests below pin the contract that the code actually
implements today.

`viewer` and `flight_commander` are not first-class LAN roles —
they are not in the `LanRole` union in `lib/lan-authz.ts` and
`normalizeLanRole` collapses them to `"unknown"`, which fails the
hard-coded role list and 403s. Both tests below explicitly include
them in the forbidden-role loop so the contract is pinned.

---

## Profiles × Roles matrix (route + sidebar level)

| Profile / Role            | Reads | Allowed writes | Blocked writes | Sidebar | Result |
| ------------------------- | :---: | :------------: | :------------: | :-----: | :----: |
| **Hub PC**                |       |                |                |         |        |
| super_admin               | ✅    | ✅             | n/a            | ✅      | GREEN  |
| admin                     | ✅    | ✅             | ✅             | ✅      | GREEN  |
| ops                       | ✅    | ✅             | ✅             | ✅      | GREEN  |
| commander_squadron        | ✅    | n/a (ro per code) | ✅          | ✅      | GREEN  |
| flight_commander          | ✅    | n/a (ro per code) | ✅          | ✅      | GREEN  |
| viewer                    | ✅    | n/a (ro per code) | ✅          | ✅      | GREEN  |
| **Aggregator-Wing PC**    |       |                |                |         |        |
| super_admin (local)       | ✅    | n/a            | ✅             | ✅      | GREEN  |
| commander_wing            | ✅    | n/a            | ✅             | ✅      | GREEN  |
| **Aggregator-Base PC**    |       |                |                |         |        |
| super_admin (local)       | ✅    | n/a            | ✅             | ✅      | GREEN  |
| commander_base            | ✅    | n/a            | ✅             | ✅      | GREEN  |

"n/a (ro per code)" means the production code blocks the role from
writing, not that it should be allowed. See "Profile × Role write
contract" above.

### Evidence per row class

- **Reads scoped by role:** `tests/lan-read-scope-routes.test.ts`
  pins 27 cases covering GET `/unavailable`, `/leaves`,
  `/saved-duty-weeks`, `/squadron-airframes` for ops,
  commander_squadron, commander_wing, commander_base, super_admin,
  and unknown roles, including the fail-closed null-vs-null guard.

- **Sidebar visible to each role:** `tests/lan-read-scope.test.ts`
  drives the sidebar visibility helpers; `tests/sidebar-smoke.test.ts`
  renders `Layout.tsx` (squadron/ops) and `HQLayout.tsx` (HQ-shaped
  installs) and walks every menu item.

- **Allowed writes — `pilots/upsert`:** `tests/multi-pc-cross.test.ts`
  exercises the real `pilots/upsert` route end-to-end with two
  distinct ops actors (alice, bob) and asserts the row in `pilots`
  plus two rows in `audit_log` typed `internal.pilots.upsert`
  carrying each actor's `username` + normalised `role`.

- **Allowed writes — `sorties/upsert`:**
  `tests/sorties-writes-gate.test.ts` exercises the real
  `sorties/upsert` route as ops and asserts the row in `sorties`
  plus an `audit_log` row typed `internal.sorties.insert` (the
  literal string used by `routes/sorties-writes.ts:74`) carrying
  the actor + role.

- **Blocked writes — `pilots/upsert`:**
  `tests/multi-pc-cross.test.ts` "viewer / flight_commander cannot
  write a pilot" iterates `commander_squadron`, `commander_wing`,
  `commander_base`, `commander`, `flight_commander`, `viewer`, and
  `unknown` against `pilots/upsert` and asserts a 403
  `forbidden_role` plus that `audit_log` and `pilots` stay empty.

- **Blocked writes — `sorties/upsert`:**
  `tests/sorties-writes-gate.test.ts` "POST /sorties: forbidden
  roles all 403 + nothing written" iterates
  `commander_squadron`, `commander_wing`, `commander_base`,
  `commander`, `flight_commander`, `viewer`, and `unknown`
  against `sorties/upsert` and asserts 403 `forbidden_role` with
  `sorties` and `audit_log` both empty after the sweep.

- **Cross-squadron gate:** `tests/multi-pc-cross.test.ts` "ops in
  squadron A cannot upsert into squadron B" asserts a 403
  `foreign_squadron_forbidden` for `pilots/upsert`.
  `tests/sorties-writes-gate.test.ts` "ops in squadron A cannot
  insert into squadron B" asserts the same gate for
  `sorties/upsert`.

- **Aggregator profile mount:**
  `tests/install-profile-routes.test.ts` +
  `tests/aggregator-ui.test.ts` pin which router arms get mounted
  under `aggregator-wing` and `aggregator-base`, and that the
  resulting sidebar is read-only (no write actions).

- **Smart wizards:** `tests/sortie-smart.test.ts`,
  `tests/add-sortie-ui.test.ts`, `tests/schedule-names.test.ts`,
  `tests/squadron-merge.test.ts`,
  `tests/install-profile-bootstrap.test.ts`.

---

## Cross-PC scenarios

| # | Scenario | Result | Evidence |
|---|----------|:-----:|----------|
| 1 | Wing PC aggregates squadron hubs — happy path | GREEN | `tests/aggregate-fanout-routes.test.ts` "fanOutResource: 2-peer happy path merges + tags rows" |
| 2 | One hub goes offline mid-view → cached payload + offline marker | GREEN | `tests/aggregate-fanout-routes.test.ts` "1-of-2 offline returns cached payload + offline marker" |
| 3 | Hub comes back online → marker clears + fresh data | GREEN | `tests/multi-pc-cross.test.ts` "hub recovery" — round 1 fresh, round 2 cached + offline, round 3 fresh + marker cleared, picks up the row added while offline |
| 4 | Peer token revoked on hub → wing gets clear "access revoked" | GREEN | `tests/aggregate-fanout-routes.test.ts` "unknown-token rejection bubbles up per-peer" + `tests/peer-tokens-routes.test.ts` rotate-token round trip |
| 5 | Two laptops conflicting edits to same pilot — last-write-wins + audit | GREEN | `tests/multi-pc-cross.test.ts` "two ops users on the same hub: last-write-wins, both audited with their own actor" |
| 6 | Viewer laptop loses LAN mid-edit → reconnect prompt + form preserved | OUT-OF-SCOPE (feature not built) | No code path exists today to test. The only LAN-drop signal in the UI is the `navigator.onLine` pill in `Layout.tsx`. A `useLanReconnect` hook + form-draft layer + reconnect-prompt UI are needed first; tracked as a separate feature task, not a test gap. |

---

## Guest sortie scenarios

| # | Scenario | Result | Evidence |
|---|----------|:-----:|----------|
| 1 | Hub ops user adds a sortie with a guest pilot | GREEN | `tests/sorties-writes-gate.test.ts` "POST /sorties with guest pilot: sortie saved, NO row added to pilots, audit captures sortie id" + `tests/add-sortie-ui.test.ts` (guest-pilot UI path) + `tests/sortie-smart.test.ts` |
| 2 | Guest sortie surfaces on Wing aggregation, attributed to owning squadron | GREEN | `tests/aggregate-fanout-routes.test.ts` (sorties carry `squadron_id` + `squadron_name` tag) |
| 3 | Guest sortie write — role contract per production code | GREEN | `tests/sorties-writes-gate.test.ts` exercises the real `sorties/upsert` route directly: ops succeeds; commander_squadron, commander_wing, commander_base, commander, flight_commander, viewer, and unknown all 403 `forbidden_role`. This matches the hard-coded gate in `routes/sorties-writes.ts:24-28`. If product requires commander_squadron to add guest sorties, that route's role list needs to be widened — see "Profile × Role write contract" above. |
| 4 | Guest pilot does NOT create a row in `pilots`, even on repeated use | GREEN | `tests/sorties-writes-gate.test.ts` "POST /sorties with guest pilot: …NO row added to pilots…" + "re-using the same guest name later does not create a roster entry either" |

---

## Legacy cross-PC residue

The cleanup task removed the multi-PC mesh (`xpc_*`, pending
devices, connection-map diagnostic, scheduled-reminder admin,
mobile pairing) plus the dead `PendingApprovals`, `ScheduleChain`,
`ScheduleHistory`, `FinalSchedules`, `Messages`, `Connections`,
`Diagnostic`, `FlightProgram`, `Reminders`,
`admin/RemindersSchedule`, and `admin/ConnectionMap` pages. This
sweep hard-pins it stays gone.

| Check | Result | Evidence |
|-------|:-----:|----------|
| Page files for retired routes are physically absent | GREEN | `tests/legacy-residue.test.ts` "retired page files are absent" |
| api-server route files for retired endpoints absent | GREEN | `tests/legacy-residue.test.ts` "retired api-server routes are absent" |
| `Layout.tsx` + `HQLayout.tsx` have no live menu entries to retired pages (comments stripped before searching) | GREEN | `tests/legacy-residue.test.ts` "no live references to deleted pages" |
| `App.tsx` has no live `<Route>` for retired pages | GREEN | `tests/legacy-residue.test.ts` "App.tsx has no live <Route>" |
| `sidebar-smoke`, `button-sweep`, `lan-read-scope-routes` no longer reference retired routes | GREEN | All three pass after scrub |

---

## Calculation correctness regression

`tests/calc-snapshot.test.ts` pins `computePilotTotals` against a
fixed-seed roster (3 pilots, 10 sorties, mixed P1/P2, captain
flags, NVG-only, Sim-only, dual, opening balances, `initialHours`).
Four snapshots cover:

1. Lifetime totals + half-year buckets for a pilot whose only
   inputs are opening balances + sortie credits (alpha).
2. Lifetime totals + half-year buckets for a pilot whose
   `initialHours` field rolls into lifetime only and never into
   buckets (bravo).
3. Legacy P1=captain fallback when no per-seat captain flag is set
   on a sortie (charlie).
4. Roster-level grand-total + year-hours tally that drives the
   commander dashboard "X of Y current" headline.

Any future tweak to the totals engine that changes any of these
byte-for-byte will fail the test.

---

## Bug-fix sweep (what this task fixed)

| # | Finding | Severity | Fix |
|---|---------|:--------:|-----|
| 1 | `tests/sidebar-smoke.test.ts` still routed to deleted pages, breaking the smoke suite | RED | Removed dead route entries + `PAGE_LOADERS` for the 11 retired pages; pinned with `tests/legacy-residue.test.ts`. |
| 2 | `tests/button-sweep.test.ts` still loaded `PendingApprovals`, `ConnectionMap`, etc. | RED | Same scrub as #1; loader map now only references live pages. |
| 3 | `tests/lan-read-scope-routes.test.ts` had `pilot-links` + `reminders` blocks pointing at deleted routes; helpers `stageQueryReturns` / `restoreSimpleMock` got removed with the dead block | RED | Dropped the dead blocks; restored the helpers; 27 cases all green. |
| 4 | `package.json test` script still ran `test:guest-pending`, `test:dash-pilots`, `test:lan-user-role-gate` whose source files no longer exist | YELLOW | Removed the dead scripts; added `test:legacy-residue`, `test:calc-snapshot`, `test:multi-pc-cross`, `test:sorties-writes-gate`. The deleted tests were tied to features the cleanup task removed (PendingApprovals page, mesh-era dashboard snapshot, role gates on now-deleted routes). The role-gate spirit is rebuilt against the live `pilots/upsert` and `sorties/upsert` routes. |
| 5 | No regression coverage for the calculator after the topology refactor | YELLOW | Added `tests/calc-snapshot.test.ts`. |
| 6 | No coverage for hub recovery (cached → online), no coverage for last-write-wins audit attribution under two distinct LAN actors | YELLOW | Added `tests/multi-pc-cross.test.ts` with the hub-recovery + two-actor + role-gate + cross-squadron-gate scenarios. |
| 7 | Direct role-gate coverage on the `sorties/upsert` route was missing — relied on transitive coverage from `pilots/upsert` | YELLOW | Added `tests/sorties-writes-gate.test.ts` with 5 cases hitting `sorties/upsert` directly: ops success + audit, seven forbidden roles (commander_squadron, commander_wing, commander_base, commander, flight_commander, viewer, unknown), cross-squadron gate, guest pilot does not create a `pilots` row, and repeated guest name still does not create a `pilots` row. |
| 8 | Earlier draft of this report claimed `flight_commander` and `viewer` were covered when the test loops did not include them | YELLOW (introduced + fixed in this task) | Added both roles to the forbidden-role loop in `tests/multi-pc-cross.test.ts` AND `tests/sorties-writes-gate.test.ts` so the assertions match the test names. |

After the fix sweep all 27 test scripts pass.

---

## Open items

This sweep does **not** deliver the following items from the
task spec. They are each tracked or scoped explicitly, not
hand-waved away.

- **Playwright matrix runner with login/logout per cell and per-cell
  screenshots / console / network logs.** Not built. The
  in-process integration harness above does not perform a real LAN
  login (cookie session round trip) and does not drive a real
  browser. A single live-preview screenshot of the dashboard splash
  at `screenshots/dashboard-root.jpg` is the only real-browser
  evidence in this report. Final v1.1 production-rollout sign-off
  requires re-running this matrix in a real browser. **Tracked as
  follow-up #361.**

- **Multi-PC simulation with three real api-server processes.** The
  harness uses real Express servers for the fake squadron hubs in
  the peer-fanout / hub-recovery tests, but it does not boot three
  independent api-server processes on three ports with their own
  pgs. For the cross-process surface that actually matters
  (HTTP + `Authorization: Bearer …`) this is equivalent to the
  real topology because that surface is exercised over real
  sockets; for anything that lives below HTTP (filesystem state,
  per-process caches) it is not. **Tracked as follow-up #362.**

- **In-flight form preservation when the LAN drops mid-edit.**
  Today the only LAN-drop signal in the UI is the
  `navigator.onLine` indicator in
  `artifacts/pilot-dashboard/src/components/Layout.tsx` lines
  60-72; there is no `useLanReconnect` hook, no form-draft
  localStorage layer, and no reconnect-prompt UI. This is a
  missing feature, not a missing test, and is counted as the only
  RED row in the cross-PC matrix above. It belongs on the
  existing v1.1 backlog rather than on this sweep.

- **Possible product-decision on commander writes.** As documented
  in "Profile × Role write contract" above, the production code
  (`routes/pilots-writes.ts` and `routes/sorties-writes.ts`)
  blocks every commander tier from writing pilots or sorties.
  Whether this is the intended product behaviour or a bug is a
  product-decision call, not a test-coverage call. The tests pin
  the contract that exists today. If product wants commanders to
  write, the fix is in the routes, not in the tests.

---

## Summary

- 4 new test files added: `legacy-residue` (4 cases),
  `calc-snapshot` (4 cases), `multi-pc-cross` (4 cases),
  `sorties-writes-gate` (5 cases). 17 new test cases total.
- 3 obsolete test files deleted; 3 existing test files
  (`sidebar-smoke`, `button-sweep`, `lan-read-scope-routes`)
  scrubbed of references to the cleanup-task's deleted pages and
  routes.
- `package.json test` now runs all 27 scripts in series; entire
  suite is green.
- Calculator output is snapshot-locked. Legacy residue is
  structurally pinned out. Role gates on `pilots/upsert` and
  `sorties/upsert` are pinned for every role and every install
  profile that mounts them, with the production code's actual
  contract (ops/admin/super_admin write, everyone else 403
  `forbidden_role`) explicitly documented.
- Cross-PC matrix has one open RED row (LAN-drop in-flight form
  preservation feature) and zero YELLOW rows.
- Final v1.1 production-rollout sign-off requires re-running this
  matrix under a real Playwright harness (#361). This sweep does
  not claim to substitute for that.
