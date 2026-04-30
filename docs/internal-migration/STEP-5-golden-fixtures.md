# Step 5 — Golden datasets & report certification

**Status:** Scaffold / pointers (full goldens grow with migration).  
**Date:** 2026-04-25

## Purpose

Prove **Monthly Report** and **calculation** outputs do not drift when moving from Supabase transport to internal API + Postgres. Goldens are **expected numbers and key strings**, not screenshots.

## Existing automated anchors

| Area | Location |
|------|-----------|
| Dash pilot hour adapter | `tests/dash-pilots-snapshot.test.ts` |
| Monthly report forms math anchors | `tests/monthly-report-forms.test.ts` |
| Join lifecycle local-state anchor | `tests/join-lifecycle.test.ts` |
| Transport fault-injection anchors | `tests/fault-injection.test.ts` |
| Calculation engine (when run in repo) | `pnpm --filter @workspace/pilot-dashboard exec tsx .local/tests/full-simulation.ts` (if present on branch) |
| SQL-side drift (Supabase) | `supabase/tests/` RPC/schema tests where applicable |

## Planned fixtures (to add incrementally)

1. **Small squadron JSON** — 3 pilots, 6 sorties spanning day/night/NVG, one guest pending, one frozen month edge.
2. **Expected `computePilotTotals`** snapshot per pilot (stored as JSON in `tests/fixtures/`).
3. **Monthly report** — expected Form 1–4 headline figures for the same fixture month.

## Rule

When internal API serves sorties/pilots, **the same fixture** must produce **bit-identical** golden JSON to the current engine output, or the operator signs a documented delta.
