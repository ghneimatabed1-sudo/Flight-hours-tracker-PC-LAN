# Step 1 — Baseline inventory & parity contract pointer

**Status:** DRAFT — ready for operator sign-off as “Step 1 complete” for the internal-LAN migration program.  
**Date:** 2026-04-25  
**Repository:** Flight-hours-tracker-PC (Hawk Eye)

This document satisfies **IMPLEMENT STEP 1** in the internal-migration plan: *map what exists today* (Supabase, edge functions, tables, env, non-Supabase internet), and *point to* the living parity contract (DOMAIN + code “sources of truth”), without changing product behavior.

---

## 1. Parity contract (what “must not break”)

| Source | Role |
|--------|------|
| [DOMAIN.md](../../DOMAIN.md) | What each page, role, and report number **means** operationally. |
| [AGENTS.md](../../AGENTS.md) | Do-nots, test commands, migration rules, memory-update protocol. |
| [replit.md](../../replit.md) | Monorepo overview, Supabase/edge/CI context. |
| [calculations.ts](../../artifacts/pilot-dashboard/src/lib/calculations.ts) | Canonical `computePilotTotals` — must stay aligned with mobile. |
| [monthly-report.ts](../../artifacts/pilot-dashboard/src/lib/monthly-report.ts) | Forms 1–4 and related builders. |
| [cross-pc.ts](../../artifacts/pilot-dashboard/src/lib/cross-pc.ts) | Cross-PC registry, messages, `xpc_pending`, schedule shares, snapshots. |
| [sidebar-smoke.test.ts](../../artifacts/pilot-dashboard/tests/sidebar-smoke.test.ts) | **Route list per layout/persona** (first-render guard only — *not* deep behavior). |
| [Layout.tsx](../../artifacts/pilot-dashboard/src/components/Layout.tsx), [HQLayout.tsx](../../artifacts/pilot-dashboard/src/components/HQLayout.tsx) | **Role-shaped** nav (Ops shell vs commander shell by `user.scope`). |

**Locked intent:** the app **reshapes per PC role** (Ops vs Flight/Squadron/Wing/Base/HQ commander vs Super Admin, Deputy subset of Ops). After migration, **role → menu + data scope** must match this contract, with internal API replacing Supabase transport.

---

## 2. Build-time & runtime config (desktop)

| Variable / secret | Where used | Purpose |
|-------------------|------------|--------|
| `VITE_SUPABASE_URL` | [supabase.ts](../../artifacts/pilot-dashboard/src/lib/supabase.ts), [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts), CI | PostgREST + Auth + Realtime base URL. |
| `VITE_SUPABASE_ANON_KEY` | Same | Public anon key for `supabase-js` and direct `fetch` to REST/RPC. |
| `VITE_UNIT_JOIN_SECRET` | [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts) | Header `x-unit-join-secret` for anonymous `unit_*` RPCs. |
| `VITE_API_SERVER_URL` | [supabase.ts](../../artifacts/pilot-dashboard/src/lib/supabase.ts) (register), [dashboard-windows-installer.yml](../../.github/workflows/dashboard-windows-installer.yml) | Base for `POST /api/license/register` (if still used in any path). |
| `VITE_EXPECTED_SUPABASE_HOST` | [Diagnostic.tsx](../../artifacts/pilot-dashboard/src/pages/Diagnostic.tsx) | Optional host check vs configured URL. |

**Internal migration target:** replace or proxy these with **one internal base URL** + auth story (design in later steps); this inventory is the checklist of *every* consumer.

---

## 3. Supabase Edge Functions (repo `supabase/functions/`)

| Function | Called from (dashboard) | Notes |
|----------|-------------------------|--------|
| `unit-approve-device` | [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts) (`fetch` … `/functions/v1/`) | Device approval; uses service role server-side. |
| `unit-claim-device` | [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts) | Post-approval password claim. |
| `unit-super-admin-setup` | [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts) | One-shot first super-admin. |
| `super-admin-2fa` | [auth.tsx](../../artifacts/pilot-dashboard/src/lib/auth.tsx), [Security flow] | TOTP / password challenge; future “install password only” plan will supersede parts. |
| `heal-claims` | [auth.tsx](../../artifacts/pilot-dashboard/src/lib/auth.tsx) | JWT claim repair after login. |
| `manage-reminder-schedule` | [RemindersSchedule.tsx](../../artifacts/pilot-dashboard/src/pages/admin/RemindersSchedule.tsx), [ReminderLog.tsx](../../artifacts/pilot-dashboard/src/pages/admin/ReminderLog.tsx) | CRON/schedule management; also chains to notify functions server-side. |
| `validate-license` | [supabase.ts](../../artifacts/pilot-dashboard/src/lib/supabase.ts) | Legacy/optional path; confirm whether still reachable from UI. |
| `provision-commander` | [supabase.ts](../../artifacts/pilot-dashboard/src/lib/supabase.ts) | Legacy/optional; refresh commander auth users. |
| `provision-user` | [squadron-data.ts](../../artifacts/pilot-dashboard/src/lib/squadron-data.ts) | Referenced in comments / invoke path for provisioning. |
| `link-pilot-device` | Mobile (see below) | Pilot phone pairing. |
| `notify-alert` / `notify-notam` / `notify-currency-expiry` | Invoked from DB cron / `manage-reminder-schedule` | **Outbound** to Expo push (`https://exp.host/...`); internal-only policy must decide fate. |

---

## 4. Direct HTTP to Supabase (bypassing `supabase.from`)

| Path pattern | File | Purpose |
|--------------|------|--------|
| `POST {SUPABASE_URL}/rest/v1/rpc/{name}` | [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts) | `unit_*` RPCs (anon or JWT). |

**RPCs via `unit-join` (by name):** `unit_super_admin_exists`, `unit_super_admin_setup_allowed`, `unit_squadrons_for_join`, `unit_request_join`, `unit_request_status`, `unit_pending_requests`, `unit_list_devices`, `unit_reject_request`, `unit_ignore_request`, `unit_update_squadrons`, `unit_remove_member`, `unit_member_self`, `unit_reserve_approval`.

---

## 5. `supabase-js` — Edge `functions.invoke` (by name)

| Name | File(s) |
|------|---------|
| `validate-license` | [supabase.ts](../../artifacts/pilot-dashboard/src/lib/supabase.ts) |
| `provision-commander` | [supabase.ts](../../artifacts/pilot-dashboard/src/lib/supabase.ts) |
| `super-admin-2fa` | [auth.tsx](../../artifacts/pilot-dashboard/src/lib/auth.tsx) |
| `heal-claims` | [auth.tsx](../../artifacts/pilot-dashboard/src/lib/auth.tsx) |
| `manage-reminder-schedule` | [RemindersSchedule.tsx](../../artifacts/pilot-dashboard/src/pages/admin/RemindersSchedule.tsx), [ReminderLog.tsx](../../artifacts/pilot-dashboard/src/pages/admin/ReminderLog.tsx) |
| `provision-user` | [squadron-data.ts](../../artifacts/pilot-dashboard/src/lib/squadron-data.ts) (invoke on specific paths) |

---

## 6. `supabase.rpc` (Postgres RPC from dashboard `src/`)

| RPC | File |
|-----|------|
| `runtime_error_capture` | [runtimeErrorReporter.ts](../../artifacts/pilot-dashboard/src/lib/runtimeErrorReporter.ts) |
| `xpc_pair_touch` | [cross-pc.ts](../../artifacts/pilot-dashboard/src/lib/cross-pc.ts) |
| `transfer_pilot` | [squadron-data.ts](../../artifacts/pilot-dashboard/src/lib/squadron-data.ts) |
| `issue_pilot_link_code` | [squadron-data.ts](../../artifacts/pilot-dashboard/src/lib/squadron-data.ts) |
| `xpc_redeem_pair_code`, `xpc_admin_create_pair`, `xpc_revoke_my_pair`, `xpc_admin_revoke_pair`, `xpc_admin_set_permanent`, `xpc_admin_reset_pc`, `xpc_admin_bulk_pair_in_squadron`, `xpc_pair_links_sweep` | [pairs.ts](../../artifacts/pilot-dashboard/src/lib/pairs.ts) |

---

## 7. PostgREST `from("<table>")` — tables touched in dashboard `src/` (incomplete union)

**Operational (squadron data):** `pilots`, `sorties`, `alerts`, `notams`, `duty_week`, `leaves`, `unavailable`, `schedule`, `users` (read), `saved_duty_weeks`, `pilot_devices`, `pilot_link_codes`, `pilot_reminder_prefs`, `pilot_currency_notifications`, `squadrons`.

**Cross-PC / ecosystem:** `xpc_registry`, `xpc_user_pcs`, `xpc_pending`, `xpc_schedule_shares`, `xpc_messages`, `xpc_squadron_snapshot`, `xpc_pcs` (delete via pairs), `xpc_pair_codes`, `xpc_pair_links`, `xpc_pair_audit`.

**Audit / admin:** `audit_log`, `license_registry` (if still in use for standalone flows).

**Offline queue:** [offlineQueue.ts](../../artifacts/pilot-dashboard/src/lib/offlineQueue.ts) replays generic `{ table, payload, match }` to `supabase.from(m.table)`.

*Full schema:* see `artifacts/pilot-dashboard/supabase/migrations/` in repo.

---

## 8. Pilot mobile (`artifacts/pilot-mobile/`)

| Surface | File | Supabase use |
|--------|------|--------------|
| Client | [supabase.ts](../../artifacts/pilot-mobile/lib/supabase.ts) | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, session. |
| Data + pilot link | [data.tsx](../../artifacts/pilot-mobile/lib/data.tsx) | `pilots`, `sorties`, `notams`, etc. (via supabase) |
| RPCs | [notifications.ts](../../artifacts/pilot-mobile/lib/notifications.ts) | `get_pilot_reminder_prefs`, `save_pilot_reminder_prefs`, `ping_pilot_sync` |
| | [supabase.ts](../../artifacts/pilot-mobile/lib/supabase.ts) | `pilot_heartbeat`, `runtime_error_capture` (reporter) |

**CI / codemagic:** [codemagic.yaml](../../codemagic.yaml) embeds `EXPO_PUBLIC_SUPABASE_*` — must be part of any internal endpoint rotation (no stray public project in mobile builds).

---

## 9. Other internet / public coupling (not PostgREST)

| Mechanism | Location | Purpose |
|-----------|----------|--------|
| **CSP `connect-src`** | [index.html](../../artifacts/pilot-dashboard/index.html) | `https://*.supabase.co`, `wss://*.`, `https://*.replit.app` / `replit.dev` — must change for internal-only hosts. |
| **Google Fonts** | [index.html](../../artifacts/pilot-dashboard/index.html) | `fonts.googleapis.com` / `fonts.gstatic.com` — optional offline font policy. |
| **electron-updater** | [electron/main.ts](../../artifacts/pilot-dashboard/electron/main.ts) | Checks **GitHub Releases** (see [electron-builder.json](../../artifacts/pilot-dashboard/electron-builder.json) `publish`: `ghneimatabed1-sudo/Flight-hours-tracker-Releases`). **Separate** from “sortie data” but still **public network** for updates. |
| **Expo push (edge)** | `notify-*.` functions | External HTTPS to Expo. |

**Policy decision for “no public internet at runtime”:** either disable auto-update in offline policy, or mirror releases internally — **documented in plan Phase / cutover**, not here.

---

## 10. Role × sidebar (where to look — deep matrix is Step 1 *output* template)

- **Authoritative route lists** for smoke: [sidebar-smoke.test.ts](../../artifacts/pilot-dashboard/tests/sidebar-smoke.test.ts) — `PERSONAS`: `super_admin`, `wing_cmdr`, `base_cmdr`, `sqn_cmdr`, `sqn_cmdr_multi`, `flight_cmdr`, `ops`, `deputy`. **Note:** an **HQ commander** `scope: "hq"` person is *not* in the default `PERSONAS` list today — **add** when building the full deep matrix so HQ is not skipped.
- **Commander nav builder:** [HQLayout.tsx](../../artifacts/pilot-dashboard/src/components/HQLayout.tsx) — `user.scope` drives which blocks appear (squadron vs flight vs wing vs base vs HQ).
- **Ops nav:** [Layout.tsx](../../artifacts/pilot-dashboard/src/components/Layout.tsx) — deputy filter differs from full ops.

Step 1 **delivers** the inventory; **filling** every (role, route) cell with “deep” evidence is the ongoing certification artifact referenced in the migration plan.

---

## 11. Recommended follow-up commands (regression, not re-deciding rules)

From repo root (operator machine with env if needed):

- `pnpm --filter @workspace/pilot-dashboard test` (includes [sidebar-smoke.test.ts](../../artifacts/pilot-dashboard/tests/sidebar-smoke.test.ts))
- `pnpm --filter @workspace/pilot-dashboard exec tsx --test src/lib/calculations.parity.test.ts` (path adjusted if required by package)
- RLS / cross-PC: see [AGENTS.md](../../AGENTS.md) for `rls-policy-audit.mjs`, `cross-pc-e2e.mjs` when present in checkout

---

## 12. Sign-off (Step 1)

| Stakeholder | Action |
|-------------|--------|
| Builder / agent | Inventory & this file committed. |
| Operator | Confirms: “this matches our deployment; proceed to Step 2.” |

**Sign-off (pending):** _________________________  **Date:** __________

---

*Generated as part of `IMPLEMENT STEP 1` — internal migration program.*
