// Peer Tokens — super-admin page for managing this hub's peer access
// tokens.
//
// Mirrors `pages/admin/Users.tsx` in shape: read straight from
// `GET /api/internal/peer-tokens`, issue with
// `POST /api/internal/peer-tokens` (the plain token comes back exactly
// once), revoke with `DELETE /api/internal/peer-tokens/:id`. The
// underlying CRUD is implemented by
// `routes/peer-tokens-internal.ts` and is gated to super_admin both
// client-side (here) and server-side.
//
// The page is the in-app twin of the host-side helpers
// `scripts/lan-host/first-time-setup.ps1` (which prints the FIRST peer
// token) and `scripts/lan-host/reset-peer-token.ps1` (which re-issues a
// new one without going through the dashboard). Operators who can't
// log in are pointed at the latter as a fallback.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import {
  fetchInternalPeerTokens,
  postInternalPeerTokenCreate,
  deleteInternalPeerToken,
  type InternalPeerTokenRow,
} from "@/lib/internal-migration";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  KeyRound,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Copy,
  AlertTriangle,
  Trash2,
} from "lucide-react";

type CreateDraft = {
  label: string;
  expires_at: string; // yyyy-mm-dd from <input type="date">
};

const EMPTY_CREATE: CreateDraft = { label: "", expires_at: "" };

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString();
  } catch {
    return String(iso);
  }
}

type RowStatus = "revoked" | "expired" | "active";

function rowStatus(row: InternalPeerTokenRow): RowStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) return "expired";
  }
  return "active";
}

export default function PeerTokens() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isSuperAdmin = user?.role === "super_admin";

  const [rows, setRows] = useState<InternalPeerTokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  // Once a token is issued, its plain text is shown a single time in a
  // dismissible banner. We keep it in state so that re-renders triggered
  // by the reload don't wipe it; only Close/Copy clears it.
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issuedLabel, setIssuedLabel] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<InternalPeerTokenRow | null>(
    null,
  );

  const reload = async () => {
    setLoading(true);
    setError(null);
    const r = await fetchInternalPeerTokens();
    if (r === null) {
      setError("Could not load peer tokens from the LAN api-server.");
      setRows([]);
    } else {
      setRows(r);
    }
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  const sortedRows = useMemo(() => {
    // Server already orders by issued_at desc; defensively re-sort so a
    // newly issued row that we splice in stays at the top.
    return [...rows].sort((a, b) => {
      const ta = Date.parse(a.issued_at);
      const tb = Date.parse(b.issued_at);
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return tb - ta;
    });
  }, [rows]);

  if (!isSuperAdmin) {
    return (
      <div className="space-y-4 max-w-3xl" data-testid="page-peer-tokens-forbidden">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {t("peerTokensTitle")}
          </h1>
        </header>
        <Card>
          <CardContent className="p-4 text-sm text-zinc-300">
            {t("peerTokensSuperAdminOnly")}
          </CardContent>
        </Card>
      </div>
    );
  }

  function openCreate() {
    setCreateDraft(EMPTY_CREATE);
    setCreateErr(null);
    setCreateOpen(true);
  }

  async function submitCreate() {
    setCreateErr(null);
    const label = createDraft.label.trim();
    if (label.length < 1) {
      setCreateErr("Label is required.");
      return;
    }
    if (label.length > 200) {
      setCreateErr("Label is too long.");
      return;
    }
    let expiresIso: string | null = null;
    const rawExpires = createDraft.expires_at.trim();
    if (rawExpires) {
      // <input type="date"> hands us yyyy-mm-dd in the user's local
      // timezone. The server accepts any Date.parse-able string and
      // stores as `timestamptz`. Send midnight local time so the date
      // shown back matches what the user picked.
      const local = new Date(`${rawExpires}T00:00:00`);
      if (Number.isNaN(local.getTime())) {
        setCreateErr("Invalid expiry date.");
        return;
      }
      expiresIso = local.toISOString();
    }
    setCreateBusy(true);
    const res = await postInternalPeerTokenCreate({
      label,
      expires_at: expiresIso,
    });
    setCreateBusy(false);
    if (!res.ok) {
      setCreateErr(`Could not issue token: ${res.error}`);
      return;
    }
    setCreateOpen(false);
    setIssuedToken(res.token);
    setIssuedLabel(res.row.label ?? label);
    setCopyOk(false);
    // Optimistically prepend the row so the table reflects the new
    // entry immediately; reload will reconcile metadata.
    setRows((prev) => [res.row, ...prev]);
    void reload();
  }

  async function copyIssuedToken() {
    if (!issuedToken) return;
    try {
      await navigator.clipboard.writeText(issuedToken);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1500);
    } catch {
      // Browsers without Clipboard API permission — fall back to a
      // textarea-based copy so the token is still recoverable.
      const ta = document.createElement("textarea");
      ta.value = issuedToken;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopyOk(true);
        setTimeout(() => setCopyOk(false), 1500);
      } catch {
        /* ignore */
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setBusyId(revokeTarget.id);
    const res = await deleteInternalPeerToken(revokeTarget.id);
    setBusyId(null);
    if (!res.ok) {
      setError(`Could not revoke token: ${res.error}`);
      setRevokeTarget(null);
      return;
    }
    // Replace the row in place so the "revoked" badge shows up
    // immediately without waiting for the reload round-trip.
    setRows((prev) => prev.map((r) => (r.id === res.row.id ? res.row : r)));
    setRevokeTarget(null);
    void reload();
  }

  return (
    <div className="space-y-6 max-w-5xl" data-testid="page-peer-tokens">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {t("peerTokensTitle")}
          </h1>
          <p className="text-sm text-zinc-400 max-w-3xl">
            {t("peerTokensIntro")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reload()}
            data-testid="button-reload-peer-tokens"
          >
            <RefreshCw className="h-3.5 w-3.5 me-1" />
            {t("refresh")}
          </Button>
          <Button onClick={openCreate} size="sm" data-testid="button-issue-peer-token">
            <Plus className="h-3.5 w-3.5 me-1" />
            {t("peerTokensIssue")}
          </Button>
        </div>
      </header>

      {error && (
        <div
          className="rounded border border-red-700/40 bg-red-900/20 p-3 text-sm text-red-200"
          data-testid="peer-tokens-error"
        >
          {error}
        </div>
      )}

      {issuedToken && (
        <section
          className="rounded border border-emerald-700/40 bg-emerald-900/20 p-4 space-y-3"
          data-testid="peer-token-issued-banner"
        >
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-300 mt-0.5 shrink-0" />
            <div className="flex-1 space-y-1">
              <div className="text-sm font-medium text-emerald-100">
                {t("peerTokensIssuedBanner")}
              </div>
              {issuedLabel && (
                <div className="text-xs text-emerald-200/80">
                  {t("peerTokensColLabel")}: <span className="font-mono">{issuedLabel}</span>
                </div>
              )}
            </div>
          </div>
          <pre
            className="rounded border border-emerald-700/40 bg-emerald-950/60 p-2 text-[12px] font-mono text-emerald-100 overflow-x-auto select-all"
            data-testid="text-issued-peer-token"
          >
            {issuedToken}
          </pre>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={() => void copyIssuedToken()}
              data-testid="button-copy-peer-token"
            >
              <Copy className="h-3.5 w-3.5 me-1" />
              {t("peerTokensCopyToken")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setIssuedToken(null);
                setIssuedLabel(null);
                setCopyOk(false);
              }}
              data-testid="button-dismiss-peer-token"
            >
              {t("peerTokensClose")}
            </Button>
            {copyOk && (
              <span className="text-xs text-emerald-300" data-testid="text-peer-token-copied">
                {t("peerTokensCopied")}
              </span>
            )}
          </div>
        </section>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-zinc-400">{t("loading")}</div>
          ) : sortedRows.length === 0 ? (
            <div className="p-6 text-sm text-zinc-400" data-testid="peer-tokens-empty">
              {t("peerTokensNone")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-start text-xs text-zinc-400">
                  <tr className="border-b border-border">
                    <th className="text-start px-3 py-2">{t("peerTokensColLabel")}</th>
                    <th className="text-start px-3 py-2">{t("peerTokensColScope")}</th>
                    <th className="text-start px-3 py-2">{t("peerTokensColIssued")}</th>
                    <th className="text-start px-3 py-2">{t("peerTokensColExpires")}</th>
                    <th className="text-start px-3 py-2">{t("peerTokensColLastUsed")}</th>
                    <th className="text-start px-3 py-2">{t("peerTokensColStatus")}</th>
                    <th className="text-end px-3 py-2">{t("peerTokensColActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => {
                    const status = rowStatus(r);
                    return (
                      <tr
                        key={r.id}
                        className={
                          "border-b border-border/60 "
                          + (status !== "active" ? "opacity-60" : "")
                        }
                        data-testid={`row-peer-token-${r.id}`}
                      >
                        <td className="px-3 py-2 font-medium">
                          <div>{r.label ?? "—"}</div>
                          {r.issued_by && (
                            <div className="text-xs text-zinc-500">
                              {t("peerTokensIssuedBy")}:{" "}
                              <span className="font-mono">{r.issued_by}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{r.scope}</td>
                        <td className="px-3 py-2 text-xs text-zinc-400">
                          {fmtDateTime(r.issued_at)}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">
                          {fmtDate(r.expires_at)}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">
                          {fmtDateTime(r.last_used_at)}
                        </td>
                        <td className="px-3 py-2">
                          {status === "active" ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                              <ShieldCheck className="h-3.5 w-3.5" />
                              {t("peerTokensActive")}
                            </span>
                          ) : status === "expired" ? (
                            <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
                              <ShieldAlert className="h-3.5 w-3.5" />
                              {t("peerTokensExpired")}
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1 text-xs text-amber-300">
                                <ShieldAlert className="h-3.5 w-3.5" />
                                {t("peerTokensRevoked")}
                                {r.revoked_at && (
                                  <span className="text-zinc-500 ms-1">
                                    · {fmtDateTime(r.revoked_at)}
                                  </span>
                                )}
                              </span>
                              {r.revoked_by && (
                                <div className="text-xs text-zinc-500">
                                  {t("peerTokensRevokedBy")}:{" "}
                                  <span className="font-mono">{r.revoked_by}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1 flex-wrap">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === r.id || status !== "active"}
                              onClick={() => setRevokeTarget(r)}
                              data-testid={`button-revoke-peer-token-${r.id}`}
                            >
                              <Trash2 className="h-3 w-3 me-1" />
                              {t("peerTokensRevoke")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <section
        className="rounded border border-zinc-800 bg-zinc-900/40 p-4 space-y-2"
        data-testid="section-peer-tokens-host-fallback"
      >
        <h2 className="text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-300" />
          {t("peerTokensHostFallbackTitle")}
        </h2>
        <p className="text-xs text-zinc-400">
          {t("peerTokensHostFallbackBody")}
        </p>
        <pre
          className="rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-300 overflow-x-auto"
          data-testid="text-peer-token-script-path"
        >
{`PS C:\\hawk-eye> .\\scripts\\lan-host\\reset-peer-token.ps1 -Username "superadmin"`}
        </pre>
      </section>

      {/* Issue dialog ---------------------------------------------------- */}
      <Dialog open={createOpen} onOpenChange={(v) => !v && setCreateOpen(false)}>
        <DialogContent className="max-w-md" data-testid="dialog-issue-peer-token">
          <DialogHeader>
            <DialogTitle>{t("peerTokensIssue")}</DialogTitle>
            <DialogDescription>
              {t("peerTokensIssueDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="peer-token-label">{t("peerTokensFieldLabel")}</Label>
              <Input
                id="peer-token-label"
                value={createDraft.label}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, label: e.target.value }))
                }
                maxLength={200}
                placeholder="tigers-hub-pc"
                data-testid="input-peer-token-label"
              />
              <p className="text-xs text-zinc-500">{t("peerTokensFieldLabelHelp")}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="peer-token-expires">
                {t("peerTokensFieldExpires")}
              </Label>
              <Input
                id="peer-token-expires"
                type="date"
                value={createDraft.expires_at}
                onChange={(e) =>
                  setCreateDraft((d) => ({ ...d, expires_at: e.target.value }))
                }
                data-testid="input-peer-token-expires"
              />
              <p className="text-xs text-zinc-500">
                {t("peerTokensFieldExpiresHelp")}
              </p>
            </div>
            {createErr && (
              <div
                className="rounded border border-red-700/40 bg-red-900/20 p-2 text-xs text-red-200"
                data-testid="peer-token-create-error"
              >
                {createErr}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={createBusy}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              disabled={createBusy}
              data-testid="button-submit-issue-peer-token"
            >
              {createBusy ? t("saving") : t("peerTokensIssue")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm dialog ----------------------------------------- */}
      <Dialog
        open={!!revokeTarget}
        onOpenChange={(v) => !v && setRevokeTarget(null)}
      >
        <DialogContent className="max-w-md" data-testid="dialog-revoke-peer-token">
          <DialogHeader>
            <DialogTitle>{t("peerTokensRevokeTitle")}</DialogTitle>
            <DialogDescription>
              {t("peerTokensRevokeConfirm").replace(
                "{label}",
                revokeTarget?.label ?? "—",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={busyId === revokeTarget?.id}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void confirmRevoke()}
              disabled={busyId === revokeTarget?.id}
              data-testid="button-confirm-revoke-peer-token"
            >
              {busyId === revokeTarget?.id ? t("saving") : t("peerTokensRevoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
