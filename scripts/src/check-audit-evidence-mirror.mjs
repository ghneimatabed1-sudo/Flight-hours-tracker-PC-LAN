#!/usr/bin/env node
// scripts/src/check-audit-evidence-mirror.mjs
//
// Task #281 (Round 4 AA4) — CI guard that enforces the
// audit-evidence-mirror convention documented in
// `audit-evidence/README.md`.
//
// Why this exists
// ───────────────
// Round-3 of the 2026-04-27 audit produced extensive sibling reports
// (L, M, N, O, P, Q) and Playwright traces — all of which lived under
// gitignored `.local/reports/audit-2026-04-27/`. None of those files
// reached the coordinator agent's environment after the merge into
// main, so the master report (`audit-evidence/2026-04-27/MASTER-GO-NO-GO.md`,
// §E #3) had to re-derive what it could from in-tree tests + commit
// messages. The next coordinator round inherited the same blind spot.
//
// The convention this guard enforces:
//   When a commit message self-identifies as audit work by including
//   the substring `audit-NNNN-MM-DD` (matching the round date), the
//   commit MUST also touch a `audit-evidence/NNNN-MM-DD/` path. If
//   not, the audit's terminal report is not in version control and
//   the convention is violated.
//
// Mode
// ────
// The guard runs in two modes:
//
//   --mode warning  (default for the first cycle)
//     Print a `::warning::` annotation, exit 0. CI passes.
//   --mode blocker  (promoted after one clean cycle)
//     Print a `::error::` annotation, exit 1. CI fails.
//
// Range
// ─────
// By default the guard inspects the most recent commit on the current
// HEAD. In CI the GitHub Actions checkout is shallow but includes
// HEAD, so `git log -1 --format=%B` resolves correctly.
//
// Override the inspection range with `--commits N` (last N commits) or
// `--range A..B` (any git revision range) for backfill / batch checks.
//
// Exit codes:
//   0  no violations OR violations in warning mode.
//   1  violations in blocker mode.
//   2  setup error (not a git repo, range malformed, etc).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ── Args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let mode = "warning";
// `range` is only used when --range is passed explicitly. The
// commits=N path uses `git log -n N HEAD` so it works on shallow
// CI checkouts where `HEAD~1` is unavailable (default
// actions/checkout@v4 fetch-depth is 1).
let range = null;
let commits = 1;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--mode") {
    const v = args[++i];
    if (v !== "warning" && v !== "blocker") {
      console.error(
        `[audit-evidence-mirror] --mode must be 'warning' or 'blocker', got '${v}'`,
      );
      process.exit(2);
    }
    mode = v;
  } else if (a === "--range") {
    range = args[++i];
    commits = -1; // explicit range overrides commit count
  } else if (a === "--commits") {
    commits = Number(args[++i]);
    if (!Number.isFinite(commits) || commits < 1) {
      console.error(
        `[audit-evidence-mirror] --commits must be a positive integer, got '${args[i]}'`,
      );
      process.exit(2);
    }
    // Do NOT translate to `HEAD~N..HEAD` — that breaks on shallow
    // checkouts. The commits path is handled by `git log -n N`.
  } else if (a === "--help" || a === "-h") {
    console.log(
      [
        "Usage: node scripts/src/check-audit-evidence-mirror.mjs [options]",
        "",
        "Options:",
        "  --mode warning|blocker  Violation severity (default: warning)",
        "  --commits N             Inspect the last N commits (default: 1 = HEAD)",
        "  --range A..B            Inspect a custom git revision range",
        "",
        "The guard scans every commit in the chosen range. For each",
        "commit whose message contains a substring matching",
        "/audit-(\\d{4}-\\d{2}-\\d{2})/ (the audit-round date), it",
        "verifies the same commit touches",
        "audit-evidence/{date}/. Violations are annotated as",
        "GitHub Actions workflow warnings or errors per --mode.",
      ].join("\n"),
    );
    process.exit(0);
  } else {
    console.error(`[audit-evidence-mirror] unknown arg: ${a}`);
    process.exit(2);
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function git(...gitArgs) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const stderr = e?.stderr?.toString() ?? String(e);
    console.error(`[audit-evidence-mirror] git ${gitArgs.join(" ")} failed:`);
    console.error(stderr);
    process.exit(2);
  }
}

function listCommitsByRange(rev) {
  const raw = git("log", "--format=%H", rev).trim();
  if (!raw) return [];
  return raw.split("\n");
}

function listCommitsByCount(n) {
  // Works on shallow CI checkouts where `HEAD~N` is unavailable —
  // `git log -n N HEAD` simply truncates to whatever HEAD's history
  // makes reachable, instead of failing on the rev-parse.
  const raw = git("log", "-n", String(n), "--format=%H", "HEAD").trim();
  if (!raw) return [];
  return raw.split("\n");
}

function commitMessage(sha) {
  return git("log", "-1", "--format=%B", sha);
}

function commitFiles(sha) {
  return git("show", "--name-only", "--format=", sha)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function annotate(severity, message) {
  // GitHub Actions workflow command. Falls back to plain stderr if
  // run outside Actions.
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::${severity}::${message}`);
  } else {
    console.error(`[${severity}] ${message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────
let shas;
const inspectionLabel =
  range !== null ? `range '${range}'` : `last ${commits} commit(s)`;
try {
  shas = range !== null ? listCommitsByRange(range) : listCommitsByCount(commits);
} catch {
  console.error(
    `[audit-evidence-mirror] could not resolve ${inspectionLabel}.`,
  );
  process.exit(2);
}

if (shas.length === 0) {
  console.log(
    `[audit-evidence-mirror] no commits in ${inspectionLabel} — nothing to check.`,
  );
  process.exit(0);
}

const AUDIT_TAG_RE = /audit-(\d{4}-\d{2}-\d{2})/g;
const violations = [];

for (const sha of shas) {
  const msg = commitMessage(sha);
  const tags = new Set();
  let m;
  AUDIT_TAG_RE.lastIndex = 0;
  while ((m = AUDIT_TAG_RE.exec(msg))) {
    tags.add(m[1]);
  }
  if (tags.size === 0) continue;

  const files = commitFiles(sha);
  for (const date of tags) {
    const expectedPrefix = `audit-evidence/${date}/`;
    const touched = files.some((f) => f.startsWith(expectedPrefix));
    if (!touched) {
      // Treat the violation as advisory if the audit-evidence/{date}/
      // directory exists in HEAD already — meaning the mirror was
      // landed in a sibling commit. This avoids spurious warnings
      // when sibling task agents land their mirrors in separate
      // commits within the same merge.
      const dirOnDisk = resolve(REPO_ROOT, "audit-evidence", date);
      const mirrorPresentInTree =
        existsSync(dirOnDisk) &&
        statSync(dirOnDisk).isDirectory() &&
        readdirSync(dirOnDisk).length > 0;
      violations.push({
        sha: sha.slice(0, 12),
        date,
        expectedPrefix,
        mirrorPresentInTree,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `[audit-evidence-mirror] OK — ${shas.length} commit(s) inspected, no audit-tagged commits without a mirror.`,
  );
  process.exit(0);
}

const severity = mode === "blocker" ? "error" : "warning";

for (const v of violations) {
  const note = v.mirrorPresentInTree
    ? " (mirror directory exists in HEAD — likely landed in a sibling commit)"
    : "";
  annotate(
    severity,
    `Audit-tagged commit ${v.sha} mentions audit-${v.date} but does not touch ${v.expectedPrefix}.${note} See audit-evidence/README.md for the mirror convention.`,
  );
}

if (mode === "blocker") {
  console.error(
    `[audit-evidence-mirror] FAIL — ${violations.length} commit(s) violate the mirror convention.`,
  );
  process.exit(1);
}

console.log(
  `[audit-evidence-mirror] WARN — ${violations.length} commit(s) lack a mirror (warning mode, not failing). Promote --mode blocker after one clean cycle.`,
);
process.exit(0);
