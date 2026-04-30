# ROLE FLOW MATRIX — Full-role reliability hardening

Date: 2026-04-25
Scope: `pilot-dashboard` role routes + core operational flows

## Ops PC

| Area | Entry points | Expected behavior |
|---|---|---|
| Daily operations authoring | `App.tsx` → `SquadronOpsRoutes` (`/sortie-log`, `/sortie-add`, `/flight-program`, `/leaves`, `/currency`, `/schedule-chain`) | Ops can author sorties/schedules/leaves and push chain messages without commander-only approvals. |
| Schedule chain submit | `pages/ScheduleChain.tsx` (`myTier = "ops"`) | Ops can submit/share schedule with linked flight/squadron peers and receive return edits. |
| Message flow | `components/Layout.tsx` + `lib/cross-pc.ts` `canUseMessages()` | Ops has messages enabled; unread badges appear and inbox routes mount. |
| Shared-data persistence | `lib/squadron-data.ts`, `lib/leaves-daily.ts` | Writes should be Supabase-backed when configured, not local-only. |

## Squadron Commander

| Area | Entry points | Expected behavior |
|---|---|---|
| Commander shell | `App.tsx` → `CommanderRoutes` | Squadron commander routes are mounted in HQ shell and scoped. |
| Schedule decisions | `pages/ScheduleChain.tsx` (`myTier="squadron"`) + `useDecideSchedule` | Commander can approve/reject/edit-and-return and forward up-chain where applicable. |
| Final schedules | `canViewFinalSchedules` + `/dashboard/final-schedules` | Visible where policy allows; read-only finals review. |
| Pilot/currency views | `/dashboard/pilots`, `/dashboard/currencies` | Squadron-level read surfaces should match scope picker and data permissions. |

## Flight Commander

| Area | Entry points | Expected behavior |
|---|---|---|
| Flight scope routes | `HQLayout.tsx` item gating (`scope==="flight"`) | Flight-only commander sees flight program, simulator, schedule chain/history, messages. |
| Upward share | `ScheduleChain.tsx` (`myTier="flight"`) | Flight can submit schedules to squadron and receive feedback loop. |
| Scope restrictions | `CommanderUnavailableGate` + route guards | Flight scope cannot bypass unavailable visibility restrictions by direct URL. |

## Wing Commander

| Area | Entry points | Expected behavior |
|---|---|---|
| Chain forward | `ScheduleChain.tsx` (`myTier="wing"`) | Wing forwards approved schedules to Base (parent pinning respected). |
| Multi-squadron visibility | `squadron-scope` + dashboard routes | Wing can inspect allowed squadron snapshots/currency/alerts without owning ops writes. |
| Messaging | `canUseMessages` gates + `/dashboard/messages` | Wing messaging inbox active, scoped by cross-PC policies. |

## Base Commander

| Area | Entry points | Expected behavior |
|---|---|---|
| Chain approval | `ScheduleChain.tsx` (`myTier="base"`) | Base acts as top approver in configured chain path for its assigned flows. |
| Final schedule read | `/dashboard/final-schedules` | Base sees approved finals rollup across governed squadrons. |
| Snapshot consumption | `dash-pilots` + snapshot routes | Base consumes readonly snapshots; no ops-grade writes. |

## HQ Commander

| Area | Entry points | Expected behavior |
|---|---|---|
| Global command visibility | `HQLayout.tsx` commander nav + scope picker | HQ can view broad operational rollups and chain outcomes under policy constraints. |
| Messaging and history | `/dashboard/messages`, `/dashboard/schedule-history` | HQ can review chain traffic and history where permitted. |

## Super Admin

| Area | Entry points | Expected behavior |
|---|---|---|
| Device/member governance | `/admin/pending-devices`, `/admin/devices-users` | Join→Approve→Bind lifecycle controlled centrally by super admin. |
| Security controls | `/admin/security` + 2FA hooks | Super admin auth and recovery controls are available and guarded. |
| Org registry management | `/admin/squadrons` + `lib/squadron-store.ts` | Super admin CRUD should persist to Supabase (`squadrons`/`wings`/`bases`) with RLS-super-admin gate. |
| Audit and reminders | `/admin/audit`, `/admin/reminders` | Cluster-level monitoring and scheduler control available. |

## Cross-role critical invariants

1. Ops-authored operational data must be shared-state (Supabase-backed) for downstream Wing/Base/HQ consumption.
2. Schedule chain transitions must preserve visibility for previous/current chain participants.
3. Role/sidebar gates in `Layout.tsx` and `HQLayout.tsx` must match route-level protections in `App.tsx`.
4. Super admin registry edits must never require service-role secrets in client code.
