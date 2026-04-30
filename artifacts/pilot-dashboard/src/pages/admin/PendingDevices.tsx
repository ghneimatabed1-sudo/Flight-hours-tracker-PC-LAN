// PendingDevices — super-admin view of every `device_request` with
// status='pending'. Approve / reject / ignore / squadron-override.
// Task #299.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listPendingRequests, listSquadronsForJoin, approveRequest,
  rejectRequest, ignoreRequest,
  type UnitPendingRequest, type UnitSquadron,
} from "../../lib/unit-join";
import { supabase } from "../../lib/supabase";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { useI18n } from "@/lib/i18n";

const POLL_INTERVAL_MS = 5000;

export default function PendingDevices() {
  const { t } = useI18n();
  const lanMode = isLanSessionLoginEnabled();
  const [rows, setRows] = useState<UnitPendingRequest[]>([]);
  const [squadrons, setSquadrons] = useState<UnitSquadron[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrideRows, setOverrideRows] = useState<Record<string, string[]>>({});

  const reload = useCallback(async () => {
    const list = await listPendingRequests();
    setRows(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (lanMode) {
      setLoading(false);
      setRows([]);
      setSquadrons([]);
      setError(null);
      return;
    }
    void reload();
    void listSquadronsForJoin().then(setSquadrons);

    // Poll fallback in case realtime drops.
    const t = window.setInterval(reload, POLL_INTERVAL_MS);

    // Realtime subscription on device_requests for instant refresh.
    let cleanup: (() => void) | null = null;
    const sb = supabase;
    if (sb) {
      const ch = sb
        .channel("device_requests:pending")
        .on("postgres_changes", { event: "*", schema: "public", table: "device_requests" }, () => {
          void reload();
        })
        .subscribe();
      cleanup = () => { void sb.removeChannel(ch); };
    }
    return () => {
      window.clearInterval(t);
      if (cleanup) cleanup();
    };
  }, [lanMode, reload]);

  const onApprove = async (req: UnitPendingRequest) => {
    setBusyId(req.id);
    setError(null);
    const override = overrideRows[req.id] ?? null;
    const r = await approveRequest(req.id, override);
    setBusyId(null);
    if (!r.ok) {
      const detail =
        typeof r.detail === "string"
          ? r.detail
          : r.detail && typeof r.detail === "object" && "detail" in (r.detail as Record<string, unknown>)
            ? String((r.detail as Record<string, unknown>).detail ?? "")
            : "";
      setError(`Approve failed: ${r.error}${detail ? ` (${detail})` : ""}`);
      return;
    }
    void reload();
  };

  const onReject = async (req: UnitPendingRequest) => {
    const reason = window.prompt("Reason for rejecting (will be visible to the joining laptop):") ?? "";
    setBusyId(req.id);
    setError(null);
    const ok = await rejectRequest(req.id, reason || "rejected");
    setBusyId(null);
    if (!ok) { setError("Reject failed."); return; }
    void reload();
  };

  const onIgnore = async (req: UnitPendingRequest) => {
    setBusyId(req.id);
    setError(null);
    const ok = await ignoreRequest(req.id);
    setBusyId(null);
    if (!ok) { setError("Ignore failed."); return; }
    void reload();
  };

  const toggleOverride = (req: UnitPendingRequest, name: string) => {
    setOverrideRows((cur) => {
      const list = cur[req.id] ?? [...req.requested_squadron_names];
      const next = list.includes(name) ? list.filter((x) => x !== name) : [...list, name];
      return { ...cur, [req.id]: next };
    });
  };

  const heading = useMemo(() => `${rows.length} pending`, [rows.length]);

  if (lanMode) {
    return (
      <div className="space-y-4 p-4">
        <div>
          <h1 className="text-xl font-semibold">Pending Devices</h1>
          <p className="text-xs text-slate-400">
            {t("pendingDevicesLanDisabledTitle")}
          </p>
        </div>
        <div className="rounded-lg border border-sky-700/40 bg-sky-900/20 p-4 text-sm text-sky-100">
          {t("pendingDevicesLanDisabledBody")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Pending Devices</h1>
          <p className="text-xs text-slate-400">
            Each row is a laptop waiting to join. Approving creates the
            user account and binds the device. Rejecting tells the
            joining laptop why.
          </p>
        </div>
        <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300">{heading}</span>
      </div>

      {error && <div className="rounded border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-200">{error}</div>}

      {loading && <div className="text-sm text-slate-400">Loading…</div>}
      {!loading && rows.length === 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-400">
          No pending requests.
        </div>
      )}

      <ul className="space-y-3">
        {rows.map((req) => {
          const override = overrideRows[req.id] ?? req.requested_squadron_names;
          return (
            <li key={req.id} className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{req.display_name} <span className="text-slate-500">·</span> <span className="font-mono text-xs text-slate-400">{req.username}</span></div>
                  <div className="mt-1 text-xs text-slate-400">
                    Role <span className="font-mono text-slate-300">{req.requested_role}</span>
                    {" · "}
                    submitted {new Date(req.submitted_at).toLocaleString()}
                    {req.originating_ip && <> · IP <span className="font-mono">{req.originating_ip}</span></>}
                    {req.originating_city && <> · <span className="text-slate-300">{req.originating_city}</span></>}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500 font-mono">
                    fp {req.fingerprint.slice(0, 16)}…
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={busyId === req.id}
                    onClick={() => onApprove(req)}
                    className="rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-emerald-400 disabled:opacity-50"
                  >Approve</button>
                  <button
                    type="button"
                    disabled={busyId === req.id}
                    onClick={() => onReject(req)}
                    className="rounded bg-rose-500/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                  >Reject</button>
                  <button
                    type="button"
                    disabled={busyId === req.id}
                    onClick={() => onIgnore(req)}
                    className="rounded border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >Ignore</button>
                </div>
              </div>

              <div className="rounded border border-slate-800 bg-slate-950/60 p-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Squadron(s) — click to override</div>
                <div className="flex flex-wrap gap-1.5">
                  {squadrons.map((sq) => {
                    const active = override.includes(sq.name);
                    return (
                      <button
                        key={sq.id}
                        type="button"
                        onClick={() => toggleOverride(req, sq.name)}
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] border transition " +
                          (active
                            ? "border-amber-500 bg-amber-500/15 text-amber-200"
                            : "border-slate-700 text-slate-400 hover:border-slate-500")
                        }
                      >
                        {sq.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
