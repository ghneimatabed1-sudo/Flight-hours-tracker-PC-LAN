// Squadron Ops data layer.
//
// Every operational page reads through these React Query hooks instead of
// importing arrays from `mock.ts` directly. When VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY are set, hooks talk to the real Supabase project
// (and Row Level Security on `squadron_id` keeps each squadron in its own
// silo). When the env vars are missing — demo mode — hooks fall back to the
// seed data in `mock.ts` so the hosted preview keeps working without a
// backend.
//
// IMPORTANT: when Supabase IS configured but a query fails, hooks surface the
// error (no silent fallback to seed data). Downstream consumers — especially
// PDF exports — must treat an empty/errored result as "data unavailable", not
// as "no records exist". Substituting mock pilots/hours into an official
// authorization report would be unsafe.
//
// Mutations only attempt to write when Supabase is configured; in demo mode
// they no-op successfully so the existing UI keeps functioning.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { supabase, supabaseConfigured, recordAuditEvent } from "./supabase";
import {
  PILOTS as MOCK_PILOTS,
  SORTIES as MOCK_SORTIES,
  NOTAMS as MOCK_NOTAMS,
  DUTY_WEEK as MOCK_DUTY_WEEK,
  type Pilot,
  type Sortie,
} from "./mock";

export type { Pilot, Sortie } from "./mock";

export interface NotamRow { id: string; date: string; text: string; pk?: string; }
export interface DutyDay  { day: string; mainDuty: string; standby: string; rcm: string; }
export interface UnavailEntry { id: string; pilotId: string; from: string; to: string; reason: string; }
export interface ScheduleEntry { id: string; ac: string; config: string; crew: string[]; mission: string; takeoff: string; land: string; fuel: string; }
export interface LeaveRow { pilotId: string; months: number[]; total: number; }
export interface CurrencyRow { pilotId: string; task: string; status: "done" | "partial" | "missing"; }
export interface AppUser { id: string; username: string; role: "ops" | "deputy"; created: string; }

const isLive = () => supabaseConfigured && supabase !== null;

// ── pilots ──────────────────────────────────────────────────────────────
function rowToPilot(r: Record<string, unknown>): Pilot {
  const data = (r.data ?? {}) as Partial<Pilot>;
  return {
    id: String(r.id),
    callSign: data.callSign ? String(data.callSign) : undefined,
    flightName: data.flightName ? String(data.flightName) : undefined,
    name: String(r.name ?? data.name ?? ""),
    arabicName: String(r.arabic_name ?? data.arabicName ?? ""),
    militaryNumber: data.militaryNumber ? String(data.militaryNumber) : undefined,
    rank: String(r.rank ?? data.rank ?? ""),
    phone: String(r.phone ?? data.phone ?? ""),
    address: String(data.address ?? ""),
    unit: (r.unit as Pilot["unit"]) ?? data.unit ?? "SQDN",
    available: Boolean(r.available ?? data.available ?? true),
    openingDay: Number(data.openingDay ?? 0),
    openingNight: Number(data.openingNight ?? 0),
    openingNvg: Number(data.openingNvg ?? 0),
    doctorNote: data.doctorNote,
    monthDay: Number(data.monthDay ?? 0),
    monthNight: Number(data.monthNight ?? 0),
    monthNvg: Number(data.monthNvg ?? 0),
    monthSim: Number(data.monthSim ?? 0),
    monthCaptain: Number(data.monthCaptain ?? 0),
    totalDay: Number(data.totalDay ?? 0),
    totalNight: Number(data.totalNight ?? 0),
    totalNvg: Number(data.totalNvg ?? 0),
    totalSim: Number(data.totalSim ?? 0),
    totalCaptain: Number(data.totalCaptain ?? 0),
    expiry: data.expiry ?? { day: "", night: "", irt: "", medical: "", sim: "" },
    hiddenCurrencies: Array.isArray(data.hiddenCurrencies) ? data.hiddenCurrencies : undefined,
  };
}

let mockPilotsList: Pilot[] | null = null;
function getMockPilots(): Pilot[] {
  if (!mockPilotsList) mockPilotsList = [...MOCK_PILOTS];
  return mockPilotsList;
}

export function usePilots(): UseQueryResult<Pilot[]> & { data: Pilot[] } {
  const q = useQuery<Pilot[]>({
    queryKey: ["pilots"],
    queryFn: async () => {
      if (!isLive()) return [...getMockPilots()];
      const { data, error } = await supabase!.from("pilots").select("*").order("id");
      if (error) throw error;
      return (data ?? []).map(rowToPilot);
    },
    initialData: isLive() ? undefined : () => [...getMockPilots()],
    staleTime: 30_000,
    retry: isLive() ? 1 : false,
  });
  const fallback: Pilot[] = isLive() ? [] : getMockPilots();
  return { ...q, data: q.data ?? fallback } as UseQueryResult<Pilot[]> & { data: Pilot[] };
}

export function useUpdatePilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: Pilot) => {
      if (!isLive()) {
        const arr = getMockPilots();
        const idx = arr.findIndex(x => x.id === p.id);
        if (idx >= 0) arr[idx] = p;
        return p;
      }
      const { data, error } = await supabase!.from("pilots").update({
        name: p.name,
        arabic_name: p.arabicName,
        rank: p.rank,
        phone: p.phone,
        unit: p.unit,
        available: p.available,
        // Persist every Pilot field inside `data` so monthly/total hours and
        // other derived values aren't wiped on profile edits.
        data: {
          callSign: p.callSign,
          flightName: p.flightName,
          name: p.name,
          arabicName: p.arabicName,
          militaryNumber: p.militaryNumber,
          rank: p.rank,
          phone: p.phone,
          address: p.address,
          unit: p.unit,
          available: p.available,
          openingDay: p.openingDay,
          openingNight: p.openingNight,
          openingNvg: p.openingNvg,
          doctorNote: p.doctorNote,
          monthDay: p.monthDay,
          monthNight: p.monthNight,
          monthNvg: p.monthNvg,
          monthSim: p.monthSim,
          monthCaptain: p.monthCaptain,
          totalDay: p.totalDay,
          totalNight: p.totalNight,
          totalNvg: p.totalNvg,
          totalSim: p.totalSim,
          totalCaptain: p.totalCaptain,
          expiry: p.expiry,
          hiddenCurrencies: p.hiddenCurrencies,
          qualifications: p.qualifications,
          lastSimDate: p.lastSimDate,
        },
      }).eq("id", p.id).select().single();
      if (error) throw error;
      return rowToPilot(data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pilots"] }),
  });
}

export function useCreatePilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: Pilot) => {
      if (!isLive()) {
        const arr = getMockPilots();
        if (arr.some(x => x.id === p.id)) {
          throw new Error(`Pilot ID ${p.id} already exists`);
        }
        arr.unshift(p);
        return p;
      }
      const { data, error } = await supabase!.from("pilots").insert({
        id: p.id,
        name: p.name,
        arabic_name: p.arabicName,
        rank: p.rank,
        phone: p.phone,
        unit: p.unit,
        available: p.available,
        data: {
          callSign: p.callSign,
          flightName: p.flightName,
          name: p.name,
          arabicName: p.arabicName,
          militaryNumber: p.militaryNumber,
          rank: p.rank,
          phone: p.phone,
          address: p.address,
          unit: p.unit,
          available: p.available,
          openingDay: p.openingDay,
          openingNight: p.openingNight,
          openingNvg: p.openingNvg,
          doctorNote: p.doctorNote,
          monthDay: p.monthDay,
          monthNight: p.monthNight,
          monthNvg: p.monthNvg,
          monthSim: p.monthSim,
          monthCaptain: p.monthCaptain,
          totalDay: p.totalDay,
          totalNight: p.totalNight,
          totalNvg: p.totalNvg,
          totalSim: p.totalSim,
          totalCaptain: p.totalCaptain,
          expiry: p.expiry,
          hiddenCurrencies: p.hiddenCurrencies,
          qualifications: p.qualifications,
          lastSimDate: p.lastSimDate,
        },
      }).select().single();
      if (error) throw error;
      return rowToPilot(data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pilots"] }),
  });
}

export function useDeletePilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!isLive()) {
        const arr = getMockPilots();
        const idx = arr.findIndex(x => x.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        return { id };
      }
      const { error } = await supabase!.from("pilots").delete().eq("id", id);
      if (error) throw error;
      return { id };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pilots"] }),
  });
}

// ── sorties ─────────────────────────────────────────────────────────────
function rowToSortie(r: Record<string, unknown>): Sortie {
  const data = (r.data ?? {}) as Partial<Sortie>;
  return {
    id: String(r.id),
    date: String(r.date),
    acType: String(r.ac_type ?? data.acType ?? ""),
    acNumber: String(r.ac_number ?? data.acNumber ?? ""),
    pilotId: String(r.pilot_id ?? data.pilotId ?? ""),
    coPilotId: String(r.co_pilot_id ?? data.coPilotId ?? ""),
    pilotExternal: data.pilotExternal,
    coPilotExternal: data.coPilotExternal,
    sortieType: String(r.sortie_type ?? data.sortieType ?? ""),
    name: String(r.sortie_name ?? data.name ?? ""),
    day1: Number(data.day1 ?? 0),
    day2: Number(data.day2 ?? 0),
    dayDual: Number(data.dayDual ?? 0),
    night1: Number(data.night1 ?? 0),
    night2: Number(data.night2 ?? 0),
    nightDual: Number(data.nightDual ?? 0),
    nvg: Number(data.nvg ?? 0),
    nvg1: data.nvg1 != null ? Number(data.nvg1) : undefined,
    nvg2: data.nvg2 != null ? Number(data.nvg2) : undefined,
    nvgDual: data.nvgDual != null ? Number(data.nvgDual) : undefined,
    sim: Number(data.sim ?? 0),
    actual: Number(data.actual ?? 0),
    condition: data.condition,
    remarks: data.remarks,
    time: data.time != null ? Number(data.time) : undefined,
    dual: data.dual,
    pilotPosition: data.pilotPosition,
    coPilotPosition: data.coPilotPosition,
    pilotStatus: data.pilotStatus,
    coPilotStatus: data.coPilotStatus,
    pilotIsCaptain: data.pilotIsCaptain,
    coPilotIsCaptain: data.coPilotIsCaptain,
    msnDuty: data.msnDuty,
    instrumentFlight: data.instrumentFlight,
    ifSim: data.ifSim != null ? Number(data.ifSim) : undefined,
    ifAct: data.ifAct != null ? Number(data.ifAct) : undefined,
    ils: data.ils != null ? Number(data.ils) : undefined,
    vor: data.vor != null ? Number(data.vor) : undefined,
  };
}

// Derive the legacy day1/day2/night1/night2/dayDual/nightDual/nvg buckets
// from the new simple-mode inputs (single Time + condition + per-seat
// position + dual flag). Keeping the legacy fields populated means existing
// monthly reports, archives, and the mobile app totals work unchanged.
export function deriveSortieBuckets(input: {
  time: number;
  condition: "Day" | "Night" | "NVG";
  pilotPosition: "1st" | "2nd";
  dual: boolean;
}): {
  day1: number; day2: number; dayDual: number;
  night1: number; night2: number; nightDual: number;
  nvg: number; actual: number;
} {
  const t = Number.isFinite(input.time) ? Math.max(0, input.time) : 0;
  const out = { day1: 0, day2: 0, dayDual: 0, night1: 0, night2: 0, nightDual: 0, nvg: 0, actual: t };
  if (t <= 0) return out;
  if (input.condition === "Day") {
    if (input.dual) out.dayDual = t;
    else if (input.pilotPosition === "1st") out.day1 = t;
    else out.day2 = t;
  } else if (input.condition === "Night") {
    if (input.dual) out.nightDual = t;
    else if (input.pilotPosition === "1st") out.night1 = t;
    else out.night2 = t;
  } else {
    // NVG goes ONLY to the NVG bucket — NEVER also to night1/night2/nightDual.
    // This mirrors the old mobile rule and prevents NVG hours being
    // double-counted in pilot Night totals.
    out.nvg = t;
  }
  return out;
}

export function useSorties(): UseQueryResult<Sortie[]> & { data: Sortie[] } {
  const q = useQuery<Sortie[]>({
    queryKey: ["sorties"],
    queryFn: async () => {
      if (!isLive()) return MOCK_SORTIES;
      const { data, error } = await supabase!
        .from("sorties").select("*").order("date", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []).map(rowToSortie);
    },
    initialData: isLive() ? undefined : MOCK_SORTIES,
    staleTime: 30_000,
    retry: isLive() ? 1 : false,
  });
  const fallback: Sortie[] = isLive() ? [] : MOCK_SORTIES;
  return { ...q, data: q.data ?? fallback } as UseQueryResult<Sortie[]> & { data: Sortie[] };
}

// Currency auto-refresh: when a Day/Night/NVG sortie is logged, push the
// affected pilots' expiry dates forward to sortie-date + N days (default
// 60 per RJAF UH-60M SOP; ops officer can override per-squadron via
// Settings). Never moves an expiry backwards — if the pilot already has a
// later date on record (from a more recent sortie), we keep the later one.
// Applies to both P1 and P2. Day condition refreshes `day`; Night and NVG
// conditions refresh `night` (UH-60M night ops are flown on NVG, so they
// share a currency per squadron SOP).
import { getCurrencyWindow } from "./currency-settings";
function bumpDate(current: string, sortieDate: string, days: number): string {
  const d = new Date(sortieDate);
  if (isNaN(d.getTime())) return current;
  d.setDate(d.getDate() + days);
  const iso = d.toISOString().slice(0, 10);
  if (!current) return iso;
  return iso > current ? iso : current;
}

async function refreshCurrenciesForSortie(
  s: { date: string; pilotId: string; coPilotId: string; condition?: "Day" | "Night" | "NVG" },
  getPilot: (id: string) => Pilot | undefined,
  persist: (p: Pilot) => Promise<void>,
) {
  if (!s.condition) return;
  const w = getCurrencyWindow();
  const ids = [s.pilotId, s.coPilotId].filter(Boolean);
  for (const id of ids) {
    const p = getPilot(id);
    if (!p) continue;
    const next = { ...p.expiry };
    if (s.condition === "Day") {
      next.day = bumpDate(p.expiry.day, s.date, w.day);
    } else {
      // Night or NVG both credit the night/NVG currency window.
      next.night = bumpDate(p.expiry.night, s.date, w.nvg);
    }
    if (next.day === p.expiry.day && next.night === p.expiry.night) continue;
    await persist({ ...p, expiry: next });
  }
}

async function applyCurrencyRefresh(
  s: { date: string; pilotId: string; coPilotId: string; condition?: "Day" | "Night" | "NVG" },
  qc: ReturnType<typeof useQueryClient>,
) {
  if (!s.condition) return;
  if (!isLive()) {
    const arr = getMockPilots();
    await refreshCurrenciesForSortie(
      s,
      (id) => arr.find((x) => x.id === id),
      async (p) => {
        const idx = arr.findIndex((x) => x.id === p.id);
        if (idx >= 0) arr[idx] = p;
      },
    );
    return;
  }
  // Live mode: re-fetch pilots in cache, patch via update.
  const cached = qc.getQueryData<Pilot[]>(["pilots"]) ?? [];
  await refreshCurrenciesForSortie(
    s,
    (id) => cached.find((x) => x.id === id),
    async (p) => {
      const { error } = await supabase!.from("pilots").update({
        data: {
          callSign: p.callSign,
          flightName: p.flightName,
          name: p.name, arabicName: p.arabicName, rank: p.rank, phone: p.phone,
          address: p.address, unit: p.unit, available: p.available,
          openingDay: p.openingDay, openingNight: p.openingNight, openingNvg: p.openingNvg,
          doctorNote: p.doctorNote,
          monthDay: p.monthDay, monthNight: p.monthNight, monthNvg: p.monthNvg,
          monthSim: p.monthSim, monthCaptain: p.monthCaptain,
          totalDay: p.totalDay, totalNight: p.totalNight, totalNvg: p.totalNvg,
          totalSim: p.totalSim, totalCaptain: p.totalCaptain,
          expiry: p.expiry,
          hiddenCurrencies: p.hiddenCurrencies,
          qualifications: p.qualifications,
          lastSimDate: p.lastSimDate,
        },
      }).eq("id", p.id);
      if (error) throw error;
    },
  );
}

export function useCreateSortie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (s: Omit<Sortie, "id">) => {
      if (!isLive()) {
        const created = { ...s, id: "S" + Date.now() } as Sortie;
        MOCK_SORTIES.push(created);
        await applyCurrencyRefresh(s, qc);
        return created;
      }
      const { data, error } = await supabase!.from("sorties").insert({
        pilot_id: s.pilotId,
        co_pilot_id: s.coPilotId,
        date: s.date,
        ac_type: s.acType,
        ac_number: s.acNumber,
        sortie_type: s.sortieType,
        sortie_name: s.name,
        data: {
          day1: s.day1, day2: s.day2, dayDual: s.dayDual,
          night1: s.night1, night2: s.night2, nightDual: s.nightDual,
          nvg: s.nvg, sim: s.sim, actual: s.actual,
          condition: s.condition,
          remarks: s.remarks,
          pilotExternal: s.pilotExternal,
          coPilotExternal: s.coPilotExternal,
          time: s.time, dual: s.dual,
          pilotPosition: s.pilotPosition,
          coPilotPosition: s.coPilotPosition,
          pilotIsCaptain: s.pilotIsCaptain,
          coPilotIsCaptain: s.coPilotIsCaptain,
          msnDuty: s.msnDuty,
          instrumentFlight: s.instrumentFlight,
          ifSim: s.ifSim, ifAct: s.ifAct, ils: s.ils, vor: s.vor,
        },
      }).select().single();
      if (error) throw error;
      await applyCurrencyRefresh(s, qc);
      return rowToSortie(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["pilots"] });
    },
  });
}

// Update an existing sortie. Demo mode mutates the in-memory mock; live mode
// patches the Supabase row. Both paths emit a `sortie.update` audit event so
// commanders can trace who changed which entry.
export function useUpdateSortie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sortie: Sortie; actor?: string }) => {
      const s = input.sortie;
      if (!isLive()) {
        const idx = MOCK_SORTIES.findIndex(x => x.id === s.id);
        if (idx < 0) throw new Error("sortie_not_found");
        MOCK_SORTIES[idx] = s;
        await applyCurrencyRefresh(s, qc);
        appendDemoAudit({
          ts: tsNow(),
          user: input.actor ?? "ops.officer",
          action: "Sortie edit",
          target: `${s.id} · ${s.date} · ${s.acNumber}`,
        });
        return s;
      }
      const { error } = await supabase!.from("sorties").update({
        pilot_id: s.pilotId, co_pilot_id: s.coPilotId,
        date: s.date, ac_type: s.acType, ac_number: s.acNumber,
        sortie_type: s.sortieType, sortie_name: s.name,
        data: {
          day1: s.day1, day2: s.day2, dayDual: s.dayDual,
          night1: s.night1, night2: s.night2, nightDual: s.nightDual,
          nvg: s.nvg, sim: s.sim, actual: s.actual,
          condition: s.condition,
          remarks: s.remarks,
          pilotExternal: s.pilotExternal,
          coPilotExternal: s.coPilotExternal,
          time: s.time, dual: s.dual,
          pilotPosition: s.pilotPosition,
          coPilotPosition: s.coPilotPosition,
          pilotIsCaptain: s.pilotIsCaptain,
          coPilotIsCaptain: s.coPilotIsCaptain,
          msnDuty: s.msnDuty,
          instrumentFlight: s.instrumentFlight,
          ifSim: s.ifSim, ifAct: s.ifAct, ils: s.ils, vor: s.vor,
        },
      }).eq("id", s.id);
      if (error) throw error;
      await applyCurrencyRefresh(s, qc);
      await recordAuditEvent({
        type: "sortie.update",
        actor: input.actor,
        detail: { id: s.id, date: s.date, acNumber: s.acNumber },
      });
      return s;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["pilots"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// Delete a sortie. Mirror of useUpdateSortie — demo mode splices the mock,
// live mode issues a DELETE. Audit event records who deleted what.
export function useDeleteSortie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; actor?: string }) => {
      if (!isLive()) {
        const idx = MOCK_SORTIES.findIndex(x => x.id === input.id);
        if (idx < 0) throw new Error("sortie_not_found");
        const removed = MOCK_SORTIES.splice(idx, 1)[0];
        appendDemoAudit({
          ts: tsNow(),
          user: input.actor ?? "ops.officer",
          action: "Sortie delete",
          target: `${removed.id} · ${removed.date} · ${removed.acNumber}`,
        });
        return { id: input.id };
      }
      const { error } = await supabase!.from("sorties").delete().eq("id", input.id);
      if (error) throw error;
      await recordAuditEvent({
        type: "sortie.delete",
        actor: input.actor,
        detail: { id: input.id },
      });
      return { id: input.id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// ── notams ──────────────────────────────────────────────────────────────
let mockNotamsList: NotamRow[] | null = null;
function getMockNotams(): NotamRow[] {
  if (!mockNotamsList) mockNotamsList = [...MOCK_NOTAMS];
  return mockNotamsList;
}
export function useNotams(): UseQueryResult<NotamRow[]> & { data: NotamRow[] } {
  const q = useQuery<NotamRow[]>({
    queryKey: ["notams"],
    queryFn: async () => {
      if (!isLive()) return [...getMockNotams()];
      const { data, error } = await supabase!
        .from("notams").select("id, notam_no, posted_on, body")
        .order("posted_on", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(r => ({
        id: r.notam_no as string,
        pk: String(r.id),
        date: r.posted_on as string,
        text: r.body as string,
      }));
    },
    initialData: isLive() ? undefined : () => [...getMockNotams()],
    retry: isLive() ? 1 : false,
  });
  const fallback: NotamRow[] = isLive() ? [] : getMockNotams();
  return { ...q, data: q.data ?? fallback } as UseQueryResult<NotamRow[]> & { data: NotamRow[] };
}

export function useCreateNotam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const id = "N" + Date.now();
      const date = new Date().toISOString().slice(0, 10);
      if (!isLive()) {
        const row = { id, date, text };
        getMockNotams().unshift(row);
        return row;
      }
      const { error } = await supabase!.from("notams").insert({
        notam_no: id, posted_on: date, body: text,
      });
      if (error) throw error;
      return { id, date, text };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notams"] }),
  });
}

export function useUpdateNotam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (n: NotamRow) => {
      if (!isLive()) {
        const arr = getMockNotams();
        const idx = arr.findIndex(x => x.id === n.id);
        if (idx >= 0) arr[idx] = n;
        return n;
      }
      // Always update by primary key (uuid) — notam_no is a text label and
      // not guaranteed unique, so matching on it could mutate sibling rows.
      if (!n.pk) throw new Error("Missing NOTAM primary key");
      const { error } = await supabase!.from("notams").update({ body: n.text }).eq("id", n.pk);
      if (error) throw error;
      return n;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notams"] }),
  });
}

export function useDeleteNotam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (n: NotamRow) => {
      if (!isLive()) {
        const arr = getMockNotams();
        const idx = arr.findIndex(x => x.id === n.id);
        if (idx >= 0) arr.splice(idx, 1);
        return n;
      }
      if (!n.pk) throw new Error("Missing NOTAM primary key");
      const { error } = await supabase!.from("notams").delete().eq("id", n.pk);
      if (error) throw error;
      return n;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notams"] }),
  });
}

// ── duty week ───────────────────────────────────────────────────────────
export function useDutyWeek(): UseQueryResult<DutyDay[]> & { data: DutyDay[] } {
  const q = useQuery<DutyDay[]>({
    queryKey: ["duty_week"],
    queryFn: async () => {
      if (!isLive()) return MOCK_DUTY_WEEK;
      const { data, error } = await supabase!
        .from("duty_week").select("day, main_duty, standby, rcm")
        .order("effective_from", { ascending: false }).limit(7);
      if (error) throw error;
      return (data ?? []).map(r => ({
        day: r.day as string,
        mainDuty: (r.main_duty as string) ?? "",
        standby: (r.standby as string) ?? "",
        rcm: (r.rcm as string) ?? "",
      }));
    },
    initialData: isLive() ? undefined : MOCK_DUTY_WEEK,
    retry: isLive() ? 1 : false,
  });
  const fallback: DutyDay[] = isLive() ? [] : MOCK_DUTY_WEEK;
  return { ...q, data: q.data ?? fallback } as UseQueryResult<DutyDay[]> & { data: DutyDay[] };
}

// ── leaves (annual breakdown) ───────────────────────────────────────────
export function useLeaves(): UseQueryResult<LeaveRow[]> & { data: LeaveRow[] } {
  const q = useQuery<LeaveRow[]>({
    queryKey: ["leaves"],
    queryFn: async () => {
      if (!isLive()) return seedLeaves();
      const year = new Date().getFullYear();
      const { data, error } = await supabase!
        .from("leaves").select("pilot_id, months").eq("year", year);
      if (error) throw error;
      return (data ?? []).map(r => {
        const months = Array.from({ length: 12 }, (_, i) => Number((r.months as Record<string, number>)?.[String(i)] ?? 0));
        return { pilotId: r.pilot_id as string, months, total: months.reduce((a, b) => a + b, 0) };
      });
    },
    initialData: isLive() ? undefined : seedLeaves(),
    retry: isLive() ? 1 : false,
  });
  const fallback: LeaveRow[] = isLive() ? [] : seedLeaves();
  return { ...q, data: q.data ?? fallback } as UseQueryResult<LeaveRow[]> & { data: LeaveRow[] };
}

function seedLeaves(): LeaveRow[] {
  let s = 13;
  const r = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  return MOCK_PILOTS.map(p => {
    const months = Array.from({ length: 12 }, () => Math.floor(r() * 8));
    return { pilotId: p.id, months, total: months.reduce((a, b) => a + b, 0) };
  });
}

// ── unavailable entries ─────────────────────────────────────────────────
let mockUnavailList: UnavailEntry[] | null = null;
function getMockUnavail(): UnavailEntry[] {
  if (!mockUnavailList) mockUnavailList = seedUnavailable();
  return mockUnavailList;
}
export function useUnavailable(): UseQueryResult<UnavailEntry[]> & { data: UnavailEntry[] } {
  const q = useQuery<UnavailEntry[]>({
    queryKey: ["unavailable"],
    queryFn: async () => {
      if (!isLive()) return [...getMockUnavail()];
      const { data, error } = await supabase!
        .from("unavailable").select("id, pilot_id, from_date, to_date, reason")
        .order("from_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(r => ({
        id: String(r.id),
        pilotId: r.pilot_id as string,
        from: r.from_date as string,
        to: r.to_date as string,
        reason: (r.reason as string) ?? "—",
      }));
    },
    initialData: isLive() ? undefined : () => [...getMockUnavail()],
    retry: isLive() ? 1 : false,
  });
  const fallback: UnavailEntry[] = isLive() ? [] : getMockUnavail();
  return { ...q, data: q.data ?? fallback } as UseQueryResult<UnavailEntry[]> & { data: UnavailEntry[] };
}

function seedUnavailable(): UnavailEntry[] {
  return [
    { id: "u-1", pilotId: MOCK_PILOTS[2]?.id ?? "P003", from: "2026-04-15", to: "2026-04-22", reason: "Medical leave" },
    { id: "u-2", pilotId: MOCK_PILOTS[5]?.id ?? "P006", from: "2026-04-18", to: "2026-04-25", reason: "Course attendance" },
  ];
}

export function useCreateUnavailable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entry: Omit<UnavailEntry, "id">) => {
      const id = "u-" + Date.now();
      if (!isLive()) {
        const row = { ...entry, id };
        getMockUnavail().push(row);
        return row;
      }
      const { data, error } = await supabase!.from("unavailable").insert({
        pilot_id: entry.pilotId, from_date: entry.from, to_date: entry.to, reason: entry.reason,
      }).select().single();
      if (error) throw error;
      return {
        id: String(data.id),
        pilotId: data.pilot_id as string,
        from: data.from_date as string,
        to: data.to_date as string,
        reason: (data.reason as string) ?? "—",
      };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unavailable"] }),
  });
}

export function useDeleteUnavailable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!isLive()) {
        const arr = getMockUnavail();
        const idx = arr.findIndex(x => x.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        return { id };
      }
      const { error } = await supabase!.from("unavailable").delete().eq("id", id);
      if (error) throw error;
      return { id };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["unavailable"] }),
  });
}

// ── schedule ────────────────────────────────────────────────────────────
export function useSchedule(): UseQueryResult<ScheduleEntry[]> & { data: ScheduleEntry[] } {
  const q = useQuery<ScheduleEntry[]>({
    queryKey: ["schedule"],
    queryFn: async () => {
      if (!isLive()) return seedSchedule();
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase!
        .from("schedule").select("*").eq("flight_date", today).order("takeoff");
      if (error) throw error;
      return (data ?? []).map(r => ({
        id: String(r.id),
        ac: r.ac as string,
        config: (r.config as string) ?? "",
        crew: (r.crew as string[]) ?? [],
        mission: (r.mission as string) ?? "",
        takeoff: (r.takeoff as string) ?? "",
        land: (r.land as string) ?? "",
        fuel: (r.fuel as string) ?? "",
      }));
    },
    initialData: isLive() ? undefined : seedSchedule(),
    retry: isLive() ? 1 : false,
  });
  const fallback: ScheduleEntry[] = isLive() ? [] : seedSchedule();
  return { ...q, data: q.data ?? fallback } as UseQueryResult<ScheduleEntry[]> & { data: ScheduleEntry[] };
}

function seedSchedule(): ScheduleEntry[] {
  const p = MOCK_PILOTS;
  const crewName = (i: number) => `${p[i]?.rank ?? ""} ${p[i]?.name ?? ""}`.trim();
  return [
    { id: "sc-1", ac: "UH-60M #832", config: "External cargo", crew: [crewName(0), crewName(3)], mission: "NAV / EMER", takeoff: "0700", land: "1030", fuel: "2200 lbs" },
    { id: "sc-2", ac: "UH-60M #841", config: "MEDEVAC", crew: [crewName(1), crewName(4)], mission: "MSN DAY", takeoff: "0900", land: "1130", fuel: "1800 lbs" },
    { id: "sc-3", ac: "UH-60AIL #756", config: "Standard", crew: [crewName(2), crewName(5)], mission: "IF / MTF", takeoff: "1300", land: "1545", fuel: "2000 lbs" },
    { id: "sc-4", ac: "UH-60M #819", config: "NVG ready", crew: [crewName(6), crewName(7)], mission: "MSN NVG", takeoff: "1900", land: "2230", fuel: "2400 lbs" },
  ];
}

// ── currencies (6-month tasks) ──────────────────────────────────────────
export function useCurrencies(): UseQueryResult<CurrencyRow[]> & { data: CurrencyRow[] } {
  const q = useQuery<CurrencyRow[]>({
    queryKey: ["currencies"],
    queryFn: async () => {
      if (!isLive()) return [];
      const { data, error } = await supabase!
        .from("currencies").select("pilot_id, task, status");
      if (error) throw error;
      return (data ?? []).map(r => ({
        pilotId: r.pilot_id as string,
        task: r.task as string,
        status: r.status as CurrencyRow["status"],
      }));
    },
    initialData: [],
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<CurrencyRow[]> & { data: CurrencyRow[] };
}

// ── deputy users (squadron) ────────────────────────────────────────────
let mockUsersList: AppUser[] | null = null;
function getMockUsers(): AppUser[] {
  if (!mockUsersList) mockUsersList = seedUsers();
  return mockUsersList;
}
export function useSquadronUsers(): UseQueryResult<AppUser[]> & { data: AppUser[] } {
  const q = useQuery<AppUser[]>({
    queryKey: ["users"],
    queryFn: async () => {
      if (!isLive()) return [...getMockUsers()];
      const { data, error } = await supabase!
        .from("users").select("id, username, role, created_at")
        .in("role", ["ops", "deputy"]).order("created_at");
      if (error) throw error;
      return (data ?? []).map(r => ({
        id: String(r.id),
        username: r.username as string,
        role: r.role as AppUser["role"],
        created: String(r.created_at).slice(0, 10),
      }));
    },
    initialData: isLive() ? undefined : () => [...getMockUsers()],
    retry: isLive() ? 1 : false,
  });
  const fallback: AppUser[] = isLive() ? [] : getMockUsers();
  return { ...q, data: q.data ?? fallback } as UseQueryResult<AppUser[]> & { data: AppUser[] };
}

function seedUsers(): AppUser[] {
  return [
    { id: "1", username: "ops.lead", role: "ops", created: "2026-01-12" },
    { id: "2", username: "deputy.k", role: "deputy", created: "2026-02-04" },
  ];
}

// ── audit log ──────────────────────────────────────────────────────────
export interface AuditRow {
  ts: string;
  user: string;
  action: string;
  target: string;
}

const SEED_AUDIT: AuditRow[] = [
  { ts: "2026-04-17 08:14:32", user: "ops.lead", action: "Login", target: "—" },
  { ts: "2026-04-17 08:21:09", user: "ops.lead", action: "Add Sortie", target: "S10092" },
  { ts: "2026-04-17 09:02:11", user: "deputy.k", action: "Edit Pilot", target: "P003" },
  { ts: "2026-04-17 09:18:45", user: "ops.lead", action: "Mark Unavailable", target: "P006" },
  { ts: "2026-04-17 10:33:02", user: "ops.lead", action: "Publish NOTAM", target: "N0004" },
  { ts: "2026-04-17 11:01:55", user: "admin", action: "Reset Password", target: "deputy.k" },
];

export function useAuditLog(): UseQueryResult<AuditRow[]> & { data: AuditRow[] } {
  const q = useQuery<AuditRow[]>({
    queryKey: ["audit_log"],
    queryFn: async () => {
      if (!isLive()) return SEED_AUDIT;
      const { data, error } = await supabase!
        .from("audit_log")
        .select("occurred_at, actor, type, detail")
        .order("occurred_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []).map(r => ({
        ts: new Date(r.occurred_at as string).toISOString().replace("T", " ").slice(0, 19),
        user: (r.actor as string | null) ?? "system",
        action: r.type as string,
        target: typeof r.detail === "object" && r.detail
          ? Object.entries(r.detail as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join(" ")
          : "—",
      }));
    },
    initialData: isLive() ? undefined : SEED_AUDIT,
    retry: isLive() ? 1 : false,
  });
  const fallback: AuditRow[] = isLive() ? [] : SEED_AUDIT;
  return { ...q, data: q.data ?? fallback } as UseQueryResult<AuditRow[]> & { data: AuditRow[] };
}

export interface CreateSquadronUserInput {
  username: string;
  password: string;
}

export function useCreateSquadronUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | CreateSquadronUserInput) => {
      const username = typeof input === "string" ? input : input.username;
      const password = typeof input === "string" ? "changeme123" : input.password;
      const created = new Date().toISOString().slice(0, 10);
      if (!isLive()) {
        const row = { id: String(Date.now()), username, role: "deputy" as const, created };
        getMockUsers().push(row);
        return row;
      }
      // Provisioning a Supabase auth user requires the service role key, so
      // it must run server-side. The provision-user edge function creates
      // the auth user (with squadron_id stamped into app_metadata) and the
      // matching row in public.users in one transaction-like step.
      const { data, error } = await supabase!.functions.invoke("provision-user", {
        body: { username, password, role: "deputy" },
      });
      if (error) throw error;
      const payload = data as { ok?: boolean; error?: string; user?: { id: string } };
      if (!payload?.ok) throw new Error(payload?.error ?? "provision_failed");
      return {
        id: payload.user?.id ?? String(Date.now()),
        username,
        role: "deputy" as const,
        created,
      };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

// ── historical import (legacy SqDn App 21.10.16 CSV) ──────────────────
export interface ImportPayload {
  pilots: Pilot[];
  sorties: Sortie[];
  actor?: string;
}
export interface ImportResult {
  pilotsInserted: number;
  sortiesInserted: number;
  mode: "supabase" | "demo";
}

function tsNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function appendDemoAudit(row: AuditRow) {
  SEED_AUDIT.unshift(row);
}

// Persist the timestamp of the most recent successful import so the user
// can undo it with a single click. localStorage is fine here — undo only
// makes sense for the device that did the import in the first place.
const LAST_IMPORT_KEY = "rjaf.lastImportStamp";
export function getLastImportStamp(): string | null {
  try { return localStorage.getItem(LAST_IMPORT_KEY); } catch { return null; }
}
function setLastImportStamp(s: string | null) {
  try {
    if (s) localStorage.setItem(LAST_IMPORT_KEY, s);
    else localStorage.removeItem(LAST_IMPORT_KEY);
  } catch { /* ignore */ }
}

export function useImportHistory() {
  const qc = useQueryClient();
  return useMutation<ImportResult, Error, ImportPayload>({
    mutationFn: async ({ pilots, sorties, actor }) => {
      const stamp = new Date().toISOString();
      // Tag every imported record so later tooling can distinguish migrated
      // rows from rows entered through the UI.
      const taggedPilots = pilots.map(p => ({ ...p, imported: true, importedAt: stamp }));
      const taggedSorties = sorties.map(s => ({ ...s, imported: true, importedAt: stamp }));

      if (!isLive()) {
        // Demo mode: persist into the in-memory mock arrays so the rest of
        // the UI immediately reflects the imported data.
        for (const p of taggedPilots) {
          const idx = MOCK_PILOTS.findIndex(x => x.id === p.id);
          if (idx >= 0) MOCK_PILOTS[idx] = p; else MOCK_PILOTS.push(p);
        }
        for (const s of taggedSorties) {
          const idx = MOCK_SORTIES.findIndex(x => x.id === s.id);
          if (idx >= 0) MOCK_SORTIES[idx] = s; else MOCK_SORTIES.push(s);
        }
        appendDemoAudit({
          ts: tsNow(),
          user: actor ?? "ops.lead",
          action: "Historical Import (imported)",
          target: `${taggedPilots.length} pilots, ${taggedSorties.length} sorties`,
        });
        return { pilotsInserted: taggedPilots.length, sortiesInserted: taggedSorties.length, mode: "demo" as const };
      }

      // Live Supabase: bulk insert each table. PostgREST treats each .insert
      // array as a single statement, so the batch is atomic per table; if a
      // row violates a constraint the whole batch is rejected.
      const pilotRows = taggedPilots.map(p => ({
        id: p.id, name: p.name, arabic_name: p.arabicName, rank: p.rank,
        phone: p.phone, unit: p.unit, available: p.available,
        data: { ...p, imported: true, importedAt: stamp },
      }));
      const { error: pErr } = await supabase!.from("pilots").upsert(pilotRows, { onConflict: "id" });
      if (pErr) throw new Error(`Pilots import failed: ${pErr.message}`);

      const sortieRows = taggedSorties.map(s => ({
        id: s.id, pilot_id: s.pilotId, co_pilot_id: s.coPilotId,
        date: s.date, ac_type: s.acType, ac_number: s.acNumber,
        sortie_type: s.sortieType, sortie_name: s.name,
        data: { ...s, imported: true, importedAt: stamp },
      }));
      const { error: sErr } = await supabase!.from("sorties").upsert(sortieRows, { onConflict: "id" });
      if (sErr) throw new Error(`Sorties import failed: ${sErr.message}`);

      await recordAuditEvent({
        type: "import.history.ok",
        actor,
        detail: {
          imported: true,
          pilots: taggedPilots.length,
          sorties: taggedSorties.length,
        },
      });
      return { pilotsInserted: taggedPilots.length, sortiesInserted: taggedSorties.length, mode: "supabase" as const };
    },
    onSuccess: (_res, vars) => {
      // Re-derive the stamp the same way mutationFn did so undo targets
      // exactly the rows that were just inserted. We approximate "the moment
      // of this import" by reading back the importedAt of the first tagged
      // pilot/sortie — they all share the same stamp by construction.
      const stamp = vars.pilots[0]?.importedAt ?? vars.sorties[0]?.importedAt
        ?? new Date().toISOString();
      setLastImportStamp(stamp);
      qc.invalidateQueries({ queryKey: ["pilots"] });
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// Roll back the most recent CSV import by deleting every pilot and sortie
// whose importedAt matches the saved stamp. Records added or edited through
// the UI after the import remain untouched because they have a different
// importedAt (or none at all). If no stamp exists this is a no-op.
export interface UndoImportResult {
  pilotsRemoved: number;
  sortiesRemoved: number;
  mode: "supabase" | "demo";
}
export function useUndoLastImport() {
  const qc = useQueryClient();
  return useMutation<UndoImportResult, Error, { actor?: string } | void>({
    mutationFn: async (input) => {
      const actor = (input && "actor" in input) ? input.actor : undefined;
      const stamp = getLastImportStamp();
      if (!stamp) throw new Error("no_import_to_undo");

      if (!isLive()) {
        const beforeP = MOCK_PILOTS.length;
        const beforeS = MOCK_SORTIES.length;
        for (let i = MOCK_PILOTS.length - 1; i >= 0; i--) {
          if (MOCK_PILOTS[i].imported && MOCK_PILOTS[i].importedAt === stamp) MOCK_PILOTS.splice(i, 1);
        }
        for (let i = MOCK_SORTIES.length - 1; i >= 0; i--) {
          if (MOCK_SORTIES[i].imported && MOCK_SORTIES[i].importedAt === stamp) MOCK_SORTIES.splice(i, 1);
        }
        const removedP = beforeP - MOCK_PILOTS.length;
        const removedS = beforeS - MOCK_SORTIES.length;
        appendDemoAudit({
          ts: tsNow(),
          user: actor ?? "ops.lead",
          action: "Historical Import (undone)",
          target: `${removedP} pilots, ${removedS} sorties`,
        });
        setLastImportStamp(null);
        return { pilotsRemoved: removedP, sortiesRemoved: removedS, mode: "demo" as const };
      }

      // Live Supabase: delete by JSONB stamp match. Sorties first because of
      // the FK from sorties.pilot_id → pilots.id.
      const { data: sDel, error: sErr } = await supabase!
        .from("sorties")
        .delete()
        .filter("data->>importedAt", "eq", stamp)
        .select("id");
      if (sErr) throw new Error(`Sortie undo failed: ${sErr.message}`);
      const { data: pDel, error: pErr } = await supabase!
        .from("pilots")
        .delete()
        .filter("data->>importedAt", "eq", stamp)
        .select("id");
      if (pErr) throw new Error(`Pilot undo failed: ${pErr.message}`);

      await recordAuditEvent({
        type: "import.history.undone",
        actor,
        detail: { stamp, pilots: pDel?.length ?? 0, sorties: sDel?.length ?? 0 },
      });
      setLastImportStamp(null);
      return {
        pilotsRemoved: pDel?.length ?? 0,
        sortiesRemoved: sDel?.length ?? 0,
        mode: "supabase" as const,
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pilots"] });
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// ── mobile link codes & device revocation ───────────────────────────────
//
// Server-side trust model lives in 0002_mobile_link.sql. The dashboard side
// only ever:
//   * calls issue_pilot_link_code(pilotId) RPC to get a fresh plaintext code
//     (the RPC invalidates any previous unconsumed code for the same pilot),
//   * UPDATEs pilot_devices.revoked_at to revoke a phone, and
//   * SELECTs from pilot_devices / pilot_link_codes for status display.
// In demo mode (no Supabase) we keep an in-memory mock of the same shape so
// the UI is fully exercisable in the hosted preview.

// Mirrors the SQL default `expires_at default (now() + interval '7 days')` in
// 0002_mobile_link.sql so demo and live show the same countdown.
const LINK_CODE_TTL_MS = 7 * 24 * 60 * 60_000;

export interface PilotLinkStatus {
  device: { linkedAt: string; lastSeenAt: string; revokedAt: string | null } | null;
  pendingCode: { expiresAt: string } | null;
}

interface MockDevice { pilotId: string; linkedAt: string; lastSeenAt: string; revokedAt: string | null }
interface MockCode   { pilotId: string; expiresAt: string; consumedAt: string | null }
const mockDevices: MockDevice[] = [];
const mockCodes: MockCode[] = [];

function mockStatus(pilotId: string): PilotLinkStatus {
  const dev = mockDevices.filter(d => d.pilotId === pilotId).sort((a, b) => b.linkedAt.localeCompare(a.linkedAt))[0] ?? null;
  const code = mockCodes.find(c => c.pilotId === pilotId && c.consumedAt === null && c.expiresAt > new Date().toISOString()) ?? null;
  return {
    device: dev ? { linkedAt: dev.linkedAt, lastSeenAt: dev.lastSeenAt, revokedAt: dev.revokedAt } : null,
    pendingCode: code ? { expiresAt: code.expiresAt } : null,
  };
}

export function usePilotLinkStatus(pilotId: string | undefined): UseQueryResult<PilotLinkStatus> {
  return useQuery<PilotLinkStatus>({
    queryKey: ["pilot_link_status", pilotId],
    enabled: Boolean(pilotId),
    queryFn: async () => {
      if (!pilotId) return { device: null, pendingCode: null };
      if (!isLive()) return mockStatus(pilotId);
      const [{ data: devRows, error: devErr }, { data: codeRows, error: codeErr }] = await Promise.all([
        supabase!.from("pilot_devices")
          .select("linked_at,last_seen_at,revoked_at")
          .eq("pilot_id", pilotId)
          .order("linked_at", { ascending: false })
          .limit(1),
        supabase!.from("pilot_link_codes")
          .select("expires_at,consumed_at")
          .eq("pilot_id", pilotId)
          .is("consumed_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("issued_at", { ascending: false })
          .limit(1),
      ]);
      if (devErr) throw devErr;
      if (codeErr) throw codeErr;
      const d = devRows?.[0];
      const c = codeRows?.[0];
      return {
        device: d ? { linkedAt: String(d.linked_at), lastSeenAt: String(d.last_seen_at), revokedAt: d.revoked_at ? String(d.revoked_at) : null } : null,
        pendingCode: c ? { expiresAt: String(c.expires_at) } : null,
      };
    },
    staleTime: 5_000,
  });
}

export function useIssueLinkCode() {
  const qc = useQueryClient();
  return useMutation<{ code: string; expiresAt: string }, Error, { pilotId: string; actor?: string }>({
    mutationFn: async ({ pilotId, actor }) => {
      if (!isLive()) {
        // Invalidate previous unconsumed codes for this pilot, mirroring the SQL.
        for (const c of mockCodes) if (c.pilotId === pilotId && c.consumedAt === null) c.consumedAt = new Date().toISOString();
        const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
        const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
        mockCodes.push({ pilotId, expiresAt, consumedAt: null });
        return { code, expiresAt };
      }
      const { data, error } = await supabase!.rpc("issue_pilot_link_code", { p_pilot_id: pilotId });
      if (error) throw error;
      const code = String(data ?? "");
      if (!code) throw new Error("Server did not return a code");
      await recordAuditEvent({ type: "mobile.code.issued", actor, detail: { pilotId } });
      return { code, expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString() };
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pilot_link_status", vars.pilotId] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

export function useRevokePilotDevices() {
  const qc = useQueryClient();
  return useMutation<{ revoked: number }, Error, { pilotId: string; actor?: string }>({
    mutationFn: async ({ pilotId, actor }) => {
      if (!isLive()) {
        let n = 0;
        const now = new Date().toISOString();
        for (const d of mockDevices) {
          if (d.pilotId === pilotId && d.revokedAt === null) { d.revokedAt = now; n++; }
        }
        // Also expire any outstanding unconsumed code.
        for (const c of mockCodes) if (c.pilotId === pilotId && c.consumedAt === null) c.consumedAt = now;
        return { revoked: n };
      }
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase!
        .from("pilot_devices")
        .update({ revoked_at: nowIso })
        .eq("pilot_id", pilotId)
        .is("revoked_at", null)
        .select("token_hash");
      if (error) throw error;
      // Also burn any outstanding unconsumed link codes so a previously issued
      // code can't be used to relink after a revoke. RLS already restricts this
      // to the caller's squadron.
      const { error: codeErr } = await supabase!
        .from("pilot_link_codes")
        .update({ consumed_at: nowIso })
        .eq("pilot_id", pilotId)
        .is("consumed_at", null);
      if (codeErr) throw codeErr;
      const revoked = (data ?? []).length;
      await recordAuditEvent({ type: "mobile.device.revoked", actor, detail: { pilotId, devices: revoked } });
      return { revoked };
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["pilot_link_status", vars.pilotId] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// ── pilot reminder prefs + last-sent log (ops view) ────────────────────
export type CurrencyKeyName = "day" | "night" | "irt" | "medical" | "sim";

export interface ReminderOverviewRow {
  pilotId: string;
  pushEnabled: boolean;
  expoPushToken: string | null;
  platform: string | null;
  thresholds: Partial<Record<CurrencyKeyName, number[]>>;
  updatedAt: string | null;
  lastSentAt: string | null;
  lastSentCurrency: CurrencyKeyName | null;
  lastSentThresholdDays: number | null;
  lastSentExpiry: string | null;
}

let mockReminderOverview: ReminderOverviewRow[] | null = null;
function seedReminderOverview(): ReminderOverviewRow[] {
  // Synthetic preview data: opt half the roster in to push, leave the rest
  // un-configured so the "no reminders" filter in the ops view has data.
  const today = new Date();
  return MOCK_PILOTS.map((p, i) => {
    const enrolled = i % 2 === 0;
    const updated = new Date(today.getTime() - (i + 1) * 86400000).toISOString();
    if (!enrolled) {
      return {
        pilotId: p.id,
        pushEnabled: false,
        expoPushToken: null,
        platform: null,
        thresholds: {},
        updatedAt: null,
        lastSentAt: null,
        lastSentCurrency: null,
        lastSentThresholdDays: null,
        lastSentExpiry: null,
      };
    }
    const fired = i % 3 === 0;
    return {
      pilotId: p.id,
      pushEnabled: true,
      expoPushToken: "ExponentPushToken[demo-" + p.id + "]",
      platform: i % 2 === 0 ? "ios" : "android",
      thresholds: {
        day: [14, 7, 1],
        night: [7],
        irt: [],
        medical: [30, 7],
        sim: [],
      },
      updatedAt: updated,
      lastSentAt: fired ? new Date(today.getTime() - (i + 1) * 3600000).toISOString() : null,
      lastSentCurrency: fired ? "day" : null,
      lastSentThresholdDays: fired ? 7 : null,
      lastSentExpiry: fired ? p.expiry.day : null,
    };
  });
}
function getMockReminderOverview(): ReminderOverviewRow[] {
  if (!mockReminderOverview) mockReminderOverview = seedReminderOverview();
  return mockReminderOverview;
}

export function useReminderOverview(): UseQueryResult<ReminderOverviewRow[]> & {
  data: ReminderOverviewRow[];
} {
  const q = useQuery<ReminderOverviewRow[]>({
    queryKey: ["reminder_overview"],
    queryFn: async () => {
      if (!isLive()) return [...getMockReminderOverview()];
      // Pull the squadron's prefs (RLS already scopes by squadron_id) and the
      // most recent fire from the dedupe log per pilot. We do two reads and
      // join in JS to avoid relying on a SQL view.
      const [{ data: prefs, error: prefErr }, { data: notifs, error: notifErr }] =
        await Promise.all([
          supabase!
            .from("pilot_reminder_prefs")
            .select("pilot_id, thresholds, push_enabled, expo_push_token, platform, updated_at"),
          // Use the SQL DISTINCT-on equivalent via order + unique grouping in
          // JS, but ensure we capture the latest fire per pilot regardless of
          // squadron volume. We page through up to 5k recent rows; ops viewing
          // is per-squadron so RLS already trims this server-side.
          supabase!
            .from("pilot_currency_notifications")
            .select("pilot_id, currency_key, expiry_date, threshold_days, sent_at")
            .order("sent_at", { ascending: false })
            .limit(5000),
        ]);
      if (prefErr) throw prefErr;
      if (notifErr) throw notifErr;
      const lastByPilot = new Map<string, NonNullable<typeof notifs>[number]>();
      for (const n of notifs ?? []) {
        if (!lastByPilot.has(n.pilot_id as string)) {
          lastByPilot.set(n.pilot_id as string, n);
        }
      }
      const byPilot = new Map<string, ReminderOverviewRow>();
      for (const r of prefs ?? []) {
        const last = lastByPilot.get(r.pilot_id as string);
        byPilot.set(r.pilot_id as string, {
          pilotId: r.pilot_id as string,
          pushEnabled: Boolean(r.push_enabled),
          expoPushToken: (r.expo_push_token as string | null) ?? null,
          platform: (r.platform as string | null) ?? null,
          thresholds: (r.thresholds ?? {}) as ReminderOverviewRow["thresholds"],
          updatedAt: (r.updated_at as string | null) ?? null,
          lastSentAt: (last?.sent_at as string | null) ?? null,
          lastSentCurrency: (last?.currency_key as CurrencyKeyName | null) ?? null,
          lastSentThresholdDays: (last?.threshold_days as number | null) ?? null,
          lastSentExpiry: (last?.expiry_date as string | null) ?? null,
        });
      }
      // Surface pilots that have a fire log but no prefs row (edge case from
      // pre-revoke history) so ops still sees their last reminder.
      for (const [pid, last] of lastByPilot) {
        if (byPilot.has(pid)) continue;
        byPilot.set(pid, {
          pilotId: pid,
          pushEnabled: false,
          expoPushToken: null,
          platform: null,
          thresholds: {},
          updatedAt: null,
          lastSentAt: (last.sent_at as string | null) ?? null,
          lastSentCurrency: (last.currency_key as CurrencyKeyName | null) ?? null,
          lastSentThresholdDays: (last.threshold_days as number | null) ?? null,
          lastSentExpiry: (last.expiry_date as string | null) ?? null,
        });
      }
      return Array.from(byPilot.values());
    },
    initialData: () => [...getMockReminderOverview()],
    staleTime: 30_000,
  });
  return {
    ...q,
    data: q.data ?? getMockReminderOverview(),
  } as UseQueryResult<ReminderOverviewRow[]> & { data: ReminderOverviewRow[] };
}

// ── demo seed (preview only) ────────────────────────────────────────────
//
// Populates the in-memory mock arrays with one day of sample sorties so a
// squadron commander can preview the Flight Records page without waiting
// for real data to be entered. No-op in live (Supabase) mode — the real
// backend is the source of truth there. Records created here are tagged
// with `importedAt === DEMO_SEED_TAG` so `clearDemoSeed()` can remove
// only the demo records and leave any real ops-officer entries alone.

const DEMO_SEED_TAG = "DEMO_SEED";

function todayIsoLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyExpiry(): Pilot["expiry"] {
  return { day: "", night: "", irt: "", medical: "", sim: "" };
}

function makeDemoPilots(): Pilot[] {
  const base = (overrides: Partial<Pilot>): Pilot => ({
    id: "",
    name: "",
    arabicName: "",
    rank: "",
    phone: "",
    address: "",
    unit: "SQDN",
    openingDay: 0, openingNight: 0, openingNvg: 0,
    monthDay: 0, monthNight: 0, monthNvg: 0, monthSim: 0, monthCaptain: 0,
    totalDay: 0, totalNight: 0, totalNvg: 0, totalSim: 0, totalCaptain: 0,
    expiry: emptyExpiry(),
    available: true,
    imported: true,
    importedAt: DEMO_SEED_TAG,
    ...overrides,
  });
  return [
    base({ id: "D-1001", rank: "Maj",  name: "Hamzah Al-Shurman", arabicName: "حمزة الشرمان", callSign: "EAGLE-01", qualifications: ["IP", "NVG"] }),
    base({ id: "D-1002", rank: "Capt", name: "Ali Al-Zoubi",       arabicName: "علي الزعبي",    callSign: "EAGLE-02", qualifications: ["MTP"] }),
    base({ id: "D-1003", rank: "Capt", name: "Khalid Al-Tarawneh", arabicName: "خالد الطراونة", callSign: "EAGLE-03" }),
    base({ id: "D-1004", rank: "1Lt",  name: "Omar Al-Masri",      arabicName: "عمر المصري",    callSign: "EAGLE-04" }),
  ];
}

function makeDemoSorties(date: string): Sortie[] {
  const s = (overrides: Partial<Sortie>): Sortie => ({
    id: "",
    date,
    acType: "UH-60M",
    acNumber: "",
    pilotId: "",
    coPilotId: "",
    sortieType: "",
    name: "",
    day1: 0, day2: 0, dayDual: 0,
    night1: 0, night2: 0, nightDual: 0,
    nvg: 0, sim: 0, actual: 0,
    imported: true,
    importedAt: DEMO_SEED_TAG,
    ...overrides,
  });
  return [
    s({ id: "DS-1", acNumber: "1801", pilotId: "D-1001", coPilotId: "D-1002", sortieType: "MSN DAY", name: "Troop Insertion — Al-Jafr",           day1: 1.8, actual: 1.8, condition: "Day",   remarks: "Clear skies, winds 090/08." }),
    s({ id: "DS-2", acNumber: "1801", pilotId: "D-1001", coPilotId: "D-1003", sortieType: "NAV",     name: "Low-level Nav — King Hussein Route",  day1: 1.5, actual: 1.5, condition: "Day" }),
    s({ id: "DS-3", acNumber: "1803", pilotId: "D-1002", coPilotId: "D-1004", sortieType: "GH",      name: "General Handling + Autos",            day2: 1.3, dayDual: 1.3, actual: 1.3, condition: "Day" }),
    s({ id: "DS-4", acNumber: "1805", pilotId: "D-1003", coPilotId: "D-1001", sortieType: "MSN NVG", name: "NVG Mission — Dead Sea Corridor",     nvg: 2.0, night1: 2.0, actual: 2.0, condition: "NVG", remarks: "Illum 28%. Handoffs at WP3." }),
    s({ id: "DS-5", acNumber: "1805", pilotId: "D-1002", coPilotId: "D-1004", sortieType: "CRS NVG", name: "NVG Crosscountry — Azraq",            nvg: 1.7, night1: 1.7, actual: 1.7, condition: "NVG" }),
    s({ id: "DS-6", acNumber: "1803", pilotId: "D-1001", coPilotId: "D-1002", sortieType: "EMER",    name: "Emergencies Procedures Refresher",    day1: 0.9, actual: 0.9, condition: "Day", remarks: "EP set B. Satisfactory." }),
  ];
}

export function isDemoSeedLoaded(): boolean {
  if (isLive()) return false;
  return MOCK_SORTIES.some((x) => x.importedAt === DEMO_SEED_TAG);
}

export function seedDemoDay(): void {
  if (isLive()) return;
  if (isDemoSeedLoaded()) return;
  const arr = getMockPilots();
  const demoPilots = makeDemoPilots();
  for (const p of demoPilots) {
    if (!arr.some((x) => x.id === p.id)) arr.unshift(p);
  }
  const demoSorties = makeDemoSorties(todayIsoLocal());
  MOCK_SORTIES.push(...demoSorties);
}

export function clearDemoSeed(): void {
  if (isLive()) return;
  const arr = getMockPilots();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].importedAt === DEMO_SEED_TAG) arr.splice(i, 1);
  }
  for (let i = MOCK_SORTIES.length - 1; i >= 0; i--) {
    if (MOCK_SORTIES[i].importedAt === DEMO_SEED_TAG) MOCK_SORTIES.splice(i, 1);
  }
}

export function canSeedDemo(): boolean {
  return !isLive();
}

// ── backup / restore helpers ────────────────────────────────────────────
//
// The offline squadron deployment keeps its operational data in the module
// -level mock arrays above (mockPilotsList, MOCK_SORTIES, mockNotamsList,
// mockUnavailList, mockUsersList). These helpers let `lib/backup.ts`
// serialise that state into an encrypted export and slam it back in on a
// fresh install after an uninstall/reinstall. They are intentionally no-ops
// when Supabase is configured: the canonical store is the cloud, and the
// mock arrays are not in the data path on that install.

export interface SquadronMockState {
  pilots: Pilot[];
  sorties: Sortie[];
  notams: NotamRow[];
  unavail: UnavailEntry[];
  users: AppUser[];
}

export function exportSquadronMockState(): SquadronMockState {
  if (isLive()) {
    return { pilots: [], sorties: [], notams: [], unavail: [], users: [] };
  }
  return {
    pilots: [...getMockPilots()],
    sorties: [...MOCK_SORTIES],
    notams: [...getMockNotams()],
    unavail: [...mockUnavailList ?? []],
    users: [...getMockUsers()],
  };
}

export function applySquadronMockState(s: SquadronMockState): void {
  if (isLive()) return;
  mockPilotsList = [...(s.pilots ?? [])];
  MOCK_SORTIES.splice(0, MOCK_SORTIES.length, ...(s.sorties ?? []));
  mockNotamsList = [...(s.notams ?? [])];
  mockUnavailList = [...(s.unavail ?? [])];
  mockUsersList = [...(s.users ?? [])];
}
