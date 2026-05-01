#!/usr/bin/env node
// Hawk Eye — single "release verify" runner.
//
// Hawk Eye ships into an air-gapped LAN (no CI). Operators about to
// push a USB build need one obvious "is the release green?" command
// that runs every gate sequentially, captures evidence per gate, and
// emits a single GO/NO-GO report.
//
// Run:  pnpm run release:verify
//
// Output:
//   release-evidence/<date>/<check-slug>.log       per-check stdout+stderr
//   release-evidence/<date>/<check-slug>.exit      per-check exit code
//   release-evidence/<date>/matrix-snapshot.json   normalized current snapshot
//   release-evidence/<date>/matrix-diff.json       drift list (machine-readable)
//   HAWKEYE-RELEASE-REPORT-<date>.md               GREEN / AMBER / RED report
//
// Verdict rules (whole run):
//   GREEN  — every check passed AND matrix evidence diff is empty
//   AMBER  — every check passed BUT matrix evidence diff is non-empty
//            (probe outcomes drifted from the committed baseline)
//   RED    — any check failed
//
// Exit code: GREEN → 0, AMBER → 2, RED → 1. So a wrapper script can
// branch on `$?` without re-parsing the markdown.
//
// The check list is pinned in CHECKS so an operator can see exactly
// what `release:verify` is gating on without reading the runner. To
// add a check: append to CHECKS. To temporarily skip one (e.g.
// matrix Playwright on a host without Chromium): set the env var
// listed in `skipEnv` for that check.
//
// Exports (consumed by `scripts/tests/release-verify.test.ts`):
//   diffMatrixEvidence(baseline, current)
//     — pure function; given two normalized matrix snapshots returns
//       the sorted list of (profile, role_slug, label) probes whose
//       status drifted (added, removed, or changed).
//   loadMatrixEvidenceFromDir(dir)
//     — walks a `test-evidence/<date>/` tree and returns a normalized
//       snapshot suitable for `diffMatrixEvidence`.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

// ── Check list (pinned, documented) ──────────────────────────────
//
// Order matters: cheap static checks first, expensive browser sweep
// last, so a fast failure short-circuits the run.
//
// `command` runs from REPO_ROOT via the system shell. The runner
// captures stdout+stderr to per-check log files and records the
// exit code.

const CHECKS = [
  {
    slug: "typecheck",
    label: "TypeScript typecheck (all workspace packages)",
    command: "pnpm run typecheck",
    skipEnv: "HAWKEYE_RELEASE_SKIP_TYPECHECK",
  },
  {
    slug: "check-no-external-urls",
    label: "Static check: no external URLs in dashboard bundle",
    command: "pnpm run check:no-external-urls",
    skipEnv: "HAWKEYE_RELEASE_SKIP_NO_EXTERNAL_URLS",
  },
  {
    slug: "in-process-tests",
    label: "All in-process tests (pilot-dashboard suite)",
    command: "pnpm --filter @workspace/pilot-dashboard run test",
    skipEnv: "HAWKEYE_RELEASE_SKIP_IN_PROCESS_TESTS",
  },
  {
    slug: "multi-pc-real-process",
    label: "3-process multi-PC test (real api-server processes)",
    command:
      "pnpm --filter @workspace/pilot-dashboard run test:multi-pc-real-process",
    skipEnv: "HAWKEYE_RELEASE_SKIP_MULTI_PC_REAL_PROCESS",
  },
  {
    slug: "matrix-playwright",
    label: "Matrix Playwright sweep (role × profile × probe)",
    command:
      "pnpm --filter @workspace/pilot-dashboard run test:matrix-playwright",
    skipEnv: "HAWKEYE_RELEASE_SKIP_MATRIX_PLAYWRIGHT",
  },
];

const MATRIX_EVIDENCE_ROOT = resolve(
  REPO_ROOT,
  "artifacts",
  "pilot-dashboard",
  "test-evidence",
);

const BASELINE_PATH = resolve(__dirname, "release-evidence-baseline.json");

// ── Helpers ──────────────────────────────────────────────────────

function todayUtcDate() {
  const env = String(process.env.RELEASE_VERIFY_DATE ?? "").trim();
  if (env) return env;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function relFromRepo(p) {
  return relative(REPO_ROOT, p) || ".";
}

function openLogFile(logPath, check) {
  ensureDir(dirname(logPath));
  const handle = openSync(logPath, "w");
  const header =
    `release-verify: ${check.label}\n` +
    `release-verify: command: ${check.command}\n` +
    `release-verify: started_at: ${new Date().toISOString()}\n` +
    `------------------------------------------------------------\n`;
  writeSync(handle, header);
  return {
    write(chunk) {
      writeSync(handle, chunk);
    },
    end() {
      closeSync(handle);
    },
  };
}

/**
 * Run one check, streaming stdout+stderr to `logPath` and the
 * console. Returns { exitCode, durationMs }.
 */
function runCheck(check, logPath) {
  return new Promise((resolveRun) => {
    const start = Date.now();
    const fd = openLogFile(logPath, check);
    const child = spawn(check.command, {
      cwd: REPO_ROOT,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      try {
        fd.write(chunk);
      } catch {
        /* ignore */
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      try {
        fd.write(chunk);
      } catch {
        /* ignore */
      }
    });

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 1;
      const durationMs = Date.now() - start;
      try {
        fd.write(
          `\n--- release-verify: check exited with code ${exitCode} after ${formatDuration(durationMs)} ---\n`,
        );
      } catch {
        /* ignore */
      }
      try {
        fd.end();
      } catch {
        /* ignore */
      }
      resolveRun({ exitCode, durationMs });
    });
    child.on("error", (err) => {
      try {
        fd.write(`\nrelease-verify: spawn error: ${err.message}\n`);
        fd.end();
      } catch {
        /* ignore */
      }
      resolveRun({ exitCode: 127, durationMs: Date.now() - start });
    });
  });
}

// ── Matrix evidence loading + diff ───────────────────────────────

/**
 * Read every `test-evidence/<date>/<profile>/<role>/probes.json`
 * under `dir` and return a normalized snapshot:
 *
 * {
 *   "<profile>": {
 *     "<role_slug>": {
 *       "<probe_label>": <status:int|null>,
 *       …
 *     },
 *     …
 *   },
 *   …
 * }
 *
 * Missing dir or no probes → returns {}.
 */
export function loadMatrixEvidenceFromDir(dir) {
  if (!dir || !existsSync(dir)) return {};
  const out = {};
  let profiles;
  try {
    profiles = readdirSync(dir, { withFileTypes: true });
  } catch {
    return {};
  }
  for (const profileEntry of profiles) {
    if (!profileEntry.isDirectory()) continue;
    const profile = profileEntry.name;
    const profileDir = join(dir, profile);
    let roles;
    try {
      roles = readdirSync(profileDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const roleEntry of roles) {
      if (!roleEntry.isDirectory()) continue;
      const roleSlug = roleEntry.name;
      const probesPath = join(profileDir, roleSlug, "probes.json");
      if (!existsSync(probesPath)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(probesPath, "utf8"));
      } catch {
        continue;
      }
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      const probeMap = {};
      for (const r of results) {
        if (!r || typeof r.label !== "string") continue;
        probeMap[r.label] =
          typeof r.status === "number" ? r.status : null;
      }
      out[profile] ??= {};
      out[profile][roleSlug] = probeMap;
    }
  }
  return out;
}

/**
 * Pure diff: given two normalized matrix snapshots, return the
 * sorted list of probes whose status drifted (added, removed, or
 * changed). Used both by the runner and by the unit test.
 *
 * Each diff entry has shape:
 *   { profile, role_slug, label,
 *     baseline_status: number|null|undefined,
 *     current_status:  number|null|undefined,
 *     kind: "changed" | "added" | "removed" }
 */
export function diffMatrixEvidence(baseline, current) {
  const drifts = [];
  const profiles = new Set([
    ...Object.keys(baseline ?? {}),
    ...Object.keys(current ?? {}),
  ]);
  for (const profile of profiles) {
    const baseRoles = (baseline ?? {})[profile] ?? {};
    const curRoles = (current ?? {})[profile] ?? {};
    const roleKeys = new Set([
      ...Object.keys(baseRoles),
      ...Object.keys(curRoles),
    ]);
    for (const roleSlug of roleKeys) {
      const baseProbes = baseRoles[roleSlug] ?? {};
      const curProbes = curRoles[roleSlug] ?? {};
      const labels = new Set([
        ...Object.keys(baseProbes),
        ...Object.keys(curProbes),
      ]);
      for (const label of labels) {
        const inBase = Object.prototype.hasOwnProperty.call(
          baseProbes,
          label,
        );
        const inCur = Object.prototype.hasOwnProperty.call(
          curProbes,
          label,
        );
        const baseStatus = inBase ? baseProbes[label] : undefined;
        const curStatus = inCur ? curProbes[label] : undefined;
        if (!inBase && inCur) {
          drifts.push({
            profile,
            role_slug: roleSlug,
            label,
            baseline_status: undefined,
            current_status: curStatus,
            kind: "added",
          });
          continue;
        }
        if (inBase && !inCur) {
          drifts.push({
            profile,
            role_slug: roleSlug,
            label,
            baseline_status: baseStatus,
            current_status: undefined,
            kind: "removed",
          });
          continue;
        }
        if (baseStatus !== curStatus) {
          drifts.push({
            profile,
            role_slug: roleSlug,
            label,
            baseline_status: baseStatus,
            current_status: curStatus,
            kind: "changed",
          });
        }
      }
    }
  }
  drifts.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile < b.profile ? -1 : 1;
    if (a.role_slug !== b.role_slug)
      return a.role_slug < b.role_slug ? -1 : 1;
    return a.label < b.label ? -1 : 1;
  });
  return drifts;
}

/**
 * Returns { snapshot, initialized }. `initialized` is false when the
 * baseline file is missing, unparseable, or still the empty starter
 * shipped with the runner. An uninitialized baseline downgrades the
 * matrix diff to "informational only" so a clean-branch run can
 * still produce a GREEN verdict — the report will explicitly tell
 * the operator to promote the current snapshot to the baseline.
 */
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return { snapshot: {}, initialized: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return { snapshot: {}, initialized: false };
  }
  const snapshot =
    parsed && typeof parsed.snapshot === "object" && parsed.snapshot
      ? parsed.snapshot
      : {};
  const hasAnyProbe = Object.values(snapshot).some(
    (roles) =>
      roles &&
      typeof roles === "object" &&
      Object.values(roles).some(
        (probes) =>
          probes &&
          typeof probes === "object" &&
          Object.keys(probes).length > 0,
      ),
  );
  // Treat both an empty `snapshot: {}` and an explicit
  // `captured_at: null` (the starter file ships with both) as "no
  // baseline pinned yet". Any pinned baseline must have at least one
  // probe.
  const initialized = hasAnyProbe;
  return { snapshot, initialized };
}

// ── Report rendering ─────────────────────────────────────────────

function formatStatus(s) {
  if (s === undefined) return "—";
  if (s === null) return "network_error";
  return String(s);
}

function decideVerdict({ results, drifts, baselineInitialized, current }) {
  const anyFail = results.some((r) => !r.skipped && r.exitCode !== 0);
  if (anyFail) {
    return {
      tag: "RED",
      recommendation: "NO-GO. Do not copy this build to USB.",
      action:
        "Open the per-check log files listed above, fix the failing check, then re-run `pnpm run release:verify` until it goes GREEN. Do not bypass.",
    };
  }
  // No baseline pinned yet: the diff is informational only — a
  // clean-branch run cannot have "drifted" from nothing. Verdict
  // stays GREEN, with an explicit prompt to promote the current
  // snapshot to the baseline so the next run can detect drift.
  if (!baselineInitialized) {
    const haveCurrent = Object.keys(current ?? {}).length > 0;
    return {
      tag: "GREEN",
      recommendation: haveCurrent
        ? "GO (provisional). All checks passed. Matrix baseline not yet initialized — the drift detector is informational only on this run."
        : "GO. All checks passed. Matrix baseline not yet initialized; no matrix evidence captured this run either.",
      action: haveCurrent
        ? "Promote `release-evidence/<date>/matrix-snapshot.json` into `scripts/src/release-evidence-baseline.json` (preserve the `$comment` block), commit it, then re-run `pnpm run release:verify` to confirm GREEN with drift detection live. Then proceed with §7 of `OPERATOR-RUNBOOK.md`."
        : "Run `pnpm --filter @workspace/pilot-dashboard run test:matrix-playwright` once on a host with Chromium so matrix evidence is captured, then promote the snapshot into the baseline. Until then, proceed with §7 of `OPERATOR-RUNBOOK.md` knowing the drift detector is dormant.",
    };
  }
  if (drifts.length > 0) {
    return {
      tag: "AMBER",
      recommendation:
        "HOLD. All checks passed but matrix evidence drifted from the committed baseline.",
      action:
        "Review the drift table above. If the new probe outcomes are intentional (e.g. a new role-gate landed), re-record the baseline by replacing `scripts/src/release-evidence-baseline.json` with the current snapshot and committing it; then re-run `pnpm run release:verify` and confirm GREEN before USB push.",
    };
  }
  return {
    tag: "GREEN",
    recommendation: "GO. Safe to copy this build to the USB stick.",
    action:
      "Proceed with §7 of `OPERATOR-RUNBOOK.md` (Push an updated build via USB).",
  };
}

function renderReport({
  date,
  results,
  drifts,
  verdict,
  overallStartedAt,
  overallEndedAt,
  evidenceDir,
  baselineInitialized,
}) {
  const lines = [];
  lines.push(`# Hawk Eye — Release Verify Report (${date})`);
  lines.push("");
  lines.push(`**Verdict:** ${verdict.tag} — ${verdict.recommendation}`);
  lines.push("");
  lines.push(`- Started: ${overallStartedAt}`);
  lines.push(`- Finished: ${overallEndedAt}`);
  lines.push(`- Evidence: \`${relFromRepo(evidenceDir)}/\``);
  lines.push(
    `- Baseline: \`${relFromRepo(BASELINE_PATH)}\` (${
      !existsSync(BASELINE_PATH)
        ? "missing — diff treated as informational"
        : baselineInitialized
          ? "initialized"
          : "uninitialized starter — diff treated as informational"
    })`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Check | Status | Duration | Log |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of results) {
    const status = r.skipped
      ? "SKIP"
      : r.exitCode === 0
        ? "PASS"
        : "FAIL";
    const log = r.skipped ? "—" : `\`${relFromRepo(r.logPath)}\``;
    const duration = r.skipped ? "—" : formatDuration(r.durationMs);
    lines.push(`| ${r.label} | ${status} | ${duration} | ${log} |`);
  }
  lines.push("");

  lines.push("## Matrix evidence diff");
  lines.push("");
  if (!baselineInitialized) {
    lines.push(
      `Baseline \`${relFromRepo(BASELINE_PATH)}\` is the empty starter — no probe outcomes have ever been pinned. The diff below is informational only and will not gate the verdict. Promote \`release-evidence/${date}/matrix-snapshot.json\` into the baseline (preserve the \`$comment\` block) and commit it; subsequent runs will then catch real drift.`,
    );
    lines.push("");
  }
  if (drifts.length === 0) {
    lines.push(
      "No drift from baseline. Every probe in this run matched the committed baseline status.",
    );
  } else {
    lines.push(
      `${drifts.length} probe(s) ${
        baselineInitialized
          ? "drifted from baseline. Investigate before pushing a USB build, or update"
          : "would be added to a fresh baseline. Promote the current snapshot into"
      } \`${relFromRepo(BASELINE_PATH)}\`${
        baselineInitialized ? " if the new behaviour is intentional." : "."
      }`,
    );
    lines.push("");
    lines.push("| Profile | Role | Probe | Baseline | Current | Kind |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const d of drifts) {
      lines.push(
        `| ${d.profile} | ${d.role_slug} | ${d.label} | ${formatStatus(d.baseline_status)} | ${formatStatus(d.current_status)} | ${d.kind} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Per-check details");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.label}`);
    lines.push("");
    if (r.skipped) {
      lines.push(
        `- Skipped via \`${r.skipEnv}=${process.env[r.skipEnv]}\``,
      );
      lines.push("");
      continue;
    }
    lines.push(`- Command: \`${r.command}\``);
    lines.push(
      `- Exit code: ${r.exitCode} (${r.exitCode === 0 ? "PASS" : "FAIL"})`,
    );
    lines.push(`- Duration: ${formatDuration(r.durationMs)}`);
    lines.push(`- Log: \`${relFromRepo(r.logPath)}\``);
    lines.push("");
  }

  lines.push("## Recommended next action");
  lines.push("");
  lines.push(verdict.action);
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const date = todayUtcDate();
  const evidenceDir = resolve(REPO_ROOT, "release-evidence", date);
  ensureDir(evidenceDir);

  const overallStartedAt = new Date().toISOString();
  const results = [];
  for (const check of CHECKS) {
    if (check.skipEnv && process.env[check.skipEnv]) {
      console.log(
        `\n=== SKIP ${check.label} (env ${check.skipEnv}=${process.env[check.skipEnv]}) ===`,
      );
      results.push({
        ...check,
        skipped: true,
        exitCode: 0,
        durationMs: 0,
        logPath: join(evidenceDir, `${check.slug}.log`),
      });
      continue;
    }
    console.log(`\n=== RUN ${check.label} ===`);
    console.log(`    $ ${check.command}`);
    const logPath = join(evidenceDir, `${check.slug}.log`);
    const { exitCode, durationMs } = await runCheck(check, logPath);
    writeFileSync(
      join(evidenceDir, `${check.slug}.exit`),
      `${exitCode}\n`,
      "utf8",
    );
    results.push({
      ...check,
      skipped: false,
      exitCode,
      durationMs,
      logPath,
    });
    console.log(
      `=== ${exitCode === 0 ? "PASS" : "FAIL"} ${check.label} (${formatDuration(durationMs)}) ===`,
    );
  }
  const overallEndedAt = new Date().toISOString();

  // Matrix diff (after the Playwright sweep has had its chance).
  const { snapshot: baseline, initialized: baselineInitialized } =
    loadBaseline();
  const matrixDateDir = join(MATRIX_EVIDENCE_ROOT, date);
  const current = loadMatrixEvidenceFromDir(matrixDateDir);
  const drifts = diffMatrixEvidence(baseline, current);

  // Persist the current snapshot alongside the evidence so the next
  // baseline update can copy it in one command.
  writeFileSync(
    join(evidenceDir, "matrix-snapshot.json"),
    `${JSON.stringify(
      { generated_at: overallEndedAt, date, snapshot: current },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(evidenceDir, "matrix-diff.json"),
    `${JSON.stringify(
      {
        generated_at: overallEndedAt,
        baseline_path: relFromRepo(BASELINE_PATH),
        current_path: relFromRepo(matrixDateDir),
        drifts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const verdict = decideVerdict({
    results,
    drifts,
    baselineInitialized,
    current,
  });
  const reportMd = renderReport({
    date,
    results,
    drifts,
    verdict,
    overallStartedAt,
    overallEndedAt,
    evidenceDir,
    baselineInitialized,
  });
  const reportPath = resolve(
    REPO_ROOT,
    `HAWKEYE-RELEASE-REPORT-${date}.md`,
  );
  writeFileSync(reportPath, reportMd, "utf8");

  console.log("");
  console.log(`=== Verdict: ${verdict.tag} ===`);
  console.log(`Report: ${relFromRepo(reportPath)}`);
  console.log(`Evidence: ${relFromRepo(evidenceDir)}/`);

  // Best-effort post one audit row per release-verify run so an
  // investigator can see "GO/NO-GO at <timestamp>" without having to
  // grep release-evidence/ on the host PC. Controlled by
  // HAWKEYE_RELEASE_VERIFY_AUDIT_URL — when unset, this is a no-op so
  // a developer running release:verify on their laptop without a
  // running api-server doesn't see a misleading network error.
  await maybePostAuditRow({
    date,
    verdict,
    results,
    drifts,
    baselineInitialized,
    evidenceDir,
    reportPath,
    overallStartedAt,
    overallEndedAt,
  }).catch((err) => {
    console.warn(
      `release-verify: audit POST failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  if (verdict.tag === "RED") process.exit(1);
  if (verdict.tag === "AMBER") process.exit(2);
  process.exit(0);
}

// ── Audit-log POST ───────────────────────────────────────────────
//
// Writes one `op.release_verify` row into the LAN api-server's
// audit_log table per release-verify run. Authenticates with the
// system-identity header.
//
// Default-on behaviour:
//   - URL defaults to the local hub api-server at
//     http://127.0.0.1:${HAWK_API_PORT||3847}/api/internal/audit/op-event
//     so a host run with no extra env still posts. Override with
//     HAWKEYE_RELEASE_VERIFY_AUDIT_URL when running cross-host.
//   - Token resolution mirrors the api-server loader in
//     artifacts/api-server/src/lib/system-identity.ts:
//       1. HAWK_SYSTEM_IDENTITY_TOKEN          (canonical env)
//       2. HAWKEYE_SYSTEM_IDENTITY_TOKEN       (legacy alias)
//       3. file at HAWK_SYSTEM_IDENTITY_TOKEN_FILE
//       4. file at HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE (legacy alias)
//     Aligning the canonical-first order across api-server,
//     release-verify, and verify-backup.ps1 prevents the case where an
//     operator sets HAWKEYE_… on the host (legacy) and HAWK_… in the
//     api-server env (canonical) and silently sends a token the server
//     rejects. If both canonical and legacy env vars are set to
//     different values, we log a warning so the misconfig is surfaced.
//   - To explicitly opt out, set HAWKEYE_RELEASE_VERIFY_AUDIT_URL=off.
// When the token cannot be resolved we log a single warn line and
// continue — release-verify must never fail because audit is down.

export function resolveReleaseVerifyAuditUrl() {
  const explicit = String(
    process.env.HAWKEYE_RELEASE_VERIFY_AUDIT_URL ?? "",
  ).trim();
  if (explicit) return explicit;
  const port = String(process.env.HAWK_API_PORT ?? "3847").trim() || "3847";
  return `http://127.0.0.1:${port}/api/internal/audit/op-event`;
}

export function resolveReleaseVerifySystemIdentityToken() {
  const canonical = String(
    process.env.HAWK_SYSTEM_IDENTITY_TOKEN ?? "",
  ).trim();
  const legacy = String(
    process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN ?? "",
  ).trim();
  if (canonical && legacy && canonical !== legacy) {
    console.warn(
      "release-verify: HAWK_SYSTEM_IDENTITY_TOKEN and HAWKEYE_SYSTEM_IDENTITY_TOKEN are both set to different values — using HAWK_… (canonical). Unset the legacy alias to silence this warning.",
    );
  }
  if (canonical) return canonical;
  if (legacy) return legacy;
  const tokenFile = String(
    process.env.HAWK_SYSTEM_IDENTITY_TOKEN_FILE ?? "",
  ).trim();
  if (tokenFile) {
    try {
      const v = readFileSync(tokenFile, "utf8").trim();
      if (v) return v;
    } catch (err) {
      console.warn(
        `release-verify: HAWK_SYSTEM_IDENTITY_TOKEN_FILE set but unreadable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  const tokenFileLegacy = String(
    process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE ?? "",
  ).trim();
  if (tokenFileLegacy) {
    try {
      const v = readFileSync(tokenFileLegacy, "utf8").trim();
      if (v) return v;
    } catch (err) {
      console.warn(
        `release-verify: HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE set but unreadable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return "";
}

export async function maybePostAuditRow({
  date,
  verdict,
  results,
  drifts,
  baselineInitialized,
  evidenceDir,
  reportPath,
  overallStartedAt,
  overallEndedAt,
}) {
  const auditUrl = resolveReleaseVerifyAuditUrl();
  if (auditUrl.toLowerCase() === "off") return; // explicit opt-out
  const token = resolveReleaseVerifySystemIdentityToken();
  if (!token) {
    console.warn(
      `release-verify: system-identity token not configured (set HAWK_SYSTEM_IDENTITY_TOKEN or HAWK_SYSTEM_IDENTITY_TOKEN_FILE) — skipping audit POST to ${auditUrl}.`,
    );
    return;
  }
  const failed = results.filter((r) => !r.skipped && r.exitCode !== 0).length;
  const passed = results.filter((r) => !r.skipped && r.exitCode === 0).length;
  const skipped = results.filter((r) => r.skipped).length;
  const outcome =
    verdict.tag === "GREEN"
      ? "success"
      : verdict.tag === "AMBER"
        ? "partial"
        : "failure";
  const summary =
    `${verdict.tag} — ${passed} pass / ${failed} fail / ${skipped} skip` +
    (drifts.length > 0 ? `, ${drifts.length} drift` : "");
  const body = JSON.stringify({
    event_type: "op.release_verify",
    actor_username: "system:release-verify",
    outcome,
    summary,
    evidence_path: relFromRepo(evidenceDir),
    details: {
      date,
      verdict_tag: verdict.tag,
      verdict_recommendation: verdict.recommendation,
      baseline_initialized: baselineInitialized,
      counts: {
        passed,
        failed,
        skipped,
        drifts: drifts.length,
      },
      report_path: relFromRepo(reportPath),
      started_at: overallStartedAt,
      ended_at: overallEndedAt,
      checks: results.map((r) => ({
        slug: r.slug,
        label: r.label,
        skipped: !!r.skipped,
        exit_code: r.exitCode ?? null,
        duration_ms: r.durationMs ?? 0,
      })),
      drifts,
    },
  });
  const res = await fetch(auditUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hawk-system-identity": token,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  console.log(`release-verify: audit row posted to ${auditUrl}`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("release-verify: fatal:", err);
    process.exit(1);
  });
}
