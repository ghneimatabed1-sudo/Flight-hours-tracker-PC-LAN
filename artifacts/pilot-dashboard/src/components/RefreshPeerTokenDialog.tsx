// RefreshPeerTokenDialog — operator-facing prompt that shows up when
// the aggregator dashboard detects a peer squadron's token was rotated
// (the next health probe came back 401 with body `invalid_token` or
// `revoked_token`).
//
// Why no auto-rotation: rotating a peer token is a security gate, so
// the operator MUST paste the new bearer themselves. The dialog gives
// them a "Test" button that calls the new POST /api/aggregate/peers/
// :id/probe endpoint to verify the bearer works against the peer's
// /api/peer/healthz BEFORE the PATCH commits it. That way a typo
// surfaces immediately instead of being baked into the address book.
//
// We deliberately use a plain modal (same pattern as ConfirmDialog)
// rather than the Radix Dialog so the test in
// `tests/refresh-peer-token-dialog.test.ts` doesn't need the asset
// loader / radix focus-scope shims required by the peer-tokens-page
// test.

import { useState } from "react";
import {
  patchAggregatePeer,
  probeAggregatePeer,
  type PeerErrorKind,
} from "@/lib/internal-migration";
import { useI18n } from "@/lib/i18n";

export interface RefreshPeerTokenDialogProps {
  peerId: string;
  squadronName: string;
  /** Called after a successful PATCH so the parent can refetch health. */
  onSaved: () => void;
  onCancel: () => void;
}

type ProbeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "fail"; message: string };

function probeFailureMessage(
  t: (k: string) => string,
  errorKind: PeerErrorKind | undefined,
  rawError: string,
): string {
  switch (errorKind) {
    case "auth_revoked":
      return t("refreshPeerTokenStillRevoked");
    case "auth_invalid":
      return t("refreshPeerTokenStillInvalid");
    case "network_error":
      return t("refreshPeerTokenNetworkUnreachable");
    default:
      return rawError || t("refreshPeerTokenProbeFailed");
  }
}

export function RefreshPeerTokenDialog({
  peerId,
  squadronName,
  onSaved,
  onCancel,
}: RefreshPeerTokenDialogProps) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const trimmed = token.trim();
  const canTest = trimmed.length > 0 && probe.kind !== "running" && !saving;
  const canSave = trimmed.length > 0 && !saving;

  async function handleTest() {
    if (!canTest) return;
    setProbe({ kind: "running" });
    const result = await probeAggregatePeer(peerId, trimmed);
    if (result.ok) {
      setProbe({ kind: "ok" });
    } else {
      setProbe({
        kind: "fail",
        message: probeFailureMessage(t, result.error_kind, result.error),
      });
    }
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const result = await patchAggregatePeer(peerId, { token: trimmed });
    setSaving(false);
    if (result.ok) {
      onSaved();
      return;
    }
    setSaveError(result.error || t("refreshPeerTokenSaveFailed"));
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onCancel}
      data-testid="dialog-refresh-peer-token-overlay"
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("refreshPeerTokenTitle")}
        data-testid="dialog-refresh-peer-token"
      >
        <div className="p-4 border-b border-border">
          <div className="text-base font-semibold">
            {t("refreshPeerTokenTitle")}
          </div>
          <div
            className="text-xs text-muted-foreground mt-1"
            data-testid="text-refresh-peer-token-squadron"
          >
            {squadronName}
          </div>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            {t("refreshPeerTokenDescription")}
          </p>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("refreshPeerTokenLabel")}
            </span>
            <input
              type="text"
              autoFocus
              spellCheck={false}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                if (probe.kind !== "idle") setProbe({ kind: "idle" });
                if (saveError) setSaveError(null);
              }}
              className="mt-1 w-full font-mono text-xs px-2 py-2 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring"
              data-testid="input-refresh-peer-token"
              placeholder="phk_…"
            />
          </label>
          {probe.kind === "ok" && (
            <div
              className="text-emerald-500 text-xs flex items-center gap-1"
              data-testid="text-refresh-peer-token-ok"
            >
              <span aria-hidden>✓</span>
              <span>{t("refreshPeerTokenProbeOk")}</span>
            </div>
          )}
          {probe.kind === "fail" && (
            <div
              className="text-rose-500 text-xs"
              data-testid="text-refresh-peer-token-error"
            >
              {probe.message}
            </div>
          )}
          {saveError && (
            <div
              className="text-rose-500 text-xs"
              data-testid="text-refresh-peer-token-save-error"
            >
              {saveError}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onCancel}
            className="px-3 py-2 rounded-md bg-secondary border border-border text-sm"
            data-testid="button-refresh-peer-token-cancel"
          >
            {t("cancel")}
          </button>
          <button
            onClick={handleTest}
            disabled={!canTest}
            className="px-3 py-2 rounded-md border border-border text-sm disabled:opacity-50"
            data-testid="button-refresh-peer-token-test"
          >
            {probe.kind === "running" ? "…" : t("refreshPeerTokenTest")}
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            data-testid="button-refresh-peer-token-save"
          >
            {saving ? "…" : t("refreshPeerTokenSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RefreshPeerTokenDialog;
