/**
 * `LanPeers` — super-admin panel that renders the live list of PCs
 * Hawk Eye sees on this LAN segment via the `_hawkeye._tcp` mDNS
 * broadcast (Task T-R, Step 3).
 *
 * Reads `GET /api/internal/lan-discovery/peers` (or
 * `/api/aggregate/lan-discovery/peers` on aggregator profiles) every
 * 5 seconds. The page is intentionally read-only — pairing actions
 * live in `LanPairingInbox` (Hub) or in the first-launch card
 * (Aggregator/Viewer) so this page stays a calm topology view.
 *
 * "discovery offline" means dns-sd.exe could not be spawned (Bonjour
 * not installed on the host, OS-level multicast blocked, etc.).
 * The page nudges the operator at the Bonjour install in the
 * runbook rather than silently showing zero peers.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
  fetchLanDiscoveryReport,
  type LanDiscoveryReport,
  type LanDiscoveredPeer,
} from "@/lib/internal-migration";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, Server, ShieldAlert, Wifi, WifiOff } from "lucide-react";

const REFRESH_MS = 5_000;

function fmtAge(ms: number): string {
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function roleVariant(role: LanDiscoveredPeer["role"]): "default" | "secondary" | "outline" {
  if (role === "hub") return "default";
  if (role === "viewer") return "outline";
  return "secondary";
}

export default function LanPeers() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isSuperAdmin = user?.role === "super_admin";

  const [report, setReport] = useState<LanDiscoveryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadAt, setReloadAt] = useState(Date.now());

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      const r = await fetchLanDiscoveryReport();
      if (!cancelled) {
        setReport(r);
        setLoading(false);
      }
    })();
    const id = setInterval(() => setReloadAt(Date.now()), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isSuperAdmin, reloadAt]);

  if (!isSuperAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6 flex items-center gap-3 text-amber-600">
            <ShieldAlert className="h-5 w-5" />
            <span>{t("lanPeersForbidden")}</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  const enabled = report?.enabled === true;
  const self = report?.self ?? null;
  const peers = report?.peers ?? [];
  const now = Date.now();

  return (
    <div className="p-6 space-y-4" data-testid="page-lan-peers">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("lanPeersTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("lanPeersSubtitle")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReloadAt(Date.now())}
          data-testid="button-reload"
        >
          <RefreshCw className="h-4 w-4 me-2" />
          {t("refresh")}
        </Button>
      </div>

      {!loading && !enabled && (
        <Card>
          <CardContent className="p-4 flex items-center gap-3 text-amber-600">
            <WifiOff className="h-5 w-5" />
            <div>
              <div className="font-medium">{t("lanPeersDisabledTitle")}</div>
              <div className="text-sm text-muted-foreground">
                {t("lanPeersDisabledHint")}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {self && (
        <Card>
          <CardContent className="p-4 flex items-center gap-3" data-testid="card-self">
            <Wifi className="h-5 w-5 text-emerald-600" />
            <div className="flex-1">
              <div className="font-medium">{self.hostname}</div>
              <div className="text-xs text-muted-foreground">
                {t("lanPeersSelfLabel")} · {self.address || "—"}:{self.port}
              </div>
            </div>
            <Badge variant={roleVariant(self.role)}>{self.role}</Badge>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground">{t("loading")}…</div>
          ) : peers.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground" data-testid="empty-peers">
              {enabled ? t("lanPeersEmpty") : t("lanPeersDisabledEmpty")}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="text-start p-3">{t("lanPeersColHostname")}</th>
                  <th className="text-start p-3">{t("lanPeersColRole")}</th>
                  <th className="text-start p-3">{t("lanPeersColAddress")}</th>
                  <th className="text-start p-3">{t("lanPeersColVersion")}</th>
                  <th className="text-start p-3">{t("lanPeersColLastSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {peers.map((p) => (
                  <tr key={p.hostname} className="border-t" data-testid={`row-peer-${p.hostname}`}>
                    <td className="p-3 font-medium flex items-center gap-2">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      {p.hostname}
                    </td>
                    <td className="p-3">
                      <Badge variant={roleVariant(p.role)}>{p.role}</Badge>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {p.address || "—"}{p.port ? `:${p.port}` : ""}
                    </td>
                    <td className="p-3 text-muted-foreground">{p.txt.version || "—"}</td>
                    <td className="p-3 text-muted-foreground">{fmtAge(now - p.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
