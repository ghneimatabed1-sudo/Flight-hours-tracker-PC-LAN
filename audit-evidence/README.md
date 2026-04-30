# `audit-evidence/` — the permanent, version-controlled mirror of every audit round

## Why this directory exists

Round-2 (2026-04-25) and round-3 (2026-04-27) of the full-role audit
process both produced extensive evidence — driver outputs, sibling
reports, regression traces, screenshots — that lived under
`.local/reports/audit-NNNN-MM-DD/`. The `.local/` tree is gitignored at
the system level (`/etc/.gitignore`), so none of those files survived
the merge into the project's main branch. Every coordinator agent
inherited that gap and had to re-derive what it could from in-tree
tests + commit messages.

The 2026-04-27 master report (`audit-evidence/2026-04-27/MASTER-GO-NO-GO.md`,
§E #3 / §E #4 / §E #5) names this as a P1/P2-class meta-defect:

> Round-3 evidence not mirrored to version control. L, M, N, O, P, Q
> reports and Playwright traces all live under gitignored
> `.local/reports/audit-2026-04-27/`. Z had to re-derive what it could
> from in-tree tests + commit messages. The sibling tasks should have
> followed the round-2 pattern of writing a
> `audit-evidence/2026-04-27/{sibling}.md` mirror that survives the merge.

This directory is the convention that closes that gap.

## The rule (mandatory for every audit-* task)

**Every audit task — sibling or coordinator — MUST mirror its terminal
report and any evidence files referenced by the master report into**

```
audit-evidence/{ISO date of the round}/{task name or letter}/
```

**before calling `mark_task_complete`.** Gitignored
`.local/reports/audit-NNNN-MM-DD/` may be used as scratch space during
the run, but nothing under `.local/` counts as audit evidence.

## What "terminal report" means

The single Markdown file each sibling produces summarising:

- What was tested (calc surfaces, RLS shapes, UI roles, etc.)
- Pass / fail outcome per item, with a one-line pointer to the proof
- Defects found (if any), each with severity + reproduction
- Fixes applied this round (with file paths / commit refs)
- Anything escalated to a follow-up

Naming convention:

```
audit-evidence/2026-04-27/AA4/AA4-report.md
audit-evidence/2026-04-27/L/L-report.md
audit-evidence/2026-04-27/MASTER-GO-NO-GO.md   ← coordinator's master
```

## What "evidence files referenced by the master report" means

If the master report (or your own sibling report) cites a specific file
to back up a claim, that file MUST be mirrored too. Examples:

- `apply-workflow.log` — the action log of a CI re-run.
- `regression-{name}.log` — output of an in-tree regression script.
- `prefix-collision.txt` — output of a guard script.
- Playwright traces / screenshots — the `.zip` traces and `.png` shots
  that prove a UI walk happened.
- Driver JSON output (`evidence/G/g-driver.json`, etc.) — the raw run
  trace of any audit driver script the master report inherits a PASS
  from.

If the file is huge (multi-MB Playwright traces), check it in anyway.
Storage is cheap; blind audits are not.

## What can stay under `.local/`

- Working notes ("here's what I tried before settling on the fix").
- Half-finished script drafts.
- Personal scratch files unrelated to the audit verdict.

If in doubt, mirror it. The downside of mirroring extra evidence is
zero; the downside of skipping evidence is the next coordinator's
verdict is partially blind.

## How CI enforces this

`scripts/src/check-audit-evidence-mirror.mjs` runs in
`.github/workflows/apply-supabase-migrations.yml` (warning-mode for the
first cycle, then promoted to a hard blocker). It fails any commit
whose message contains `audit-NNNN-MM-DD` but does NOT touch a
corresponding `audit-evidence/NNNN-MM-DD/` directory in the same
commit.

The guard is intentionally lenient: it only fires on commits that
self-identify as audit work. Ordinary feature commits never trip it.

## How task plans enforce this

Every audit task spec under `.local/tasks/audit-*.md` includes a
"Mirror to git" section as the last step before "Done looks like".
The skeleton at `audit-evidence/_audit-task-template.md` (in this
directory, version-controlled) is the canonical shape future audit
task authors should clone. Authors clone it INTO their gitignored
`.local/tasks/audit-{ROUND}-{LETTER}.md` workspace; the version-
controlled copy stays here so every coordinator can find it.

## History

| Round | Date | Mirrored evidence |
|---|---|---|
| 1 | 2026-04-25 | `audit-evidence/2026-04-25/MASTER-GO-NO-GO.md` only — sibling reports were not mirrored (the convention had not yet been established). |
| 2 | 2026-04-26 | Master + G/H/I/J/K reports + raw driver JSON under `evidence/`. First round to follow the mirror convention end-to-end (post-hoc, under task #255). |
| 3 | 2026-04-27 | Master only — sibling reports L/M/N/O/P/Q stayed in `.local/`. This is the P1 defect (§E #3) that round-4 AA4 closes by establishing the convention permanently. |
| 4 | 2026-04-27 | AA1/AA2/AA3/AA4/AA-Z each mirror their own sibling report under `AA{N}/`. Master is `MASTER-GO-NO-GO.md` at the round root (when AA-Z lands). |
