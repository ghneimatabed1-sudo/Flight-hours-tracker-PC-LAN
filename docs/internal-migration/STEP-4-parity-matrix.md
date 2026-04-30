# Step 4 — Parity contract matrix (GO/NO-GO reference)

**Status:** Living document — extend as new surfaces ship.  
**Date:** 2026-04-25

This matrix ties **operator-visible behavior** to **evidence** (code source of truth + automated checks). Internal migration is **NO-GO** until every row needed for your deployment has a **green** test path (or an explicit signed waiver).

| Domain area | Source of truth | Automated gate today | Deep gate (future / manual) |
|-------------|-----------------|----------------------|-----------------------------|
| Role → menu & first paint | `Layout.tsx`, `HQLayout.tsx`, `DOMAIN.md` §2–3 | `tests/sidebar-smoke.test.ts` (all roles × routes) + `tests/button-sweep.test.ts` (click-through where deterministic in jsdom) | Per-role workflow scripts; HQ persona still optional extension |
| Pilot roster & detail | `squadron-data.ts`, `Roster.tsx` | Sidebar smoke + ops routes; internal `GET /api/internal/pilots` when LAN server has pilots (else cloud) | Edit pilot, transfer, CSV import |
| Sortie log / add / guest | `AddSortie.tsx`, `cross-pc.ts`, `PendingApprovals.tsx` | Sidebar smoke; **`tests/guest-pending-actions.test.ts`** (offline clicks: Accept, Reject+reason, Drop); **`tests/add-sortie-smart.test.ts`** (pre-save consistency rules) | Live Supabase: `.local/tests/guest-pilot-e2e.mjs` |
| Hours & currencies | `calculations.ts`, `DOMAIN.md` §5–6 | `dash-pilots-snapshot.test.ts`; mobile parity separate | `full-simulation` harness when present; goldens (Step 5) |
| Monthly report Forms 1–4 | `monthly-report.ts`, `DOMAIN.md` §9 | Sidebar smoke (`/monthly-report` first paint) | Golden PDF/field fixtures (Step 5) |
| Schedule chain | `ScheduleChain.tsx`, `cross-pc.ts`, `DOMAIN.md` §7 | Sidebar smoke + `schedule-names.test.ts` (crew naming rule) | `.local/tests/cross-pc-e2e.mjs` on live project |
| Cross-PC messages | `Messages.tsx`, `cross-pc.ts` | Sidebar smoke | cross-pc e2e |
| Multi-PC join / devices | `unit-join.ts`, admin Pending Devices | Sidebar smoke (admin routes) | Join lifecycle e2e; Approve uses `window.prompt` on reject reason — covered in manual matrix |
| Super Admin org | `admin/*`, `squadron-store.ts`, migrations | Sidebar smoke; `tests/squadron-remote-rows.test.ts` (registry row map) | RLS audit `rls-policy-audit.mjs`; pilot transfer RPC test; LAN contract vs `GET /api/internal/squadrons` |
| Auth / session | `auth.tsx`, `DOMAIN.md` §2 | Sidebar smoke (login not in table — first paint post-session only) | Step 10 install-password implementation + dedicated auth suite |
| Internal API path | `internal-migration.ts`, `api-server` | Diagnostic + dev proxy (Step 3); `tests/squadron-defaults-merge.test.ts` (defaults merge parity) | Contract tests against real LAN `api-server` + response goldens |

## NO-GO triggers (examples)

- Any **red** row in the CI suite you rely on for release.
- **RLS** change without `WITH CHECK` audit pass (see `AGENTS.md`).
- **DOMAIN.md** drift for a changed flow.

## Waivers

Only the **operator** may waive a row; the waiver must name the risk and the date.
