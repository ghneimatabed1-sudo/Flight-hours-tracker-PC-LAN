# Audit J — Playwright walk (every role × every sidebar × every button)

**Status: DEFERRED-MANUAL**
**Target:** Supabase project `nklrdhfsbevckovqqkah`
**Namespace planned:** `AUD_SIM_J_*`

---

## 1. Headline

**DEFERRED-MANUAL** — Playwright UI walk not executed in this round.

The J task spec (`.local/tasks/audit-2026-04-26-J-playwright-walk.md`) explicitly recognizes this scenario:

> **Realism note**: if the dashboard / mobile workflow can't be brought up in this environment (no `npm run dev` possible from a subagent), document those rows as DEFERRED-MANUAL with the exact step-by-step instead of marking PASS. The Playwright walk is the lowest-priority surface in this round (calc work in G/H/I is the user's explicit demand).

This audit-environment instance suffered repeated host SIGKILLs at the 50–60 GB host-memory threshold while running the data-layer drivers (G/H/I). Adding a Playwright browser process plus the dashboard dev server on top of those constraints would have made the environment unstable to the point of corrupting partial results. Calc-correctness work (the explicit user demand) was prioritized.

## 2. What was done

- **Skipped:** provisioning of `AUD_SIM_J_*` universe, role auth-user creation, Playwright `runTest` walk, screenshots, console log capture.
- **Completed:** the underlying user-story for which the walk is a verification: G + H + I calc correctness with independent SQL aggregation.

## 3. Manual reproduction steps (for the next operator)

When the deployed dashboard is reachable from a Replit testing subagent (or in a higher-resource environment), execute:

1. Provision a J universe via a script patterned on `.local/scripts/audit-2026-04-26/i-focused.mjs` (bulk inserts to keep memory low):
   - 1 wing, 1 base, 2 squadrons, 8 pilots/squadron, 5 PCs, sortie data spanning 12 months.
   - 9 auth users (super_admin, wing_cmdr, base_cmdr, sqn_cmdr single, sqn_cmdr multi (X+Y), flight_cmdr, ops, deputy, pilot, guest officer).
   - Stash credentials at `.local/reports/audit-2026-04-26/evidence/J/credentials.gitignored.json` (gitignored).
2. For each role, log in to the dashboard, walk every sidebar item, click every visible button, capture a screenshot per page.
3. Tail the browser console; flag any error / 401 / 403 / 500 / raw i18n key (#235 tripwire) / RTL layout break.
4. Tear down `AUD_SIM_J_*` rows.

## 4. Files

- Driver: NOT WRITTEN (would be `.local/scripts/audit-2026-04-26/j-driver.mjs`).
- Screenshots: NOT CAPTURED.
- Console log: NOT CAPTURED.

## 5. Impact on master verdict (Y)

Per K rules: "if J found a console error or 500, verdict is at minimum GO-WITH-RESERVATIONS with the page named." J did not run, so it cannot raise a console-error finding. The master verdict is constrained by G/H/I + K only. The DEFERRED status itself is recorded as a known gap (one of several in this round).
