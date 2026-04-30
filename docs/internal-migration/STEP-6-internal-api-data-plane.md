# Step 6 — Internal API data plane kickoff

**Status:** Started — multiple read endpoints wired (schedules, squadron defaults, registry list) + base-LAN session bootstrap on `api-server`.  
**Date:** 2026-04-25 (updated 2026-04-26)

## Goal

Begin replacing direct client dependence on Supabase/PostgREST reads by introducing internal API endpoints consumed by dashboard surfaces.

## Delivered in this step slice

| Piece | File(s) | What it does |
|------|---------|--------------|
| Internal pilot-options endpoint | `artifacts/api-server/src/routes/pilot-options.ts` | `GET /api/internal/pilot-options` returns schedule-safe pilot identifiers from DB (`flightName` → `callSign` → `id`), never full personal name. |
| Internal squadron defaults endpoint | `artifacts/api-server/src/routes/squadron-airframes.ts` | `GET /api/internal/squadron-airframes?number=` returns `base`, `wing`, `default_aircraft`, `default_monthly_targets` for that squadron row (Setup Wizard / migration 0039 shape). |
| Route registration | `artifacts/api-server/src/routes/index.ts` | Mounts internal data routes under `/api/internal/...` (see LAN session notes below). |
| Dashboard client hook-in | `artifacts/pilot-dashboard/src/lib/internal-migration.ts` | Adds `fetchInternalPilotOptions()` and `fetchInternalSquadronDefaultsRow()` over the same internal API path logic used by health checks. |
| Schedule consumers | `FlightProgram.tsx`, `ScheduleChain.tsx` | When internal API returns pilot options, schedule pickers consume those values directly (fallback remains local roster-derived options). |
| Squadron defaults hydration | `artifacts/pilot-dashboard/src/lib/squadron-defaults.ts` | `hydrateSquadronDefaultsFromDb` tries internal API first; on miss or when internal is disabled, falls back to Supabase. Shared merge logic: `mergeSquadronsRemoteRowIntoDefaults`. |
| Merge unit tests | `artifacts/pilot-dashboard/tests/squadron-defaults-merge.test.ts` | `pnpm run test:squadron-merge` |
| Internal squadrons list endpoint | `artifacts/api-server/src/routes/squadrons-list.ts` | `GET /api/internal/squadrons` — full `squadrons` registry for Super Admin refresh. |
| Internal pilots table endpoint | `artifacts/api-server/src/routes/pilots-table.ts` | `GET /api/internal/pilots` — roster-shaped pilot rows (`rank_en`, `data` jsonb, etc.). |
| Roster read path | `artifacts/pilot-dashboard/src/lib/squadron-data.ts` (`usePilots`) | When live + internal returns ≥1 pilot, maps rows with existing `rowToPilot`; else Supabase `select *`. |
| Super Admin refresh path | `artifacts/pilot-dashboard/src/lib/squadron-store.ts` | `refreshSquadronsFromDb` uses internal list when it returns **≥1** row (empty internal response keeps Supabase path for hybrid safety). `squadronsFromRemoteRows` shared mapper. |
| Registry mapping tests | `artifacts/pilot-dashboard/tests/squadron-remote-rows.test.ts` | `pnpm run test:squadrons-remote` |
| Internal sorties list endpoint | `artifacts/api-server/src/routes/sorties-read.ts` | `GET /api/internal/sorties?limit=` — `select * from sorties order by date desc limit N` (default 500, max 2000). No write-secret header (read-only). |
| Sortie log read path | `artifacts/pilot-dashboard/src/lib/squadron-data.ts` (`useSorties`), `internal-migration.ts` (`fetchInternalSortieTableRows`) | When `internalWritesEnabled()` ( `VITE_INTERNAL_WRITES` + internal API base), fetches internal list first so LAN writes and reads stay aligned; on miss/error, Supabase as today. |
| Pilot / sortie write routes (optional secret) | `pilots-writes.ts`, `sorties-writes.ts`, `internal-write-auth.ts` | `POST /api/internal/pilots/upsert`, `DELETE …/pilots/:id`, `POST/PATCH/DELETE …/sorties…`; gated by `INTERNAL_WRITE_SECRET` ↔ `x-hawk-internal-write` when set. Dashboard mutations in `squadron-data.ts` branch on `internalWritesEnabled()`. |
| Base-LAN session (Supabase-Auth replacement path) | `lan-auth-public.ts`, `lan-auth-middleware.ts`, `lan-auth-schema.ts`, `password.ts` | `POST /api/internal/auth/lan/bootstrap` (first user; needs `HAWK_LAN_BOOTSTRAP_TOKEN`), `POST /api/internal/auth/lan/login`, `GET /api/internal/auth/lan/me`, `POST /api/internal/auth/lan/logout`. Optional hard gate: `HAWK_INTERNAL_SESSION_AUTH=required` enforces `x-hawk-lan-session` (or `Authorization: Bearer …`) on `/api/internal/*` data routes. |
| Dashboard token hook (prep) | `artifacts/pilot-dashboard/src/lib/internal-migration.ts` | Internal fetches can attach `x-hawk-lan-session` from `localStorage` key `rjaf.lanSessionToken` when a LAN login UI stores it. |

## Why this matters

- Data-plane reads move incrementally off PostgREST while **fallbacks** stay until cutover.
- Schedule surfaces use tactical pilot identifiers; squadron defaults and registry reads share the same internal URL rules as Diagnostic health.

## Validation run

- `pnpm --filter @workspace/api-server run typecheck`
- `pnpm --filter @workspace/pilot-dashboard run typecheck`
- Dashboard regression suites: `test:buttons`, `test:guest-pending`, `test:sortie-smart`, `test:schedule-names`, `test:squadron-merge`, `test:squadrons-remote`

All passed in this branch.

## Next Step 6 expansion

1. Add internal read endpoints for remaining heavy lists (e.g. currencies, messages, pending) as each write path moves.
2. Add contract tests that compare internal API JSON responses against golden snapshots (beyond merge-unit coverage).
3. Gate each migrated surface with fallback + diagnostics until full cutover.
