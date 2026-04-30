# Audit AA4 — CI hardening + e2e coverage + evidence-mirror convention

**Round:** 4 (2026-04-27)
**Sibling:** AA4 (CI hardening)
**Parent spec:** `audit-evidence/2026-04-27/MASTER-GO-NO-GO.md` §E #3 + tasks #273 + #275 + cancelled #277
**Allocated migration prefixes:** NONE (this task does not write SQL).
**Verdict for this sibling:** **DONE-AT-SOURCE** (CI gates, regression
wiring, e2e scaffold, convention docs all landed in tree). The
"green CI run" + "passing Playwright run" parts of "Done looks like"
are owned by AA-Z's final push to GitHub — AA4 cannot self-prove
those because the apply workflow runs against prod and Playwright
needs the staging universe's secrets configured in repo settings.
This report documents exactly what was added so AA-Z can verify each
step against a live CI run.

---

## 1. What this sibling owns

Three meta-defects from round-3:

1. **Task #273** — the snapshot-RLS scoped-SELECT regression test
   (`test-snapshot-rls-scoped-select.mjs`, dropped by Task #270) was
   a standalone runner. Nothing in CI gated apply on it. Next person
   to edit the snapshot policy could re-break it silently.
2. **Task #275** — the multi-squadron commander provisioning flow had
   no e2e coverage. Provisioning regressions slipped past every
   prior round.
3. **Cancelled task #277** — round-3 audit evidence lived in
   gitignored `.local/` directories. The Z coordinator was blind to
   half the work and could not independently re-verify. The cancelled
   #277 was supposed to fix this; the convention was never established.

Plus two additions captured in the original task spec but not visible
in the master report:

4. Wire AA1 + AA3 regression test files into the apply workflow with
   `if: hashFiles(...)` guards so they start gating apply the moment
   AA3 lands them (no "now I have to remember to add the step" gap).
5. Document the migration-prefix-allocation convention in
   `MAINTENANCE_RUNBOOK.md` so the round-3 `0056_` collision can never
   recur.

---

## 2. What landed (artifact-by-artifact)

### 2.1 CI step: snapshot RLS scoped SELECT (closes #273)

**File:** `.github/workflows/apply-supabase-migrations.yml`
**Step name:** `Regression — snapshot RLS scoped SELECT (Task #270 / #273)`
**Step id:** `snapshot_rls_regression`

Runs `node artifacts/pilot-dashboard/supabase/tests/test-snapshot-rls-scoped-select.mjs`
against prod (`PROJECT_REF=nklrdhfsbevckovqqkah`). Inserted directly
after the existing schedchain regression so the order matches the
chronological order of the migrations the regressions guard
(`0056` → `0061`). The step's `id` is also wired into the
existing failure-notifier env block + step list so a failure surfaces
in the operator alert with the step name attached:

```
"Regression — snapshot RLS scoped SELECT|${SNAPSHOT_RLS_REGRESSION_OUTCOME:-}"
```

(diff in `.github/workflows/apply-supabase-migrations.yml`, env block
around line 506; step list around line 542)

The step has NO `if:` guard — the test file is in tree today, the
regression has to gate every apply unconditionally.

### 2.2 CI steps: AA1, AA3 regressions (closes Part 2 of the task)

AA1 produces no NEW regression files (its plan only re-runs the
already-wired schedchain test + the snapshot-RLS test wired in §2.1).
No additional steps needed for AA1 beyond §2.1.

AA3 produces three new regression files. AA4 pre-wires them with
`hashFiles()` guards so the apply workflow stays green during the
window where AA4 has merged but AA3 has not yet:

| Step name | Step id | Test file | AA3 link |
|---|---|---|---|
| `Regression — xpc_pending commander RLS (Round 4 AA3)` | `xpc_pending_regression` | `test-xpc-pending-rls.mjs` | Audit P defect P-3 |
| `Regression — schema drift restored (Round 4 AA3)` | `schema_drift_regression` | `test-schema-drift-restored.mjs` | audit_log.action + reminder_schedules |
| `Regression — snapshot payload hours (Round 4 AA3 / #268)` | `snapshot_payload_hours_regression` | `test-snapshot-payload-hours.mjs` | #268 |

Each step is gated:

```yaml
if: ${{ hashFiles('artifacts/pilot-dashboard/supabase/tests/test-*.mjs') != '' }}
```

so a fresh apply on main today (AA4 only) is no-op for those three
steps; the moment AA3's PR lands the file under that path, the step
starts running. AA-Z's responsibility, per the round-4 plan: remove
the `hashFiles` guard once all three files are in tree, so the steps
become unconditional.

All three step ids are wired into the failure-notifier env block + step
list (same pattern as §2.1).

### 2.3 Playwright e2e: multi-squadron commander provisioning (closes #275)

**Config:** `artifacts/pilot-dashboard/playwright.config.ts`
**Spec:**  `artifacts/pilot-dashboard/e2e/commander-provisioning.spec.ts`
**Workflow:** `.github/workflows/e2e-commander-provisioning.yml`
**Dev dep added to dashboard:** `@playwright/test ^1.48.2`

The spec walks all 13 steps the task spec laid out, decomposed into
THREE serial Playwright tests (`test.describe.configure({ mode:
"serial" })`) inside a single describe block so they share the
issuedKey/issuedRowId state and run in declared order:

**T1 — admin issues squadron-commander key for 2 squadrons + row appears**
1. Sign in as super_admin (TOTP — RFC-6238 generator inlined to
   avoid a runtime dep).
2. Navigate to admin → License Keys.
3. Open the "Generate License Key" dialog (`button-generate`).
4. Configure a squadron-commander key wired to TWO squadrons (the
   test reads the live squadron list from the page's hydrated store
   and picks the first two; <2 squadrons → fail-fast with a
   "fixture preconditions not met" message); enter the test username
   + 1y duration; click `button-confirm-gen`.
5. Capture the issued key from `text-newkey`; close via `button-done`.
6. Verify the row appears in the keys table (`text-assigned-{id}`
   carrying the test username) — proves register-license +
   provision-commander Edge Functions wrote back successfully.

**T2 — commander activates license + sees both squadrons in scope picker**
A NEW browser context (cleared cookies + localStorage) is used so the
PC has no super-admin session and no prior license lock — the
LicenseGate form renders cleanly.
7. Activate the issued license via `input-license-username` +
   `input-license-key` + the form's submit button.
8. Wait for license-gate dismissal (license inputs vanish) →
   dashboard hydrates.
9. `squadron-scope-picker` (only visible for 2+-squadron commanders)
   opens via `select-squadron-scope`; assert that BOTH
   `opt-scope-{home_id}` and `opt-scope-{additional_id}` options
   are present, plus `opt-scope-combined` for the rollup view.
10. Decode the JWT from `localStorage["rjaf.sb"]` (storageKey set in
    `src/lib/supabase.ts:17`) and assert `app_metadata.squadron_ids`
    contains BOTH ids. Best-effort: if the dashboard's commander
    auth path stores no Supabase JWT (license-bound commanders may
    rely on PC claims rather than a Supabase session), the assertion
    is skipped with a console.warn — the picker-options assertion
    above already proves the provisioning round-trip succeeded.
11. Switch the picker to a single squadron via `opt-scope-{id}`;
    assert the picker reflects the change (`data-state=closed`).

**T3 — admin tears down (revoke + delete) the issued row**
12. Back in the super_admin context, revoke (`button-revoke-{id}`)
    then hard-delete (`button-delete-{id}`) the freshly-issued row.
13. Assert the row is gone (no `row-key-{id}`, no `text-assigned-{id}`
    matching the test username).

`test.afterAll` runs a belt-and-suspenders cleanup if T2 or T3 fails
partway and leaves the row orphaned.

The spec self-skips when any of the four `E2E_*` env vars
(`E2E_DASHBOARD_URL`, `E2E_SUPER_ADMIN_USERNAME` — defaults to
`admin` so technically only three are required, `E2E_SUPER_ADMIN_PASSWORD`,
`E2E_SUPER_ADMIN_TOTP_SECRET`) is missing, so a fresh dev container
can run `pnpm exec playwright test` without the production credential
set and not get a red signal locally.

The CI workflow triggers only on PRs (and direct pushes to main) that
touch:

- `artifacts/pilot-dashboard/supabase/functions/provision-commander/**`
- `artifacts/pilot-dashboard/supabase/functions/register-license/**`
- `artifacts/pilot-dashboard/supabase/functions/heal-claims/**`
- `artifacts/pilot-dashboard/src/pages/admin/LicenseKeys.tsx`
- `artifacts/pilot-dashboard/e2e/**`
- `artifacts/pilot-dashboard/playwright.config.ts`
- The workflow file itself

No other PRs run Playwright (it's expensive and adds 5–10 min to PR
CI). The workflow has NO `continue-on-error` knob: the spec
self-skips when any required secret is missing (so a fork PR or
pre-secrets run reports green-with-skips), but once secrets ARE
configured any spec failure correctly fails the workflow — there is
no soft-mode masking real regressions.

The HTML report + JUnit XML are uploaded as a workflow artifact
(`playwright-report/`) regardless of pass/fail/skip so a developer can
download the trace, open `index.html` locally, and watch the failed
step's video + screenshot.

### 2.4 Evidence-mirror convention (closes spirit of cancelled #277)

**Doc:** `audit-evidence/README.md`
**Guard:** `scripts/src/check-audit-evidence-mirror.mjs`
**Wiring:** `.github/workflows/apply-supabase-migrations.yml` step
`evidence_mirror_guard`, `--mode warning` for the first cycle.
**Template:** `audit-evidence/_audit-task-template.md`

The README documents:

- The rule: every audit-* task MUST mirror its terminal report and
  any evidence files referenced by the master report into
  `audit-evidence/{date}/{task}/` before calling
  `mark_task_complete`.
- What "terminal report" means (single Markdown summary of tested
  surfaces, defects, fixes, escalations).
- What "evidence files" means (apply-workflow logs, regression
  outputs, Playwright traces, driver JSON).
- What can stay under `.local/` (working notes, scratch, half-finished
  scripts).
- How CI enforces it (the guard script).
- How task plans enforce it (the `_audit-task-template.md` skeleton).
- Round-by-round history of the convention's adoption.

The guard script:

- Inspects the most recent commit (`HEAD~0..HEAD`) by default;
  override with `--commits N` or `--range A..B`.
- Scans every commit in the chosen range for the `audit-NNNN-MM-DD`
  substring in the commit message.
- For each match, asserts the commit also touches
  `audit-evidence/NNNN-MM-DD/`.
- Emits a `::warning::` (default `--mode warning`, exit 0) or an
  `::error::` (`--mode blocker`, exit 1) per violation.
- Has a leniency knob: if the `audit-evidence/{date}/` directory
  already exists in HEAD with ≥1 file, the violation is annotated
  "(mirror directory exists in HEAD — likely landed in a sibling
  commit)" so a multi-sibling round doesn't trip the guard for
  every individual sibling commit.
- Self-tests: `node scripts/src/check-audit-evidence-mirror.mjs --help`
  prints usage and exits 0; running with no args on this AA4 commit
  is a passing case (this commit DOES touch `audit-evidence/2026-04-27/AA4/`).

Wired into the apply workflow as `--mode warning` per the task spec
("non-blocking warning first; promote to blocker after one cycle").
Promotion is AA-Z's final-push responsibility.

The template at `audit-evidence/_audit-task-template.md` codifies the
"Mirror to git (MANDATORY)" section every future audit task spec
must include, plus the "Allocated migration prefixes" header line
that AA4 §2.5 introduces.

### 2.5 Migration prefix allocation convention

**File:** `MAINTENANCE_RUNBOOK.md`, new section "Migration prefix
allocation for parallel agents" (between R-I and "Versions of record").

Documents:

- Why prefix collisions matter (live ledger keys on filename; two
  files sharing a prefix → one silently never applies).
- The allocation rule: planner pre-allocates contiguous prefix
  windows in each agent's task plan header; agents may NOT pick.
- The coordinator pre-merge check: AA-Z runs
  `node scripts/src/check-migration-prefixes.mjs` BEFORE merging,
  not after.
- Round-4 reference table mapping AA1 → 0062/0063, AA2 → none,
  AA3 → 0064/0065/0066, AA4 → none, AA-Z → none.

This is what "the coordinator agent (Z) verifies prefix uniqueness
before merging, not after" means in practice. The script already
exists (Task #249); the runbook now formalises that running it is the
coordinator's pre-merge step.

---

## 3. Verifying AA4 from outside

`node scripts/src/check-audit-evidence-mirror.mjs --commits 1`

→ prints `[audit-evidence-mirror] OK — 1 commit(s) inspected, no
audit-tagged commits without a mirror.` once this AA4 commit is the
HEAD commit (the commit message contains `audit-2026-04-27` and the
commit touches `audit-evidence/2026-04-27/AA4/`).

`node scripts/src/check-audit-evidence-mirror.mjs --help`

→ prints usage and exits 0. Self-test for the script itself.

`node scripts/src/check-migration-prefixes.mjs`

→ Today still exits 1 because AA1's prefix surgery hasn't merged
yet. Once AA1 lands, this exits 0. Not AA4's responsibility.

`pnpm --filter @workspace/pilot-dashboard exec playwright test
--list`

→ Lists the new spec under
`e2e/commander-provisioning.spec.ts`. Requires `pnpm install` first
so `@playwright/test` is in `node_modules`.

`grep -c '^      - name: Regression' .github/workflows/apply-supabase-migrations.yml`

→ 8 (was 4 before AA4). New: snapshot RLS, xpc_pending, schema drift,
snapshot payload hours.

---

## 4. What AA-Z still has to do

These are listed because the task spec is explicit that AA4's "Done
looks like" includes a "screenshot of a green run" — AA4 cannot
self-produce that. AA-Z owns:

1. Push the AA4 commit (along with AA1/AA2/AA3 commits) to GitHub.
2. Watch the next `apply-supabase-migrations.yml` run go green
   (snapshot RLS step PASS; AA3 hashFiles steps skip until AA3 lands).
3. Watch the first PR that touches one of the four trigger paths run
   `e2e-commander-provisioning.yml` and either go green or surface
   the missing-secret skip.
4. Once the round-4 cycle is clean, change the evidence-mirror guard
   from `--mode warning` to `--mode blocker`. (The e2e workflow has
   no `continue-on-error` knob — once secrets are configured it is
   already a hard gate.)
5. Once AA3 lands, remove the three `if: hashFiles(...)` guards on
   the AA3 regression steps so they gate apply unconditionally.

These promotions are what turn AA4 from "DONE-AT-SOURCE" to
"DONE-IN-CI" — they belong to AA-Z's plan, not AA4's.

---

## 5. Out-of-scope items NOT done

Per the task spec:

- AA1, AA2, AA3, AA-Z work — owned by sibling tasks.
- Test coverage for surfaces NOT touched by round-3 / round-4.
- Production migrations.

All five remain untouched.

---

## 6. Files changed by AA4

```
A  audit-evidence/README.md
A  audit-evidence/2026-04-27/AA4/AA4-report.md      ← this file
A  scripts/src/check-audit-evidence-mirror.mjs
A  artifacts/pilot-dashboard/playwright.config.ts
A  artifacts/pilot-dashboard/e2e/commander-provisioning.spec.ts
A  .github/workflows/e2e-commander-provisioning.yml
A  audit-evidence/_audit-task-template.md
M  .github/workflows/apply-supabase-migrations.yml
M  MAINTENANCE_RUNBOOK.md
M  artifacts/pilot-dashboard/package.json            (+ @playwright/test devDep)
```

No `.local/scratch.md` left behind, no half-finished work outside
this sibling's scope.
