import { appendInternalAudit } from "./internal-audit";

/**
 * Operationally significant action types — subset that the audit-log
 * viewer renders with friendly text + a structured "Show details"
 * expander. New entries here must also get matching i18n strings in
 * `pilot-dashboard/src/lib/i18n.tsx` (`audit_op_<event>`) and a
 * renderer in `pages/admin/AuditLog.tsx`.
 *
 * The `op.*` namespace is reserved for actions that an investigator
 * needs to reconstruct after the fact — e.g. "did the operator run
 * verify-backup before the USB push, and what was the outcome?". Do
 * NOT use it for routine CRUD — those keep the existing
 * `internal.<table>.<verb>` namespace.
 */
export const OP_AUDIT_EVENT_TYPES = [
  "op.release_verify",
  "op.backup_run",
  "op.verify_backup_run",
  "op.verify_backup_run_manual",
] as const;

export type OpAuditEventType = (typeof OP_AUDIT_EVENT_TYPES)[number];

export type OpAuditOutcome = "success" | "failure" | "partial";

export type OpAuditEvent = {
  /** Stable namespaced event name. Must start with `op.`. */
  event_type: OpAuditEventType | (string & {});
  /** Optional LAN user id of the human who triggered the action. */
  actor_user_id?: string | null;
  /** Username string written into the `actor` column. Falls back to
   *  `"system"` when the action was triggered by a non-human caller
   *  (e.g. the verify-backup PowerShell scheduled task). */
  actor_username?: string | null;
  outcome: OpAuditOutcome;
  /** One-line human summary, English-only. Always shown in the viewer. */
  summary: string;
  /** Structured payload. Rendered behind a "Show details" expander. */
  details?: Record<string, unknown>;
  /** Optional path on disk to additional evidence (e.g. release-verify
   *  report markdown or the per-check log directory). */
  evidence_path?: string | null;
};

/**
 * Validate the shape of an op-audit event before we let it reach the
 * `audit_log` table. Returns null when valid, or an error string the
 * caller can surface back to the HTTP client. The validator
 * deliberately enforces:
 *
 *  - `event_type` non-empty + `op.` prefix (so the viewer's friendly
 *    renderers actually trigger and the namespace cannot be polluted
 *    by accident),
 *  - `outcome` one of the three documented enum values,
 *  - `summary` non-empty (viewer would render an empty cell),
 *  - `details` either omitted or a plain object (anything else would
 *    confuse the JSON.stringify in `appendInternalAudit`).
 */
export function validateOpAuditEvent(
  ev: Partial<OpAuditEvent> | null | undefined,
): string | null {
  if (!ev || typeof ev !== "object") return "event_required";
  const et = String(ev.event_type ?? "").trim();
  if (!et) return "event_type_required";
  if (!et.startsWith("op.")) return "event_type_must_start_with_op";
  if (et.length > 120) return "event_type_too_long";
  const outcome = String(ev.outcome ?? "").trim();
  if (outcome !== "success" && outcome !== "failure" && outcome !== "partial") {
    return "outcome_invalid";
  }
  const summary = String(ev.summary ?? "").trim();
  if (!summary) return "summary_required";
  if (summary.length > 1000) return "summary_too_long";
  if (
    ev.details != null
    && (typeof ev.details !== "object" || Array.isArray(ev.details))
  ) {
    return "details_must_be_object";
  }
  return null;
}

/**
 * Insert a single op-audit row. Persists into the existing `audit_log`
 * table (no schema change — the JSONB `detail` column already carries
 * everything that doesn't fit into `actor` / `type`).
 *
 * The structured payload written to `detail` is:
 *
 *   {
 *     outcome,                // "success" | "failure" | "partial"
 *     summary,                // short human text
 *     evidence_path?,         // optional disk path to evidence
 *     actor_user_id?,         // optional LAN user id
 *     ...details              // caller-supplied structured payload
 *   }
 *
 * Best-effort insert: silently swallows the "table doesn't exist"
 * window between cold-boot and `ensureFullSchema()` — same convention
 * as `appendInternalAudit`. All other DB errors propagate.
 */
export async function recordOpAuditEvent(ev: OpAuditEvent): Promise<void> {
  const err = validateOpAuditEvent(ev);
  if (err) throw new Error(err);

  const detail: Record<string, unknown> = {
    ...(ev.details ?? {}),
    outcome: ev.outcome,
    summary: ev.summary,
  };
  if (ev.evidence_path != null && String(ev.evidence_path).trim() !== "") {
    detail.evidence_path = String(ev.evidence_path);
  }
  if (ev.actor_user_id != null && String(ev.actor_user_id).trim() !== "") {
    detail.actor_user_id = String(ev.actor_user_id);
  }

  const actor = String(ev.actor_username ?? "").trim() || "system";
  await appendInternalAudit(actor, ev.event_type, detail);
}
