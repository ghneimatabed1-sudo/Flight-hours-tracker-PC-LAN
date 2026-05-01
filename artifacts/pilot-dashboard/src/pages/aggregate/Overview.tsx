// Aggregator-mode overview — high-level system status the operator
// sees right after sign-in on a Wing/Base PC. Renders the same
// `/api/aggregate/peers/health` data as the sidebar panel but with
// more breathing room and an explicit count of online vs offline
// squadrons. Each per-resource page (Pilots, Sorties, …) is one
// click away from the sidebar.

import { useEffect, useState } from "react";
import {
  fetchAggregatePeersHealth,
  type PeerHealthStatus,
} from "@/lib/internal-migration";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Server } from "lucide-react";

export default function AggregatorOverview() {
  const { t } = useI18n();
  const [peers, setPeers] = useState<PeerHealthStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetchAggregatePeersHealth();
      if (cancelled) return;
      if (r === null) {
        setError("unavailable");
        setPeers([]);
      } else {
        setPeers(r);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const online = (peers ?? []).filter(p => p.status === "online").length;
  const offline = (peers ?? []).filter(p => p.status === "offline").length;

  return (
    <div className="space-y-3" data-testid="aggregator-overview">
      <div className="flex items-center gap-2">
        <Server className="h-5 w-5 text-amber-300" />
        <h1 className="text-xl font-semibold flex-1">
          {t("aggregatorOverviewTitle")}
        </h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("aggregatorOverviewIntro")}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent className="py-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("aggregatorOverviewSquadrons")}
            </div>
            <div className="text-2xl font-semibold">{peers?.length ?? "—"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("squadronStatusOnline")}
            </div>
            <div className="text-2xl font-semibold text-emerald-300">{online}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("squadronStatusOffline")}
            </div>
            <div className="text-2xl font-semibold text-rose-300">{offline}</div>
          </CardContent>
        </Card>
      </div>
      {error === "unavailable" && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">
            {t("aggregateUnavailable")}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
