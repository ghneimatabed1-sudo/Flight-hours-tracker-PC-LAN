// Adapter between the real ops-officer roster (squadron-data.usePilots())
// and the shape the Commander dashboard pages expect (types.Pilot).
//
// HISTORY (v1.0.45): Every Commander page — Overview, PilotsTable,
// Currencies, Alerts, PilotDetail, Simulator — imported the empty static
// `pilots` array from `mockData.ts`. Result: a commander signing in on
// the same PC the ops officer was using would see an empty roster, zero
// currencies, zero alerts — completely disconnected from reality. This
// module bridges the two shapes so commanders see the LIVE roster the
// ops officer just built.
//
// Real Pilot (squadron-data / mock.ts) uses `name`, `arabicName`,
// `expiry.{day,night,nvg,irt,medical}`, `monthDay/Night/Nvg`,
// `totalDay/Night/Nvg`. Dashboard Pilot (types.ts) uses `fullName`,
// `fullNameAr`, `dayCurrencyDate` etc. and a `squadronId` field that
// doesn't exist on the real type — this PC is bound to a single squadron
// so we stamp every pilot with the commander's authorized squadron ID.
//
// ROUND 3 O (audit J F-J-03/04, task #263): a wing / base / HQ commander,
// or a squadron-tier commander whose license authorizes more than one
// squadron, has NO local roster on their PC and must roll up across
// squadrons. We resolve their roster from `xpc_squadron_snapshot` (one
// row per squadron, published by the canonical Ops PC) instead of the
// local DB. Hours fields are absent in the snapshot payload — they
// default to 0 because the rollup view doesn't yet ship hours; the
// per-squadron drill-down still uses the dedicated snapshot card on
// PilotsTable, which renders the same data. The single-squadron ops
// commander path is unchanged.

import { useMemo } from "react";
import { useAuth } from "./auth";
import { usePilots, type Pilot as RealPilot } from "./squadron-data";
import { useSquadrons } from "./squadron-store";
import {
  useAllSquadronSnapshots,
  type SquadronSnapshotPilot,
  type SquadronSnapshotRow,
} from "./cross-pc";
import type { Pilot as DashPilot, Squadron } from "./types";

// Resolve which squadronId to stamp on every pilot for the signed-in
// commander. Priority:
//   1. The commander's first authorized squadron (from license / account).
//   2. The PC's bound squadron id (set at license activation).
//   3. "SQDN" — a stable sentinel used by the synthetic squadron fallback.
function resolveSquadronId(user: { squadronIds?: string[] } | null): string {
  const first = user?.squadronIds?.[0];
  if (first) return first;
  try {
    const bound = localStorage.getItem("rjaf.squadronId");
    if (bound) return bound;
  } catch { /* noop */ }
  return "SQDN";
}

// True when the signed-in user needs the snapshot rollup (cross-squadron
// commander) rather than the local-DB roster (single-squadron ops). Wing,
// base and HQ scope ALWAYS roll up. Squadron-scope commanders roll up
// only when their license authorizes more than one squadron — single
// squadron stays on the local DB so the ops officer + commander share
// the same source of truth on the squadron PC.
function needsSnapshotRollup(user: {
  role?: string;
  scope?: string;
  squadronIds?: string[];
} | null): boolean {
  if (!user || user.role !== "commander") return false;
  if (user.scope === "wing" || user.scope === "base" || user.scope === "hq") return true;
  const ids = user.squadronIds ?? [];
  return ids.length > 1;
}

export function adaptPilot(real: RealPilot, squadronId: string): DashPilot {
  const monthly =
    Number(real.monthDay ?? 0) +
    Number(real.monthNight ?? 0) +
    Number(real.monthNvg ?? 0);
  const grand =
    Number(real.totalDay ?? 0) +
    Number(real.totalNight ?? 0) +
    Number(real.totalNvg ?? 0);
  return {
    id: real.id,
    callSign: real.callSign ?? "",
    flightName: real.flightName,
    rank: real.rank ?? "",
    rankAr: real.rank ?? "",
    fullName: real.name ?? "",
    fullNameAr: real.arabicName || real.name || "",
    squadronId,
    monthlyHours: monthly,
    grandTotalHours: grand,
    nvgTotalHours: Number(real.totalNvg ?? 0),
    dayHours: Number(real.totalDay ?? 0),
    nightHours: Number(real.totalNight ?? 0),
    simHours: Number(real.totalSim ?? 0),
    captainHours: Number(real.totalCaptain ?? 0),
    instrumentHours: undefined,
    dayCurrencyDate: real.expiry?.day ?? "",
    // v1.1.69 — Night and NVG are fully independent currencies (per the
    // April 2026 rebuild). Each maps to its own expiry slot. The old
    // shortcut that aliased `nightCurrencyDate` to `expiry.nvg` was
    // surfacing NVG dates under a "Night" label on Pilot Detail and the
    // Alerts feed, exactly the bug reported by the field operator.
    nightCurrencyDate: real.expiry?.night ?? "",
    nvgCurrencyDate: real.expiry?.nvg ?? "",
    irtCurrencyDate: real.expiry?.irt ?? "",
    medicalCurrencyDate: real.expiry?.medical ?? "",
    qualifications: real.qualifications,
    lastSimDate: real.lastSimDate,
  };
}

// Snapshot → DashPilot adapter. The snapshot payload now carries the
// roster (callsign, name, flight, rank), the five expiry dates the
// commander rollup displays, AND the lifetime hour totals (Round 4
// AA3 / #268). Hour fields are optional in the snapshot payload —
// legacy snapshots published by pre-AA3 dashboards omit them, in which
// case we fall through to 0. Once the squadron's Ops PC publishes its
// next tick (~2 minutes after the new dashboard loads), commander
// rollups (PilotsTable, Currencies, Alerts) show real hours.
export function adaptSnapshotPilot(
  snap: SquadronSnapshotPilot,
  squadronId: string,
): DashPilot {
  // Coerce + finite-guard each hour field. `Number(null) === 0` but
  // `Number(undefined) === NaN` and a malformed legacy payload can
  // hand us non-numeric junk — the `?? 0` covers null/undefined and
  // `Number.isFinite` stops NaN/Infinity propagating into the rollup
  // arithmetic.
  const safe = (raw: unknown): number => {
    const n = Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const day = safe(snap.dayHours);
  const night = safe(snap.nightHours);
  const nvg = safe(snap.nvgHours);
  const sim = safe(snap.simHours);
  const captain = safe(snap.captainHours);
  return {
    id: snap.id,
    callSign: snap.callSign ?? "",
    flightName: snap.flightName ?? undefined,
    rank: snap.rank ?? "",
    rankAr: snap.rank ?? "",
    fullName: snap.name ?? "",
    fullNameAr: snap.name ?? "",
    squadronId,
    // monthlyHours is not carried in the snapshot payload (the publisher
    // would need to compute month-bounded sums per pilot, and the rollup
    // view does not yet surface monthly figures for cross-squadron
    // pilots). grandTotalHours is the sum of day+night+nvg, mirroring
    // adaptPilot above.
    monthlyHours: 0,
    grandTotalHours: day + night + nvg,
    nvgTotalHours: nvg,
    dayHours: day,
    nightHours: night,
    simHours: sim,
    captainHours: captain,
    instrumentHours: undefined,
    dayCurrencyDate: snap.expDay ?? "",
    nightCurrencyDate: snap.expNight ?? "",
    nvgCurrencyDate: snap.expNvg ?? "",
    irtCurrencyDate: snap.expIrt ?? "",
    medicalCurrencyDate: snap.expMedical ?? "",
    qualifications: undefined,
    lastSimDate: undefined,
  };
}

export function useDashPilots(): DashPilot[] {
  const { user } = useAuth();
  const rollup = needsSnapshotRollup(user);
  // Local DB roster for single-squadron ops commanders. The query is
  // always wired so the hooks order stays stable across renders, but
  // we ignore the result on the rollup path.
  const localQ = usePilots();
  const localRaw = localQ.data;
  const sqnId = resolveSquadronId(user);
  // Snapshot rollup for cross-squadron commanders. `enabled: false`
  // when the user is on the local-DB path so we don't burn quota.
  const snapQ = useAllSquadronSnapshots({ enabled: rollup });
  const snapRows = snapQ.data;
  const authorizedKey = (user?.squadronIds ?? []).join(",");
  return useMemo(() => {
    if (rollup) {
      const authorized = new Set(user?.squadronIds ?? []);
      const out: DashPilot[] = [];
      for (const row of snapRows) {
        // When the JWT carries an explicit squadron_ids allow-list the
        // RLS migration (0056) already filters server-side, but we
        // double-filter on the client to defend against legacy / wide
        // policies and to match the licensed scope exactly.
        if (authorized.size > 0 && !authorized.has(row.squadronId)) continue;
        for (const sp of row.payload.roster ?? []) {
          out.push(adaptSnapshotPilot(sp, row.squadronId));
        }
      }
      return out;
    }
    return localRaw.map(p => adaptPilot(p, sqnId));
  }, [rollup, snapRows, localRaw, sqnId, authorizedKey, user?.squadronIds]);
}

// Guarantees the commander's authorized squadron is always represented in
// the list — even when `rjaf.squadrons` hasn't been populated on this PC
// yet. Without this, `squadrons.filter(s => myIds.has(s.id))` comes back
// empty and the Overview page renders zero squadron cards.
//
// ROUND 3 O: for rollup commanders we ALSO pull squadron ids out of the
// snapshot rows so wing / base / HQ surfaces have a usable squadron
// list even when the local `rjaf.squadrons` mirror is empty (which it
// always is on a freshly-licensed wing PC). The squadron name falls
// back to the id when we don't have anything richer to show.
export function useDashSquadrons(): Squadron[] {
  const { user, squadron } = useAuth();
  const list = useSquadrons();
  const rollup = needsSnapshotRollup(user);
  const snapQ = useAllSquadronSnapshots({ enabled: rollup });
  const snapRows: SquadronSnapshotRow[] = snapQ.data;
  return useMemo(() => {
    const ids = user?.squadronIds ?? [];
    const out: Squadron[] = [...list];
    const ensure = (id: string) => {
      if (!id) return;
      if (out.some(s => s.id === id)) return;
      out.push({
        id,
        name: squadron?.name || id,
        nameAr: squadron?.name || id,
        code: id,
        base: squadron?.base || "",
        baseAr: squadron?.base || "",
        wing: "",
        wingAr: "",
        enabled: true,
        keyHolder: null,
      });
    };
    for (const id of ids) ensure(id);
    if (rollup) {
      const authorized = new Set(ids);
      for (const row of snapRows) {
        if (authorized.size > 0 && !authorized.has(row.squadronId)) continue;
        ensure(row.squadronId);
      }
    }
    return out;
  }, [list, user?.squadronIds, squadron?.name, squadron?.base, rollup, snapRows]);
}
