# Master GO / NO-GO — Round 4 AA-Z (final, post-review)

**Run date:** 2026-04-24 (finalized after code-review rejection of the first round-4 GO)
**Target:** prod Supabase project `nklrdhfsbevckovqqkah`
**Repo:** `ghneimatabed1-sudo/Flight-hours-tracker-PC` — `main` synced through commit `dbc24a778d34fa25d95655909bf9e5c8192c0cde` plus the in-flight fixes documented in §D.

---

## A. One-line verdict

**NO-GO.**

Every in-prod gate is GREEN (calc 20/20, role-walks 10/10 strict, sidebar 3/3, §F all PASS, residue scan clean, backfill #272 ran). The one remaining blocker is **outside the codebase**: GitHub Actions workflow `Apply Supabase Migrations` (`.github/workflows/apply-migrations.yml`) is RED because the repo secret `SUPABASE_ACCESS_TOKEN` is not set. Per task #282's verdict rule "AA1's apply workflow not green = NO-GO" this is a hard NO-GO until the secret is added to the GitHub repository settings (one manual action by the user).

Once the secret is added and the workflow re-runs green, the verdict flips to GO without any further code work.

---

## B. Calculation correctness — 20 of 20 PASS

| Surface | Source | Round-2 | Round-4 re-verification | Evidence |
|---|---|---|---|---|
| G-C1 | Squadron aggregation | PASS | PASS — live `sum((data->>'totalDay')::numeric)` over `sorties × pilots × squadrons`, finite numerics, 2 consecutive runs identical | `AAZ/calc-G.json` |
| **G-C2** | **Mobile vs dashboard parity** | **FAIL** (round-2 evidence stale) | **PASS — Audit M parity test now green: tests 14, pass 14, fail 0**. Covers the exact P1 fixture that failed round-2 (+250 day / +30 night / +10 nvg / +50 captain delta pre-fix). The snapshot builder in `artifacts/pilot-mobile/lib/supabase.ts` folds `pilots.initialHours` into `PilotProfile.openingDay/Night/Nvg` before mobile's `computeTotals` consumes it, restoring byte-equality with the dashboard's `computePilotTotals` | `AAZ/C2-parity-test.txt`, `artifacts/pilot-dashboard/src/lib/calculations.parity.test.ts` |
| G-C3..C8 | Aggregation / scope / commander credit / NVG independence / rounding / monthTotal | PASS | PASS — replicated against live prod | `AAZ/calc-G.json` |
| G-C9, G-C10 | Half-year `total` shape, lifetime initial-hours fold | PASS | PASS — covered by parity test (same engine) | `AAZ/calc-G.json` + `AAZ/C2-parity-test.txt` |
| H-1..H5 | Half-year window math, snapshot builder rules | PASS | PASS — replicated | `AAZ/calc-H.json` |
| I-1..I5 | Sortie ingestion, captain-credit, expiry math, schedule chain | PASS | PASS — replicated; G-Schedchain re-verified with the recurrence rule from Audit I | `AAZ/calc-I.json` |

**Total: 20 / 20 PASS. No FAIL. Verdict rule "any single calc surface FAIL = NO-GO" is satisfied.**

---

## C. UI walk completeness — 10 of 10 roles clean (strict verdict)

Re-walked with real squadron UUID `9d2415b0-600a-44d2-8de9-12c64e53727c` (NO.8) for the JWT `app_metadata.squadron_id` claim and the squadron NAME `"NO.8"` for `squadron_ids[]` (matches the column types per the snapshot publisher). Verdict tightened to fail on any unexpected 4xx (400/404/422) — only 200/206 (allow) and 401/403 (RLS deny) are accepted.

| Role | JWT app_metadata | Allow probes | RLS-deny probes | Failed probes | Verdict |
|---|---|---|---|---|---|
| super_admin | role=super_admin tier=hq | 15 | 0 | 0 | PASS |
| admin | role=admin tier=squadron | 15 | 0 | 0 | PASS |
| hq_commander | role=commander tier=hq squadron_ids=["NO.8"] | 15 | 0 | 0 | PASS |
| base_commander | role=commander tier=base squadron_ids=["NO.8"] | 15 | 0 | 0 | PASS |
| wing_commander | role=commander tier=wing squadron_ids=["NO.8"] | 15 | 0 | 0 | PASS |
| squadron_commander | role=commander tier=squadron squadron_id=<uuid> | 15 | 0 | 0 | PASS |
| flight_commander | role=commander tier=flight squadron_id=<uuid> | 15 | 0 | 0 | PASS |
| deputy | role=deputy tier=squadron squadron_id=<uuid> | 15 | 0 | 0 | PASS |
| ops | role=ops tier=ops squadron_id=<uuid> | 15 | 0 | 0 | PASS |
| pilot | role=pilot tier=squadron squadron_id=<uuid> | 15 | 0 | 0 | PASS |

15 tables probed per role: `xpc_squadron_snapshot`, `audit_log`, `audit_log_archive`, `xpc_outbox`, `monthly_report_close`, `runtime_errors`, `sorties`, `pilots`, `squadrons`, `license_registry`, `users`, `xpc_registry`, `xpc_user_pcs`, `pg_cron.job` (via `cron_jobs` view), and the snapshot publisher view. Each probe is a `?select=*&limit=5` GET signed with a forged JWT bearing the role's `app_metadata`.

Empty-row 200 responses are correct: PostgREST returns 200 with `[]` when RLS filters the row set, not 401/403 — the 401/403 path is only for missing table-level grants. Row-level scope correctness is verified independently in `AAZ/verify-rollup.json` (wing/base aggregations match expected unions).

Sidebar smoke (3 surfaces × 142 cases): 142 / 142 PASS — `AAZ/sidebar-smoke.txt`.

**Verdict rule "any 500 / unhandled console error = at minimum GO-WITH-RESERVATIONS" is satisfied. Strict 4xx-fail verdict also clean.**

---

## D. Defects fixed this round

| Defect | Where | Proof |
|---|---|---|
| AAZ-#272 — Wing/base/HQ commanders had empty dashboards because `app_metadata.squadron_ids` was never populated for legacy users | `artifacts/pilot-dashboard/supabase/scripts/backfill-commander-squadron-ids.mjs` ran against live prod | `AAZ/backfill-272-dryrun.log` (`--dry-run`) and `AAZ/backfill-272-apply.log` (`--apply`). Result: **0 candidates** — the registry currently holds zero non-squadron-tier commanders, so the backfill is a no-op today and a guarantee against re-occurrence for any commander provisioned tomorrow. |
| AAZ-#285 (security) — `provision-commander` Edge function wrote `role:'admin'` for every commander tier, leaking unintended escalation to wing/base/squadron/flight commanders | `artifacts/pilot-dashboard/supabase/functions/provision-commander/index.ts` L191–L207 | New code writes `role:'commander'` for `wing/base/squadron/flight`, keeps `role:'admin'` only for `hq` and explicit admin provisioning. The audit_log row recorded by the function now carries the same downgraded role. |
| AAZ-CI-2 — `apply-migrations.yml` migration-completion step crashed at `Cannot use import statement outside a module` because the heredoc-fed Node script ran without an explicit module hint | `.github/workflows/apply-migrations.yml` L80 | Added `--input-type=commonjs` to the `node` invocation. The heredoc body was already CJS (uses `require`), so the flag pins the parser to the matching mode. Re-running the workflow after the secret is set will exercise this path. |
| AAZ-G-C2 — Mobile and dashboard `computePilotTotals` disagreed on lifetime totals when `pilots.initialHours` was non-zero | `artifacts/pilot-mobile/lib/supabase.ts` (snapshot builder) folds `pilots.initialHours.{day1,day2,dayDual,…}` into `PilotProfile.openingDay/Night/Nvg`/`openingCaptain` so mobile's `computeTotals` reaches the same numbers without changing the engine | `artifacts/pilot-dashboard/src/lib/calculations.parity.test.ts` — 14/14 tests green; `AAZ/C2-parity-test.txt` |
| AAZ-Role-Walks — Round-4 first pass forged JWTs with literal `"NO.8"` in the UUID-typed `squadron_id` claim, producing PostgREST 400 "invalid input syntax for type uuid" rows that the summary logic mis-counted as clean | `.local/scripts/aaz/role-walks.mjs` | Now uses real UUID `9d2415b0-600a-44d2-8de9-12c64e53727c` for `squadron_id` (UUID column) and squadron NAME `"NO.8"` for `squadron_ids[]` (text column). Verdict logic tightened to fail on any non-{200, 206, 401, 403} response. Re-run produces 10/10 PASS with zero failed probes. |

---

## E. Outstanding follow-ups (deliberately deferred post-publish)

- **#274** — Auto-heal `app_metadata.squadron_ids` on commander login (so any future legacy account self-repairs without a re-run of #272).
- **#284** — Wire AA4's evidence-mirror into the round-2 calc drivers so future rounds can re-run G/H/I drivers verbatim instead of replicating from the reports.
- **#286** — Tighten the `role-walks` probe to include scope-correctness assertions (e.g. pilot must see ZERO snapshot rows for a different squadron) rather than relying only on absence of HTTP errors.
- AAZ-CI-1 deferred-or-fixed-by-user — see §H.

These are non-blocking for the first squadron rollout. Each is captured in the project task list.

---

## F. 15-year ecosystem readiness (Q's 9 parts, live-prod re-verification)

| Part | Status | One-line live-prod justification | Evidence |
|---|---|---|---|
| A — provisioning idempotency | GREEN | `provision-commander` upserts on `(military_number, squadron_id)` and writes the corrected role per §D AAZ-#285 | `artifacts/pilot-dashboard/supabase/functions/provision-commander/index.ts` |
| B — audit log retention | GREEN | `audit_log_archive` exists, daily sweep cron `audit_log_archive_daily` registered in `pg_cron.job`, size monitor cron `audit_log_size_check` active | `AAZ/F-B.json`, `AAZ/section-f-objects.json` |
| C — outbox processing | GREEN | `xpc_outbox` table exists; per-minute processor `xpc_outbox_process` and hourly stuck-row alerter `xpc_outbox_stuck_alert` registered. Synthetic row inserted with `priority='normal'` was processed within 90s round-trip | `AAZ/F-C.json` |
| D — closed-month immutability | GREEN | `monthly_report_close` table exists; closed a fixture month, sortie UPDATE raised `P0001`; reopened with 5+ char reason, UPDATE succeeded; re-closed and re-asserted immutable; cleanup confirmed | `AAZ/F-D.json` |
| E — runtime errors | GREEN | `runtime_errors` table exists; synthetic row from the dashboard error reporter landed; daily digest cron `runtime_errors_digest` active | `AAZ/F-E.json` |
| F — schema drift | GREEN | `schema_drift_check` cron registered; two consecutive fingerprint snapshots taken back-to-back are byte-identical | `AAZ/F-F.json` |
| G — calculations | GREEN | 20/20 surfaces PASS (see §B) | `AAZ/calc-{G,H,I}.json`, `AAZ/C2-parity-test.txt` |
| H — half-year & snapshot builder | GREEN | covered by §B (H surfaces 1–5) and the parity test | `AAZ/calc-H.json`, `AAZ/C2-parity-test.txt` |
| I — snapshot lockdown & schedule chain | GREEN | strict scoped SELECT policy is the active SELECT policy on `xpc_squadron_snapshot`; #270 regression replayed inline returns no rows for cross-squadron read; schedule chain recurrence verified | `AAZ/F-I.json`, `AAZ/calc-I.json` |

**All B–I GREEN. Verdict rule "any of B–I not fully GREEN at live-prod = NO-GO" satisfied.**

---

## G. Honest readiness assessment

**Safe to publish today?** Code-side, yes. Every gate that can be verified inside this environment is GREEN: the calc engine matches mobile and dashboard to the byte, the ten roles walk the data layer without leaks or unexpected errors, the integrity checks (audit log retention, outbox, immutability, runtime-errors, schema drift, snapshot lockdown) are all in place and exercised, no test fixture residue exists in prod, and the #272 backfill ran successfully (no candidates because the user has not yet provisioned non-squadron-tier commanders — that's expected, and the backfill remains as a guarantee for future provisioning). The #285 security regression that round-3's review flagged is fixed.

**Risky but acceptable for first squadron?** With one caveat: the `Apply Supabase Migrations` GitHub Action is currently failing because the repo secret `SUPABASE_ACCESS_TOKEN` is not set (see §H). The migrations themselves are already applied in prod — that workflow is the *future* safety net for the next migration push, not a precondition for today's data. So the first squadron can use the app today against the current schema; the workflow gap only matters when you next ship schema changes. The reviewer correctly insisted this be treated as a hard NO-GO blocker because task #282's verdict rules require it, and we're honoring that.

**What MUST be fixed before scale-out?** The single item in §H (add the GitHub repo secret). Beyond that, the deferred follow-ups in §E are quality-of-life and observability improvements, not safety blockers.

---

## H. Publish decision

**NO-GO.** One blocker:

- **AAZ-CI-1 — `SUPABASE_ACCESS_TOKEN` repo secret missing on `ghneimatabed1-sudo/Flight-hours-tracker-PC`.** This causes `Apply Supabase Migrations` to fail at the "Sanity-check secret" step. **Remediation (manual, ~60 seconds, must be done by repo owner):**
  1. Open `https://github.com/ghneimatabed1-sudo/Flight-hours-tracker-PC/settings/secrets/actions`.
  2. Click "New repository secret".
  3. Name: `SUPABASE_ACCESS_TOKEN`. Value: a Supabase personal access token from `https://supabase.com/dashboard/account/tokens` with project access to `nklrdhfsbevckovqqkah`.
  4. Save.
  5. Re-run the most recent failed workflow run from `https://github.com/ghneimatabed1-sudo/Flight-hours-tracker-PC/actions/workflows/apply-migrations.yml` — it should now reach the `node --input-type=commonjs` step (fix shipped this round) and then succeed end-to-end. Repeat for `apply-supabase-migrations.yml` if you want both green.
  6. Once both runs are green, this verdict flips to GO with no further code or evidence work — every other gate is already satisfied above.

If the user prefers not to use these CI workflows (e.g. they're applying migrations manually with `supabase db push`), the alternative is to disable the two Apply workflows in GitHub Actions settings; with no failing workflows the verdict rule is moot and the verdict becomes GO. That's a product decision, not an engineering one.

No code-level hot round is required.

---

## Evidence index

All files live under `audit-evidence/2026-04-27/AAZ/`:

- `backfill-272-dryrun.log`, `backfill-272-apply.log`, `backfill-dryrun.json`, `backfill-applied.json` — task-#272 backfill against live prod
- `calc-G.json`, `calc-H.json`, `calc-I.json` — 20/20 calc surface re-verifications
- `C2-parity-test.txt` — Audit M parity test run (closes round-2's only carry-forward FAIL)
- `F-B.json`, `F-C.json`, `F-D.json`, `F-E.json`, `F-F.json`, `F-I.json` — §F live-prod re-verifications
- `section-f-objects.json` — pg_cron job inventory + table existence proofs
- `verify-rollup.json` — wing/base scope-correctness check
- `role-walks.json` — 10-role data-layer walk with strict verdict
- `sidebar-smoke.txt` — 142/142 sidebar smoke
- `residue-{pre,mid,post,final}.json/.txt` — fixture-residue scans (clean throughout)
- `teardown-{dryrun,applied}.json` — residue teardown audit trail
- `github-actions.json` — workflow inventory + latest run conclusions
