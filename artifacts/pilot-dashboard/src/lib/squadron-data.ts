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
import {
  deleteInternalAlert,
  fetchInternalActivePilotDevicesRows,
  deleteInternalNotam,
  deleteInternalUnavailableById,
  fetchInternalAlertsRows,
  fetchInternalAuditLogRows,
  fetchInternalDutyWeekRows,
  fetchInternalLeavesRows,
  fetchInternalNotamsRows,
  fetchInternalPilotTableRows,
  fetchInternalSavedDutyWeeksRows,
  fetchInternalScheduleRows,
  fetchInternalSortieTableRows,
  fetchInternalUnavailableRows,
  fetchInternalPilotLinkStatus,
  fetchInternalReminderOverviewRows,
  internalWritesEnabled,
  isLanSessionLoginEnabled,
  patchInternalAlert,
  patchInternalNotam,
  internalPilotUpsertFetch,
  internalPilotDeleteFetch,
  postInternalAlertInsert,
  postInternalIssuePilotLinkCode,
  postInternalImportHistory,
  postInternalNotamInsert,
  postInternalPilotTransfer,
  postInternalRevokePilotDevices,
  postInternalSquadronUserCreate,
  postInternalUndoImport,
  fetchInternalSquadronUsersRows,
  internalSortieInsertFetch,
  internalSortieUpdateFetch,
  internalSortieDeleteFetch,
  postInternalUnavailableInsert,
  postInternalUnavailableUpsertDay,
  postInternalSavedDutyWeekUpsert,
  deleteInternalOldSavedDutyWeeks,
} from "@/lib/internal-migration";
import { supabase, supabaseConfigured, recordAuditEvent } from "./supabase";
import { lookupRankEn } from "./ranks";
import {
  isFrozenMonth,
  monthOf,
  isThisPcAuthorized,
  getThisPc,
} from "./monthly-close";
import {
  PILOTS as MOCK_PILOTS,
  SORTIES as MOCK_SORTIES,
  NOTAMS as MOCK_NOTAMS,
  DUTY_WEEK as MOCK_DUTY_WEEK,
  type Pilot,
  type Sortie,
} from "./mock";

export type { Pilot, Sortie } from "./mock";

// Client-side mirrors of the CHECK constraints + normalize trigger added
// in migration 0045_round4_fixes.sql. Catching these in the form layer
// produces a friendly error before the network round-trip and keeps the
// 400 from PostgREST out of the user's face. The server is still the
// source of truth — if these helpers ever fall behind, the DB will reject
// the row and the existing toast handler surfaces the Postgres message.
const MIN_DATE = new Date("1990-01-01T00:00:00Z");
function maxDate(): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}
function trimNorm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : s;
}
function assertLen(field: string, v: unknown, min: number, max: number, required: boolean) {
  const s = trimNorm(v);
  if (s === null) {
    if (required) throw new Error(`${field} is required.`);
    return;
  }
  if (s.length < min) throw new Error(`${field} must be at least ${min} character${min === 1 ? "" : "s"}.`);
  if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer.`);
}
function assertDate(field: string, v: unknown) {
  if (v === null || v === undefined || v === "") throw new Error(`${field} is required.`);
  const d = typeof v === "string" || typeof v === "number" ? new Date(v) : v as Date;
  if (!(d instanceof Date) || isNaN(d.getTime())) throw new Error(`${field} is not a valid date.`);
  if (d < MIN_DATE || d > maxDate()) {
    throw new Error(`${field} must be between 1990-01-01 and one year from today.`);
  }
}
export function assertValidPilotInput(p: Partial<Pilot> & { id?: string }) {
  assertLen("Pilot ID", p.id, 1, 60, true);
  assertLen("Rank", p.rank, 1, 30, true);
  assertLen("Name", p.name, 1, 200, true);
  assertLen("Arabic name", p.arabicName, 1, 200, false);
  assertLen("Unit", p.unit, 1, 50, false);
  assertLen("Phone", p.phone, 1, 30, false);
  assertLen("English rank", p.rankEn, 1, 30, false);
}
export function assertValidSortieInput(s: {
  pilotId?: string | null; coPilotId?: string | null; acType?: string | null;
  acNumber?: string | null; sortieType?: string | null; sortieName?: string | null;
  date?: string | Date | null;
}) {
  assertLen("Pilot ID", s.pilotId, 1, 60, true);
  assertLen("Co-pilot ID", s.coPilotId, 1, 60, false);
  assertLen("Aircraft type", s.acType, 1, 30, false);
  assertLen("Aircraft number", s.acNumber, 1, 30, false);
  assertLen("Sortie type", s.sortieType, 1, 50, false);
  assertLen("Sortie name", s.sortieName, 1, 200, false);
  assertDate("Sortie date", s.date);
}
export function assertValidNotamInput(n: { notamNo?: string | null; body?: string | null; postedOn?: string | Date | null }) {
  assertLen("NOTAM number", n.notamNo, 1, 100, true);
  assertLen("NOTAM body", n.body, 1, 8000, true);
  assertDate("Posted-on date", n.postedOn);
}

// Shared 3-level priority used by alerts, notams and private messages.
// DB stores 'normal' | 'medium' | 'urgent'; UI labels them Normal / High /
// Very High and colours them green / yellow / red.
export type ItemPriority = "normal" | "medium" | "urgent";
export interface NotamRow { id: string; date: string; text: string; pk?: string; priority: ItemPriority; }
export interface AlertRow { id: string; postedAt: string; text: string; author: string; priority: ItemPriority; }
export interface DutyDay  { day: string; mainDuty: string; standby: string; rcm: string; }
export interface UnavailEntry { id: string; pilotId: string; from: string; to: string; reason: string; }
export interface ScheduleEntry { id: string; ac: string; config: string; crew: string[]; mission: string; takeoff: string; land: string; fuel: string; }
export interface LeaveRow { pilotId: string; months: number[]; total: number; }
export interface CurrencyRow { pilotId: string; task: string; status: "done" | "partial" | "missing"; }
export interface AppUser { id: string; username: string; role: "ops" | "deputy"; created: string; }

const isLive = () => supabaseConfigured && supabase !== null;
const shouldUseInternalDataPlane = () => isLanSessionLoginEnabled() || internalWritesEnabled();

async function sessionSquadronIdForInternalWrite(): Promise<string> {
  if (isLanSessionLoginEnabled()) {
    try {
      const raw = localStorage.getItem("rjaf.user");
      if (raw) {
        const parsed = JSON.parse(raw) as { squadronIds?: unknown };
        if (Array.isArray(parsed?.squadronIds) && parsed.squadronIds.length > 0) {
          const sid = String(parsed.squadronIds[0] ?? "").trim();
          if (sid) return sid;
        }
      }
    } catch {
      // fall through to Supabase session lookup if present
    }
  }
  if (!supabase) throw new Error("no_supabase_session");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const sid = data?.session?.user?.app_metadata?.squadron_id;
  if (typeof sid !== "string" || !sid.trim()) {
    throw new Error("squadron_session_missing");
  }
  return sid.trim();
}

async function nextFreePilotIdFromInternal(): Promise<string> {
  const rows = await fetchInternalPilotTableRows();
  if (!rows || rows.length === 0) return "P001";
  const used = new Set(rows.map((r) => String(r.id ?? "")));
  const nums = rows
    .map((r) => parseInt(String(r.id ?? "").replace(/\D/g, ""), 10))
    .filter((n) => !Number.isNaN(n));
  let n = (nums.length ? Math.max(...nums) : 0) + 1;
  while (used.has(`P${String(n).padStart(3, "0")}`)) n++;
  return `P${String(n).padStart(3, "0")}`;
}

async function readInternalJsonRow(res: Response): Promise<Record<string, unknown>> {
  const j = (await res.json().catch(() => ({}))) as { row?: Record<string, unknown> };
  if (!res.ok) {
    const msg = JSON.stringify(j && Object.keys(j).length ? j : { status: res.status });
    throw new Error(msg);
  }
  if (!j.row) throw new Error("internal_missing_row");
  return j.row;
}

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
    // English rank: prefer the explicit `rank_en` column (added in
    // migration 0030), fall back to the JSONB `data.rankEn` mirror,
    // then to the RJAF lookup so older rows that haven't been re-saved
    // yet still resolve to a clean English value at render time. The
    // next operator save persists the authoritative column value.
    rankEn: r.rank_en
      ? String(r.rank_en)
      : (data.rankEn
          ? String(data.rankEn)
          : (lookupRankEn(String(r.rank ?? data.rank ?? "")) || undefined)),
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
    expiry: {
      day: data.expiry?.day ?? "",
      night: data.expiry?.night ?? "",
      // Legacy rows had no separate `nvg` expiry — treat blank as
      // "not yet recorded" rather than aliasing Night, so the ops officer
      // sees an explicit "—" and is prompted to set it once.
      nvg: data.expiry?.nvg ?? "",
      irt: data.expiry?.irt ?? "",
      medical: data.expiry?.medical ?? "",
      sim: data.expiry?.sim ?? "",
      missionQual: data.expiry?.missionQual ? String(data.expiry.missionQual) : undefined,
    },
    hiddenCurrencies: Array.isArray(data.hiddenCurrencies) ? data.hiddenCurrencies : undefined,
    // Qualifications round-trip: prefer the joined `qualification`
    // string (the format the operator chose with `/` or `-`), fall
    // back to the legacy array. The chip array is derived from the
    // string when present so render sites keep working unchanged.
    qualifications: typeof data.qualification === "string" && data.qualification.trim().length
      ? data.qualification.split(/\s*[/\-,|]\s*/).map((s: string) => s.trim()).filter(Boolean)
      : (Array.isArray(data.qualifications) ? data.qualifications : undefined),
    qualification: typeof data.qualification === "string" ? data.qualification : undefined,
    qualificationSeparator: data.qualificationSeparator === "-" ? "-" : (data.qualificationSeparator === "/" ? "/" : undefined),
    lastSimDate: data.lastSimDate ? String(data.lastSimDate) : undefined,
    // Other-aircraft experience (April 2026): list of airframes flown
    // outside the squadron's primary type. Persisted inside the JSONB
    // `data` blob alongside every other free-form pilot field.
    otherAircraft: Array.isArray(data.otherAircraft)
      ? (data.otherAircraft as Pilot["otherAircraft"])
      : undefined,
    // INITIAL HOURS — read the eleven-bucket baseline from JSONB. No
    // schema migration needed; lives inside `data`. Auto-migration:
    // if the operator never opened the new form but has legacy
    // openingDay/Night/Nvg values from the old simple form, surface
    // those as 1st-PLT baseline so totals stay identical.
    initialHours: (() => {
      const ih = (data as Partial<Pilot>).initialHours;
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      if (ih && typeof ih === "object") {
        return {
          day1: num(ih.day1),
          day2: num(ih.day2),
          dayDual: num(ih.dayDual),
          night1: num(ih.night1),
          night2: num(ih.night2),
          nightDual: num(ih.nightDual),
          nvg1: num(ih.nvg1),
          nvg2: num(ih.nvg2),
          nvgDual: num(ih.nvgDual),
          captain: num(ih.captain),
          instrument: num(ih.instrument),
        };
      }
      return undefined;
    })(),
    // Migration provenance — `imported`/`importedAt` are stamped onto every
    // row by the legacy CSV import (see `useImportLegacy`) and consumed by
    // the roster/sortie "Imported only" filters and the row-level badge.
    // Round-tripped through the JSONB blob so a plain edit never strips
    // the flag from a migrated record.
    imported: data.imported === true ? true : undefined,
    importedAt: typeof data.importedAt === "string" ? data.importedAt : undefined,
  };
}

// Offline persistence: when there's no Supabase, the roster used to live
// only in this module-scoped array, so a hard refresh wiped every pilot
// the ops officer had added/edited/deleted (and broke the Pending
// Approvals picker that depends on the roster). We mirror the working
// list into localStorage on every mutation and re-hydrate from there on
// first read so offline edits survive reloads.
const MOCK_PILOTS_KEY = "rjaf.mock.pilots";
let mockPilotsList: Pilot[] | null = null;
function loadMockPilotsFromStorage(): Pilot[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MOCK_PILOTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as Pilot[];
  } catch {
    return null;
  }
}
function saveMockPilots(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOCK_PILOTS_KEY, JSON.stringify(mockPilotsList ?? []));
  } catch { /* quota / private mode */ }
}
function getMockPilots(): Pilot[] {
  if (!mockPilotsList) {
    const fromStorage = loadMockPilotsFromStorage();
    mockPilotsList = fromStorage ?? [...MOCK_PILOTS];
    if (!fromStorage) saveMockPilots();
  }
  return mockPilotsList;
}

export function usePilots(): UseQueryResult<Pilot[]> & { data: Pilot[] } {
  const useDemoSeed = !isLive() && !isLanSessionLoginEnabled();
  const q = useQuery<Pilot[]>({
    queryKey: ["pilots"],
    queryFn: async () => {
      if (!isLive() && !shouldUseInternalDataPlane()) return [...getMockPilots()];
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalPilotTableRows();
        return rows ? rows.map(rowToPilot) : [];
      }
      // Internal LAN: load roster from your base server first when it returns
      // at least one pilot (same hybrid safety as the squadron list — an
      // empty scratch database must not hide a full cloud roster).
      const internalRows = await fetchInternalPilotTableRows();
      if (internalRows !== null && internalRows.length > 0) {
        return internalRows.map(rowToPilot);
      }
      const { data, error } = await supabase!.from("pilots").select("*").order("id");
      if (error) throw error;
      return (data ?? []).map(rowToPilot);
    },
    initialData: useDemoSeed ? () => [...getMockPilots()] : undefined,
    staleTime: 30_000,
    retry: isLive() ? 1 : false,
  });
  const fallback: Pilot[] = useDemoSeed ? getMockPilots() : [];
  return { ...q, data: q.data ?? fallback } as UseQueryResult<Pilot[]> & { data: Pilot[] };
}

// Compute the diff between two pilots so the audit log captures only what
// actually changed (instead of a full row dump on every keystroke save).
// Numeric fields tolerate a tiny epsilon to avoid spurious entries from
// floating-point round-trips through the form. Returns null if nothing
// material changed — caller should skip the audit insert in that case.
function pilotProfileDiff(prev: Pilot | undefined, next: Pilot): Record<string, { before: unknown; after: unknown }> | null {
  if (!prev) return null;
  const keys: Array<keyof Pilot> = [
    "name", "arabicName", "rank", "rankEn", "militaryNumber", "phone", "address",
    "unit", "callSign", "flightName", "doctorNote", "available",
    "qualifications", "qualification", "lastSimDate",
  ];
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    const sameStr = JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (!sameStr) {
      changes[k as string] = { before: a ?? null, after: b ?? null };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

// Input wrapper for the mutation hooks below. Existing callers may pass a
// bare Pilot; profile-edit callers in the Roster pass the wrapper so the
// audit log captures who made the change and exactly which fields moved.
export type UpdatePilotInput = Pilot | { pilot: Pilot; actor?: string; prev?: Pilot };
export type CreatePilotInput = Pilot | { pilot: Pilot; actor?: string };
export type DeletePilotInput = string | { id: string; actor?: string; pilotName?: string };
export interface TransferPilotInput {
  pilotId: string;
  toSquadronId: string;
  actor?: string;
  pilotName?: string;
  fromSquadronId?: string;
}

function unwrapUpdate(input: UpdatePilotInput): { pilot: Pilot; actor?: string; prev?: Pilot } {
  if ("pilot" in input) return input;
  return { pilot: input };
}
function unwrapCreate(input: CreatePilotInput): { pilot: Pilot; actor?: string } {
  if ("pilot" in input) return input;
  return { pilot: input };
}
function unwrapDelete(input: DeletePilotInput): { id: string; actor?: string; pilotName?: string } {
  if (typeof input === "string") return { id: input };
  return input;
}

export function useUpdatePilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePilotInput) => {
      const { pilot: p, actor, prev } = unwrapUpdate(input);
      assertValidPilotInput(p);
      if (!isLive() && !shouldUseInternalDataPlane()) {
        const arr = getMockPilots();
        const idx = arr.findIndex(x => x.id === p.id);
        if (idx >= 0) arr[idx] = p;
        saveMockPilots();
        const changes = pilotProfileDiff(prev, p);
        if (changes) {
          void recordAuditEvent({
            type: "pilot.profile.update",
            actor,
            detail: { pilotId: p.id, pilotName: p.name, changes },
          });
        }
        return p;
      }
      // Defensive: some squadron DBs may not have run migration 0031 yet
      // (rank_en column). If the schema cache rejects the column we retry
      // without it so the rest of the pilot row still saves. The JSONB
      // `data.rankEn` mirror keeps the English rank readable until the
      // migration is applied. See `.local/memory/multi-squadron.md`.
      const updatePayload: Record<string, unknown> = {
        name: p.name,
        arabic_name: p.arabicName,
        rank: p.rank,
        rank_en: p.rankEn ?? null,
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
          rankEn: p.rankEn,
          qualifications: p.qualifications,
          qualification: p.qualification,
          qualificationSeparator: p.qualificationSeparator,
          lastSimDate: p.lastSimDate,
          otherAircraft: p.otherAircraft,
          initialHours: p.initialHours,
          // Preserve legacy-import provenance across edits — without
          // these the JSONB blob would be rewritten on every save and
          // the "Imported only" filter / row badge would silently drop
          // the pilot from the migrated set.
          imported: p.imported,
          importedAt: p.importedAt,
        },
      };
      if (shouldUseInternalDataPlane()) {
        const squadronId = await sessionSquadronIdForInternalWrite();
        const res = await internalPilotUpsertFetch({
          squadron_id: squadronId,
          id: p.id,
          ...updatePayload,
        });
        if (res.status === 409) {
          throw new Error("Pilot save conflict — please refresh the roster.");
        }
        const data = await readInternalJsonRow(res);
        const saved = rowToPilot(data);
        const changes = pilotProfileDiff(prev, saved);
        if (changes) {
          void recordAuditEvent({
            type: "pilot.profile.update",
            actor,
            detail: { pilotId: saved.id, pilotName: saved.name, changes },
          });
        }
        return saved;
      }
      let { data, error } = await supabase!.from("pilots").update(updatePayload).eq("id", p.id).select().single();
      if (error && isMissingColumnError(error, "rank_en")) {
        const { rank_en: _drop, ...without } = updatePayload as { rank_en?: unknown } & Record<string, unknown>;
        void _drop;
        // eslint-disable-next-line no-console
        console.warn("[pilots.update] retrying without rank_en — DB missing migration 0031_pilots_rank_en");
        ({ data, error } = await supabase!.from("pilots").update(without).eq("id", p.id).select().single());
      }
      if (error) throw error;
      const saved = rowToPilot(data);
      // Audit profile edits (live path). Fire-and-forget; the audit
      // helper is non-throwing, but we still wrap in a try just in case
      // a future change makes it surface.
      const changes = pilotProfileDiff(prev, saved);
      if (changes) {
        void recordAuditEvent({
          type: "pilot.profile.update",
          actor,
          detail: { pilotId: saved.id, pilotName: saved.name, changes },
        });
      }
      return saved;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pilots"] }),
  });
}

// Detect a Supabase/PostgREST schema-cache error for a specific column.
// Symptom in production: a deployed squadron forgot to run a column-add
// migration; every save fails with "Could not find the 'X' column of
// 'pilots' in the schema cache" and the operator sees the entire row
// (military number, name, hours) appear to vanish on edit because the
// UPDATE rolled back. We retry without the offending column so the rest
// of the row still saves; the missing-column data lives on the JSONB
// `data` mirror until the migration is applied.
function isMissingColumnError(err: { message?: string; code?: string } | null | undefined, column: string): boolean {
  if (!err) return false;
  const msg = String(err.message ?? "").toLowerCase();
  return (
    err.code === "PGRST204" ||
    msg.includes(`'${column}' column`) ||
    msg.includes(`column "${column}"`) && msg.includes("does not exist") ||
    msg.includes(`could not find the '${column}'`)
  );
}

export function useCreatePilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePilotInput) => {
      const { pilot: p, actor } = unwrapCreate(input);
      assertValidPilotInput(p);
      if (!isLive() && !shouldUseInternalDataPlane()) {
        const arr = getMockPilots();
        if (arr.some(x => x.id === p.id)) {
          throw new Error(`Pilot ID ${p.id} already exists`);
        }
        arr.unshift(p);
        saveMockPilots();
        void recordAuditEvent({
          type: "pilot.profile.create",
          actor,
          detail: { pilotId: p.id, pilotName: p.name, militaryNumber: p.militaryNumber },
        });
        return p;
      }
      // pilots.id is the GLOBAL primary key across every squadron in the
      // database. The Roster form picks the "next" id by looking at pilots
      // loaded for THIS squadron only, so if another PC's squadron already
      // has the same id (or a stale local cache miscounted), the insert
      // would fail with "duplicate key value violates unique constraint
      // pilots_pkey". To make Add Pilot bullet-proof we:
      //   1. Try the requested id first.
      //   2. On 23505 (unique violation), query the actual max id across
      //      ALL squadrons and retry with the next free Pxxx, up to 10x.
      // This is invisible to the operator — they just see the new pilot
      // appear with whatever id was actually free.
      const buildPayload = (id: string) => ({
        id,
        name: p.name,
        arabic_name: p.arabicName,
        rank: p.rank,
        rank_en: p.rankEn ?? null,
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
          rankEn: p.rankEn,
          qualifications: p.qualifications,
          qualification: p.qualification,
          qualificationSeparator: p.qualificationSeparator,
          lastSimDate: p.lastSimDate,
          otherAircraft: p.otherAircraft,
          initialHours: p.initialHours,
          // New pilots created through Add Pilot are NOT imported, but
          // we still pass the flags through verbatim for symmetry with
          // useUpdatePilot — defaulting `imported` to undefined keeps
          // the Roster's "Imported only" toggle accurate.
          imported: p.imported,
          importedAt: p.importedAt,
        },
      });

      if (shouldUseInternalDataPlane()) {
        const squadronId = await sessionSquadronIdForInternalWrite();
        let attemptId = p.id;
        for (let attempt = 0; attempt < 10; attempt++) {
          const payload = { ...buildPayload(attemptId), squadron_id: squadronId };
          const res = await internalPilotUpsertFetch(payload);
          if (res.ok) {
            const data = await readInternalJsonRow(res);
            const created = rowToPilot(data);
            void recordAuditEvent({
              type: "pilot.profile.create",
              actor,
              detail: { pilotId: created.id, pilotName: created.name, militaryNumber: created.militaryNumber },
            });
            return created;
          }
          if (res.status === 409) {
            attemptId = await nextFreePilotIdFromInternal();
            continue;
          }
          throw new Error(await res.text());
        }
        throw new Error(
          "Could not allocate a free pilot ID after 10 attempts — please refresh and try again.",
        );
      }

      const nextFreeId = async (): Promise<string> => {
        const { data: rows } = await supabase!
          .from("pilots")
          .select("id")
          .like("id", "P%");
        const used = new Set((rows ?? []).map(r => String(r.id)));
        const nums = (rows ?? [])
          .map(r => parseInt(String(r.id).replace(/\D/g, ""), 10))
          .filter(n => !isNaN(n));
        let n = (nums.length ? Math.max(...nums) : 0) + 1;
        // Defensive: skip any id that somehow appears in the used set
        // (shouldn't happen if max is correct, but cheap insurance).
        while (used.has(`P${String(n).padStart(3, "0")}`)) n++;
        return `P${String(n).padStart(3, "0")}`;
      };

      let attemptId = p.id;
      for (let attempt = 0; attempt < 10; attempt++) {
        const payload = buildPayload(attemptId);
        let { data, error } = await supabase!
          .from("pilots")
          .insert(payload)
          .select()
          .single();
        // Defensive: same fallback as updatePilot for squadrons whose DB
        // hasn't run migration 0031 (rank_en column). See
        // `.local/memory/multi-squadron.md`.
        if (error && isMissingColumnError(error, "rank_en")) {
          const { rank_en: _drop, ...without } = payload as { rank_en?: unknown } & Record<string, unknown>;
          void _drop;
          // eslint-disable-next-line no-console
          console.warn("[pilots.insert] retrying without rank_en — DB missing migration 0031_pilots_rank_en");
          ({ data, error } = await supabase!.from("pilots").insert(without).select().single());
        }
        if (!error) {
          const created = rowToPilot(data);
          void recordAuditEvent({
            type: "pilot.profile.create",
            actor,
            detail: { pilotId: created.id, pilotName: created.name, militaryNumber: created.militaryNumber },
          });
          return created;
        }
        // 23505 = unique_violation. Only retry if it's the primary-key
        // collision we know how to recover from; surface anything else
        // (e.g. the new militaryNumber unique index) to the caller so the
        // form can show the proper validation message.
        const code = (error as { code?: string }).code;
        const msg = (error.message ?? "").toLowerCase();
        if (code !== "23505" || !msg.includes("pilots_pkey")) throw error;
        attemptId = await nextFreeId();
      }
      throw new Error(
        "Could not allocate a free pilot ID after 10 attempts — please refresh and try again.",
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pilots"] }),
  });
}

export function useDeletePilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeletePilotInput) => {
      const { id, actor, pilotName } = unwrapDelete(input);
      if (!isLive() && !shouldUseInternalDataPlane()) {
        const arr = getMockPilots();
        const idx = arr.findIndex(x => x.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        saveMockPilots();
        void recordAuditEvent({
          type: "pilot.profile.delete",
          actor,
          detail: { pilotId: id, pilotName },
        });
        return { id };
      }
      if (shouldUseInternalDataPlane()) {
        const res = await internalPilotDeleteFetch(id);
        if (!res.ok && res.status !== 404) {
          throw new Error(await res.text());
        }
        void recordAuditEvent({
          type: "pilot.profile.delete",
          actor,
          detail: { pilotId: id, pilotName },
        });
        return { id };
      }
      const { error } = await supabase!.from("pilots").delete().eq("id", id);
      if (error) throw error;
      void recordAuditEvent({
        type: "pilot.profile.delete",
        actor,
        detail: { pilotId: id, pilotName },
      });
      return { id };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pilots"] }),
  });
}

// ─── Inter-squadron transfer ────────────────────────────────────────────
// Calls the SECURITY DEFINER `public.transfer_pilot(p_pilot_id, p_to_squadron)`
// RPC installed by 0053_pilot_transfer.sql. The RPC does the heavy lifting
// (re-homing pilots / sorties / currencies / leaves / unavailable +
// writing paired audit_log entries on both squadrons) atomically. The
// hook just invalidates the local pilots cache so the UI reflects the
// removal from the source squadron's roster immediately.
export function useTransferPilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ pilotId, toSquadronId, actor, pilotName, fromSquadronId }: TransferPilotInput) => {
      if (!pilotId || !toSquadronId) {
        throw new Error("pilotId and toSquadronId are required");
      }
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalPilotTransfer(pilotId, toSquadronId);
        if (!out.ok) throw new Error(out.error);
        return {
          pilotId: out.pilotId,
          fromSquadron: out.fromSquadron,
          toSquadron: out.toSquadron,
        };
      }
      if (!isLive()) {
        // Mock-mode behaviour: simply re-stamp an ad-hoc squadronId on
        // the pilot record so the demo still works without a database.
        // The Pilot type doesn't formally model squadron membership
        // (live mode infers it via RLS), so we attach it dynamically
        // and read it back the same way — purely for demo continuity.
        const arr = getMockPilots();
        const idx = arr.findIndex(x => x.id === pilotId);
        if (idx < 0) throw new Error(`pilot ${pilotId} not found`);
        const cur = arr[idx] as Pilot & { squadronId?: string };
        const before = cur.squadronId ?? fromSquadronId ?? null;
        arr[idx] = { ...cur, squadronId: toSquadronId } as Pilot;
        saveMockPilots();
        void recordAuditEvent({
          type: "pilot.transfer.out",
          actor,
          detail: { pilotId, pilotName, fromSquadron: before, toSquadron: toSquadronId, mode: "mock" },
        });
        return { pilotId, fromSquadron: before, toSquadron: toSquadronId };
      }
      // Live path: call the definer RPC. PostgREST exposes RPCs at
      // /rest/v1/rpc/<fn_name> and the supabase-js .rpc() helper wraps
      // it. The RPC writes the canonical audit rows itself (one per
      // squadron) so we don't double-log here.
      const { data, error } = await supabase!.rpc("transfer_pilot", {
        p_pilot_id: pilotId,
        p_to_squadron: toSquadronId,
      });
      if (error) throw error;
      return {
        pilotId,
        fromSquadron: fromSquadronId ?? (data as { fromSquadron?: string } | null)?.fromSquadron ?? null,
        toSquadron: toSquadronId,
        result: data,
      };
    },
    onSuccess: () => {
      // Both pilots and sorties query keys need to refresh — the
      // pilot disappears from the source roster, the sorties move,
      // and the squadron stats on the Overview must recompute.
      qc.invalidateQueries({ queryKey: ["pilots"] });
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["currencies"] });
      qc.invalidateQueries({ queryKey: ["leaves"] });
      qc.invalidateQueries({ queryKey: ["unavailable"] });
    },
  });
}

// ── sorties ─────────────────────────────────────────────────────────────
// Same offline-persistence pattern as `mockPilotsList` above: without this
// mirror, anything an ops officer logged offline (a sortie, an edit, a
// delete) lived only in this module's memory and was wiped on hard refresh.
const MOCK_SORTIES_KEY = "rjaf.mock.sorties";
// Archive bucket for sorties older than the retention window. Kept in
// localStorage on the same PC (per the operator's explicit instruction:
// nothing about historical sortie data goes to the central Supabase, it
// stays on the originating PC). Read-on-demand via `loadArchivedSorties()`.
const MOCK_SORTIES_ARCHIVE_KEY = "rjaf.mock.sorties.archive";
// Hot-set retention — sorties older than this slide into the archive
// bucket so the active list (which gets serialised to localStorage on
// every write) stays small even after years of daily flying. 3 years
// covers every operationally-meaningful currency window (NVG, IRT, day,
// night, medical) with a wide safety margin.
const SORTIE_HOT_RETENTION_MS = 3 * 365 * 24 * 60 * 60_000;
let mockSortiesList: Sortie[] | null = null;
function loadMockSortiesFromStorage(): Sortie[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MOCK_SORTIES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as Sortie[];
  } catch {
    return null;
  }
}
function saveMockSorties(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOCK_SORTIES_KEY, JSON.stringify(mockSortiesList ?? []));
  } catch { /* quota / private mode */ }
}

// Read the on-disk archive bucket. Returns [] on first call. Used by any
// future "historical report" UI that needs to look beyond the 3-year hot
// window — does NOT touch the in-memory list, so loading the archive
// never bloats the working set.
export function loadArchivedSorties(): Sortie[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(MOCK_SORTIES_ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Sortie[]) : [];
  } catch {
    return [];
  }
}

// Move sorties older than the hot-retention window from the active list
// into the archive bucket. Pure local — never talks to Supabase. Runs
// once per app boot (lazy, on first call to getMockSorties) and is a no-op
// when nothing is old enough to archive, so the cost is one date compare
// per sortie on app startup.
function archiveStaleSorties(active: Sortie[]): Sortie[] {
  try {
    const cutoff = Date.now() - SORTIE_HOT_RETENTION_MS;
    const stale: Sortie[] = [];
    const fresh: Sortie[] = [];
    for (const s of active) {
      const t = +new Date(s.date);
      if (Number.isFinite(t) && t < cutoff) stale.push(s);
      else fresh.push(s);
    }
    if (stale.length === 0) return active;
    // Merge into the existing archive bucket, dedup by id (defensive in
    // case the same sortie was somehow archived twice on different runs).
    const existing = loadArchivedSorties();
    const byId = new Map<string, Sortie>();
    for (const s of existing) byId.set(s.id, s);
    for (const s of stale) byId.set(s.id, s);
    const merged = Array.from(byId.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MOCK_SORTIES_ARCHIVE_KEY, JSON.stringify(merged));
    }
    return fresh;
  } catch {
    return active; // archive best-effort — never lose hot data
  }
}

function getMockSorties(): Sortie[] {
  if (!mockSortiesList) {
    const fromStorage = loadMockSortiesFromStorage();
    const initial = fromStorage ?? [...MOCK_SORTIES];
    // Lazy archive sweep on first read per session. Subsequent calls hit
    // the cached list and pay nothing.
    mockSortiesList = archiveStaleSorties(initial);
    saveMockSorties();
  }
  return mockSortiesList;
}

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
    pilotSeatStatus: data.pilotSeatStatus,
    coPilotSeatStatus: data.coPilotSeatStatus,
    sim: Number(data.sim ?? 0),
    actual: Number(data.actual ?? 0),
    condition: data.condition,
    remarks: data.remarks,
    time: data.time != null ? Number(data.time) : undefined,
    dual: data.dual,
    pilotPosition: data.pilotPosition,
    coPilotPosition: data.coPilotPosition,
    pilotIsCaptain: data.pilotIsCaptain,
    coPilotIsCaptain: data.coPilotIsCaptain,
    msnDuty: data.msnDuty,
    instrumentFlight: data.instrumentFlight,
    ifSim: data.ifSim != null ? Number(data.ifSim) : undefined,
    ifAct: data.ifAct != null ? Number(data.ifAct) : undefined,
    ils: data.ils != null ? Number(data.ils) : undefined,
    vor: data.vor != null ? Number(data.vor) : undefined,
    // See `rowToPilot` — the legacy-import provenance flags. Surfaced so
    // the Sortie Log "Imported only" toggle and the row-level badge can
    // distinguish migrated rows from sorties entered through the UI.
    imported: data.imported === true ? true : undefined,
    importedAt: typeof data.importedAt === "string" ? data.importedAt : undefined,
  };
}

// Derive the 9-bucket schema (Day/Night/NVG × 1st PLT/2nd PLT/Dual) from a
// single flight time + per-seat statuses. Both seats are routed independently:
// the same flight `time` lands in BOTH the pilot-seat's bucket AND the
// co-pilot-seat's bucket so a (1st × Dual) sortie correctly records both
// flying time and dual-instruction time. computePilotTotals reads the flat
// fields back per-pilot via the seat-status fields so neither pilot is
// double-credited at totals time. NVG NEVER bleeds into night buckets.
export type SeatStatus = "1st" | "2nd" | "Dual";

export function deriveSortieBuckets(input: {
  time: number;
  condition: "Day" | "Night" | "NVG";
  pilotStatus: SeatStatus;
  coPilotStatus: SeatStatus;
}): {
  day1: number; day2: number; dayDual: number;
  night1: number; night2: number; nightDual: number;
  nvg: number; nvg1: number; nvg2: number; nvgDual: number;
  actual: number;
} {
  const t = Number.isFinite(input.time) ? Math.max(0, input.time) : 0;
  const out = {
    day1: 0, day2: 0, dayDual: 0,
    night1: 0, night2: 0, nightDual: 0,
    nvg: 0, nvg1: 0, nvg2: 0, nvgDual: 0,
    actual: t,
  };
  if (t <= 0) return out;
  const route = (status: SeatStatus) => {
    if (input.condition === "Day") {
      if (status === "Dual") out.dayDual += t;
      else if (status === "1st") out.day1 += t;
      else out.day2 += t;
    } else if (input.condition === "Night") {
      if (status === "Dual") out.nightDual += t;
      else if (status === "1st") out.night1 += t;
      else out.night2 += t;
    } else {
      // NVG: route into NVG sub-bucket. The combined `nvg` field stays the
      // single-seat amount (T) — NOT 2T — so legacy readers that sum `nvg`
      // per pilot don't over-credit. The 9-bucket nvg1/nvg2/nvgDual carry
      // the per-seat detail.
      if (status === "Dual") out.nvgDual += t;
      else if (status === "1st") out.nvg1 += t;
      else out.nvg2 += t;
    }
  };
  route(input.pilotStatus);
  route(input.coPilotStatus);
  // Combined `nvg` field = single flight duration for legacy readers.
  if (input.condition === "NVG") out.nvg = t;
  return out;
}

export function useSorties(): UseQueryResult<Sortie[]> & { data: Sortie[] } {
  const useDemoSeed = !isLive() && !isLanSessionLoginEnabled();
  const q = useQuery<Sortie[]>({
    queryKey: ["sorties"],
    queryFn: async () => {
      if (!isLive() && !shouldUseInternalDataPlane()) return [...getMockSorties()];
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalSortieTableRows(500);
        return rows ? rows.map(rowToSortie) : [];
      }
      if (shouldUseInternalDataPlane()) {
        const rows = await fetchInternalSortieTableRows(500);
        if (rows !== null) return rows.map(rowToSortie);
      }
      const { data, error } = await supabase!
        .from("sorties").select("*").order("date", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []).map(rowToSortie);
    },
    initialData: useDemoSeed ? () => [...getMockSorties()] : undefined,
    staleTime: 30_000,
    retry: isLive() ? 1 : false,
  });
  const fallback: Sortie[] = useDemoSeed ? getMockSorties() : [];
  return { ...q, data: q.data ?? fallback } as UseQueryResult<Sortie[]> & { data: Sortie[] };
}

// Currency auto-refresh: when a sortie is logged, push the affected
// pilots' expiry dates forward to sortie-date + N days (per the
// per-currency window configured under Settings). Never moves an expiry
// backwards — if the pilot already has a later date on record (from a more
// recent sortie), we keep the later one. Applies to both P1 and P2.
//
// CANONICAL RULES (see replit.md → "Domain Logic — Currency Refresh
// Rules" — do not change these without operator sign-off):
//   - Day sortie       → bumps expiry.day   only (window: w.day, default 30 d)
//   - Night sortie     → bumps expiry.night only (window: w.night, default 30 d)
//   - NVG sortie       → bumps expiry.nvg   only (window: w.nvg, default 30 d)
//   - IRT/instrument   → bumps expiry.irt   only (window: w.instrument, 365 d)
//                        Triggered when sortieType === "IRT" OR
//                        instrumentFlight === true.
//   - Simulator        → MANUAL ONLY, never auto-bumped here. Sim is an
//                        overseas training event that the operator types
//                        in by hand on the pilot form.
//   - Medical          → MANUAL ONLY (doctor visit, not a flight).
// Day/Night/NVG/IRT are FULLY INDEPENDENT — flying one never bumps another.
import { getCurrencyWindow } from "./currency-settings";
function bumpDate(current: string, sortieDate: string, days: number): string {
  const d = new Date(sortieDate);
  if (isNaN(d.getTime())) return current;
  d.setDate(d.getDate() + days);
  const iso = d.toISOString().slice(0, 10);
  if (!current) return iso;
  return iso > current ? iso : current;
}

interface RefreshSortie {
  date: string;
  pilotId: string;
  coPilotId: string;
  condition?: "Day" | "Night" | "NVG";
  // IRT signal — either the dedicated checkbox is on, OR the operator
  // chose "IRT" as the sortie type. Either one refreshes IRT currency.
  instrumentFlight?: boolean;
  sortieType?: string;
}

async function refreshCurrenciesForSortie(
  s: RefreshSortie,
  getPilot: (id: string) => Pilot | undefined,
  persist: (p: Pilot) => Promise<void>,
) {
  // IRT credit fires from EITHER signal — the dedicated Instrument
  // checkbox or selecting "IRT" as the sortie type. RJAF practice
  // treats both as the same training event.
  const isIrt = !!s.instrumentFlight || (s.sortieType ?? "").trim().toUpperCase() === "IRT";
  // Skip only when there's nothing to refresh at all.
  if (!s.condition && !isIrt) return;
  const w = getCurrencyWindow();
  const ids = [s.pilotId, s.coPilotId].filter(Boolean);
  for (const id of ids) {
    const p = getPilot(id);
    if (!p) continue;
    const next = { ...p.expiry };
    if (s.condition === "Day") {
      next.day = bumpDate(p.expiry.day, s.date, w.day);
    } else if (s.condition === "Night") {
      next.night = bumpDate(p.expiry.night, s.date, w.night);
    } else if (s.condition === "NVG") {
      // NVG only — never touches `night`.
      next.nvg = bumpDate(p.expiry.nvg, s.date, w.nvg);
    }
    if (isIrt) {
      // IRT runs in addition to Day/Night/NVG — a Day-condition IRT
      // sortie bumps both Day and IRT.
      next.irt = bumpDate(p.expiry.irt, s.date, w.instrument);
    }
    if (
      next.day === p.expiry.day &&
      next.night === p.expiry.night &&
      next.nvg === p.expiry.nvg &&
      next.irt === p.expiry.irt
    ) continue;
    await persist({ ...p, expiry: next });
  }
}

async function applyCurrencyRefresh(
  s: RefreshSortie,
  qc: ReturnType<typeof useQueryClient>,
) {
  const isIrt = !!s.instrumentFlight || (s.sortieType ?? "").trim().toUpperCase() === "IRT";
  if (!s.condition && !isIrt) return;
  if (!isLive()) {
    const arr = getMockPilots();
    await refreshCurrenciesForSortie(
      s,
      (id) => arr.find((x) => x.id === id),
      async (p) => {
        const idx = arr.findIndex((x) => x.id === p.id);
        if (idx >= 0) arr[idx] = p;
        saveMockPilots();
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
          rankEn: p.rankEn,
          qualifications: p.qualifications,
          qualification: p.qualification,
          qualificationSeparator: p.qualificationSeparator,
          lastSimDate: p.lastSimDate,
          otherAircraft: p.otherAircraft,
          initialHours: p.initialHours,
          // Preserve provenance — currency refresh after a sortie save
          // rewrites the entire JSONB blob, and would otherwise strip
          // the "imported" tag from migrated pilots whose currencies
          // happen to roll over.
          imported: p.imported,
          importedAt: p.importedAt,
        },
      }).eq("id", p.id);
      if (error) throw error;
    },
  );
}

export function useCreateSortie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<Sortie, "id"> | { sortie: Omit<Sortie, "id">; actor?: string }) => {
      // Backwards-compat: callers may pass a bare sortie OR { sortie, actor }.
      const s = ("sortie" in input ? input.sortie : input) as Omit<Sortie, "id">;
      const actor = "sortie" in input ? input.actor : undefined;
      assertValidSortieInput({
        pilotId: s.pilotId, coPilotId: s.coPilotId, acType: s.acType,
        acNumber: s.acNumber, sortieType: s.sortieType, sortieName: s.name, date: s.date,
      });
      const frozenOverride = enforceMonthlyClose([s.date]);
      if (!isLive() && !shouldUseInternalDataPlane()) {
        const created = { ...s, id: "S" + Date.now() } as Sortie;
        getMockSorties().push(created);
        saveMockSorties();
        await applyCurrencyRefresh(s, qc);
        if (frozenOverride) {
          appendDemoAudit({
            ts: tsNow(),
            user: actor ?? "ops.officer",
            action: "Sortie create (frozen override)",
            target: `${created.id} · ${created.date} · ${created.acNumber} · pc:${frozenOverride.pcName}`,
          });
        }
        return created;
      }
      const sortieDataPayload = {
        day1: s.day1, day2: s.day2, dayDual: s.dayDual,
        night1: s.night1, night2: s.night2, nightDual: s.nightDual,
        nvg: s.nvg,
        nvg1: s.nvg1, nvg2: s.nvg2, nvgDual: s.nvgDual,
        sim: s.sim, actual: s.actual,
        condition: s.condition,
        remarks: s.remarks,
        pilotExternal: s.pilotExternal,
        coPilotExternal: s.coPilotExternal,
        time: s.time, dual: s.dual,
        pilotPosition: s.pilotPosition,
        coPilotPosition: s.coPilotPosition,
        pilotSeatStatus: s.pilotSeatStatus,
        coPilotSeatStatus: s.coPilotSeatStatus,
        pilotIsCaptain: s.pilotIsCaptain,
        coPilotIsCaptain: s.coPilotIsCaptain,
        msnDuty: s.msnDuty,
        instrumentFlight: s.instrumentFlight,
        ifSim: s.ifSim, ifAct: s.ifAct, ils: s.ils, vor: s.vor,
        imported: s.imported,
        importedAt: s.importedAt,
      };
      if (shouldUseInternalDataPlane()) {
        const squadronId = await sessionSquadronIdForInternalWrite();
        let createdBy: string | null = null;
        const { data: sess } = await supabase!.auth.getSession();
        const uid = sess?.session?.user?.id;
        if (typeof uid === "string" && uid.trim()) createdBy = uid.trim();
        const body = {
          squadron_id: squadronId,
          pilot_id: s.pilotId,
          co_pilot_id: s.coPilotId && String(s.coPilotId).trim() ? s.coPilotId : null,
          date: s.date,
          ac_type: s.acType,
          ac_number: s.acNumber,
          sortie_type: s.sortieType,
          sortie_name: s.name,
          created_by: createdBy,
          data: sortieDataPayload,
        };
        const res = await internalSortieInsertFetch(body);
        const row = await readInternalJsonRow(res);
        await applyCurrencyRefresh(s, qc);
        const created = rowToSortie(row);
        if (frozenOverride) {
          await recordAuditEvent({
            type: "sortie.create",
            actor,
            detail: {
              id: created.id, date: created.date, acNumber: created.acNumber,
              frozenOverride: true,
              frozenMonths: frozenOverride.months,
              pcId: frozenOverride.pcId,
              pcName: frozenOverride.pcName,
            },
          });
        }
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
        data: sortieDataPayload,
      }).select().single();
      if (error) throw error;
      await applyCurrencyRefresh(s, qc);
      const created = rowToSortie(data);
      if (frozenOverride) {
        await recordAuditEvent({
          type: "sortie.create",
          actor,
          detail: {
            id: created.id, date: created.date, acNumber: created.acNumber,
            frozenOverride: true,
            frozenMonths: frozenOverride.months,
            pcId: frozenOverride.pcId,
            pcName: frozenOverride.pcName,
          },
        });
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["pilots"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// Frozen-month gate. Throws `month_frozen` when any of the supplied dates
// sits in the frozen window (>12 months old) AND this PC is not on the
// super-admin's authorized list. When the PC IS authorized the call
// returns a small payload describing the override so callers can attach
// PC identity + frozen month(s) to the audit trail.
// Multiple dates may be checked at once — useful when an edit moves a
// sortie BETWEEN months: ALL frozen months involved are checked together.
function enforceMonthlyClose(dates: string[]): {
  months: string[]; pcId: string; pcName: string;
} | null {
  const months = Array.from(new Set(dates.filter(d => isFrozenMonth(d)).map(monthOf)));
  if (months.length === 0) return null;
  if (!isThisPcAuthorized()) {
    const err = new Error("month_frozen");
    (err as Error & { frozenMonth?: string }).frozenMonth = months[0];
    throw err;
  }
  const pc = getThisPc();
  return { months, pcId: pc.id, pcName: pc.name };
}

// Update an existing sortie. Demo mode mutates the in-memory mock; live mode
// patches the Supabase row. Both paths emit a `sortie.update` audit event so
// commanders can trace who changed which entry.
export function useUpdateSortie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sortie: Sortie; actor?: string; reason?: string }) => {
      const s = input.sortie;
      assertValidSortieInput({
        pilotId: s.pilotId, coPilotId: s.coPilotId, acType: s.acType,
        acNumber: s.acNumber, sortieType: s.sortieType, sortieName: s.name, date: s.date,
      });
      // Honour the original sortie's date for the close check too — if a
      // historical row is being moved into another month, BOTH the old and
      // the new month must be open. Without this, an operator could shift
      // a closed-month sortie into the live month and edit it freely,
      // bypassing the lock entirely.
      const cached = (qc.getQueryData<Sortie[]>(["sorties"]) ?? []).find(x => x.id === s.id);
      const datesToCheck = [s.date];
      if (cached?.date && cached.date !== s.date) datesToCheck.push(cached.date);
      const frozenOverride = enforceMonthlyClose(datesToCheck);
      if (!isLive() && !shouldUseInternalDataPlane()) {
        const arr = getMockSorties();
        const idx = arr.findIndex(x => x.id === s.id);
        if (idx < 0) throw new Error("sortie_not_found");
        arr[idx] = s;
        saveMockSorties();
        await applyCurrencyRefresh(s, qc);
        appendDemoAudit({
          ts: tsNow(),
          user: input.actor ?? "ops.officer",
          action: frozenOverride
            ? `Sortie edit (frozen override${input.reason ? `; ${input.reason}` : ""})`
            : input.reason
              ? `Sortie edit (${input.reason})`
              : "Sortie edit",
          target: frozenOverride
            ? `${s.id} · ${s.date} · ${s.acNumber} · pc:${frozenOverride.pcName} · months:${frozenOverride.months.join(",")}`
            : `${s.id} · ${s.date} · ${s.acNumber}`,
        });
        return s;
      }
      const sortieUpdateData = {
        day1: s.day1, day2: s.day2, dayDual: s.dayDual,
        night1: s.night1, night2: s.night2, nightDual: s.nightDual,
        nvg: s.nvg,
        nvg1: s.nvg1, nvg2: s.nvg2, nvgDual: s.nvgDual,
        sim: s.sim, actual: s.actual,
        condition: s.condition,
        remarks: s.remarks,
        pilotExternal: s.pilotExternal,
        coPilotExternal: s.coPilotExternal,
        time: s.time, dual: s.dual,
        pilotPosition: s.pilotPosition,
        coPilotPosition: s.coPilotPosition,
        pilotSeatStatus: s.pilotSeatStatus,
        coPilotSeatStatus: s.coPilotSeatStatus,
        pilotIsCaptain: s.pilotIsCaptain,
        coPilotIsCaptain: s.coPilotIsCaptain,
        msnDuty: s.msnDuty,
        instrumentFlight: s.instrumentFlight,
        ifSim: s.ifSim, ifAct: s.ifAct, ils: s.ils, vor: s.vor,
        imported: s.imported,
        importedAt: s.importedAt,
      };
      if (shouldUseInternalDataPlane()) {
        const res = await internalSortieUpdateFetch(s.id, {
          pilot_id: s.pilotId,
          co_pilot_id: s.coPilotId && String(s.coPilotId).trim() ? s.coPilotId : null,
          date: s.date,
          ac_type: s.acType,
          ac_number: s.acNumber,
          sortie_type: s.sortieType,
          sortie_name: s.name,
          data: sortieUpdateData,
        });
        await readInternalJsonRow(res);
      } else {
        const { error } = await supabase!.from("sorties").update({
          pilot_id: s.pilotId, co_pilot_id: s.coPilotId,
          date: s.date, ac_type: s.acType, ac_number: s.acNumber,
          sortie_type: s.sortieType, sortie_name: s.name,
          data: sortieUpdateData,
        }).eq("id", s.id);
        if (error) throw error;
      }
      await applyCurrencyRefresh(s, qc);
      await recordAuditEvent({
        type: "sortie.update",
        actor: input.actor,
        detail: frozenOverride
          ? {
              id: s.id, date: s.date, acNumber: s.acNumber,
              frozenOverride: true,
              frozenMonths: frozenOverride.months,
              pcId: frozenOverride.pcId,
              pcName: frozenOverride.pcName,
              ...(input.reason ? { reason: input.reason } : {}),
            }
          : input.reason
            ? { id: s.id, date: s.date, acNumber: s.acNumber, reason: input.reason }
            : { id: s.id, date: s.date, acNumber: s.acNumber },
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
    mutationFn: async (input: { id: string; date?: string; actor?: string; reason?: string }) => {
      // Resolve the sortie's date from cache or in-memory mock so the
      // close check works even when the caller didn't pass it explicitly.
      // Without a known date we err on the side of "unknown ⇒ allow",
      // matching the legacy behaviour for callers that haven't yet been
      // updated to forward the date.
      const cached = (qc.getQueryData<Sortie[]>(["sorties"]) ?? []).find(x => x.id === input.id);
      const sortieDate = input.date ?? cached?.date ?? getMockSorties().find(x => x.id === input.id)?.date;
      const frozenOverride = sortieDate ? enforceMonthlyClose([sortieDate]) : null;
      if (!isLive() && !shouldUseInternalDataPlane()) {
        const arr = getMockSorties();
        const idx = arr.findIndex(x => x.id === input.id);
        if (idx < 0) throw new Error("sortie_not_found");
        const removed = arr.splice(idx, 1)[0];
        saveMockSorties();
        appendDemoAudit({
          ts: tsNow(),
          user: input.actor ?? "ops.officer",
          action: frozenOverride
            ? `Sortie delete (frozen override${input.reason ? `; ${input.reason}` : ""})`
            : input.reason
              ? `Sortie delete (${input.reason})`
              : "Sortie delete",
          target: frozenOverride
            ? `${removed.id} · ${removed.date} · ${removed.acNumber} · pc:${frozenOverride.pcName} · months:${frozenOverride.months.join(",")}`
            : `${removed.id} · ${removed.date} · ${removed.acNumber}`,
        });
        return { id: input.id };
      }
      if (shouldUseInternalDataPlane()) {
        const res = await internalSortieDeleteFetch(input.id);
        if (!res.ok && res.status !== 404) {
          throw new Error(await res.text());
        }
      } else {
        const { error } = await supabase!.from("sorties").delete().eq("id", input.id);
        if (error) throw error;
      }
      await recordAuditEvent({
        type: "sortie.delete",
        actor: input.actor,
        detail: frozenOverride
          ? {
              id: input.id, date: sortieDate,
              frozenOverride: true,
              frozenMonths: frozenOverride.months,
              pcId: frozenOverride.pcId,
              pcName: frozenOverride.pcName,
              ...(input.reason ? { reason: input.reason } : {}),
            }
          : input.reason
            ? { id: input.id, date: sortieDate, reason: input.reason }
            : { id: input.id, date: sortieDate },
      });
      return { id: input.id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sorties"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
    },
  });
}

// Helper that produces the JSONB `data` payload Supabase expects for a
// pilots row. Centralised so the restore path (below) writes exactly the
// same shape as useUpdatePilot/useCreatePilot — keeping any field in lock-
// step across the three writers.
function pilotDataPayload(p: Pilot) {
  return {
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
    rankEn: p.rankEn,
    qualifications: p.qualifications,
    qualification: p.qualification,
    qualificationSeparator: p.qualificationSeparator,
    lastSimDate: p.lastSimDate,
    otherAircraft: p.otherAircraft,
    initialHours: p.initialHours,
  };
}

// Restore a sortie that was previously edited or deleted, optionally
// restoring affected pilot rows alongside it. Used exclusively by the
// 30-second undo toast — the caller snapshots the prior state, then
// invokes this mutation if the operator clicks Undo. Currency expiries
// only ever move forward through applyCurrencyRefresh, so reverting an
// edit that bumped a date requires us to push the OLD pilot snapshot
// back; that's why this mutation accepts a `pilots` array rather than
// re-deriving it from sortie data.
export function useRestoreSortie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sortie: Sortie; pilots?: Pilot[]; actor?: string; reason?: string }) => {
      const { sortie: s, pilots = [], actor, reason } = input;
      if (!isLive()) {
        // Restore pilots first so totals/currencies snap back to their
        // pre-action values before any consumer reads them.
        const arr = getMockPilots();
        for (const p of pilots) {
          const idx = arr.findIndex(x => x.id === p.id);
          if (idx >= 0) arr[idx] = p; else arr.push(p);
        }
        const sArr = getMockSorties();
        const sIdx = sArr.findIndex(x => x.id === s.id);
        if (sIdx >= 0) sArr[sIdx] = s;
        else sArr.push(s);
        saveMockSorties();
        appendDemoAudit({
          ts: tsNow(),
          user: actor ?? "ops.officer",
          action: reason ? `Sortie restore (${reason})` : "Sortie restore (undo)",
          target: `${s.id} · ${s.date} · ${s.acNumber}`,
        });
        return s;
      }
      // Live: restore pilots one by one, then upsert the sortie.
      for (const p of pilots) {
        const { error } = await supabase!.from("pilots").update({
          name: p.name, arabic_name: p.arabicName, rank: p.rank, rank_en: p.rankEn ?? null, phone: p.phone,
          unit: p.unit, available: p.available, data: pilotDataPayload(p),
        }).eq("id", p.id);
        if (error) throw error;
      }
      const { error } = await supabase!.from("sorties").upsert({
        id: s.id,
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
          nvg: s.nvg, nvg1: s.nvg1, nvg2: s.nvg2, nvgDual: s.nvgDual,
          sim: s.sim, actual: s.actual,
          condition: s.condition, remarks: s.remarks,
          pilotExternal: s.pilotExternal, coPilotExternal: s.coPilotExternal,
          time: s.time, dual: s.dual,
          pilotPosition: s.pilotPosition, coPilotPosition: s.coPilotPosition,
          pilotSeatStatus: s.pilotSeatStatus, coPilotSeatStatus: s.coPilotSeatStatus,
          pilotIsCaptain: s.pilotIsCaptain, coPilotIsCaptain: s.coPilotIsCaptain,
          msnDuty: s.msnDuty,
          instrumentFlight: s.instrumentFlight,
          ifSim: s.ifSim, ifAct: s.ifAct, ils: s.ils, vor: s.vor,
        },
      }, { onConflict: "id" });
      if (error) throw error;
      await recordAuditEvent({
        type: "sortie.restore",
        actor,
        detail: { id: s.id, reason: reason ?? "undo" },
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

// ── notams ──────────────────────────────────────────────────────────────
// Offline persistence — same pattern as pilots/sorties so NOTAMs published
// without a backend survive a hard refresh.
const MOCK_NOTAMS_KEY = "rjaf.mock.notams";
let mockNotamsList: NotamRow[] | null = null;
function loadMockNotamsFromStorage(): NotamRow[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MOCK_NOTAMS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as NotamRow[];
  } catch { return null; }
}
function saveMockNotams(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOCK_NOTAMS_KEY, JSON.stringify(mockNotamsList ?? []));
  } catch { /* quota / private mode */ }
}
function getMockNotams(): NotamRow[] {
  if (!mockNotamsList) {
    const fromStorage = loadMockNotamsFromStorage();
    // Seed rows from mock.ts pre-date the priority field — default them
    // to "normal" so the typed shape is satisfied without reseeding the
    // demo data.
    const seeded: NotamRow[] = fromStorage ?? MOCK_NOTAMS.map(n => ({
      ...n,
      priority: ((n as { priority?: string }).priority ?? "normal") as ItemPriority,
    }));
    mockNotamsList = seeded;
    if (!fromStorage) saveMockNotams();
  }
  return mockNotamsList!;
}
// ── alerts ──────────────────────────────────────────────────────────────
// Alerts are short, time-sensitive messages pushed by squadron / flight
// commanders to pilots' phones. Same broadcast model as NOTAMs (writer
// publishes, all readers see it), but the mobile client also applies a
// per-device TTL filter so stale alerts disappear from the phone — the
// row stays on the server so the issuing commander and other pilots keep
// seeing it.
const MOCK_ALERTS_KEY = "rjaf.mock.alerts";
let mockAlertsList: AlertRow[] | null = null;
function loadMockAlertsFromStorage(): AlertRow[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MOCK_ALERTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as AlertRow[];
  } catch { return null; }
}
function saveMockAlerts(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOCK_ALERTS_KEY, JSON.stringify(mockAlertsList ?? []));
  } catch { /* quota / private mode */ }
}
function getMockAlerts(): AlertRow[] {
  if (!mockAlertsList) {
    mockAlertsList = loadMockAlertsFromStorage() ?? [];
    saveMockAlerts();
  }
  return mockAlertsList;
}
export function useAlerts(): UseQueryResult<AlertRow[]> & { data: AlertRow[] } {
  const q = useQuery<AlertRow[]>({
    queryKey: ["alerts"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalAlertsRows();
        if (!rows) return [];
        return rows.map((r) => ({
          id: String(r.id ?? ""),
          postedAt: String(r.posted_at ?? ""),
          text: String(r.body ?? ""),
          author: String(r.author ?? ""),
          priority: (String(r.priority ?? "normal") as ItemPriority),
        }));
      }
      if (!isLive()) return [...getMockAlerts()];
      const { data, error } = await supabase!
        .from("alerts").select("id, posted_at, body, author, priority")
        .order("posted_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []).map(r => ({
        id: String(r.id),
        postedAt: r.posted_at as string,
        text: r.body as string,
        author: (r.author as string) ?? "",
        priority: ((r.priority as string) ?? "normal") as ItemPriority,
      }));
    },
    initialData: !isLive() && !isLanSessionLoginEnabled() ? () => [...getMockAlerts()] : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: AlertRow[] = !isLive() && !isLanSessionLoginEnabled() ? getMockAlerts() : [];
  return { ...q, data: q.data ?? fallback } as UseQueryResult<AlertRow[]> & { data: AlertRow[] };
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { text: string; author: string; priority?: ItemPriority }) => {
      const postedAt = new Date().toISOString();
      const priority: ItemPriority = input.priority ?? "normal";
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalAlertInsert({
          posted_at: postedAt,
          body: input.text,
          author: input.author,
          priority,
        });
        if (!out.ok) throw new Error(out.error);
        const row = out.row;
        return {
          id: String(row?.id ?? "A" + Date.now()),
          postedAt: String(row?.posted_at ?? postedAt),
          text: String(row?.body ?? input.text),
          author: String(row?.author ?? input.author),
          priority: (String(row?.priority ?? priority) as ItemPriority),
        };
      }
      if (!isLive()) {
        const row: AlertRow = { id: "A" + Date.now(), postedAt, text: input.text, author: input.author, priority };
        getMockAlerts().unshift(row);
        saveMockAlerts();
        return row;
      }
      const { data, error } = await supabase!.from("alerts").insert({
        posted_at: postedAt, body: input.text, author: input.author, priority,
      }).select("id").single();
      if (error) throw error;
      const newId = String(data?.id ?? "");
      // Fire-and-forget push notification to every pilot in this squadron
      // whose phone has reminders enabled. Failures are intentionally
      // silent: the alert is already saved and visible in the app even
      // if the push leg fails (e.g. Expo down, no devices registered).
      if (newId) {
        void supabase!.functions
          .invoke("notify-alert", { body: { alertId: newId } })
          .catch((err) => console.warn("[notify-alert]", err));
      }
      return { id: newId, postedAt, text: input.text, author: input.author, priority };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: AlertRow) => {
      if (isLanSessionLoginEnabled()) {
        const out = await patchInternalAlert(a.id, { body: a.text, priority: a.priority });
        if (!out.ok) throw new Error(out.error);
        return a;
      }
      if (!isLive()) {
        const arr = getMockAlerts();
        const idx = arr.findIndex(x => x.id === a.id);
        if (idx >= 0) arr[idx] = a;
        saveMockAlerts();
        return a;
      }
      const { error } = await supabase!.from("alerts").update({ body: a.text, priority: a.priority }).eq("id", a.id);
      if (error) throw error;
      return a;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: AlertRow) => {
      if (isLanSessionLoginEnabled()) {
        const out = await deleteInternalAlert(a.id);
        if (!out.ok) throw new Error(out.error);
        return a;
      }
      if (!isLive()) {
        const arr = getMockAlerts();
        const idx = arr.findIndex(x => x.id === a.id);
        if (idx >= 0) arr.splice(idx, 1);
        saveMockAlerts();
        return a;
      }
      const { error } = await supabase!.from("alerts").delete().eq("id", a.id);
      if (error) throw error;
      return a;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
}

export function useNotams(): UseQueryResult<NotamRow[]> & { data: NotamRow[] } {
  const q = useQuery<NotamRow[]>({
    queryKey: ["notams"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalNotamsRows();
        if (!rows) return [];
        return rows.map((r) => ({
          id: String(r.notam_no ?? ""),
          pk: String(r.id ?? ""),
          date: String(r.posted_on ?? ""),
          text: String(r.body ?? ""),
          priority: (String(r.priority ?? "normal") as ItemPriority),
        }));
      }
      if (!isLive()) return [...getMockNotams()];
      const { data, error } = await supabase!
        .from("notams").select("id, notam_no, posted_on, body, priority")
        .order("posted_on", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(r => ({
        id: r.notam_no as string,
        pk: String(r.id),
        date: r.posted_on as string,
        text: r.body as string,
        priority: ((r.priority as string) ?? "normal") as ItemPriority,
      }));
    },
    initialData: !isLive() && !isLanSessionLoginEnabled() ? () => [...getMockNotams()] : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: NotamRow[] = !isLive() && !isLanSessionLoginEnabled() ? getMockNotams() : [];
  return { ...q, data: q.data ?? fallback } as UseQueryResult<NotamRow[]> & { data: NotamRow[] };
}

export function useCreateNotam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | { text: string; priority?: ItemPriority }) => {
      const text = typeof input === "string" ? input : input.text;
      const priority: ItemPriority = (typeof input === "string" ? "normal" : (input.priority ?? "normal"));
      const id = "N" + Date.now();
      const date = new Date().toISOString().slice(0, 10);
      assertValidNotamInput({ notamNo: id, body: text, postedOn: date });
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalNotamInsert({
          notam_no: id,
          posted_on: date,
          body: text,
          priority,
        });
        if (!out.ok) throw new Error(out.error);
        const row = out.row;
        return {
          id: String(row?.notam_no ?? id),
          pk: String(row?.id ?? ""),
          date: String(row?.posted_on ?? date),
          text: String(row?.body ?? text),
          priority: (String(row?.priority ?? priority) as ItemPriority),
        };
      }
      if (!isLive()) {
        const row: NotamRow = { id, date, text, priority };
        getMockNotams().unshift(row);
        saveMockNotams();
        return row;
      }
      const { data, error } = await supabase!.from("notams").insert({
        notam_no: id, posted_on: date, body: text, priority,
      }).select("id").single();
      if (error) throw error;
      const newId = String(data?.id ?? "");
      // Fire-and-forget push notification to every pilot in this squadron
      // whose phone has reminders enabled. Mirrors the notify-alert leg
      // in useCreateAlert: silent-fail so the NOTAM stays saved even if
      // Expo is momentarily unavailable.
      if (newId) {
        void supabase!.functions
          .invoke("notify-notam", { body: { notamId: newId } })
          .catch((err) => console.warn("[notify-notam]", err));
      }
      return { id, date, text, priority };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notams"] }),
  });
}

export function useUpdateNotam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (n: NotamRow) => {
      assertValidNotamInput({ notamNo: n.id, body: n.text, postedOn: n.date });
      if (isLanSessionLoginEnabled()) {
        const targetId = n.pk ?? n.id;
        const out = await patchInternalNotam(targetId, { body: n.text, priority: n.priority });
        if (!out.ok) throw new Error(out.error);
        return n;
      }
      if (!isLive()) {
        const arr = getMockNotams();
        const idx = arr.findIndex(x => x.id === n.id);
        if (idx >= 0) arr[idx] = n;
        saveMockNotams();
        return n;
      }
      // Always update by primary key (uuid) — notam_no is a text label and
      // not guaranteed unique, so matching on it could mutate sibling rows.
      if (!n.pk) throw new Error("Missing NOTAM primary key");
      const { error } = await supabase!.from("notams").update({ body: n.text, priority: n.priority }).eq("id", n.pk);
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
      if (isLanSessionLoginEnabled()) {
        const targetId = n.pk ?? n.id;
        const out = await deleteInternalNotam(targetId);
        if (!out.ok) throw new Error(out.error);
        return n;
      }
      if (!isLive()) {
        const arr = getMockNotams();
        const idx = arr.findIndex(x => x.id === n.id);
        if (idx >= 0) arr.splice(idx, 1);
        saveMockNotams();
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
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalDutyWeekRows();
        if (!rows) return [];
        return rows.map((r) => ({
          day: String(r.day ?? ""),
          mainDuty: String(r.main_duty ?? ""),
          standby: String(r.standby ?? ""),
          rcm: String(r.rcm ?? ""),
        }));
      }
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
    initialData: !isLive() && !isLanSessionLoginEnabled() ? MOCK_DUTY_WEEK : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: DutyDay[] = !isLive() && !isLanSessionLoginEnabled() ? MOCK_DUTY_WEEK : [];
  return { ...q, data: q.data ?? fallback } as UseQueryResult<DutyDay[]> & { data: DutyDay[] };
}

// ── leaves (annual breakdown) ───────────────────────────────────────────
export function useLeaves(): UseQueryResult<LeaveRow[]> & { data: LeaveRow[] } {
  const q = useQuery<LeaveRow[]>({
    queryKey: ["leaves"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const year = new Date().getFullYear();
        const rows = await fetchInternalLeavesRows(year);
        if (!rows) return [];
        return rows.map((r) => {
          const m = r.months as Record<string, number> | null | undefined;
          const months = Array.from({ length: 12 }, (_, i) => Number(m?.[String(i)] ?? 0));
          return { pilotId: String(r.pilot_id ?? ""), months, total: months.reduce((a, b) => a + b, 0) };
        });
      }
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
    initialData: !isLive() && !isLanSessionLoginEnabled() ? seedLeaves() : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: LeaveRow[] = !isLive() && !isLanSessionLoginEnabled() ? seedLeaves() : [];
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
// Offline persistence — same pattern as pilots/sorties.
const MOCK_UNAVAIL_KEY = "rjaf.mock.unavail";
let mockUnavailList: UnavailEntry[] | null = null;
function loadMockUnavailFromStorage(): UnavailEntry[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MOCK_UNAVAIL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as UnavailEntry[];
  } catch { return null; }
}
function saveMockUnavail(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOCK_UNAVAIL_KEY, JSON.stringify(mockUnavailList ?? []));
  } catch { /* quota / private mode */ }
}
function getMockUnavail(): UnavailEntry[] {
  if (!mockUnavailList) {
    const fromStorage = loadMockUnavailFromStorage();
    mockUnavailList = fromStorage ?? seedUnavailable();
    if (!fromStorage) saveMockUnavail();
  }
  return mockUnavailList;
}
export function useUnavailable(): UseQueryResult<UnavailEntry[]> & { data: UnavailEntry[] } {
  const q = useQuery<UnavailEntry[]>({
    queryKey: ["unavailable"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalUnavailableRows();
        if (!rows) return [];
        return rows.map((r) => ({
          id: String(r.id ?? ""),
          pilotId: String(r.pilot_id ?? ""),
          from: String(r.from_date ?? ""),
          to: String(r.to_date ?? ""),
          reason: String(r.reason ?? "—"),
        }));
      }
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
    initialData: !isLive() && !isLanSessionLoginEnabled() ? () => [...getMockUnavail()] : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: UnavailEntry[] = !isLive() && !isLanSessionLoginEnabled() ? getMockUnavail() : [];
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
      if (isLanSessionLoginEnabled()) {
        if (entry.from === entry.to) {
          const out = await postInternalUnavailableUpsertDay({
            pilot_id: entry.pilotId,
            day_iso: entry.from,
            reason: entry.reason,
          });
          if (!out.ok) throw new Error(out.error);
          return { ...entry, id };
        }
        const out = await postInternalUnavailableInsert({
          pilot_id: entry.pilotId,
          from_date: entry.from,
          to_date: entry.to,
          reason: entry.reason,
        });
        if (!out.ok) throw new Error(out.error);
        const row = out.row;
        if (!row) return { ...entry, id };
        return {
          id: String(row.id ?? id),
          pilotId: String(row.pilot_id ?? entry.pilotId),
          from: String(row.from_date ?? entry.from),
          to: String(row.to_date ?? entry.to),
          reason: String(row.reason ?? entry.reason ?? "—"),
        };
      }
      if (!isLive()) {
        const row = { ...entry, id };
        getMockUnavail().push(row);
        saveMockUnavail();
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
      if (isLanSessionLoginEnabled()) {
        const out = await deleteInternalUnavailableById(id);
        if (!out.ok) throw new Error(out.error);
        return { id };
      }
      if (!isLive()) {
        const arr = getMockUnavail();
        const idx = arr.findIndex(x => x.id === id);
        if (idx >= 0) arr.splice(idx, 1);
        saveMockUnavail();
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
      if (isLanSessionLoginEnabled()) {
        const today = new Date().toISOString().slice(0, 10);
        const rows = await fetchInternalScheduleRows(today);
        if (!rows) return [];
        return rows.map((r) => ({
          id: String(r.id ?? ""),
          ac: String(r.ac ?? ""),
          config: String(r.config ?? ""),
          crew: Array.isArray(r.crew) ? r.crew.map((x) => String(x ?? "")) : [],
          mission: String(r.mission ?? ""),
          takeoff: String(r.takeoff ?? ""),
          land: String(r.land ?? ""),
          fuel: String(r.fuel ?? ""),
        }));
      }
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
    initialData: !isLive() && !isLanSessionLoginEnabled() ? seedSchedule() : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: ScheduleEntry[] = !isLive() && !isLanSessionLoginEnabled() ? seedSchedule() : [];
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

// NOTE: The legacy `currencies` table read + `useCurrencies` hook were
// removed in v1.0.51 along with the rolled-up Currencies dashboard and
// Expired-After page. The `currencies` Postgres table was never written
// to by any client, so the read always returned an empty array — a silent
// data hole. Per-pilot currency expiries continue to live on the `pilots`
// row (Pilot.expiry, six-month task statuses) and are still rendered on
// the per-pilot ops page (`/currency`).

// ── deputy users (squadron) ────────────────────────────────────────────
// Offline persistence — same pattern as pilots/sorties.
const MOCK_USERS_KEY = "rjaf.mock.users";
let mockUsersList: AppUser[] | null = null;
function loadMockUsersFromStorage(): AppUser[] | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MOCK_USERS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as AppUser[];
  } catch { return null; }
}
function saveMockUsers(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(MOCK_USERS_KEY, JSON.stringify(mockUsersList ?? []));
  } catch { /* quota / private mode */ }
}
function getMockUsers(): AppUser[] {
  if (!mockUsersList) {
    const fromStorage = loadMockUsersFromStorage();
    mockUsersList = fromStorage ?? seedUsers();
    if (!fromStorage) saveMockUsers();
  }
  return mockUsersList;
}
export function useSquadronUsers(): UseQueryResult<AppUser[]> & { data: AppUser[] } {
  const useDemoSeed = !isLive() && !isLanSessionLoginEnabled();
  const q = useQuery<AppUser[]>({
    queryKey: ["users"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalSquadronUsersRows();
        if (!rows) return [];
        return rows.map((r) => ({
          id: String(r.id ?? ""),
          username: String(r.username ?? ""),
          role: (String(r.role ?? "deputy") as AppUser["role"]),
          created: String(r.created_at ?? "").slice(0, 10),
        }));
      }
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
    initialData: useDemoSeed ? () => [...getMockUsers()] : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: AppUser[] = useDemoSeed ? getMockUsers() : [];
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

// Audit retention cap: 50 entries per "page" × 50 pages = 2,500 rows max.
// Anything older falls off the end of the visible log; in live (Supabase)
// mode the rows are still in the database but the UI never asks for them
// past row 2,500 so the page stays snappy on slow ops PCs.
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGES = 50;
export const AUDIT_MAX_ROWS = AUDIT_PAGE_SIZE * AUDIT_MAX_PAGES;

export function useAuditLog(): UseQueryResult<AuditRow[]> & { data: AuditRow[] } {
  const useSeedAudit = !isLanSessionLoginEnabled() && !isLive();
  const q = useQuery<AuditRow[]>({
    queryKey: ["audit_log"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalAuditLogRows(AUDIT_MAX_ROWS);
        if (data) {
          return data.map(r => ({
            ts: new Date(String(r.occurred_at ?? new Date(0).toISOString())).toISOString().replace("T", " ").slice(0, 19),
            user: String(r.actor ?? "system"),
            action: String(r.type ?? "event"),
            target: typeof r.detail === "object" && r.detail
              ? Object.entries(r.detail as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join(" ")
              : "—",
          }));
        }
      }
      if (!isLive()) return SEED_AUDIT;
      const { data, error } = await supabase!
        .from("audit_log")
        .select("occurred_at, actor, type, detail")
        .order("occurred_at", { ascending: false })
        .limit(AUDIT_MAX_ROWS);
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
    initialData: useSeedAudit ? SEED_AUDIT : undefined,
    retry: isLive() && !isLanSessionLoginEnabled() ? 1 : false,
  });
  const fallback: AuditRow[] = useSeedAudit ? SEED_AUDIT : [];
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
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalSquadronUserCreate({
          username,
          password,
          role: "deputy",
        });
        if (!out.ok) throw new Error(`Add user failed — ${out.error}`);
        const row = out.row;
        const roleRaw = String(row?.role ?? "deputy").toLowerCase();
        const role: AppUser["role"] = roleRaw === "ops" ? "ops" : "deputy";
        return {
          id: String(row?.id ?? Date.now()),
          username: String(row?.username ?? username),
          role,
          created: String(row?.created_at ?? created).slice(0, 10),
        };
      }
      if (!isLive()) {
        const row = { id: String(Date.now()), username, role: "deputy" as const, created };
        getMockUsers().push(row);
        saveMockUsers();
        return row;
      }
      // Provisioning a Supabase auth user requires the service role key, so
      // it must run server-side. The provision-user edge function creates
      // the auth user (with squadron_id stamped into app_metadata) and the
      // matching row in public.users in one transaction-like step.
      //
      // Defence-in-depth error surfacing: when supabase.functions.invoke
      // gets a non-2xx response it returns FunctionsHttpError whose
      // .context.response holds the raw HTTP response. Reading that body
      // gives us the structured `{ error, detail }` payload instead of
      // the generic "Edge Function returned a non-2xx status code"
      // message — without this, a "no_squadron_in_token" / "forbidden"
      // / "invalid_input" reply from the edge function shows up as just
      // "Server error" in the toast, which is impossible to triage.
      const { data, error } = await supabase!.functions.invoke("provision-user", {
        body: { username, password, role: "deputy" },
      });
      if (error) {
        let detail = "";
        const resp = (error as { context?: { response?: Response } })?.context?.response;
        if (resp) {
          try {
            const txt = await resp.clone().text();
            try {
              const parsed = JSON.parse(txt) as { error?: string; detail?: string };
              const parts = [parsed?.error, parsed?.detail].filter(Boolean);
              detail = parts.length > 0
                ? `${parts.join(" — ")} (HTTP ${resp.status})`
                : `HTTP ${resp.status}: ${txt.slice(0, 240)}`;
            } catch {
              detail = `HTTP ${resp.status}: ${txt.slice(0, 240)}`;
            }
          } catch {
            detail = `HTTP ${resp.status} (no body)`;
          }
        }
        throw new Error(`Add user failed — ${detail || (error as Error).message || "edge function returned non-2xx"}`);
      }
      const payload = data as { ok?: boolean; error?: string; detail?: string; user?: { id: string } };
      if (!payload?.ok) {
        const parts = [payload?.error, payload?.detail].filter(Boolean);
        throw new Error(`Add user failed — ${parts.length > 0 ? parts.join(" — ") : "provision_failed"}`);
      }
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

      if (isLanSessionLoginEnabled()) {
        const out = await postInternalImportHistory({
          stamp,
          pilots: taggedPilots,
          sorties: taggedSorties,
          actor,
        });
        if (!out.ok) throw new Error(`Import failed: ${out.error}`);
        return {
          pilotsInserted: out.pilotsInserted,
          sortiesInserted: out.sortiesInserted,
          mode: "supabase" as const,
        };
      }

      if (!isLive()) {
        // Demo mode: persist into the in-memory mock arrays so the rest of
        // the UI immediately reflects the imported data.
        for (const p of taggedPilots) {
          const idx = MOCK_PILOTS.findIndex(x => x.id === p.id);
          if (idx >= 0) MOCK_PILOTS[idx] = p; else MOCK_PILOTS.push(p);
        }
        const sArr = getMockSorties();
        for (const s of taggedSorties) {
          const idx = sArr.findIndex(x => x.id === s.id);
          if (idx >= 0) sArr[idx] = s; else sArr.push(s);
        }
        saveMockSorties();
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
        rank_en: p.rankEn ?? null,
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

      if (isLanSessionLoginEnabled()) {
        const out = await postInternalUndoImport(stamp);
        if (!out.ok) throw new Error(`Undo failed: ${out.error}`);
        setLastImportStamp(null);
        return {
          pilotsRemoved: out.pilotsRemoved,
          sortiesRemoved: out.sortiesRemoved,
          mode: "supabase" as const,
        };
      }

      if (!isLive()) {
        const beforeP = MOCK_PILOTS.length;
        const sArr = getMockSorties();
        const beforeS = sArr.length;
        for (let i = MOCK_PILOTS.length - 1; i >= 0; i--) {
          if (MOCK_PILOTS[i].imported && MOCK_PILOTS[i].importedAt === stamp) MOCK_PILOTS.splice(i, 1);
        }
        for (let i = sArr.length - 1; i >= 0; i--) {
          if (sArr[i].imported && sArr[i].importedAt === stamp) sArr.splice(i, 1);
        }
        saveMockSorties();
        const removedP = beforeP - MOCK_PILOTS.length;
        const removedS = beforeS - sArr.length;
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

// All active (non-revoked) linked devices — used by the Settings page so ops
// can revoke any device even after the pilot has been deleted from the roster.
export interface LinkedDeviceRow {
  pilotId: string;
  linkedAt: string;
  lastSeenAt: string;
}

export function useAllLinkedDevices(): UseQueryResult<LinkedDeviceRow[]> {
  return useQuery<LinkedDeviceRow[]>({
    queryKey: ["all_linked_devices"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalActivePilotDevicesRows();
        if (!rows) return [];
        return rows.map((r) => ({
          pilotId: String(r.pilot_id ?? ""),
          linkedAt: String(r.linked_at ?? ""),
          lastSeenAt: String(r.last_seen_at ?? ""),
        }));
      }
      if (!isLive()) {
        return mockDevices
          .filter(d => d.revokedAt === null)
          .map(d => ({ pilotId: d.pilotId, linkedAt: d.linkedAt, lastSeenAt: d.lastSeenAt }));
      }
      const { data, error } = await supabase!
        .from("pilot_devices")
        .select("pilot_id, linked_at, last_seen_at")
        .is("revoked_at", null)
        .order("linked_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(r => ({
        pilotId:    String(r.pilot_id),
        linkedAt:   String(r.linked_at),
        lastSeenAt: String(r.last_seen_at),
      }));
    },
    staleTime: 10_000,
  });
}

export function usePilotLinkStatus(pilotId: string | undefined): UseQueryResult<PilotLinkStatus> {
  return useQuery<PilotLinkStatus>({
    queryKey: ["pilot_link_status", pilotId],
    enabled: Boolean(pilotId),
    queryFn: async () => {
      if (!pilotId) return { device: null, pendingCode: null };
      if (isLanSessionLoginEnabled()) {
        const out = await fetchInternalPilotLinkStatus(pilotId);
        if (!out.ok) throw new Error(out.error);
        const d = out.body.device as Record<string, unknown> | null | undefined;
        const c = out.body.pendingCode as Record<string, unknown> | null | undefined;
        return {
          device: d
            ? {
                linkedAt: String(d.linkedAt ?? ""),
                lastSeenAt: String(d.lastSeenAt ?? ""),
                revokedAt: d.revokedAt == null ? null : String(d.revokedAt),
              }
            : null,
          pendingCode: c ? { expiresAt: String(c.expiresAt ?? "") } : null,
        };
      }
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
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalIssuePilotLinkCode(pilotId);
        if (!out.ok) throw new Error(out.error);
        await recordAuditEvent({ type: "mobile.code.issued", actor, detail: { pilotId, transport: "lan_internal_api" } });
        return { code: out.code, expiresAt: out.expiresAt };
      }
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
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalRevokePilotDevices(pilotId);
        if (!out.ok) throw new Error(out.error);
        await recordAuditEvent({
          type: "mobile.device.revoked",
          actor,
          detail: { pilotId, devices: out.revoked, transport: "lan_internal_api" },
        });
        return { revoked: out.revoked };
      }
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
      qc.invalidateQueries({ queryKey: ["all_linked_devices"] });
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
  const useDemoSeed = !isLive() && !isLanSessionLoginEnabled();
  const q = useQuery<ReminderOverviewRow[]>({
    queryKey: ["reminder_overview"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalReminderOverviewRows();
        if (!rows) return [];
        return rows.map((r) => ({
          pilotId: String(r.pilotId ?? ""),
          pushEnabled: Boolean(r.pushEnabled),
          expoPushToken: r.expoPushToken == null ? null : String(r.expoPushToken),
          platform: r.platform == null ? null : String(r.platform),
          thresholds: (r.thresholds as ReminderOverviewRow["thresholds"]) ?? {},
          updatedAt: r.updatedAt == null ? null : String(r.updatedAt),
          lastSentAt: r.lastSentAt == null ? null : String(r.lastSentAt),
          lastSentCurrency: r.lastSentCurrency == null ? null : (String(r.lastSentCurrency) as CurrencyKeyName),
          lastSentThresholdDays:
            r.lastSentThresholdDays == null
              ? null
              : Number(r.lastSentThresholdDays),
          lastSentExpiry: r.lastSentExpiry == null ? null : String(r.lastSentExpiry),
        }));
      }
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
    initialData: useDemoSeed ? () => [...getMockReminderOverview()] : undefined,
    staleTime: 30_000,
  });
  return {
    ...q,
    data: q.data ?? (useDemoSeed ? getMockReminderOverview() : []),
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
  return { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" };
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
  return getMockSorties().some((x) => x.importedAt === DEMO_SEED_TAG);
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
  getMockSorties().push(...demoSorties);
  saveMockSorties();
}

export function clearDemoSeed(): void {
  if (isLive()) return;
  const arr = getMockPilots();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].importedAt === DEMO_SEED_TAG) arr.splice(i, 1);
  }
  const sArr = getMockSorties();
  for (let i = sArr.length - 1; i >= 0; i--) {
    if (sArr[i].importedAt === DEMO_SEED_TAG) sArr.splice(i, 1);
  }
  saveMockSorties();
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
    sorties: [...getMockSorties()],
    notams: [...getMockNotams()],
    unavail: [...getMockUnavail()],
    users: [...getMockUsers()],
  };
}

export function applySquadronMockState(s: SquadronMockState): void {
  if (isLive()) return;
  mockPilotsList = [...(s.pilots ?? [])];
  saveMockPilots();
  mockSortiesList = [...(s.sorties ?? [])];
  saveMockSorties();
  mockNotamsList = [...(s.notams ?? [])];
  saveMockNotams();
  mockUnavailList = [...(s.unavail ?? [])];
  saveMockUnavail();
  mockUsersList = [...(s.users ?? [])];
  saveMockUsers();
}

// ── saved duty weeks (db-backed roster archive) ─────────────────────────
// Each saved week is a single record keyed by (squadron_number, start_date)
// containing the 7-day roster as a JSON blob. In live mode this targets a
// Supabase table; in mock mode we keep it in localStorage so the data
// survives page refresh in offline / Electron deployments.
export interface SavedDutyRow {
  rank1: string; name1: string; phone1: string;
  rank2: string; name2: string; phone2: string;
}
export interface SavedDutyWeek {
  squadron: string;
  start: string; // YYYY-MM-DD
  rows: SavedDutyRow[];
  savedAt: string; // ISO
}

const SAVED_DUTY_PREFIX = "rjaf.savedDutyWeeks.";

function readMockSavedWeeks(sqn: string): SavedDutyWeek[] {
  try {
    const raw = localStorage.getItem(SAVED_DUTY_PREFIX + sqn);
    if (raw) return JSON.parse(raw) as SavedDutyWeek[];
  } catch { /* fall through */ }
  return [];
}
function writeMockSavedWeeks(sqn: string, list: SavedDutyWeek[]): void {
  try { localStorage.setItem(SAVED_DUTY_PREFIX + sqn, JSON.stringify(list)); }
  catch { /* ignore quota */ }
}

export function useSavedDutyWeeks(squadron: string): UseQueryResult<SavedDutyWeek[]> & { data: SavedDutyWeek[] } {
  const q = useQuery<SavedDutyWeek[]>({
    queryKey: ["saved_duty_weeks", squadron],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalSavedDutyWeeksRows(squadron);
        if (!rows) return [];
        return rows.map((r) => ({
          squadron: String(r.squadron ?? squadron),
          start: String(r.start_date ?? ""),
          rows: (Array.isArray(r.rows) ? r.rows : []) as SavedDutyRow[],
          savedAt: String(r.saved_at ?? new Date().toISOString()),
        }));
      }
      if (!isLive()) return readMockSavedWeeks(squadron);
      const { data, error } = await supabase!
        .from("saved_duty_weeks")
        .select("squadron, start_date, rows, saved_at")
        .eq("squadron", squadron)
        .order("start_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(r => ({
        squadron: String(r.squadron),
        start: r.start_date as string,
        rows: (r.rows as SavedDutyRow[]) ?? [],
        savedAt: (r.saved_at as string) ?? new Date().toISOString(),
      }));
    },
    initialData: !isLive() && !isLanSessionLoginEnabled() ? () => readMockSavedWeeks(squadron) : undefined,
    retry: isLive() ? 1 : false,
  });
  const fallback: SavedDutyWeek[] = !isLive() && !isLanSessionLoginEnabled() ? readMockSavedWeeks(squadron) : [];
  return { ...q, data: q.data ?? fallback } as UseQueryResult<SavedDutyWeek[]> & { data: SavedDutyWeek[] };
}

export function useSaveDutyWeek() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (entry: Omit<SavedDutyWeek, "savedAt">): Promise<SavedDutyWeek> => {
      const savedAt = new Date().toISOString();
      const full: SavedDutyWeek = { ...entry, savedAt };
      if (isLanSessionLoginEnabled()) {
        const out = await postInternalSavedDutyWeekUpsert({
          squadron: entry.squadron,
          start_date: entry.start,
          rows: entry.rows,
          saved_at: savedAt,
        });
        if (!out.ok) throw new Error(out.error);
        return full;
      }
      if (!isLive()) {
        const list = readMockSavedWeeks(entry.squadron).filter(w => w.start !== entry.start);
        list.push(full);
        list.sort((a, b) => b.start.localeCompare(a.start));
        writeMockSavedWeeks(entry.squadron, list);
        return full;
      }
      const { error } = await supabase!.from("saved_duty_weeks").upsert({
        squadron: entry.squadron,
        start_date: entry.start,
        rows: entry.rows,
        saved_at: savedAt,
      }, { onConflict: "squadron,start_date" });
      if (error) throw error;
      return full;
    },
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["saved_duty_weeks", vars.squadron] }),
  });
}

// Retention sweep: hard-delete every saved week with start_date older than
// (today - 1 year) for the given squadron. Returns the count removed so the
// UI can flash "archived N" feedback.
export function useDeleteOldDutyWeeks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (squadron: string): Promise<number> => {
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      if (isLanSessionLoginEnabled()) {
        const out = await deleteInternalOldSavedDutyWeeks(squadron, cutoffIso);
        if (!out.ok) throw new Error(out.error);
        return out.removed;
      }
      if (!isLive()) {
        const list = readMockSavedWeeks(squadron);
        const kept = list.filter(w => w.start >= cutoffIso);
        const removed = list.length - kept.length;
        if (removed > 0) writeMockSavedWeeks(squadron, kept);
        return removed;
      }
      const { data, error } = await supabase!
        .from("saved_duty_weeks").delete()
        .eq("squadron", squadron).lt("start_date", cutoffIso)
        .select("start_date");
      if (error) throw error;
      return (data ?? []).length;
    },
    onSuccess: (_n, sqn) => qc.invalidateQueries({ queryKey: ["saved_duty_weeks", sqn] }),
  });
}
