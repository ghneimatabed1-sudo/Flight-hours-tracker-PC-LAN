import { useEffect, useState } from "react";
import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { CircleDot, Loader2, AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getLastDataErrorAt, subscribeDataErrors, clearDataError } from "@/lib/query-client";
import { getHeartbeatStatus, subscribeHeartbeatStatus } from "@/lib/cross-pc";

// A tiny three-state pill that lives in the sidebar/topbar:
//  • green idle — nothing in flight, no recent error
//  • amber pulse — at least one fetch or mutation is currently running
//  • red — the most recent server call ended in an error
//
// Clicking the red pill clears the error so the operator can dismiss it
// once they've understood what happened.
export function LiveDataIndicator({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const fetching = useIsFetching();
  const mutating = useIsMutating();
  const [, setTick] = useState(0);
  const lastErr = getLastDataErrorAt();
  const heartbeat = getHeartbeatStatus();

  useEffect(() => {
    const u1 = subscribeDataErrors(() => setTick(x => x + 1));
    const u2 = subscribeHeartbeatStatus(() => setTick(x => x + 1));
    return () => { u1(); u2(); };
  }, []);

  const busy = fetching > 0 || mutating > 0;
  // Treat a stuck heartbeat as an error even if no other mutation has
  // failed, so a Flight/Squadron PC whose only failing call is the
  // 30s heartbeat upsert still flips the indicator red.
  const errored = lastErr !== null || heartbeat.errorMsg !== null;

  let label: string;
  let cls: string;
  let Icon = CircleDot;
  if (errored) {
    label = t("dataIndicatorError");
    cls = "text-rose-300 bg-rose-500/15 border-rose-500/40";
    Icon = AlertTriangle;
  } else if (busy) {
    label = t("dataIndicatorSyncing");
    cls = "text-amber-300 bg-amber-500/10 border-amber-500/30";
    Icon = Loader2;
  } else {
    label = t("dataIndicatorLive");
    cls = "text-emerald-300 bg-emerald-500/10 border-emerald-500/30";
    Icon = CircleDot;
  }

  // Hover tooltip: when there's a heartbeat error, surface the exact
  // message so the operator (or a developer doing remote support) can
  // see WHY the cross-PC sync is failing without opening the console.
  const tooltip = heartbeat.errorMsg
    ? `${label} — ${heartbeat.errorMsg}`
    : label;

  return (
    <button
      type="button"
      onClick={errored ? () => { clearDataError(); setTick(x => x + 1); } : undefined}
      title={tooltip}
      data-testid="indicator-live-data"
      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border ${cls}`}
    >
      <Icon className={`h-3.5 w-3.5 ${busy && !errored ? "animate-spin" : ""}`} />
      {!compact && <span>{label}</span>}
    </button>
  );
}
