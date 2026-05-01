import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Radio, RotateCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { toast } from "@/hooks/use-toast";
import {
  fetchInternalMdnsHealth,
  postInternalLanBroadcastRestart,
  type MdnsBadgeState,
  type MdnsHealthFetchResult,
} from "@/lib/internal-migration";

const REFRESH_MS = 30_000;

/** Maps a badge state → color tokens reused from `SystemHealth.tsx`. */
function badgeFor(state: MdnsBadgeState, label: string) {
  if (state === "alive") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 border border-emerald-500/30">
        <span className="inline-block size-2 rounded-full bg-emerald-500 me-2" />
        {label}
      </Badge>
    );
  }
  if (state === "disabled" || state === "starting") {
    return (
      <Badge className="bg-slate-500/15 text-slate-700 hover:bg-slate-500/15 border border-slate-500/30">
        <span className="inline-block size-2 rounded-full bg-slate-500 me-2" />
        {label}
      </Badge>
    );
  }
  if (state === "stale" || state === "unreadable" || state === "spawn-failed") {
    return (
      <Badge className="bg-red-500/15 text-red-800 hover:bg-red-500/15 border border-red-500/40">
        <span className="inline-block size-2 rounded-full bg-red-500 me-2" />
        {label}
      </Badge>
    );
  }
  // restarting → amber
  return (
    <Badge className="bg-amber-500/15 text-amber-800 hover:bg-amber-500/15 border border-amber-500/40">
      <span className="inline-block size-2 rounded-full bg-amber-500 me-2" />
      {label}
    </Badge>
  );
}

/**
 * Operator dashboard badge for the LAN mDNS broadcast (Task #398).
 *
 * Renders nothing when the internal API is not reachable at all (e.g. the
 * dashboard is running outside LAN and `VITE_INTERNAL_API_URL` is unset).
 * That keeps the existing System Health layout clean for cloud-only users
 * while exposing the badge on every LAN install.
 */
export function MdnsHealthCard() {
  const { t, lang } = useI18n();
  const [result, setResult] = useState<MdnsHealthFetchResult | null>(null);
  const [hidden, setHidden] = useState(false);
  // Track "have we ever rendered the card" via a ref instead of the
  // `result` state so the empty-deps effect closure does not stale
  // on the first render. Once the card has been rendered once we
  // never re-hide it on a transient `internal_api_disabled` blip.
  const hasLoadedOnce = useRef(false);
  // Stable ref to the reload closure so children (RestartButton) can
  // trigger a fresh poll right after a successful restart without
  // racing the 30s interval.
  const reloadRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      const r = await fetchInternalMdnsHealth();
      if (cancelled) return;
      // First-load suppression: when the very first call says the
      // internal API is disabled, don't mount the card at all (the
      // dashboard is not LAN-attached). Once we have rendered any
      // result we keep showing it so transient network blips do not
      // flicker the whole card off the page.
      if (
        !hasLoadedOnce.current &&
        r.ok === false &&
        r.error === "internal_api_disabled"
      ) {
        setHidden(true);
        return;
      }
      hasLoadedOnce.current = true;
      setHidden(false);
      setResult(r);
    };
    reloadRef.current = reload;
    void reload();
    const id = window.setInterval(() => {
      void reload();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (hidden) return null;
  if (!result) {
    return (
      <Card data-testid="mdns-health-card" dir={lang === "ar" ? "rtl" : "ltr"}>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Radio className="h-4 w-4" />
            {t("mdns_health_title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("system_health_loading")}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Internal API reachable but agent failed — show error card.
  if (result.ok === false) {
    return (
      <Card data-testid="mdns-health-card" dir={lang === "ar" ? "rtl" : "ltr"}>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Radio className="h-4 w-4" />
            {t("mdns_health_title")}
          </CardTitle>
          {badgeFor("unreadable", t("mdns_health_badge_unreadable"))}
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            {t("mdns_health_unreachable")}
            : <span className="font-mono text-xs">{result.error}</span>
          </p>
        </CardContent>
      </Card>
    );
  }

  if ("disabled" in result) {
    return (
      <Card
        data-testid="mdns-health-card"
        data-mdns-state="disabled"
        dir={lang === "ar" ? "rtl" : "ltr"}
      >
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Radio className="h-4 w-4" />
            {t("mdns_health_title")}
          </CardTitle>
          {badgeFor("disabled", t("mdns_health_badge_disabled"))}
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">{t("mdns_health_disabled_explainer")}</p>
        </CardContent>
      </Card>
    );
  }

  const r = result.report;
  const label = labelFor(r.state, t);
  const showCommand =
    r.state === "stale" ||
    r.state === "restarting" ||
    r.state === "spawn-failed" ||
    r.state === "unreadable";
  const command =
    r.state === "stale" || r.state === "unreadable"
      ? "powershell -ExecutionPolicy Bypass -File scripts\\lan-host\\register-mdns.ps1"
      : "powershell -ExecutionPolicy Bypass -File scripts\\lan-host\\check-mdns-health.ps1";
  // One-click restart (#403). Offered whenever the badge is not in
  // the happy "alive" / "starting" / "disabled" states — i.e. the
  // operator is currently looking at a stuck supervisor.
  const offerRestart =
    r.state === "stale" ||
    r.state === "restarting" ||
    r.state === "spawn-failed" ||
    r.state === "unreadable";

  return (
    <Card
      data-testid="mdns-health-card"
      data-mdns-state={r.state}
      dir={lang === "ar" ? "rtl" : "ltr"}
    >
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Radio className="h-4 w-4" />
          {t("mdns_health_title")}
        </CardTitle>
        {badgeFor(r.state, label)}
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm">{messageFor(r.state, t, r)}</p>
        <div className="rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] leading-snug space-y-0.5">
          {r.squadronName ? (
            <div>
              squadron: <span>{r.squadronName}</span>
            </div>
          ) : null}
          {r.apiPort ? (
            <div>
              apiPort: <span>{r.apiPort}</span>
            </div>
          ) : null}
          {r.ageSec != null ? (
            <div>
              heartbeatAgeSec: <span>{r.ageSec}</span> /{" "}
              <span>{r.staleThresholdSec}</span>
            </div>
          ) : null}
          {r.restartCount != null ? (
            <div>
              restartCount: <span>{r.restartCount}</span>
            </div>
          ) : null}
          {r.supervisorState ? (
            <div>
              supervisorState: <span>{r.supervisorState}</span>
            </div>
          ) : null}
        </div>
        {offerRestart ? <RestartButton onAfter={reloadRef.current} /> : null}
        {showCommand ? (
          <div className="rounded border border-border/60 bg-muted/40 p-2 space-y-1">
            <div className="text-xs text-muted-foreground">
              {t("mdns_health_command_hint")}
            </div>
            <code
              className="block text-[11px] font-mono break-all whitespace-pre-wrap"
              dir="ltr"
            >
              {command}
            </code>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One-click "restart the LAN broadcast scheduled task" button (#403).
 *
 * Posts to `/api/internal/lan-broadcast/restart` and then re-polls
 * the health endpoint so the badge state reflects what the
 * supervisor reports right after the kick. Mounted only when the
 * card already shows a non-happy state, so we never tempt the
 * operator into restarting a healthy broadcast.
 */
function RestartButton({ onAfter }: { onAfter: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { ok: true } | { ok: false; error: string }>(
    null,
  );
  const onClick = useCallback(async () => {
    setBusy(true);
    setDone(null);
    try {
      const r = await postInternalLanBroadcastRestart();
      if (r.ok) {
        setDone({ ok: true });
        // Toast confirmation in addition to the inline pill — the
        // inline status sits inside the card and is easy to miss
        // when the operator's focus has already moved elsewhere
        // after clicking. The toast is non-blocking and dismisses
        // itself. (Acceptance for #403.)
        toast({
          title: t("mdns_restart_toast_title"),
          description: t("mdns_restart_success"),
        });
        await onAfter();
      } else {
        setDone({ ok: false, error: r.error });
        toast({
          variant: "destructive",
          title: t("mdns_restart_toast_title"),
          description: `${t("mdns_restart_failed")}: ${r.error}`,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [onAfter, t]);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        data-testid="mdns-restart-button"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-amber-500/15 text-amber-800 border border-amber-500/40 hover:bg-amber-500/25 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCw className="h-3.5 w-3.5" />
        )}
        <span>
          {busy
            ? t("mdns_restart_running")
            : t("mdns_restart_button")}
        </span>
      </button>
      {done?.ok && (
        <span
          className="text-[11px] text-emerald-700"
          data-testid="mdns-restart-success"
        >
          {t("mdns_restart_success")}
        </span>
      )}
      {done && !done.ok && (
        <span
          className="text-[11px] text-red-700 max-w-[12rem] truncate"
          title={done.error}
          data-testid="mdns-restart-error"
        >
          {t("mdns_restart_failed")}: {done.error}
        </span>
      )}
    </div>
  );
}

function labelFor(state: MdnsBadgeState, t: (k: string) => string): string {
  switch (state) {
    case "alive":
      return t("mdns_health_badge_alive");
    case "stale":
      return t("mdns_health_badge_stale");
    case "restarting":
      return t("mdns_health_badge_restarting");
    case "spawn-failed":
      return t("mdns_health_badge_spawn_failed");
    case "starting":
      return t("mdns_health_badge_starting");
    case "unreadable":
      return t("mdns_health_badge_unreadable");
    case "disabled":
      return t("mdns_health_badge_disabled");
  }
}

function messageFor(
  state: MdnsBadgeState,
  t: (k: string) => string,
  r: { ageSec: number | null; staleThresholdSec: number; restartCount: number | null },
): string {
  switch (state) {
    case "alive":
      return t("mdns_health_message_alive");
    case "stale":
      return `${t("mdns_health_message_stale")} (${r.ageSec ?? "?"}s > ${r.staleThresholdSec}s)`;
    case "restarting":
      return t("mdns_health_message_restarting");
    case "spawn-failed":
      return t("mdns_health_message_spawn_failed");
    case "starting":
      return t("mdns_health_message_starting");
    case "unreadable":
      return t("mdns_health_message_unreadable");
    case "disabled":
      return t("mdns_health_disabled_explainer");
  }
}

export default MdnsHealthCard;
