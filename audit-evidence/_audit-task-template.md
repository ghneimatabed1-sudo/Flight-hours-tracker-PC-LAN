# Audit {LETTER} — {one-line title}

> **Skeleton — copy this file when authoring a new audit task.**
> Established by Round-4 AA4 (task #281, `audit-evidence/2026-04-27/AA4/AA4-report.md`)
> after round-3 sibling reports failed to reach the coordinator's
> environment because they lived in gitignored `.local/`.

**Parent spec:** `path/to/parent-task.md` (or `audit-evidence/{date}/MASTER-GO-NO-GO.md` §X)
**Sibling tasks:** {comma-separated letters in this round}
**Predecessors:** {prior-round audit letters that flagged this work}, if any
**Target:** prod Supabase project `nklrdhfsbevckovqqkah`
**Allocated migration prefixes:** **{NNNN, NNNN, …} ONLY** (or **NONE** if this task does not write SQL).
  See `MAINTENANCE_RUNBOOK.md` § "Migration prefix allocation for parallel agents."
  Agents may NOT pick prefixes — use what the planner allocated.

## Why
{One paragraph: what the audits found, what's broken, and what shape
the fix takes. Reference the round number and any defect IDs.}

## Pre-flight
- Read {files the agent needs to ground itself in}.
- Inspect live state where applicable: ledger rows, schema, JWT shape, etc.
- Confirm the allocated prefix range is still uncontested
  (`node scripts/src/check-migration-prefixes.mjs` exits 0).

## Plan
{Numbered steps. Include code paths touched, regression tests added,
and the apply order for any new migrations.}

## Mirror to git (MANDATORY — see `audit-evidence/README.md`)
- Create `audit-evidence/{date}/{LETTER}/` and write `{LETTER}-report.md`
  documenting: what was tested, every PASS/FAIL with a one-line proof
  pointer, defects discovered, fixes applied, anything escalated, and
  the regression tests / CI steps added.
- Mirror any evidence files the report references (regression logs,
  Playwright traces, screenshots, driver JSON).
- Commit the mirror in the same change set as the work it documents.
- The CI guard `scripts/src/check-audit-evidence-mirror.mjs` enforces
  this. Skipping it means the next coordinator round inherits a blind
  spot.

## Done looks like
- {Concrete, observable conditions — not "the fix works" but
  "`<test command>` exits 0 against prod" / "ledger row present" /
  "Playwright spec PASS in CI run #NNN".}
- `audit-evidence/{date}/{LETTER}/{LETTER}-report.md` exists in git.

## Out of scope
- {Explicit list of what this sibling does NOT own — usually the
  other siblings' surfaces and the coordinator's verdict synthesis.}
