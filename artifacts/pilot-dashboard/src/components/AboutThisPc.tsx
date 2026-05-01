// "About this PC" Settings panel.
//
// Mounted on the Settings page (`Settings.tsx`) for super_admin
// operators only. Polls `/api/internal/about` (or `/api/aggregate/about`
// on aggregator profiles) every 60 seconds and surfaces the small
// handful of facts a super_admin needs when reporting an issue:
//
//   * install profile (hub / aggregator-wing / aggregator-base / viewer)
//   * hostname
//   * api-server version + build time
//   * process uptime
//   * database name
//   * active peer-token count (hub) OR peer-squadron count (aggregator)
//   * last backup age + last backup-verify age (with health dots)
//   * node.js version
//
// Each row uses a colored dot (ok / warn / fail / unknown) so the
// operator can scan for trouble at a glance without having to
// interpret raw numbers. The "Last backup" / "Last verify" rows also
// expose inline action buttons (task #390) so a super_admin can kick
// off a fresh backup or verify-restore from the panel without
// dropping to PowerShell.

import { useCallback, useEffect, useState } from "react";
import {
  fetchInternalAboutThisPc,
  postInternalAboutAction,
  type AboutThisPcAction,
  type AboutThisPcDashboardSupervisor,
  type AboutThisPcReport,
} from "@/lib/internal-migration";
import {
  lastBackupSeverity,
  lastBackupVerifySeverity,
  type AboutDotSeverity,
} from "@/lib/about-health";
import { useI18n, type Key as I18nKey } from "@/lib/i18n";
import { Card } from "@/components/Layout";
import { Loader2, PlayCircle, Server } from "lucide-react";

const POLL_MS = 60_000;

function dotClass(s: AboutDotSeverity): string {
  switch (s) {
    case "ok":
      return "bg-emerald-400";
    case "warn":
      return "bg-amber-400";
    case "fail":
      return "bg-red-500";
    default:
      return "bg-zinc-500";
  }
}

function fmtUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function fmtAgeShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * Severity dot for the dashboard-supervisor row.
 *
 *   alive          -> ok
 *   starting       -> ok    (boot path; converges within a few seconds)
 *   restarting     -> warn  (transient between launcher exits)
 *   stale          -> fail  (supervisor task itself died)
 *   spawn-failed   -> fail  (cannot even start the launcher)
 *   unreadable     -> warn  (heartbeat file is corrupt or partial)
 */
function dashboardSupervisorSeverity(
  s: AboutThisPcDashboardSupervisor["state"],
): AboutDotSeverity {
  switch (s) {
    case "alive":
    case "starting":
      return "ok";
    case "restarting":
    case "unreadable":
      return "warn";
    case "stale":
    case "spawn-failed":
      return "fail";
    default:
      return "unknown";
  }
}

/**
 * Render the dashboard-supervisor cell as `<state-label> · age · restarts`.
 * `t` is the i18n lookup; we pass it explicitly so this stays a pure
 * helper and the test can assert on the exact rendered string without
 * mounting the whole component tree.
 */
function dashboardSupervisorStateKey(
  state: AboutThisPcDashboardSupervisor["state"],
): I18nKey {
  // Map heartbeat states to the i18n keys we registered for both EN
  // and AR. Using a switch keeps the keys statically typed (the `t`
  // callback only accepts `keyof Dict`); a string template here
  // would fail typecheck in strict mode.
  switch (state) {
    case "alive":          return "about_dashboard_supervisor_alive";
    case "stale":          return "about_dashboard_supervisor_stale";
    case "restarting":     return "about_dashboard_supervisor_restarting";
    case "spawn-failed":   return "about_dashboard_supervisor_spawn_failed";
    case "starting":       return "about_dashboard_supervisor_starting";
    case "unreadable":     return "about_dashboard_supervisor_unreadable";
  }
}

function fmtDashboardSupervisorValue(
  d: AboutThisPcDashboardSupervisor | null,
  t: (k: I18nKey) => string,
): string {
  if (!d) return t("about_dashboard_supervisor_absent");
  const parts: string[] = [t(dashboardSupervisorStateKey(d.state))];
  if (d.ageSeconds != null) {
    parts.push(fmtAgeShort(d.ageSeconds));
  }
  if (d.restartCount != null && d.restartCount > 0) {
    parts.push(`${d.restartCount}× restart`);
  }
  return parts.join(" · ");
}

function fmtBuildTime(s: string | null | undefined): string {
  if (!s) return "—";
  // ISO timestamp; render in the user's locale, short form.
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return s;
  return t.toLocaleString();
}

interface RowProps {
  label: string;
  value: React.ReactNode;
  severity?: AboutDotSeverity;
  testId?: string;
  action?: React.ReactNode;
}

function Row({ label, value, severity = "ok", testId, action }: RowProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-1 text-sm"
      data-testid={testId}
    >
      <span className="flex items-center gap-2 text-muted-foreground min-w-0">
        <span
          className={`inline-block h-2 w-2 rounded-full shrink-0 ${dotClass(severity)}`}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-center gap-2 min-w-0 justify-end">
        <span
          className="font-mono text-xs text-foreground break-all text-end"
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

interface ActionButtonProps {
  action: AboutThisPcAction;
  label: string;
  runningLabel: string;
  testId: string;
  onAfter: () => void | Promise<void>;
}

function ActionButton({
  action,
  label,
  runningLabel,
  testId,
  onAfter,
}: ActionButtonProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  // Last-run summary (#394). Holds either an error string or the
  // success metadata so we can render a green "Done" pill plus a
  // "view log" link inline next to the button. Reset on every fresh
  // click so the operator never sees a stale result.
  const [done, setDone] = useState<
    | null
    | { ok: true; logPath?: string; durationMs?: number }
    | { ok: false; error: string; logPath?: string }
  >(null);

  const onClick = useCallback(async () => {
    setBusy(true);
    setDone(null);
    try {
      const result = await postInternalAboutAction(action);
      if (!result.ok) {
        setDone({ ok: false, error: result.error, logPath: result.logPath });
        return;
      }
      setDone({ ok: true, logPath: result.logPath, durationMs: result.durationMs });
      await onAfter();
    } finally {
      setBusy(false);
    }
  }, [action, onAfter]);

  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        data-testid={testId}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-primary/15 text-primary border border-primary/40 hover:bg-primary/25 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <PlayCircle className="h-3 w-3" />
        )}
        <span>{busy ? runningLabel : label}</span>
      </button>
      {done?.ok && (
        <span
          className="text-[10px] text-emerald-600"
          data-testid={`${testId}-success`}
        >
          {t("about_action_done")}
          {typeof done.durationMs === "number"
            ? ` (${Math.round(done.durationMs / 100) / 10}s)`
            : ""}
        </span>
      )}
      {done && !done.ok && (
        <span
          className="text-[10px] text-destructive max-w-[8rem] truncate"
          title={done.error}
          data-testid={`${testId}-error`}
        >
          {done.error}
        </span>
      )}
      {done?.logPath && (
        <CopyLogPathButton
          logPath={done.logPath}
          testId={`${testId}-log`}
          label={t("about_action_log_label")}
          copiedLabel={t("about_action_log_copied")}
        />
      )}
    </span>
  );
}

// Renders the per-run log path as a clickable affordance. The path
// is a Windows file path (e.g. C:\HawkEye\logs\about-actions\xxxx.log)
// which a browser can't open directly, so the actionable control is
// "copy to clipboard" — the operator pastes it into Explorer or a
// support ticket. Falls back to selecting the text if clipboard API
// is unavailable. (#394 acceptance: surface success/failure with a
// link to the log file.)
function CopyLogPathButton({
  logPath,
  testId,
  label,
  copiedLabel,
}: {
  logPath: string;
  testId: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      title={logPath}
      onClick={async () => {
        // Only flip the "copied" pill on a genuine success — a missing
        // Clipboard API or a write rejection should leave the pill off
        // so the operator knows the path didn't actually hit the
        // clipboard. They can still grab it manually via the `title`
        // tooltip or by selecting the visible truncated text.
        if (!navigator.clipboard?.writeText) return;
        try {
          await navigator.clipboard.writeText(logPath);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked; intentionally do not show "copied" */
        }
      }}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/60 max-w-[12rem] underline-offset-2 hover:underline"
    >
      <span className="truncate">{label}: {logPath}</span>
      {copied && (
        <span className="text-emerald-600 not-italic">· {copiedLabel}</span>
      )}
    </button>
  );
}

export default function AboutThisPc(): React.ReactElement {
  const { t } = useI18n();
  const [report, setReport] = useState<AboutThisPcReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchInternalAboutThisPc();
      if (r) {
        setReport(r);
        setError(null);
      } else {
        setError("about_unreachable");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
      setLastPolledAt(new Date().toISOString());
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function tick() {
      if (cancelled) return;
      await load();
    }

    void tick();
    timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [load]);

  return (
    <Card
      className="lg:col-span-2 space-y-3"
      data-testid="about-this-pc-card"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          {t("about_this_pc_title")}
        </div>
        {lastPolledAt && (
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="about-last-polled"
          >
            {t("about_last_polled")}: {new Date(lastPolledAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("about_this_pc_blurb")}</p>

      {!loaded && (
        <div
          className="text-xs text-muted-foreground"
          data-testid="about-loading"
        >
          {t("about_loading")}
        </div>
      )}

      {loaded && !report && (
        <div
          className="rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
          data-testid="about-unreachable"
        >
          {t("about_unreachable")}
          {error && (
            <div className="mt-1 font-mono text-[11px] text-amber-300/80 break-all">
              {error}
            </div>
          )}
        </div>
      )}

      {report && (
        <div
          className="grid grid-cols-1 md:grid-cols-2 gap-x-6 divide-y md:divide-y-0 md:divide-x divide-border"
          data-testid="about-rows"
        >
          <div className="space-y-0">
            <Row
              label={t("about_field_install_profile")}
              value={report.installProfile}
              testId="about-install-profile"
            />
            <Row
              label={t("about_field_hostname")}
              value={report.hostname || "—"}
              testId="about-hostname"
            />
            <Row
              label={t("about_field_api_version")}
              value={report.apiServerVersion || "—"}
              testId="about-api-version"
            />
            <Row
              label={t("about_field_build_time")}
              value={fmtBuildTime(report.buildTime)}
              testId="about-build-time"
            />
            <Row
              label={t("about_field_uptime")}
              value={fmtUptime(report.uptimeSeconds)}
              testId="about-uptime"
            />
            <Row
              label={t("about_field_node_version")}
              value={report.nodeVersion}
              testId="about-node-version"
            />
          </div>
          <div className="space-y-0 md:ps-6">
            <Row
              label={t("about_field_database_name")}
              value={report.databaseName ?? "—"}
              severity={report.databaseName ? "ok" : "warn"}
              testId="about-database-name"
            />
            {report.peerTokenCount != null && (
              <Row
                label={t("about_field_peer_token_count")}
                value={String(report.peerTokenCount)}
                testId="about-peer-token-count"
              />
            )}
            {report.peerSquadronCount != null && (
              <Row
                label={t("about_field_peer_squadron_count")}
                value={String(report.peerSquadronCount)}
                testId="about-peer-squadron-count"
              />
            )}
            <Row
              label={t("about_field_last_backup")}
              value={
                report.lastBackupAge
                  ? fmtAgeShort(report.lastBackupAge.ageSeconds) +
                    " · " +
                    report.lastBackupAge.fileName
                  : t("about_never_backed_up")
              }
              severity={lastBackupSeverity(report.lastBackupAge?.ageSeconds ?? null)}
              testId="about-last-backup"
              action={
                <ActionButton
                  action="run-backup"
                  label={t("about_run_backup_now")}
                  runningLabel={t("about_action_running")}
                  testId="about-run-backup"
                  onAfter={load}
                />
              }
            />
            <Row
              label={t("about_field_last_backup_verify")}
              value={
                report.lastBackupVerifyAge
                  ? fmtAgeShort(report.lastBackupVerifyAge.ageSeconds) +
                    (report.lastBackupVerifyAge.ok ? "" : " · FAIL")
                  : t("about_never_verified")
              }
              severity={lastBackupVerifySeverity(report.lastBackupVerifyAge)}
              testId="about-last-backup-verify"
              action={
                <ActionButton
                  action="run-verify"
                  label={t("about_run_verify_now")}
                  runningLabel={t("about_action_running")}
                  testId="about-run-verify"
                  onAfter={load}
                />
              }
            />
            {/*
              Dashboard launcher watchdog row (Task #399 / T-O).
              `dashboardSupervisor === null` means the heartbeat file
              was absent — typical on a hub-only PC that does not
              auto-launch the dashboard locally. Render the row even
              in that case so the operator can see the dashboard
              watchdog is intentionally not installed (not silently
              broken).
            */}
            <Row
              label={t("about_field_dashboard_supervisor")}
              value={fmtDashboardSupervisorValue(report.dashboardSupervisor, t)}
              severity={
                report.dashboardSupervisor
                  ? dashboardSupervisorSeverity(
                      report.dashboardSupervisor.state,
                    )
                  : "unknown"
              }
              testId="about-dashboard-supervisor"
            />
          </div>
        </div>
      )}
    </Card>
  );
}
