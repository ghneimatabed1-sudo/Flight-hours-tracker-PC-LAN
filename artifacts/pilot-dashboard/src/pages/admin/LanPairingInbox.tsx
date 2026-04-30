/**
 * `LanPairingInbox` — Hub super_admin's review/approve queue for
 * inbound LAN pairing requests (Task T-R, Step 4).
 *
 * Inbound requests arrive from aggregator/viewer PCs that just
 * launched and clicked "Pair with this Hub" on their FirstLaunch
 * card. The Hub api-server persists each request in
 * `lan_pairing_inbound_requests`; this page polls the inbox every 5
 * seconds and lets the operator approve or deny with one click.
 *
 * Approval flow:
 *   1. Click Approve.
 *   2. Server mints a fresh `peer_tokens` row (squadron-read scope,
 *      labelled "LAN pair: <hostname>") and encrypts the plaintext
 *      token with the requester's pubkey using X25519 + AES-GCM.
 *   3. Server POSTs the sealed envelope to the requester's callback
 *      URL. The dashboard reflects "delivered" or "delivery_failed".
 *   4. The token shows up in `Peer Tokens` on this Hub for revocation.
 *
 * Operators MUST visually confirm the hostname/address/role before
 * approving — see runbook §13.
 */

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
  fetchLanPairingInbox,
  postLanPairingApprove,
  postLanPairingDeny,
  type LanInboundRequestRow,
} from "@/lib/internal-migration";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Inbox, RefreshCw, ShieldAlert, ShieldCheck, Ban, Check, AlertTriangle } from "lucide-react";

const REFRESH_MS = 5_000;

function fmtTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
  if (s === "pending") return "default";
  if (s === "delivered" || s === "approved") return "secondary";
  if (s === "denied" || s === "delivery_failed") return "destructive";
  return "outline";
}

export default function LanPairingInbox() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isSuperAdmin = user?.role === "super_admin";

  const [rows, setRows] = useState<LanInboundRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [reloadAt, setReloadAt] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      const items = await fetchLanPairingInbox(showAll ? "all" : "pending");
      if (cancelled) return;
      setRows(items ?? []);
      setLoading(false);
    })();
    const id = setInterval(() => setReloadAt(Date.now()), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isSuperAdmin, showAll, reloadAt]);

  async function approve(id: string, hostname: string): Promise<void> {
    setBusyId(id);
    setError(null);
    const r = await postLanPairingApprove(id, `LAN pair: ${hostname}`);
    setBusyId(null);
    if (!r.ok) {
      setError(r.error ?? "approve_failed");
      return;
    }
    setReloadAt(Date.now());
  }

  async function deny(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    const r = await postLanPairingDeny(id);
    setBusyId(null);
    if (!r.ok) {
      setError(r.error ?? "deny_failed");
      return;
    }
    setReloadAt(Date.now());
  }

  const pendingCount = useMemo(
    () => rows.filter((r) => r.status === "pending").length,
    [rows],
  );

  if (!isSuperAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="p-6 flex items-center gap-3 text-amber-600">
            <ShieldAlert className="h-5 w-5" />
            <span>{t("lanPairingInboxForbidden")}</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4" data-testid="page-lan-pairing-inbox">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Inbox className="h-5 w-5" />
            {t("lanPairingInboxTitle")}
            {pendingCount > 0 && (
              <Badge variant="default" data-testid="badge-pending-count">{pendingCount}</Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">{t("lanPairingInboxSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showAll ? "outline" : "default"}
            size="sm"
            onClick={() => setShowAll((v) => !v)}
            data-testid="button-toggle-all"
          >
            {showAll ? t("lanPairingShowPending") : t("lanPairingShowAll")}
          </Button>
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
      </div>

      <Card>
        <CardContent className="p-4 flex items-start gap-3 bg-amber-50 border-l-4 border-amber-400">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
          <div className="text-sm">
            <div className="font-medium text-amber-900">{t("lanPairingVerifyHostnameTitle")}</div>
            <div className="text-amber-800">{t("lanPairingVerifyHostnameBody")}</div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-3 text-sm text-destructive" data-testid="error-banner">
            {t("error")}: {error}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-center text-muted-foreground">{t("loading")}…</div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground" data-testid="empty-inbox">
              {showAll ? t("lanPairingHistoryEmpty") : t("lanPairingInboxEmpty")}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase">
                <tr>
                  <th className="text-start p-3">{t("lanPairingColRequester")}</th>
                  <th className="text-start p-3">{t("lanPairingColRole")}</th>
                  <th className="text-start p-3">{t("lanPairingColKeyFp")}</th>
                  <th className="text-start p-3">{t("lanPairingColStatus")}</th>
                  <th className="text-start p-3">{t("lanPairingColCreated")}</th>
                  <th className="text-end p-3">{t("lanPairingColActions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top" data-testid={`row-request-${r.id}`}>
                    <td className="p-3">
                      <div className="font-medium">{r.requester_hostname}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.requester_address || "—"}
                        {r.requester_app_version ? ` · v${r.requester_app_version}` : ""}
                      </div>
                    </td>
                    <td className="p-3">
                      <Badge variant="secondary">{r.requester_role}</Badge>
                    </td>
                    <td className="p-3">
                      {r.requester_sign_pub_key ? (
                        <code
                          className="text-xs font-mono text-muted-foreground"
                          title={t("lanPairingKeyFpTitle")}
                          data-testid={`key-fp-${r.id}`}
                        >
                          {r.requester_sign_pub_key.slice(0, 16)}…
                        </code>
                      ) : (
                        <span className="text-xs text-destructive">{t("lanPairingKeyFpMissing")}</span>
                      )}
                    </td>
                    <td className="p-3">
                      <Badge variant={statusVariant(r.status)} data-testid={`status-${r.id}`}>
                        {r.status}
                      </Badge>
                      {r.approval_error && (
                        <div className="text-xs text-destructive mt-1">
                          {r.approval_error.slice(0, 200)}
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground">{fmtTime(r.created_at)}</td>
                    <td className="p-3">
                      {r.status === "pending" ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="default"
                            size="sm"
                            disabled={busyId === r.id}
                            onClick={() => approve(r.id, r.requester_hostname)}
                            data-testid={`button-approve-${r.id}`}
                          >
                            <Check className="h-4 w-4 me-1" />
                            {t("approve")}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busyId === r.id}
                            onClick={() => deny(r.id)}
                            data-testid={`button-deny-${r.id}`}
                          >
                            <Ban className="h-4 w-4 me-1" />
                            {t("deny")}
                          </Button>
                        </div>
                      ) : r.status === "delivered" ? (
                        <div className="flex justify-end items-center text-emerald-600 text-xs">
                          <ShieldCheck className="h-4 w-4 me-1" />
                          {t("lanPairingDelivered")}
                        </div>
                      ) : null}
                    </td>
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
