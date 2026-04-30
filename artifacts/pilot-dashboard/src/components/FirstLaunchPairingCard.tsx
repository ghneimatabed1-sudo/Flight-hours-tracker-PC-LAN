/**
 * `FirstLaunchPairingCard` — full-screen one-click pairing card shown
 * on aggregator and viewer PCs when:
 *
 *   - this PC has not yet successfully paired with any Hub, AND
 *   - the LAN auto-discovery service can see at least one PC
 *     announcing `role=hub`.
 *
 * The card lists every visible Hub with hostname, IP, squadron name
 * (from the TXT record), and a single "Pair with this Hub" button.
 * Clicking it sends `POST /api/internal/lan-pairing/request` which
 * forwards the inbound request to the Hub super_admin's pairing
 * inbox. The card then polls `outbox` until the request flips to
 * `paired` (Hub approved + envelope decrypted) or `denied`.
 *
 * On `paired` we hand the parent a token-id callback so it can
 * dismiss this card and proceed into the dashboard. The plaintext
 * peer token itself is never displayed in the UI — it stays in the
 * server-side peer-token-client config.
 */

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import {
  fetchLanDiscoveryReport,
  fetchLanPairingOutbox,
  postLanPairingRequest,
  deleteLanPairingOutbound,
  type LanDiscoveredPeer,
  type LanOutboundRequestRow,
} from "@/lib/internal-migration";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  WifiOff,
  XCircle,
} from "lucide-react";

const REFRESH_MS = 4_000;

export type FirstLaunchPairingCardProps = {
  /**
   * Called when this PC successfully completes a pairing handshake.
   * The parent typically dismisses the card and reloads the
   * dashboard so the new peer-token-backed reads succeed.
   */
  onPaired?: (info: { tokenId: string; tokenLabel: string | null; hubHostname: string }) => void;
  /** Optional override: skip the "Skip for now" button (forced pair). */
  required?: boolean;
};

type ViewState = "loading" | "no-hubs" | "ready" | "in-flight" | "approved" | "denied" | "error";

function findActiveOutbound(
  outbox: LanOutboundRequestRow[],
): LanOutboundRequestRow | null {
  for (const row of outbox) {
    if (row.status === "pending" || row.status === "transport_failed") return row;
  }
  return null;
}

function findLatestPaired(
  outbox: LanOutboundRequestRow[],
): LanOutboundRequestRow | null {
  for (const row of outbox) {
    if (row.status === "paired") return row;
  }
  return null;
}

export default function FirstLaunchPairingCard({
  onPaired,
  required,
}: FirstLaunchPairingCardProps) {
  const { t } = useI18n();
  const [hubs, setHubs] = useState<LanDiscoveredPeer[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [outbox, setOutbox] = useState<LanOutboundRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadAt, setReloadAt] = useState(Date.now());
  const [localKeyFp, setLocalKeyFp] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [report, ob] = await Promise.all([
        fetchLanDiscoveryReport(),
        fetchLanPairingOutbox(),
      ]);
      if (cancelled) return;
      setEnabled(report?.enabled !== false);
      setHubs(report?.peers.filter((p) => p.role === "hub") ?? []);
      setOutbox(ob ?? []);
      setLoading(false);
    })();
    const id = setInterval(() => setReloadAt(Date.now()), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reloadAt]);

  const activeRequest = useMemo(() => findActiveOutbound(outbox), [outbox]);
  const lastPaired = useMemo(() => findLatestPaired(outbox), [outbox]);

  // Surface the success once, then let the parent take over.
  useEffect(() => {
    if (lastPaired && onPaired) {
      onPaired({
        tokenId: lastPaired.received_token_id ?? "",
        tokenLabel: lastPaired.received_token_label,
        hubHostname: lastPaired.hub_hostname,
      });
    }
  }, [lastPaired, onPaired]);

  const view: ViewState = loading
    ? "loading"
    : lastPaired
      ? "approved"
      : activeRequest
        ? "in-flight"
        : hubs.length === 0
          ? "no-hubs"
          : "ready";

  async function pairWith(hub: LanDiscoveredPeer): Promise<void> {
    setBusy(true);
    setError(null);
    const r = await postLanPairingRequest({
      hub_hostname: hub.hostname,
      hub_address: hub.address || hub.hostname,
      hub_port: hub.port || 80,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "request_failed");
      return;
    }
    if (r.sign_pub_key) {
      setLocalKeyFp(r.sign_pub_key.slice(0, 16));
    }
    setReloadAt(Date.now());
  }

  async function cancel(id: string): Promise<void> {
    setBusy(true);
    await deleteLanPairingOutbound(id);
    setBusy(false);
    setReloadAt(Date.now());
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6 bg-background"
      data-testid="first-launch-pairing-card"
    >
      <Card className="w-full max-w-2xl">
        <CardContent className="p-8 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-6 w-6 text-emerald-600" />
              {t("firstLaunchPairTitle")}
            </h1>
            <p className="text-sm text-muted-foreground mt-2">
              {t("firstLaunchPairSubtitle")}
            </p>
          </div>

          {view === "loading" && (
            <div className="flex items-center gap-2 text-muted-foreground" data-testid="state-loading">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loading")}…
            </div>
          )}

          {view === "no-hubs" && (
            <div className="space-y-3" data-testid="state-no-hubs">
              <div className="flex items-center gap-3 text-amber-600">
                <WifiOff className="h-5 w-5" />
                <div>
                  <div className="font-medium">{t("firstLaunchPairNoHubsTitle")}</div>
                  <div className="text-sm text-muted-foreground">
                    {enabled
                      ? t("firstLaunchPairNoHubsBody")
                      : t("firstLaunchPairDisabledBody")}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadAt(Date.now())}
                data-testid="button-reload"
              >
                <RefreshCw className="h-4 w-4 me-2" />
                {t("retry")}
              </Button>
            </div>
          )}

          {view === "ready" && (
            <div className="space-y-3" data-testid="state-ready">
              <div className="text-sm text-muted-foreground">
                {t("firstLaunchPairFoundHubs").replace("{n}", String(hubs.length))}
              </div>
              <div className="space-y-2">
                {hubs.map((h) => (
                  <div
                    key={h.hostname}
                    className="flex items-center gap-3 border rounded-md p-3"
                    data-testid={`hub-row-${h.hostname}`}
                  >
                    <Server className="h-5 w-5 text-emerald-600" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{h.hostname}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {h.address || "—"}{h.port ? `:${h.port}` : ""}
                        {h.txt.squadron ? ` · ${h.txt.squadron}` : ""}
                        {h.txt.version ? ` · v${h.txt.version}` : ""}
                      </div>
                    </div>
                    <Badge variant="default">hub</Badge>
                    <Button
                      onClick={() => pairWith(h)}
                      disabled={busy}
                      data-testid={`button-pair-${h.hostname}`}
                    >
                      {t("firstLaunchPairButton")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "in-flight" && activeRequest && (
            <div className="space-y-3" data-testid="state-inflight">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
                <div>
                  <div className="font-medium">{t("firstLaunchPairWaitingTitle")}</div>
                  <div className="text-sm text-muted-foreground">
                    {activeRequest.hub_hostname} · {activeRequest.hub_address}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {t("firstLaunchPairWaitingBody")}
                  </div>
                </div>
              </div>
              {localKeyFp && (
                <div className="rounded-md border bg-muted/50 p-3 text-xs space-y-1" data-testid="key-fingerprint-box">
                  <div className="font-medium text-foreground">{t("firstLaunchPairKeyFpTitle")}</div>
                  <code className="font-mono text-sm tracking-wider" data-testid="key-fingerprint-value">
                    {localKeyFp}…
                  </code>
                  <div className="text-muted-foreground">{t("firstLaunchPairKeyFpBody")}</div>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancel(activeRequest.id)}
                disabled={busy}
                data-testid="button-cancel"
              >
                <XCircle className="h-4 w-4 me-2" />
                {t("cancel")}
              </Button>
            </div>
          )}

          {view === "approved" && lastPaired && (
            <div className="flex items-center gap-3 text-emerald-600" data-testid="state-approved">
              <CheckCircle2 className="h-6 w-6" />
              <div>
                <div className="font-medium">{t("firstLaunchPairApprovedTitle")}</div>
                <div className="text-sm text-muted-foreground">
                  {lastPaired.hub_hostname}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive" data-testid="error-banner">
              {t("error")}: {error}
            </div>
          )}

          {!required && view !== "approved" && (
            <div className="pt-4 border-t text-xs text-muted-foreground">
              {t("firstLaunchPairManualHint")}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
