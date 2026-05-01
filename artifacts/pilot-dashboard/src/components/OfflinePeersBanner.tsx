// Amber banner shown above every aggregator read page when one or
// more peer squadrons could not be reached. Lists offline squadrons
// with the timestamp of their last successful pull (so the operator
// knows how stale the cached rows from that squadron are).
//
// `peers` is the `peers` array from `/api/aggregate/<resource>`
// (per-peer status block). When every peer is online the banner
// renders nothing — staying out of the way in the happy path.

import { AlertTriangle } from "lucide-react";
import type { PeerHealthStatus } from "@/lib/internal-migration";
import { useI18n } from "@/lib/i18n";

interface Props {
  peers: PeerHealthStatus[] | undefined | null;
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.toISOString().slice(0, 10)} ${hh}:${mm}`;
}

export function OfflinePeersBanner({ peers }: Props) {
  const { t } = useI18n();
  const offline = (peers ?? []).filter(p => p.status === "offline");
  if (offline.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-100 px-3 py-2 text-sm flex items-start gap-2"
      data-testid="offline-peers-banner"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">{t("offlinePeersHeading")}</div>
        <ul className="mt-1 space-y-0.5">
          {offline.map(p => (
            <li key={p.peer_squadron_id} className="truncate">
              <span className="font-medium">
                {p.squadron_name || p.squadron_id}
              </span>
              {" — "}
              {t("offlinePeersLastSeen")}: {formatLastSeen(p.last_success_at)}
              {p.served_from_cache ? ` (${t("offlinePeersServedCache")})` : ""}
              {p.error ? ` · ${p.error}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default OfflinePeersBanner;
