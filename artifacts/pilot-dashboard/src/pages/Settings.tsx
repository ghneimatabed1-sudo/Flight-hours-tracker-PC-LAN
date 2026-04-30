import { useState, useEffect, useCallback } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import {
  useAuth,
  getInactivityMinutes,
  setInactivityMinutes,
  INACTIVITY_OPTIONS,
  type InactivityMinutes,
} from "@/lib/auth";
import { useCurrencyWindow, DEFAULT_CURRENCY_WINDOW } from "@/lib/currency-settings";
import { usePilots, useAllLinkedDevices, useRevokePilotDevices } from "@/lib/squadron-data";
import { Smartphone, ShieldOff, Loader2, AlertTriangle, Eraser, ArrowRight, Sliders, Link2 } from "lucide-react";
import { useRegisteredPCs } from "@/lib/cross-pc";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "wouter";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";

function ReleaseLicenseButton({
  onConfirm,
  disabled = false,
}: {
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [secs, setSecs] = useState(10);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) return;
    setSecs(10);
    setTyped("");
    const id = setInterval(() => {
      setSecs(s => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [open]);

  const canConfirm = secs === 0 && typed.trim().toUpperCase() === "RELEASE";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        data-testid="button-release-license"
        className="px-3 py-1.5 rounded-md text-sm bg-destructive/20 text-destructive border border-destructive/40 hover:bg-destructive/30 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Release license
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="modal-release-license"
        >
          <div className="w-full max-w-md rounded-lg border border-destructive/60 bg-card shadow-2xl">
            <div className="flex items-start gap-3 p-4 border-b border-border">
              <AlertTriangle className="h-6 w-6 text-destructive shrink-0 mt-0.5" />
              <div>
                <div className="text-base font-semibold text-destructive">Release license — are you sure?</div>
                <div className="text-xs text-muted-foreground mt-1">
                  This frees the license slot for this PC. You will be signed out and sent
                  back to the License Activation screen, and you'll need a valid license key
                  (or a Super Admin sign-in) to get back in.
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-1.5">
                <div className="font-medium text-destructive">What this does NOT do:</div>
                <ul className="list-disc ms-4 space-y-0.5 text-foreground/90">
                  <li>It does <span className="font-semibold">not</span> delete pilots, sorties, or any cloud data.</li>
                  <li>It does <span className="font-semibold">not</span> revoke the key from the server.</li>
                </ul>
                <div className="font-medium text-destructive pt-1">What it DOES:</div>
                <ul className="list-disc ms-4 space-y-0.5 text-foreground/90">
                  <li>Clears this PC's stored credentials and license marker.</li>
                  <li>Forces a fresh activation on next launch.</li>
                </ul>
              </div>

              <div>
                <label className="text-xs text-muted-foreground">
                  Type <span className="font-mono font-semibold text-destructive">RELEASE</span> to confirm:
                </label>
                <input
                  value={typed}
                  onChange={e => setTyped(e.target.value)}
                  data-testid="input-release-confirm"
                  autoFocus
                  className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border font-mono text-sm uppercase tracking-wider"
                  placeholder="RELEASE"
                />
              </div>

              {secs > 0 && (
                <div className="text-[11px] text-amber-400 text-center">
                  Confirm button unlocks in <span className="font-mono font-semibold">{secs}s</span>…
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button
                onClick={() => setOpen(false)}
                data-testid="button-release-cancel"
                className="px-4 py-2 rounded-md text-sm bg-secondary border border-border hover:bg-secondary/80"
              >
                Cancel
              </button>
              <button
                onClick={() => { setOpen(false); onConfirm(); }}
                disabled={!canConfirm}
                data-testid="button-release-confirm"
                className="px-4 py-2 rounded-md text-sm font-semibold bg-destructive text-destructive-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {secs > 0 ? `Wait ${secs}s` : "Release license"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// "Reset this PC" — the nuclear option. Visible to every role (Ops,
// Sqn Cdr, Flight Cdr, Wing Cdr, Base, HQ Super Admin) so any operator
// who suspects this PC has a stuck/wrong registration can wipe it
// clean without waiting for a developer.
//
// What it does:
//   • DELETEs this PC's row from xpc_registry on Supabase
//   • DELETEs this PC's claim from xpc_user_pcs on Supabase
//   • Signs out from Supabase
//   • Clears every `rjaf.*` localStorage key on this device
//   • Hard reloads → next launch is exactly like a fresh install
//
// The actual implementation lives in auth.tsx (resetThisPC) so it has
// access to the supabase client and the auth state setters.
function ResetPcButton({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const lanMode = isLanSessionLoginEnabled();
  const [open, setOpen] = useState(false);
  const [secs, setSecs] = useState(5);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSecs(5);
    setTyped("");
    setWorking(false);
    const id = setInterval(() => {
      setSecs(s => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [open]);

  const canConfirm = !working && secs === 0 && typed.trim().toUpperCase() === "RESET";

  const myPcId = (() => {
    try { return localStorage.getItem("rjaf.xpc.localId") ?? ""; } catch { return ""; }
  })();
  const myDeviceLabel = (() => {
    try { return localStorage.getItem("rjaf.pcDeviceName") ?? ""; } catch { return ""; }
  })();

  const handleConfirm = async () => {
    setWorking(true);
    try { await onConfirm(); } finally {
      // resetThisPC reloads the page, so this normally never runs;
      // keep it defensive in case the reload is blocked.
      setWorking(false);
      setOpen(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="button-reset-pc"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-destructive/20 text-destructive border border-destructive/40 hover:bg-destructive/30"
      >
        <Eraser className="h-3.5 w-3.5" />
        Reset this PC
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="modal-reset-pc"
        >
          <div className="w-full max-w-md rounded-lg border border-destructive/60 bg-card shadow-2xl">
            <div className="flex items-start gap-3 p-4 border-b border-border">
              <AlertTriangle className="h-6 w-6 text-destructive shrink-0 mt-0.5" />
              <div>
                <div className="text-base font-semibold text-destructive">Reset this PC — are you sure?</div>
                <div className="text-xs text-muted-foreground mt-1">
                  This is the nuclear option. After confirmation this PC will be
                  indistinguishable from a brand-new install — and the central
                  {lanMode ? "LAN server registration" : "cloud registration"} for this device ID will be deleted.
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1.5">
                <div className="font-medium text-amber-300">This PC's identity (will be deleted):</div>
                <div className="font-mono text-[11px] break-all text-foreground/90">
                  {myPcId || <span className="italic text-muted-foreground">(no PC id registered yet)</span>}
                </div>
                {myDeviceLabel && (
                  <div className="text-[11px] text-foreground/70">Label: {myDeviceLabel}</div>
                )}
              </div>

              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-1.5">
                <div className="font-medium text-destructive">
                  {lanMode ? "What gets deleted on the LAN server:" : "What gets deleted on the cloud backend:"}
                </div>
                <ul className="list-disc ms-4 space-y-0.5 text-foreground/90">
                  <li>This PC's row in <span className="font-mono">xpc_registry</span> (other PCs stop seeing it).</li>
                  <li>This PC's claim in <span className="font-mono">xpc_user_pcs</span>.</li>
                </ul>
                <div className="font-medium text-destructive pt-1">What gets wiped locally:</div>
                <ul className="list-disc ms-4 space-y-0.5 text-foreground/90">
                  <li>License activation, signed-in user, squadron config.</li>
                  <li>PC id, device suffix, device label, role lock.</li>
                  <li>Every other Hawk Eye preference saved on this PC.</li>
                </ul>
                <div className="font-medium text-emerald-300 pt-1">What is NOT touched:</div>
                <ul className="list-disc ms-4 space-y-0.5 text-foreground/90">
                  <li>Pilots, sorties, schedules, messages — none of the squadron's data.</li>
                  <li>Other PCs' registrations.</li>
                </ul>
              </div>

              <div>
                <label className="text-xs text-muted-foreground">
                  Type <span className="font-mono font-semibold text-destructive">RESET</span> to confirm:
                </label>
                <input
                  value={typed}
                  onChange={e => setTyped(e.target.value)}
                  data-testid="input-reset-confirm"
                  autoFocus
                  className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border font-mono text-sm uppercase tracking-wider"
                  placeholder="RESET"
                />
              </div>

              {secs > 0 && (
                <div className="text-[11px] text-amber-400 text-center">
                  Confirm button unlocks in <span className="font-mono font-semibold">{secs}s</span>…
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button
                onClick={() => setOpen(false)}
                disabled={working}
                data-testid="button-reset-cancel"
                className="px-4 py-2 rounded-md text-sm bg-secondary border border-border hover:bg-secondary/80 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={!canConfirm}
                data-testid="button-reset-confirm"
                className="px-4 py-2 rounded-md text-sm font-semibold bg-destructive text-destructive-foreground disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
              >
                {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {working ? "Resetting…" : secs > 0 ? `Wait ${secs}s` : "Reset this PC"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// In-app auto-updater UI. The Electron main process already polls the
// public Releases repo at startup and downloads new builds in the
// background; this section just exposes a manual "Check now" button and
// surfaces real-time progress so the user can see what's happening
// instead of staring at a dead button. When the download finishes,
// "Restart & install" appears so they don't have to fully quit the app.
type UpdState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "none"; version?: string }
  | { kind: "progress"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

type ElectronBridge = {
  appVersion: () => Promise<string>;
  isPackaged?: () => Promise<boolean>;
  checkForUpdates?: () => Promise<{ ok: boolean; version?: string | null; reason?: string }>;
  installUpdateNow?: () => Promise<boolean>;
  setAutoUpdate?: (enabled: boolean) => Promise<boolean>;
  onUpdateEvent?: (cb: (e: UpdState) => void) => () => void;
};
function getBridge(): ElectronBridge | null {
  return (window as unknown as { rjafElectron?: ElectronBridge }).rjafElectron ?? null;
}

function fmtMB(bytes: number) { return (bytes / (1024 * 1024)).toFixed(1) + " MB"; }

// Per-role auto-update preference. Stored as `rjaf.autoUpdate.<role>` in
// localStorage so a commander on the same PC can disable silent updates
// (e.g. before a planning sortie) without affecting Ops. Default ON.
// The Electron main-process auto-updater reads this key on app launch
// AND on every "Check for updates" press to decide whether to silently
// install or only notify.
function autoUpdateKey(role: string | null | undefined): string {
  return `rjaf.autoUpdate.${role ?? "default"}`;
}
function readAutoUpdate(role: string | null | undefined): boolean {
  try {
    const v = localStorage.getItem(autoUpdateKey(role));
    return v === null ? true : v === "1";
  } catch { return true; }
}
function writeAutoUpdate(role: string | null | undefined, on: boolean) {
  try { localStorage.setItem(autoUpdateKey(role), on ? "1" : "0"); } catch { /* ignore */ }
}

function AutoUpdateSection() {
  const bridge = getBridge();
  const { user } = useAuth();
  const [version, setVersion] = useState<string>("");
  const [packaged, setPackaged] = useState<boolean>(false);
  const [state, setState] = useState<UpdState>({ kind: "idle" });
  const [autoOn, setAutoOn] = useState<boolean>(() => readAutoUpdate(user?.role));

  // Re-read whenever the role changes — switching accounts on the same
  // PC must surface that account's saved preference, not a stale one.
  useEffect(() => { setAutoOn(readAutoUpdate(user?.role)); }, [user?.role]);

  const toggleAuto = useCallback((next: boolean) => {
    setAutoOn(next);
    writeAutoUpdate(user?.role, next);
    // Push the new preference into the Electron main process so
    // autoUpdater.autoDownload / startup checks reflect it immediately.
    // No-op in browser/dev — the bridge is only present in packaged builds.
    void bridge?.setAutoUpdate?.(next);
  }, [user?.role, bridge]);

  useEffect(() => {
    if (!bridge) return;
    bridge.appVersion().then(setVersion).catch(() => {});
    bridge.isPackaged?.().then(p => setPackaged(!!p)).catch(() => {});
    // Sync the persisted preference to the main process on mount, so the
    // updater starts with the right `autoDownload` value (the renderer is
    // the source of truth — main only knows the default until we tell it).
    void bridge.setAutoUpdate?.(readAutoUpdate(user?.role));
    const off = bridge.onUpdateEvent?.((e) => setState(e));
    return () => { off?.(); };
  }, [bridge, user?.role]);

  const onCheck = useCallback(async () => {
    if (!bridge?.checkForUpdates) return;
    setState({ kind: "checking" });
    const r = await bridge.checkForUpdates();
    if (!r.ok && r.reason) setState({ kind: "error", message: r.reason });
  }, [bridge]);
  const onInstall = useCallback(async () => {
    await bridge?.installUpdateNow?.();
  }, [bridge]);

  const checking = state.kind === "checking";
  const downloading = state.kind === "progress";
  const ready = state.kind === "downloaded";

  const statusInline = (() => {
    if (state.kind === "available") return <span className="text-xs text-amber-400">v{state.version} found — starting download…</span>;
    if (state.kind === "none") return <span className="text-xs text-emerald-400">You're up to date.</span>;
    if (state.kind === "error") return <span className="text-xs text-destructive truncate max-w-[14rem]" title={state.message}>Error: {state.message}</span>;
    if (downloading) return <span className="text-xs text-muted-foreground">{state.percent.toFixed(0)}% · {fmtMB(state.transferred)}/{fmtMB(state.total)}</span>;
    if (ready) return <span className="text-xs text-emerald-400">v{state.version} ready</span>;
    return null;
  })();

  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold">Auto-Update</div>
      <p className="text-xs text-muted-foreground">
        When a new version is released, the desktop app updates itself silently. Currently on
        {" "}<span className="font-mono">v{version || "?"}</span>.
      </p>
      <label className="flex items-center gap-2 text-xs select-none">
        <input
          type="checkbox"
          checked={autoOn}
          onChange={e => toggleAuto(e.target.checked)}
          data-testid="toggle-auto-update"
        />
        <span>
          Install updates automatically
          {user?.role && <span className="text-muted-foreground"> (for {user.role})</span>}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onCheck}
          disabled={!bridge || !packaged || checking || downloading}
          className="px-3 py-1.5 rounded-md text-sm bg-secondary border border-border disabled:opacity-50 inline-flex items-center gap-2"
          data-testid="btn-check-updates"
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {checking ? "Checking…" : downloading ? "Downloading…" : "Check for updates"}
        </button>
        {ready && (
          <button
            onClick={onInstall}
            className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground"
            data-testid="btn-install-update"
          >
            Restart & install now
          </button>
        )}
        {statusInline}
      </div>
      {downloading && (
        <div className="h-1.5 w-full bg-secondary rounded overflow-hidden border border-border">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, state.percent)).toFixed(1)}%` }} />
        </div>
      )}
    </div>
  );
}

// Per-user inactivity auto-logout picker. Each operator who signs in on
// this PC has their own stored preference (keyed by user.id), so Ops can
// set 4 h while a commander keeps it at 30 m without stepping on each
// other. 0 = disabled. The auth provider reads this on login and arms
// the idle watcher.
function InactivityTimeoutSection() {
  const { user } = useAuth();
  const [mins, setMins] = useState<InactivityMinutes>(() => getInactivityMinutes(user?.id));
  const label = (m: InactivityMinutes) =>
    m === 0 ? "Off" : m < 60 ? `${m} min` : `${m / 60} h`;
  const onPick = (m: InactivityMinutes) => {
    setInactivityMinutes(user?.id, m);
    setMins(m);
  };
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold">Auto sign-out when idle</div>
      <p className="text-xs text-muted-foreground">
        If this PC is left untouched for the selected time, you'll be signed out
        automatically. Pick "Off" to stay signed in until you sign out manually.
        This setting is per-user.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {INACTIVITY_OPTIONS.map(m => {
          const active = mins === m;
          return (
            <button
              key={m}
              onClick={() => onPick(m)}
              data-testid={`inactivity-${m}`}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-secondary text-foreground border-border hover:bg-secondary/70"
              }`}
            >
              {label(m)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MobileDevicesCard() {
  const { user } = useAuth();
  const { rankOf } = useI18n();
  const pilotsQ = usePilots();
  const devicesQ = useAllLinkedDevices();
  const revoke = useRevokePilotDevices();
  const [manualId, setManualId] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The full device list lives inside a modal so the Settings page itself
  // stays compact. With 15+ paired phones the inline list used to push
  // every other Settings card off-screen and force a long scroll just to
  // reach Release License or the auto-updater toggle. Now Settings shows
  // a one-line summary + an "Open" button; the modal is full-height with
  // its own internal scroll.
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const pilotById = Object.fromEntries((pilotsQ.data ?? []).map(p => [p.id, p]));
  const devices = devicesQ.data ?? [];

  const doRevoke = async (pilotId: string) => {
    if (!window.confirm(`Revoke mobile access for pilot ${pilotById[pilotId]?.name || pilotId}? The phone will be locked out immediately.`)) return;
    setRevoking(pilotId);
    try {
      const res = await revoke.mutateAsync({ pilotId, actor: user?.username });
      if (res.revoked === 0) {
        setNotice(`No active mobile device found for ${pilotById[pilotId]?.name || pilotId} — nothing to revoke.`);
      } else {
        setNotice(`Revoked ${res.revoked} device(s) for ${pilotById[pilotId]?.name || pilotId}.`);
      }
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      // Supabase PostgrestError shape: { code, details, hint, message }.
      // Plain Error has .message. Anything else gets JSON-stringified (so
      // the user sees the real reason instead of "[object Object]").
      const err = e as { code?: string; message?: string; hint?: string };
      const code = err?.code;
      const msg = err?.message ?? (e instanceof Error ? e.message : null) ?? (() => {
        try { return JSON.stringify(e); } catch { return String(e); }
      })();
      let friendly = msg;
      if (code === "42501") {
        friendly = "Your session expired — sign out and sign back in, then try again. (If this keeps happening, re-activate the license from this PC.)";
      } else if (code === "PGRST116" || msg.includes("0 rows")) {
        friendly = "No matching device found for that pilot ID.";
      }
      setNotice(`Revoke failed: ${friendly}`);
    } finally {
      setRevoking(null);
    }
  };

  const doManualRevoke = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = manualId.trim();
    if (!id) return;
    await doRevoke(id);
    setManualId("");
  };

  const fmtDate = (iso: string) => {
    try { const d = new Date(iso); return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`; }
    catch { return iso; }
  };

  // Filter applied to the dialog list — by pilot id, name, or rank.
  const q = filter.trim().toLowerCase();
  const filteredDevices = q
    ? devices.filter(d => {
        const p = pilotById[d.pilotId];
        const hay = [d.pilotId, p?.name, p ? rankOf(p) : ""].join(" ").toLowerCase();
        return hay.includes(q);
      })
    : devices;

  return (
    <>
      {/* Compact summary card on Settings — no inline scroll-fest. */}
      <Card className="lg:col-span-2 space-y-3">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-primary" />
          <div className="text-sm font-semibold">Mobile Devices — Active Connections</div>
        </div>
        <p className="text-xs text-muted-foreground">
          All phones currently linked to this squadron's Hawk Eye mobile app. Open the full list to view
          every paired device and revoke access for any pilot — even one removed from the roster.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            {devicesQ.isLoading ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> <span className="text-muted-foreground">Loading…</span></>
            ) : (
              <>
                <span className="font-semibold tabular-nums">{devices.length}</span>
                <span className="text-muted-foreground">paired phone{devices.length === 1 ? "" : "s"}</span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-primary/15 text-primary border border-primary/40 hover:bg-primary/25"
            data-testid="button-open-mobile-devices"
          >
            View all <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
        {notice && !open && (
          <div className={`text-xs px-3 py-2 rounded-md border ${notice.startsWith("Revoke failed") ? "bg-destructive/10 text-rose-300 border-destructive/40" : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"}`}>
            {notice}
          </div>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-3xl w-[95vw] max-h-[85vh] flex flex-col gap-3"
          data-testid="dialog-mobile-devices"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-primary" />
              Mobile Devices
              <span className="ms-2 text-xs font-normal text-muted-foreground tabular-nums">
                {devices.length} paired
              </span>
            </DialogTitle>
          </DialogHeader>

          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search by pilot name, ID or rank…"
            className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
            data-testid="input-mobile-devices-filter"
          />

          <div className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border">
            {devicesQ.isLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading devices…
              </div>
            )}
            {!devicesQ.isLoading && devices.length === 0 && (
              <div className="text-xs text-muted-foreground p-4">No active mobile connections found.</div>
            )}
            {!devicesQ.isLoading && devices.length > 0 && filteredDevices.length === 0 && (
              <div className="text-xs text-muted-foreground p-4">No devices match "{filter}".</div>
            )}
            {filteredDevices.length > 0 && (
              <div className="divide-y divide-border">
                {filteredDevices.map(dev => {
                  const pilot = pilotById[dev.pilotId];
                  const isRevoking = revoking === dev.pilotId;
                  return (
                    <div key={dev.pilotId} className="flex items-center justify-between gap-3 px-3 py-2.5 bg-card">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {pilot ? `${rankOf(pilot)} ${pilot.name}` : <span className="text-amber-300">Pilot not in roster</span>}
                          <span className="ms-2 text-xs text-muted-foreground font-mono">({dev.pilotId})</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          Linked: {fmtDate(dev.linkedAt)} · Last seen: {fmtDate(dev.lastSeenAt)}
                        </div>
                      </div>
                      <button
                        onClick={() => doRevoke(dev.pilotId)}
                        disabled={isRevoking}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-destructive/15 text-rose-300 border border-destructive/40 hover:bg-destructive/25 disabled:opacity-50 shrink-0"
                        data-testid={`button-revoke-device-${dev.pilotId}`}
                      >
                        {isRevoking ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
                        Revoke
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Manual revoke for orphaned pilot IDs not in the device list yet */}
          <div className="pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground mb-1.5 font-semibold">
              Revoke by Pilot ID (for removed or unlisted pilots)
            </div>
            <form onSubmit={doManualRevoke} className="flex gap-2">
              <input
                value={manualId}
                onChange={e => setManualId(e.target.value)}
                placeholder="e.g. P001"
                className="flex-1 px-3 py-1.5 rounded-md bg-input border border-border text-sm font-mono"
                data-testid="input-manual-revoke-pilot-id"
              />
              <button
                type="submit"
                disabled={!manualId.trim() || revoke.isPending}
                className="px-3 py-1.5 rounded-md text-sm bg-destructive/15 text-rose-300 border border-destructive/40 hover:bg-destructive/25 disabled:opacity-50"
                data-testid="button-manual-revoke"
              >
                <ShieldOff className="h-3.5 w-3.5 inline me-1" />Revoke
              </button>
            </form>
          </div>

          {notice && (
            <div className={`text-xs px-3 py-2 rounded-md border ${notice.startsWith("Revoke failed") ? "bg-destructive/10 text-rose-300 border-destructive/40" : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"}`}>
              {notice}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Settings() {
  const { t, lang, setLang, rankOf } = useI18n();
  const { squadron, configureSquadron, fingerprint, releaseLicense, resetThisPC, user } = useAuth();
  const [name, setName] = useState(squadron?.name || "");
  const [num, setNum] = useState(squadron?.number || "");
  const [base, setBase] = useState(squadron?.base || "");
  const [saved, setSaved] = useState(false);
  const save = (e: React.FormEvent) => { e.preventDefault(); configureSquadron({ name, number: num, base }); setSaved(true); setTimeout(() => setSaved(false), 1500); };

  const [curWindow, setCurWindow] = useCurrencyWindow();
  const [curDay, setCurDay] = useState<string>(String(curWindow.day));
  const [curNight, setCurNight] = useState<string>(String(curWindow.night));
  const [curNvg, setCurNvg] = useState<string>(String(curWindow.nvg));
  const [curIrt, setCurIrt] = useState<string>(String(curWindow.instrument));
  const [curMed, setCurMed] = useState<string>(String(curWindow.medical));
  const [curSaved, setCurSaved] = useState(false);
  const lanMode = isLanSessionLoginEnabled();
  const parseOr = (raw: string, fallback: number) => {
    const v = parseInt(raw, 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const saveCurrencyWindow = (e: React.FormEvent) => {
    e.preventDefault();
    setCurWindow({
      day: parseOr(curDay, DEFAULT_CURRENCY_WINDOW.day),
      night: parseOr(curNight, DEFAULT_CURRENCY_WINDOW.night),
      nvg: parseOr(curNvg, DEFAULT_CURRENCY_WINDOW.nvg),
      instrument: parseOr(curIrt, DEFAULT_CURRENCY_WINDOW.instrument),
      medical: parseOr(curMed, DEFAULT_CURRENCY_WINDOW.medical),
    });
    setCurSaved(true);
    setTimeout(() => setCurSaved(false), 1500);
  };
  const resetCurrencyWindow = () => {
    setCurDay(String(DEFAULT_CURRENCY_WINDOW.day));
    setCurNight(String(DEFAULT_CURRENCY_WINDOW.night));
    setCurNvg(String(DEFAULT_CURRENCY_WINDOW.nvg));
    setCurIrt(String(DEFAULT_CURRENCY_WINDOW.instrument));
    setCurMed(String(DEFAULT_CURRENCY_WINDOW.medical));
    setCurWindow({ ...DEFAULT_CURRENCY_WINDOW });
    setCurSaved(true);
    setTimeout(() => setCurSaved(false), 1500);
  };

  return (
    <div>
      <PageHead
        title={t("nav_settings")}
        actions={
          <Link
            href="/diagnostic"
            data-testid="link-settings-diagnostic"
            className="text-xs px-2.5 py-1.5 rounded-md bg-secondary border border-border hover:bg-secondary/70 inline-flex items-center gap-1.5"
          >
            {lang === "ar" ? "أعتقد أن جهازي لا يتصل" : "I think my PC isn't connecting"}
          </Link>
        }
      />
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <form onSubmit={save} className="space-y-3">
            <div className="text-sm font-semibold">{t("setupTitle")}</div>
            <Field label={t("sqdnName")} value={name} onChange={setName} />
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("sqdnNumber")} value={num} onChange={setNum} />
              <Field label={t("base")} value={base} onChange={setBase} />
            </div>
            <button className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium">{t("save_changes")}</button>
            {saved && <span className="text-emerald-300 text-sm ml-2">✔ Saved</span>}
            <hr className="border-border my-3" />
            {/* Squadron-portability defaults (lectures, exercises, group name,
                group acronym, primary airframe, airframes list, sortie-log
                label, fuel-burn rates, ...) live on their own page so the
                editor can be wide. Surface a clear entry point here so the
                operator can find it from Settings instead of having to dig
                through Monthly Report → Defaults. */}
            <div className="text-sm font-semibold flex items-center gap-2">
              <Sliders className="h-4 w-4 text-primary" />
              {lang === "ar" ? "إعدادات السرب الافتراضية" : "Squadron Defaults"}
            </div>
            <p className="text-xs text-muted-foreground">
              {lang === "ar"
                ? "كل ما يتغير عند نقل التطبيق إلى سرب آخر: اسم المجموعة الأم، الاختصار (QRFG)، طائرات السرب، عنوان سجل الطلعات (QREG)، استهلاك الوقود، المحاضرات، التمارين، والمزيد. تنعكس هذه الإعدادات تلقائياً على التقرير الشهري، البرنامج، ونماذج الطلعات."
                : "Everything that changes when this install moves to another squadron: parent group name, acronym (QRFG), airframes, Sortie Log label (QREG), fuel-burn rates, lectures, exercises, and more. These flow automatically into Monthly Report, Flight Program, and the sortie forms."}
            </p>
            <Link href="/monthly-report/defaults"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-primary/15 text-primary border border-primary/40 hover:bg-primary/25"
              data-testid="link-open-squadron-defaults"
              onClick={(e) => e.stopPropagation()}
            >
              {lang === "ar" ? "فتح إعدادات السرب" : "Open Squadron Defaults"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </form>
        </Card>
        <Card className="space-y-3">
          <div className="text-sm font-semibold">{t("language")}</div>
          <div className="flex gap-2">
            <button onClick={()=>setLang("en")} className={`px-3 py-1.5 rounded-md text-sm ${lang==="en" ? "bg-primary text-primary-foreground" : "bg-secondary border border-border"}`}>{t("english")}</button>
            <button onClick={()=>setLang("ar")} className={`px-3 py-1.5 rounded-md text-sm ${lang==="ar" ? "bg-primary text-primary-foreground" : "bg-secondary border border-border"}`}>{t("arabic")}</button>
          </div>
          <hr className="border-border" />
          <div className="text-sm font-semibold">License & Hardware</div>
          <div className="text-xs text-muted-foreground">PC fingerprint (locked):</div>
          <div className="font-mono text-xs break-all bg-secondary p-2 rounded border border-border">{fingerprint}</div>
          <div className="flex flex-wrap items-center gap-2">
            <ReleaseLicenseButton onConfirm={releaseLicense} disabled={lanMode} />
            <ResetPcButton onConfirm={resetThisPC} />
          </div>
          {lanMode && (
            <p className="text-[11px] text-amber-300 -mt-1">
              License release is disabled in LAN session mode. Use Sign out to end this session.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground -mt-1">
            <span className="font-semibold">Reset this PC</span> wipes this device's
            registration on {lanMode ? "the LAN backend" : "the central server"} (xpc_registry + xpc_user_pcs) and clears
            every Hawk Eye setting saved locally — leaving the PC ready to set up from
            scratch. Other PCs and squadron data are not affected.
          </p>
          <hr className="border-border" />
          <InactivityTimeoutSection />
          <hr className="border-border" />
          <AutoUpdateSection />
        </Card>
        <Card className="lg:col-span-2 space-y-3">
          <form onSubmit={saveCurrencyWindow} className="space-y-3">
            <div className="text-sm font-semibold">{t("currencyWindowTitle")}</div>
            <p className="text-xs text-muted-foreground">{t("currencyWindowBlurb")}</p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 max-w-3xl">
              <label className="block">
                <span className="text-xs text-muted-foreground">{t("dayCurrencyDays")}</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={1}
                    max={1095}
                    value={curDay}
                    onChange={e => setCurDay(e.target.value)}
                    data-testid="input-currency-window-day"
                    className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{t("days")}</span>
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">{t("nightCurrencyDays")}</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={1}
                    max={1095}
                    value={curNight}
                    onChange={e => setCurNight(e.target.value)}
                    data-testid="input-currency-window-night"
                    className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{t("days")}</span>
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">{t("nvgCurrencyDays")}</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={1}
                    max={1095}
                    value={curNvg}
                    onChange={e => setCurNvg(e.target.value)}
                    data-testid="input-currency-window-nvg"
                    className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{t("days")}</span>
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">{t("instrumentCurrencyDays")}</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={1}
                    max={1095}
                    value={curIrt}
                    onChange={e => setCurIrt(e.target.value)}
                    data-testid="input-currency-window-instrument"
                    className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{t("days")}</span>
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">{t("medicalCurrencyDays")}</span>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={1}
                    max={1095}
                    value={curMed}
                    onChange={e => setCurMed(e.target.value)}
                    data-testid="input-currency-window-medical"
                    className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{t("days")}</span>
                </div>
              </label>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button type="submit" className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium text-sm" data-testid="button-save-currency-window">{t("save_changes")}</button>
              <button type="button" onClick={resetCurrencyWindow} className="px-4 py-2 rounded-md bg-secondary border border-border text-sm" data-testid="button-reset-currency-window">{t("resetDefaults")}</button>
              {curSaved && <span className="text-emerald-300 text-sm">✔</span>}
              <span className="text-[11px] text-muted-foreground ms-auto">
                {t("currentWindow")}:
                {" "}Day <span className="font-mono">{curWindow.day}d</span>
                {" · "}Night <span className="font-mono">{curWindow.night}d</span>
                {" · "}NVG <span className="font-mono">{curWindow.nvg}d</span>
                {" · "}IRT <span className="font-mono">{curWindow.instrument}d</span>
                {" · "}Med <span className="font-mono">{curWindow.medical}d</span>
              </span>
            </div>
          </form>
        </Card>
        {/* v1.1.43: Mobile Devices / Active Connections is an Ops-PC
            tool — pairing pilot phones to a squadron is the Ops officer's
            job, not the Squadron Commander's or Flight Commander's.
            Hide the whole card (including the manual revoke form) on
            commander-tier accounts so it never appears in the Sqn Cmdr
            or Flight Cmdr Settings page. */}
        {(user?.role === "ops" || user?.role === "deputy") && <MobileDevicesCard />}
        <ChainSetupSection />
        <Card className="lg:col-span-2 flex items-center gap-5">
          <img src="brand/wings.png" className="h-16 object-contain shrink-0 opacity-95" alt="Pilot Wings" />
          <div className="space-y-1.5 flex-1">
            <div className="text-sm font-semibold gold-grad">{t("creditsTitle")}</div>
            <div className="text-sm">{t("creditsDeveloper")}: <span className="font-semibold">Capt. ABEDALQADER GHUNMAT</span></div>
            <div className="text-sm">{t("creditsPhone")}: <button type="button" onClick={() => window.open("tel:+9620775008345", "_blank", "noopener")} className="text-primary hover:underline">0775008345</button></div>
            <div className="text-sm">{t("creditsEmail")}: <button type="button" onClick={() => window.open("mailto:ghneimatabed1@icloud.com", "_blank", "noopener")} className="text-primary hover:underline">ghneimatabed1@icloud.com</button></div>
            <p className="text-xs text-muted-foreground pt-1">{t("creditsBlurb")}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// v1.1.98 multi-squadron Chain Setup. Lets the operator pin the org-chart
// pointer for THIS PC: which Wing PC its Sqn talks up to (or which Base
// PC its Wing talks up to), and — for Flight PCs — which Squadron PC
// owns it. Without this pin, when the registry shows multiple wings or
// bases the forward dropdowns would list all of them and a wrong click
// would route to the wrong wing/base.
function ChainSetupSection() {
  const pcsQ = useRegisteredPCs();
  const { user } = useAuth();
  // Derive tier from authenticated user role/scope — mirrors the
  // computation used in ScheduleChain. Earlier draft read from
  // localStorage `rjaf.pcTier`, but no code writes that key, so the
  // panel never rendered. Using the same source as ScheduleChain
  // guarantees consistency between the warning banner and the picker.
  const myTier: "ops" | "flight" | "squadron" | "wing" | "base" | "" =
    !user ? ""
    : user.role === "ops" ? "ops"
    : user.scope === "flight" ? "flight"
    : user.scope === "wing" ? "wing"
    : user.scope === "base" ? "base"
    : "squadron";
  const myPcId = (() => {
    try { return localStorage.getItem("rjaf.xpc.localId") || ""; } catch { return ""; }
  })();
  const [parentPcId, setParentPcId] = useState<string>(() => {
    try { return localStorage.getItem("rjaf.parentPcId") || ""; } catch { return ""; }
  });
  const [squadronPcId, setSquadronPcId] = useState<string>(() => {
    try { return localStorage.getItem("rjaf.squadronPcId") || ""; } catch { return ""; }
  });
  const [savedNote, setSavedNote] = useState<string>("");

  // What tier should the parent PC be? Sqn → wing, Wing → base. Ops PCs
  // share their squadron's parent so they also pick a wing. Flight has
  // no upchain parent — it uses squadronPcId instead. Base has none.
  const parentTier: "wing" | "base" | null =
    myTier === "wing" ? "base" :
    (myTier === "squadron" || myTier === "ops") ? "wing" :
    null;

  const parentChoices = (pcsQ.data ?? []).filter(p => p.tier === parentTier && p.id !== myPcId);
  const squadronChoices = (pcsQ.data ?? []).filter(p => p.tier === "squadron" && p.id !== myPcId);

  const save = () => {
    try {
      if (parentPcId) localStorage.setItem("rjaf.parentPcId", parentPcId);
      else localStorage.removeItem("rjaf.parentPcId");
      if (myTier === "flight") {
        if (squadronPcId) localStorage.setItem("rjaf.squadronPcId", squadronPcId);
        else localStorage.removeItem("rjaf.squadronPcId");
      }
      setSavedNote("Saved. Heartbeat will publish the change within 30s.");
      setTimeout(() => setSavedNote(""), 4000);
    } catch {
      setSavedNote("Could not save (localStorage blocked).");
    }
  };

  // Base tier has no upchain parent and no squadron pointer — render
  // an explanatory note instead of an empty form.
  if (myTier === "base") {
    return (
      <Card className="lg:col-span-2 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Link2 className="h-4 w-4" /> Chain Setup
        </div>
        <p className="text-xs text-muted-foreground">
          This is a Base PC — it sits at the top of the chain. Nothing to pin here. Wings under this base
          should pin <span className="font-semibold">this PC</span> as their parent in their own Settings.
        </p>
        <div className="text-[11px] text-muted-foreground font-mono break-all">My PC id: {myPcId || "—"}</div>
      </Card>
    );
  }
  if (myTier === "" || parentTier === null && myTier !== "flight") {
    return null;
  }

  return (
    <Card className="lg:col-span-2 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Link2 className="h-4 w-4" /> Chain Setup
      </div>
      <p className="text-xs text-muted-foreground">
        Pin this PC's place in the multi-squadron org chart. As Hawk Eye scales beyond one squadron the
        registry starts listing PCs from other wings and bases too — pinning the parent here keeps every
        forward routed to the right destination, even when 15+ squadrons are online.
      </p>

      {parentTier && (
        <label className="block">
          <span className="text-xs text-muted-foreground">
            Parent {parentTier === "wing" ? "Wing PC (your squadron's wing commander)" : "Base PC (your wing's base commander)"}
          </span>
          <select
            value={parentPcId}
            onChange={e => setParentPcId(e.target.value)}
            className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
            data-testid="select-parent-pc"
          >
            <option value="">— not pinned (will list all visible {parentTier} PCs) —</option>
            {parentChoices.map(p => (
              <option key={p.id} value={p.id}>
                {p.deviceName ? `${p.deviceName} · ` : ""}{p.squadronName} ({p.id})
                {p.online ? " · online" : ""}
              </option>
            ))}
          </select>
          {parentChoices.length === 0 && (
            <div className="text-[11px] text-amber-300/80 mt-1">
              No {parentTier} PCs visible yet. Bring the {parentTier} PC online once and it will appear here.
            </div>
          )}
        </label>
      )}

      {myTier === "flight" && (
        <label className="block">
          <span className="text-xs text-muted-foreground">Owning Squadron PC (which squadron this flight reports to)</span>
          <select
            value={squadronPcId}
            onChange={e => setSquadronPcId(e.target.value)}
            className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
            data-testid="select-squadron-pc"
          >
            <option value="">— not pinned —</option>
            {squadronChoices.map(p => (
              <option key={p.id} value={p.id}>
                {p.deviceName ? `${p.deviceName} · ` : ""}{p.squadronName} ({p.id})
                {p.online ? " · online" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm"
          data-testid="button-save-chain-setup"
        >
          Save chain pins
        </button>
        {savedNote && <span className="text-xs text-muted-foreground">{savedNote}</span>}
      </div>
      <div className="text-[11px] text-muted-foreground font-mono break-all">My PC id: {myPcId || "—"}</div>
    </Card>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input value={value} onChange={e=>onChange(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" />
    </label>
  );
}
