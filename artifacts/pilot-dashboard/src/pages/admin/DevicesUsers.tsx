// DevicesUsers — super-admin view of every bound member + device.
// Allows squadron-list edits and member removal. Task #299.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAllDevices, listSquadronsForJoin, updateMemberSquadrons, removeMember,
  type UnitDeviceListRow, type UnitSquadron,
} from "../../lib/unit-join";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { useI18n } from "@/lib/i18n";

export default function DevicesUsers() {
  const { t } = useI18n();
  const lanMode = isLanSessionLoginEnabled();
  const [rows, setRows] = useState<UnitDeviceListRow[]>([]);
  const [squadrons, setSquadrons] = useState<UnitSquadron[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState<"all" | "active" | "removed">("active");
  const [removeTarget, setRemoveTarget] = useState<UnitDeviceListRow | null>(null);
  const [removeReason, setRemoveReason] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    const list = await listAllDevices();
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
  }, [lanMode, reload]);

  if (lanMode) {
    return (
      <div className="space-y-4 p-4">
        <div>
          <h1 className="text-xl font-semibold">Devices & Users</h1>
          <p className="text-xs text-slate-400">
            {t("devicesUsersLanDisabledTitle")}
          </p>
        </div>
        <div className="rounded-lg border border-sky-700/40 bg-sky-900/20 p-4 text-sm text-sky-100">
          {t("devicesUsersLanDisabledBody")}
        </div>
      </div>
    );
  }

  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const startEdit = (r: UnitDeviceListRow) => {
    setEdits((cur) => ({ ...cur, [r.member_id]: [...r.squadron_allow_list] }));
  };
  const cancelEdit = (memberId: string) => {
    setEdits((cur) => {
      const next = { ...cur };
      delete next[memberId];
      return next;
    });
  };
  const toggleEdit = (memberId: string, name: string) => {
    setEdits((cur) => {
      const list = cur[memberId] ?? [];
      const next = list.includes(name) ? list.filter((x) => x !== name) : [...list, name];
      return { ...cur, [memberId]: next };
    });
  };
  const saveEdit = async (r: UnitDeviceListRow) => {
    const next = edits[r.member_id] ?? [];
    if (next.length === 0) { setError("Pick at least one squadron."); return; }
    setBusyId(r.member_id);
    const ok = await updateMemberSquadrons(r.member_id, next);
    setBusyId(null);
    if (!ok) { setError("Save failed."); return; }
    cancelEdit(r.member_id);
    await reload();
  };

  const requestRemove = (r: UnitDeviceListRow) => {
    setRemoveTarget(r);
    setRemoveReason("");
  };
  const confirmRemove = async () => {
    if (!removeTarget) return;
    const reason = removeReason.trim();
    if (!reason) {
      setError("Removal reason is required.");
      return;
    }
    const r = removeTarget;
    setBusyId(r.member_id);
    const res = await removeMember(r.member_id, reason);
    setBusyId(null);
    if (!res.ok) {
      const detailText =
        typeof res.detail === "string"
          ? res.detail
          : (res.detail && typeof res.detail === "object" && "message" in res.detail
              ? String((res.detail as { message?: unknown }).message ?? "")
              : "");
      setError(`Remove failed: ${res.error}${detailText ? ` (${detailText})` : ""}`);
      return;
    }
    setRemoveTarget(null);
    setRemoveReason("");
    await reload();
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Devices & Users</h1>
          <p className="text-xs text-slate-400">
            Every approved laptop and the user it's bound to. Edit
            squadron lists or remove a member to revoke their access on
            the next session refresh.
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          {(["active", "removed", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                "rounded px-3 py-1 " +
                (filter === f
                  ? "bg-amber-500 text-slate-900 font-semibold"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700")
              }
            >{f}</button>
          ))}
        </div>
      </div>

      {error && <div className="rounded border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-200">{error}</div>}
      {removeTarget && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 space-y-3">
          <div className="text-sm text-amber-200">
            Remove <span className="font-semibold">{removeTarget.display_name}</span> ({removeTarget.username})?
          </div>
          <label className="block space-y-1">
            <span className="text-xs text-slate-300">Reason (required for audit log)</span>
            <input
              type="text"
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              placeholder="e.g. duplicate request / left unit"
              className="w-full rounded border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setRemoveTarget(null); setRemoveReason(""); }}
              className="rounded border border-slate-600 px-2 py-1 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busyId === removeTarget.member_id}
              onClick={() => void confirmRemove()}
              className="rounded bg-rose-500 px-2 py-1 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-50"
            >
              Confirm remove
            </button>
          </div>
        </div>
      )}

      {loading && <div className="text-sm text-slate-400">Loading…</div>}
      {!loading && filtered.length === 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-400">
          No members in this view.
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/60 text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Role / tier</th>
              <th className="px-3 py-2 text-left">Squadrons</th>
              <th className="px-3 py-2 text-left">Device</th>
              <th className="px-3 py-2 text-left">Approved</th>
              <th className="px-3 py-2 text-left">Last seen</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const editing = r.member_id in edits;
              const editList = edits[r.member_id] ?? [];
              return (
                <tr key={r.member_id} className="border-t border-slate-800 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.display_name}</div>
                    <div className="text-xs text-slate-400 font-mono">{r.username}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.role}</div>
                    <div className="text-xs text-slate-400">{r.tier}</div>
                  </td>
                  <td className="px-3 py-2">
                    {!editing && (
                      <div className="flex flex-wrap gap-1">
                        {r.squadron_allow_list.map((s) => (
                          <span key={s} className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">{s}</span>
                        ))}
                      </div>
                    )}
                    {editing && (
                      <div className="flex flex-wrap gap-1">
                        {squadrons.map((sq) => {
                          const active = editList.includes(sq.name);
                          return (
                            <button
                              key={sq.id}
                              type="button"
                              onClick={() => toggleEdit(r.member_id, sq.name)}
                              className={
                                "rounded-full px-2 py-0.5 text-[11px] border " +
                                (active
                                  ? "border-amber-500 bg-amber-500/15 text-amber-200"
                                  : "border-slate-700 text-slate-400 hover:border-slate-500")
                              }
                            >{sq.name}</button>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400 font-mono">
                    {r.fingerprint_short ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-300">
                    {r.approved_at ? new Date(r.approved_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-300">
                    {r.last_seen_at ? new Date(r.last_seen_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={
                      "rounded-full px-2 py-0.5 text-[11px] " +
                      (r.status === "active"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-slate-700/50 text-slate-300")
                    }>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1.5">
                      {!editing && r.status === "active" && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === r.member_id}
                            onClick={() => startEdit(r)}
                            className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
                          >Edit squadrons</button>
                          <button
                            type="button"
                            disabled={busyId === r.member_id}
                            onClick={() => requestRemove(r)}
                            className="rounded bg-rose-500/80 px-2 py-1 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
                          >Remove</button>
                        </>
                      )}
                      {editing && (
                        <>
                          <button
                            type="button"
                            disabled={busyId === r.member_id}
                            onClick={() => void saveEdit(r)}
                            className="rounded bg-emerald-500 px-2 py-1 text-xs font-semibold text-slate-900 hover:bg-emerald-400 disabled:opacity-50"
                          >Save</button>
                          <button
                            type="button"
                            onClick={() => cancelEdit(r.member_id)}
                            className="rounded border border-slate-600 px-2 py-1 text-xs"
                          >Cancel</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
