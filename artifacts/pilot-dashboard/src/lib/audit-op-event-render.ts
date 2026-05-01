/**
 * Friendly renderers for the `op.*` audit-log event types.
 *
 * The Audit Log viewer used to render every unknown `event_type` as
 * raw JSON, which made the new release-verify / backup / verify-backup
 * rows hard to scan. This module knows the four op-event types and
 * returns a structured "headline + outcome chip + key/value list" the
 * viewer can render as plain DOM (with a "Show details" expander for
 * the full JSON).
 *
 * Pure functions only — no React or DOM imports — so they can be unit
 * tested headlessly via `node:test`.
 */

export type OpAuditOutcome = "success" | "failure" | "partial" | "unknown";

export type OpAuditDisplay = {
  /** True iff this row's `type` is in the `op.*` namespace and we have
   *  a friendly renderer for it. The viewer falls back to its existing
   *  raw-JSON rendering when this is false. */
  isOpEvent: boolean;
  /** Friendly i18n key for the headline (e.g. `audit_op_release_verify`).
   *  Always defined when `isOpEvent` is true. */
  titleKey: string | null;
  /** Outcome enum extracted from `detail.outcome`. */
  outcome: OpAuditOutcome;
  /** Short summary text taken from `detail.summary`. Falls back to
   *  the empty string when missing. */
  summary: string;
  /** Optional path to evidence on disk (release-evidence/, .dump file). */
  evidencePath: string | null;
  /** Key/value pairs to surface in the friendly summary block. The
   *  caller decides how to render them. */
  highlights: Array<{ labelKey: string; value: string }>;
};

const TITLE_KEY_BY_TYPE: Record<string, string> = {
  "op.release_verify": "audit_op_release_verify",
  "op.backup_run": "audit_op_backup_run",
  "op.verify_backup_run": "audit_op_verify_backup_run",
  "op.verify_backup_run_manual": "audit_op_verify_backup_run_manual",
};

function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readOutcome(d: Record<string, unknown> | null): OpAuditOutcome {
  const raw = String(d?.outcome ?? "").trim().toLowerCase();
  if (raw === "success" || raw === "failure" || raw === "partial") return raw;
  return "unknown";
}

function pushIf(
  out: Array<{ labelKey: string; value: string }>,
  labelKey: string,
  value: string | number | null | undefined,
): void {
  if (value == null) return;
  const s = String(value);
  if (s === "") return;
  out.push({ labelKey, value: s });
}

/** True for any string starting with `op.`. */
export function isOpEventType(type: string | null | undefined): boolean {
  return String(type ?? "").startsWith("op.");
}

/**
 * Build the structured display payload for an audit row. The viewer
 * calls this once per row and renders the result alongside the raw
 * "Show details" expander.
 */
export function buildOpAuditDisplay(
  type: string | null | undefined,
  detail: Record<string, unknown> | null | undefined,
): OpAuditDisplay {
  const t = String(type ?? "");
  const titleKey = TITLE_KEY_BY_TYPE[t] ?? null;
  const isOp = titleKey != null && isOpEventType(t);
  const d = asObject(detail);
  const outcome = readOutcome(d);
  const summary = String(d?.summary ?? "").trim();
  const evidencePath = asString(d?.evidence_path);

  const highlights: Array<{ labelKey: string; value: string }> = [];

  if (t === "op.release_verify") {
    const verdictTag = asString(d?.verdict_tag);
    pushIf(highlights, "audit_op_field_verdict", verdictTag);
    const counts = asObject(d?.counts);
    if (counts) {
      const passed = asNumber(counts.passed);
      const failed = asNumber(counts.failed);
      const skipped = asNumber(counts.skipped);
      const drifts = asNumber(counts.drifts);
      const parts: string[] = [];
      if (passed != null) parts.push(`${passed} pass`);
      if (failed != null) parts.push(`${failed} fail`);
      if (skipped != null) parts.push(`${skipped} skip`);
      if (drifts != null && drifts > 0) parts.push(`${drifts} drift`);
      if (parts.length > 0) {
        pushIf(highlights, "audit_op_field_checks", parts.join(" / "));
      }
    }
    pushIf(highlights, "audit_op_field_date", asString(d?.date));
    pushIf(highlights, "audit_op_field_baseline", asNullableBool(d?.baseline_initialized));
  } else if (t === "op.backup_run" || t === "op.verify_backup_run_manual") {
    const exitCode = asNumber(d?.exit_code);
    pushIf(highlights, "audit_op_field_exit_code", exitCode);
    const durMs = asNumber(d?.duration_ms);
    if (durMs != null) {
      pushIf(highlights, "audit_op_field_duration", formatDuration(durMs));
    }
    pushIf(highlights, "audit_op_field_script", asString(d?.script));
    pushIf(highlights, "audit_op_field_triggered_via", asString(d?.triggered_via));
  } else if (t === "op.verify_backup_run") {
    pushIf(highlights, "audit_op_field_backup", asString(d?.backup));
    const counts = asObject(d?.sanityCounts ?? d?.sanity_counts);
    if (counts) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(counts)) {
        const n = asNumber(v);
        if (n != null) parts.push(`${k}=${n}`);
      }
      if (parts.length > 0) {
        pushIf(highlights, "audit_op_field_sanity_counts", parts.join(", "));
      }
    }
  }

  return {
    isOpEvent: isOp,
    titleKey,
    outcome,
    summary,
    evidencePath,
    highlights,
  };
}

function asNullableBool(v: unknown): string | null {
  if (v === true) return "true";
  if (v === false) return "false";
  return null;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r.toString().padStart(2, "0")}s`;
}
