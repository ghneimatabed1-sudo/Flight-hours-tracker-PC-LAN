// Shared severity helpers for the "About this PC" panel.
//
// Extracted into its own module (instead of hiding inside
// `AboutThisPc.tsx`) so the top-of-Settings warning ribbon
// (`AboutHealthRibbon.tsx`) and any future surfaces can derive their
// state from the same thresholds without forking the rules. Task #390:
// the inline action buttons + ribbon must agree about what counts as
// "needs attention" so the operator never sees a green dot and an
// orange ribbon at the same time.

import type { AboutThisPcReport } from "./internal-migration";

export type AboutDotSeverity = "ok" | "warn" | "fail" | "unknown";

export function lastBackupSeverity(
  seconds: number | null | undefined,
): AboutDotSeverity {
  if (seconds == null) return "unknown";
  const days = seconds / 86400;
  if (days > 7) return "fail";
  if (days > 2) return "warn";
  return "ok";
}

export function lastBackupVerifySeverity(
  v: { ageSeconds: number; ok: boolean } | null | undefined,
): AboutDotSeverity {
  if (!v) return "warn";
  if (!v.ok) return "fail";
  const days = v.ageSeconds / 86400;
  if (days > 120) return "warn";
  return "ok";
}

/**
 * Roll-up used by the Settings ribbon: returns the worst severity
 * across the dots that the operator can act on directly (last backup
 * + last verify). The ribbon shows when this is `"fail"` so we don't
 * over-fire on freshly-installed PCs whose first nightly backup
 * hasn't run yet (those start out as `"unknown"` / `"warn"`, not
 * `"fail"`).
 */
export function aboutHealthRibbonSeverity(
  report: AboutThisPcReport | null,
): AboutDotSeverity {
  if (!report) return "unknown";
  const dots: AboutDotSeverity[] = [
    lastBackupSeverity(report.lastBackupAge?.ageSeconds ?? null),
    lastBackupVerifySeverity(report.lastBackupVerifyAge),
  ];
  if (dots.includes("fail")) return "fail";
  if (dots.includes("warn")) return "warn";
  if (dots.includes("unknown")) return "unknown";
  return "ok";
}

/**
 * Convenience predicate used by `<Settings>` to decide whether to
 * mount the ribbon at all. Spec ("Done looks like"): show only when at
 * least one dot is `fail`.
 */
export function shouldShowAboutHealthRibbon(
  report: AboutThisPcReport | null,
): boolean {
  return aboutHealthRibbonSeverity(report) === "fail";
}
