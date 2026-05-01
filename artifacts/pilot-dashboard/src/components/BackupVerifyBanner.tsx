// Site-wide red banner shown to super-admin operators when the
// quarterly `verify-backup.ps1` self-restore test is overdue (>120
// days) or its last result was an explicit FAILURE. Air-gapped
// installs cannot email anyone, so this banner is the only path the
// operator has to learn the backups they're trusting are not actually
// recoverable.
//
// Behaviour:
//   - Only super-admin operators see it. Other roles get nothing.
//   - Only on the hub install profile — aggregator PCs don't run the
//     verify-backup task and would always show "never verified",
//     which would just be noise for those operators.
//   - Fetches `/api/internal/backup-verify-status` once on mount.
//   - Dismissable for the current browser session via sessionStorage.
//     We deliberately don't persist the dismiss across reloads — if
//     the operator restarts the dashboard the banner needs to come
//     back so a forgotten manual run gets re-flagged.
//   - Shows the exact `scripts/lan-host/verify-backup.ps1` command so
//     the operator can copy/paste it into PowerShell.

import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { useInstallProfile } from "@/lib/install-profile";
import { fetchBackupVerifyStatus } from "@/lib/internal-migration";

const SESSION_DISMISS_KEY = "rjaf.backupVerifyBanner.dismissedAt";
const OVERDUE_DAYS = 120;

type Marker = {
  ok: boolean;
  observedAt: string;
  ageDays: number;
  message: string | null;
} | null;

type BannerKind =
  | { kind: "ok" }
  | { kind: "never" }
  | { kind: "overdue"; ageDays: number }
  | { kind: "failed"; observedAt: string };

export function classifyBackupVerifyMarker(marker: Marker): BannerKind {
  return classify(marker);
}

function classify(marker: Marker): BannerKind {
  if (marker == null) return { kind: "never" };
  if (!marker.ok) return { kind: "failed", observedAt: marker.observedAt };
  if (marker.ageDays > OVERDUE_DAYS) {
    return { kind: "overdue", ageDays: marker.ageDays };
  }
  return { kind: "ok" };
}

function isDismissedThisSession(): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(SESSION_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissThisSession(): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(SESSION_DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** Formats an ISO timestamp as `YYYY-MM-DD`. */
function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

export function BackupVerifyBanner() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { profile } = useInstallProfile();
  const [marker, setMarker] = useState<Marker | "loading" | "error">("loading");
  const [dismissed, setDismissed] = useState<boolean>(isDismissedThisSession());

  const eligible = user?.role === "super_admin" && profile === "hub";

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchBackupVerifyStatus();
        if (cancelled) return;
        if (result.ok) {
          setMarker(result.marker);
        } else {
          setMarker("error");
        }
      } catch {
        if (!cancelled) setMarker("error");
      }
    })();
    return () => { cancelled = true; };
  }, [eligible]);

  if (!eligible) return null;
  if (dismissed) return null;
  if (marker === "loading" || marker === "error") return null;

  const kind = classify(marker);
  if (kind.kind === "ok") return null;

  const command = "scripts/lan-host/verify-backup.ps1";
  let title = "";
  let body = "";
  if (kind.kind === "never") {
    title = t("backupVerifyTitleNever");
    body = t("backupVerifyBodyNever");
  } else if (kind.kind === "overdue") {
    title = t("backupVerifyTitleOverdue");
    body = t("backupVerifyBodyOverdue").replace("{days}", String(kind.ageDays));
  } else if (kind.kind === "failed") {
    title = t("backupVerifyTitleFailed");
    body = t("backupVerifyBodyFailed").replace(
      "{date}",
      formatDate(kind.observedAt),
    );
  }

  return (
    <div
      role="alert"
      data-testid="banner-backup-verify"
      className="rounded-md border border-red-500/50 bg-red-500/15 text-red-100 px-3 py-2 text-sm flex items-start gap-2"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-red-100/85 mt-0.5">{body}</div>
        <div className="mt-1.5 text-[11px] text-red-100/70">
          {t("backupVerifyRunHint")}
        </div>
        <code className="inline-block mt-1 text-[12px] font-mono bg-red-950/60 border border-red-400/30 rounded px-2 py-0.5 select-all">
          {command}
        </code>
      </div>
      <button
        type="button"
        aria-label={t("backupVerifyDismissAria")}
        data-testid="backup-verify-dismiss"
        onClick={() => {
          dismissThisSession();
          setDismissed(true);
        }}
        className="shrink-0 p-1 rounded hover:bg-red-500/20 text-red-100/80 hover:text-red-50"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default BackupVerifyBanner;
