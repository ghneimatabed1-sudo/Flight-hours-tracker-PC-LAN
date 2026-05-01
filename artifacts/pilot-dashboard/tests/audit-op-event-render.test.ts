// Unit coverage for the friendly op.* audit-row renderer used by the
// AuditLog viewer (AuditLog.tsx). The renderer is a pure function so we
// don't need React or jsdom — node:test + assert is enough.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOpAuditDisplay,
  isOpEventType,
} from "../src/lib/audit-op-event-render";
import { dict } from "../src/lib/i18n.tsx";

test("isOpEventType only returns true for op.* event types", () => {
  assert.equal(isOpEventType("op.release_verify"), true);
  assert.equal(isOpEventType("op.backup_run"), true);
  assert.equal(isOpEventType("op.verify_backup_run"), true);
  assert.equal(isOpEventType("op.verify_backup_run_manual"), true);
  assert.equal(isOpEventType("internal.reminders.enable"), false);
  assert.equal(isOpEventType(""), false);
  assert.equal(isOpEventType(null), false);
  assert.equal(isOpEventType(undefined), false);
});

test("op.release_verify GREEN — friendly summary, verdict + counts", () => {
  const d = buildOpAuditDisplay("op.release_verify", {
    outcome: "success",
    summary: "GREEN — 7 pass / 0 fail / 0 skip",
    evidence_path: "release-evidence/2026-04-30",
    verdict_tag: "GREEN",
    date: "2026-04-30",
    baseline_initialized: true,
    counts: { passed: 7, failed: 0, skipped: 0, drifts: 0 },
  });
  assert.equal(d.isOpEvent, true);
  assert.equal(d.titleKey, "audit_op_release_verify");
  assert.equal(d.outcome, "success");
  assert.equal(d.evidencePath, "release-evidence/2026-04-30");
  const verdict = d.highlights.find(h => h.labelKey === "audit_op_field_verdict");
  assert.equal(verdict?.value, "GREEN");
  const checks = d.highlights.find(h => h.labelKey === "audit_op_field_checks");
  assert.equal(checks?.value, "7 pass / 0 fail / 0 skip");
});

test("op.release_verify AMBER → outcome=partial and drifts surfaced in checks", () => {
  const d = buildOpAuditDisplay("op.release_verify", {
    outcome: "partial",
    summary: "AMBER — 5 pass / 0 fail / 2 skip, 1 drift",
    verdict_tag: "AMBER",
    counts: { passed: 5, failed: 0, skipped: 2, drifts: 1 },
  });
  assert.equal(d.outcome, "partial");
  const checks = d.highlights.find(h => h.labelKey === "audit_op_field_checks");
  assert.equal(checks?.value, "5 pass / 0 fail / 2 skip / 1 drift");
});

test("op.backup_run success exposes exit_code, duration, script", () => {
  const d = buildOpAuditDisplay("op.backup_run", {
    outcome: "success",
    summary: "backup-postgres.ps1 completed successfully (12s)",
    exit_code: 0,
    duration_ms: 12345,
    script: "backup-postgres.ps1",
    triggered_via: "settings_button",
  });
  assert.equal(d.isOpEvent, true);
  assert.equal(d.titleKey, "audit_op_backup_run");
  assert.equal(d.outcome, "success");
  const exitCode = d.highlights.find(h => h.labelKey === "audit_op_field_exit_code");
  assert.equal(exitCode?.value, "0");
  const duration = d.highlights.find(h => h.labelKey === "audit_op_field_duration");
  assert.equal(duration?.value, "12.3s");
  const script = d.highlights.find(h => h.labelKey === "audit_op_field_script");
  assert.equal(script?.value, "backup-postgres.ps1");
});

test("op.verify_backup_run_manual failure surfaces non-zero exit code", () => {
  const d = buildOpAuditDisplay("op.verify_backup_run_manual", {
    outcome: "failure",
    summary: "verify-backup.ps1 exited with code 1",
    exit_code: 1,
    duration_ms: 4500,
    script: "verify-backup.ps1",
  });
  assert.equal(d.titleKey, "audit_op_verify_backup_run_manual");
  assert.equal(d.outcome, "failure");
  const exitCode = d.highlights.find(h => h.labelKey === "audit_op_field_exit_code");
  assert.equal(exitCode?.value, "1");
});

test("op.verify_backup_run flattens sanityCounts into a readable string", () => {
  const d = buildOpAuditDisplay("op.verify_backup_run", {
    outcome: "success",
    summary: "Verified pgbackup_2026-04-30.dump — restored + pilots=120 sorties=4500",
    sanityCounts: { pilots: 120, sorties: 4500 },
    backup: "pgbackup_2026-04-30.dump",
  });
  assert.equal(d.titleKey, "audit_op_verify_backup_run");
  const sanity = d.highlights.find(h => h.labelKey === "audit_op_field_sanity_counts");
  assert.equal(sanity?.value, "pilots=120, sorties=4500");
  const backup = d.highlights.find(h => h.labelKey === "audit_op_field_backup");
  assert.equal(backup?.value, "pgbackup_2026-04-30.dump");
});

test("non-op event types return isOpEvent=false so the viewer falls back", () => {
  const d = buildOpAuditDisplay("internal.reminders.enable", { cron: "0 6 * * *" });
  assert.equal(d.isOpEvent, false);
  assert.equal(d.titleKey, null);
});

test("malformed detail (null / non-object) is tolerated, never throws", () => {
  const d1 = buildOpAuditDisplay("op.backup_run", null);
  assert.equal(d1.isOpEvent, true);
  assert.equal(d1.outcome, "unknown");
  assert.equal(d1.summary, "");
  assert.equal(d1.highlights.length, 0);

  const d2 = buildOpAuditDisplay("op.backup_run", undefined);
  assert.equal(d2.outcome, "unknown");

  // Arrays should be treated as "no detail object" rather than crashing.
  const d3 = buildOpAuditDisplay(
    "op.backup_run",
    // @ts-expect-error — deliberately malformed for the resilience check
    [1, 2, 3],
  );
  assert.equal(d3.outcome, "unknown");
});

test("every label and title key referenced by the renderer is in EN+AR dicts", () => {
  // Catches the most common mistake when adding a new event_type:
  // forgetting to add the matching i18n entry.
  const referencedKeys = [
    "audit_op_release_verify",
    "audit_op_backup_run",
    "audit_op_verify_backup_run",
    "audit_op_verify_backup_run_manual",
    "audit_op_outcome_success",
    "audit_op_outcome_failure",
    "audit_op_outcome_partial",
    "audit_op_outcome_unknown",
    "audit_op_field_verdict",
    "audit_op_field_checks",
    "audit_op_field_date",
    "audit_op_field_baseline",
    "audit_op_field_exit_code",
    "audit_op_field_duration",
    "audit_op_field_script",
    "audit_op_field_triggered_via",
    "audit_op_field_backup",
    "audit_op_field_sanity_counts",
    "audit_op_field_evidence",
    "audit_op_show_details",
    "audit_op_hide_details",
  ];
  const en = dict.en as Record<string, string>;
  const ar = dict.ar as Record<string, string>;
  const missingEn = referencedKeys.filter(k => !(k in en));
  const missingAr = referencedKeys.filter(k => !(k in ar));
  assert.deepEqual(missingEn, [], `Missing EN keys: ${missingEn.join(", ")}`);
  assert.deepEqual(missingAr, [], `Missing AR keys: ${missingAr.join(", ")}`);
});
