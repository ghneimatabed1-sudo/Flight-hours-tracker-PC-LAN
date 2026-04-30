# Cross-PC Operational Behaviour — Surface Inventory

**Task:** #303
**Generated:** dynamic (see REPORT.md timestamp)
**Project (prod):** nklrdhfsbevckovqqkah

This file is a static enumeration of every cross-PC surface that the
verification matrix in `matrix.json` walks. Surfaces were identified by
auditing `artifacts/pilot-dashboard/src/lib/cross-pc.ts`,
`squadron-data.ts`, `auth.tsx`, the pages under
`artifacts/pilot-dashboard/src/pages/`, and migrations 0010–0080.

## A. Cross-PC scheduling chain — flight schedule sharing

- **Tables:** `xpc_schedule_shares` (origin_squadron_id, current_pc_id,
  current_tier, status, rows, baseline_rows, history, program,
  edited_program, chain_pc_ids[], rejected_by_pc_ids[],
  approved_at/by, originator_dismissed_at).
- **Producer:** Squadron PC clicks "Send to Wing" (POST
  `xpc_schedule_shares`).
- **Receivers (forward chain):** Wing PC, Base PC, then HQ.
- **Visibility rules (RLS, migration 0010 + 0029 + 0036 + 0064):**
  - Origin squadron always sees its own send (originator).
  - The PC matching `current_pc_id` sees the share while it sits on
    their inbox.
  - Wing/Base/HQ commanders also see shares whose `current_tier ='wing'/'base'/'hq'` and whose `wing_id`/`base_id` matches their
    claim (broad upstream visibility).
- **Polling cadence:** 15 s (`useScheduleInbox`).
- **Realtime:** **NOT in `supabase_realtime` publication** — no push.
- **Closed-month immutability:** migration 0058 enforces that a
  `xpc_schedule_shares` row whose `flight_date` falls inside a closed
  month cannot be updated/deleted (chain freeze).

## B. Currencies / Sortie aggregations

- **Tables:** `sorties` (squadron_id, pilot_id, co_pilot_id, date,
  ac_type, ac_number, sortie_type, sortie_name, data jsonb).
- **Currency math:** `squadron-data.ts` derives currencies per pilot
  per sortie type (NVG, instrument, day/night) by counting sorties
  inside a calendar window per pilot.
- **Cross-PC implication:** when ops on PC-A inserts a sortie, PC-B
  (same squadron, ops or commander) must see the currency change.
- **Polling cadence:** 30 s (squadron-data hooks).
- **Closed month:** sorties whose `date` is inside a closed month
  cannot be updated/deleted (migration 0058).

## C. Alerts

- **Table:** `alerts` (squadron_id, body, author, posted_at, priority).
- **Schema constraint:** alerts are scoped to a single
  `squadron_id` only — no per-target addressing of multiple squadrons,
  no wing-wide / base-wide alerts.
- **RLS (0051):**
  - `alerts_rw`: ops-tier (`pilot_id() is null`) read+write alerts of
    `squadron_id = squadron_id()` claim.
  - `alerts_pilot_read`: pilot-tier reads alerts for their squadron.
- **Cross-PC implication:** alerts written by ops on PC-A are visible
  to ops on PC-B of the same squadron. Other squadrons (and other
  wings) **must not** see the alert.

## D. NOTAMs

- **Table:** `notams` (squadron_id, notam_no, posted_on, body,
  priority).
- **RLS (0051):** identical pattern to alerts (squadron-scoped).
- **Cross-PC implication:** same as alerts — same-squadron readers
  see; cross-squadron readers must not.

## E. Pilot data (roster / manning)

- **Table:** `pilots` (squadron_id, rank, name, arabic_name,
  rank_en, data jsonb, available, auth_user_id).
- **RLS:** ops-tier read+write within own squadron; pilots can read
  their own squadron and their own row only.
- **Cross-PC implication:** edits on PC-A propagate to PC-B of same
  squadron.

## F. Sortie log

- Same `sorties` table as B but exercised as a write-then-read flow
  rather than aggregated math.

## G. Squadron rename

- **Trigger:** `xpc_squadron_rename_sync` (migration 0050) and
  `xpc_squadron_rename_sync_pending_shares` (0054) propagate name
  changes from `public.squadrons.name` into:
  - `xpc_registry.squadron_name`
  - `xpc_messages.from_pc_name` / `to_pc_name` (where matching)
  - `xpc_schedule_shares.origin_squadron_name` and
    `current_pc_name` (where matching)
- **Snapshot table:** `xpc_squadron_snapshot` is backfilled by 0053.
- **Cross-PC implication:** after rename, every PC sees the new name
  in inboxes/registry without re-login.

## H. Refresh / realtime / heartbeat

- **Heartbeat:** `cross-pc.ts` calls `xpc_registry` upsert every
  15 s; an entry is "active" if `last_seen` ≥ now – 90 s
  (`ACTIVE_WINDOW_MS = 90_000`).
- **Inactive purge:** `xpc_purge_inactive_pcs(p_threshold)` deletes
  rows older than threshold; called by the directory page.
- **Polling cadences (verified in cross-pc.ts):** 15 s for
  schedule/messages inboxes, 30 s for registry/messages history,
  60 s for analytics.
- **Realtime publication membership (verified by SQL):** only
  `device_requests` is in `supabase_realtime`. **No cross-PC table
  is push-realtime.** Updates therefore propagate at the polling
  cadence (15 s typical, 30 s worst-case for non-inbox surfaces),
  not within 5 s.

## I. Calculations

- All currency / hours math runs client-side in `squadron-data.ts`.
- DB layer: `monthly_report_close` (immutability table, 0058) plus
  `is_month_closed(p_squadron_id, p_year, p_month)` /
  `monthly_report_close_close()` /
  `monthly_report_close_reopen()` RPCs.
- **Cross-PC implication:** a closed month freezes sorties +
  schedule rows for that period; calculations on every PC must show
  identical totals because every PC reads the same rows.

## J. RLS isolation (defense-in-depth)

- **Squadron-scoped tables:** sorties, alerts, notams, pilots —
  forged JWTs from another squadron must return zero rows on
  SELECT and must error on INSERT/UPDATE/DELETE.
- **Cross-PC tables:** xpc_schedule_shares, xpc_messages,
  xpc_pending — forged JWTs that don't match the addressing must
  not see in-flight rows.

## K. RLS-policy CRUD coverage (added Round-2)

- **Source:** `pg_policies` for every `xpc_*` table.
- **Cells:** K1–K10 — one cell per cross-PC table, each verifying that
  SELECT, INSERT, UPDATE, DELETE policies are all present (FOR ALL
  policies are credited as covering all four verbs).
- **Tables checked:** `xpc_registry`, `xpc_user_pcs`, `xpc_schedule_shares`,
  `xpc_messages`, `xpc_pending`, `xpc_squadron_snapshot`,
  `xpc_message_chains`, `xpc_message_attachments`, `xpc_message_reads`,
  `xpc_message_recall_log`.

## L. Per-role page sweep

- **Roles:** ops (squadron), squadron commander, flight commander,
  deputy, wing commander, base commander, hq commander, super_admin,
  pilot.
- **Pages (sidebar):** Dashboard, Pilots, Sorties, Schedule,
  Alerts, NOTAMs, Currencies, Hours, Reports, Cross-PC Inbox,
  Cross-PC Messages, Cross-PC Directory, Settings, Squadron Admin,
  Audit Log.
- **Sweep:** for every (role, page) cell, walk the data hooks the
  page uses and confirm scope is correct.

## M. Flight schedule sender / receiver scoping

- A Squadron-tier sender must only be able to send a chain whose
  `origin_squadron_id` equals its own squadron.
- A Wing-tier receiver must only see shares whose `wing_id` (via
  origin squadron's wing) matches its own.
- Cross-wing sends must not appear in another wing's inbox.

## N. Messages page scoping

- `xpc_messages` is point-to-point (`from_pc_id` → `to_pc_id`). RLS
  permits SELECT only when caller's `xpc_user_pcs` claim contains
  either side.
- **In-history toggle:** `in_history=true` rows persist; otherwise
  retention sweeps remove them (migration 0051 retention backstop).

## O. Sortie INSERT/UPDATE/DELETE recompute parity (added Round-2; evidence reinforced Round-3 / Section S)

- **Cells:** O1–O5. Verifies cross-PC visibility of sortie writes
  through the rollup hooks: O1 INSERT, O2 UPDATE, O3 DELETE policy
  permission, O4 DELETE end-to-end, O5 currency window arithmetic.
- **Round-3 reinforcement:** `.local/scripts/task-303-section-s.mjs`
  rewrites each cell's evidence file with raw before/after counts
  and ids (no longer "derived from B1").

## P. Realtime / SLA assessment per cross-PC table (added Round-2)

- **Source:** `pg_publication_tables` for publication
  `supabase_realtime`.
- **Cells:** P1–P9. One cell per cross-PC table; passes only if the
  table is in the publication AND functional propagation is sub-5s.
  Currently every cell except `device_requests` fails.

## Q. Heartbeat / reconnect / staleness invariants (added Round-2; evidence reinforced Round-3 / Section S)

- **Cells:** Q1 ACTIVE_WINDOW_MS = 90 s, Q2 heartbeat cadence 15 s,
  Q3 inactive purge RPC present, Q4 reconnect upserts replace stale
  row in-place.
- **Round-3 reinforcement:** `.local/scripts/task-303-section-s.mjs`
  rewrites each cell's evidence with raw observations — Q1+Q2 source-grep
  values from `cross-pc.ts`, Q3 lists pg_proc rows + live-invokes the
  `(p_days integer)` overload, Q4 forces a stale `last_seen`,
  re-runs the heartbeat upsert, and asserts id-stability + last_seen
  advancement.

## R. Direct operational evidence cells (added Round-3)

- **Cells:** R1–R8 — explicit operational assertions for acceptance
  bullets that previously rolled up under broader cells. Each cell
  has its own evidence file with raw observed numbers vs expected:
  - R1 Sortie DELETE → currency recompute (PC-A delete, PC-B sees
    decremented count within polling window).
  - R2 NOTAM expiry (acceptance bullet D — currently FAIL):
    notams table has no `valid_until` / `expires_on` column;
    expired rows remain visible. Captured as a defect candidate
    (residual recorded in cells/R2.json).
  - R3 Manual refresh: explicit `refetch()` on Dashboard/Pilots/
    Schedule/Alerts/NOTAMs returns current DB state without
    waiting for the polling tick.
  - R4 Arithmetic correctness: 30/90-day currency windows count
    only sorties inside the window; totals and breakdown match
    fixture counts exactly.
  - R5 Role × page action validation: a forbidden mutating action
    (e.g. pilot trying to insert a NOTAM) is rejected at the RLS
    layer with `42501`, not silently dropped client-side.
  - R6 Closed-month immutability: UPDATE/DELETE on a sortie inside
    a closed month is rejected by trigger with the documented error.
  - R7 Squadron rename propagation: rename of a squadron flows into
    `xpc_registry.squadron_name`, `xpc_messages.from_pc_name`/
    `to_pc_name`, and `xpc_schedule_shares.origin_squadron_name` /
    `current_pc_name` within the polling window.
  - R8 Forwarder chain visibility: the forwarder's PC remains in
    `chain_pc_ids` after handoff, so they still see the share in
    the chain history view (currently FAIL — same root cause as
    Family #1).
