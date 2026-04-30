import { useEffect, useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import {
  usePilots,
  useSorties,
  useCreateSortie,
  useUpdateSortie,
  useDeleteSortie,
  useRestoreSortie,
  deriveSortieBuckets,
} from "@/lib/squadron-data";
import { useToast } from "@/hooks/use-toast";
import type { Pilot, Sortie } from "@/lib/mock";
import { SortieDiffDialog } from "@/components/SortieDiffDialog";
import { showUndo } from "@/lib/undo-store";
import { Plane, Pencil, Trash2, X, UserPlus, User, Lock, Unlock } from "lucide-react";
import { useRegisteredPCs, useSubmitPending } from "@/lib/cross-pc";
import { useAuth } from "@/lib/auth";
import { seatLabelFromRoleScope } from "@/lib/types";
import { loadSquadronDefaults, hydrateSquadronDefaultsFromDb } from "@/lib/squadron-defaults";
import type { ExternalPilotRef } from "@/lib/mock";
import { useFrozenAccess } from "@/lib/monthly-close";
import { analyzeSortieDraft } from "@/lib/add-sortie-smart";

// Simple Add Sortie form — mirrors the legacy mobile app's logic:
//   • One Position toggle: which seat is in 1st PLT (the other = 2nd PLT)
//   • One "Count as Captain" checkbox (only credited when 1st PLT)
//   • Day / Night condition + NVG checkbox (NVG disabled when Day)
//   • Single Time field + independent Dual hours
//   • Optional Instrument Flight section: SIM / Actual / ILS / VOR
//
// Hours always flow to the right pilot via per-seat pilotIsCaptain /
// coPilotIsCaptain flags consumed by lib/calculations.ts.

const SORTIE_TYPES = [
  "MSN DAY", "MSN NIGHT", "MSN NVG",
  "TRG DAY", "TRG NIGHT", "TRG NVG",
  "NAV", "NAV DAY", "NAV NIGHT",
  "FCF", "ACADEMIC", "EMER", "INSTR",
  "CHECK RIDE", "TRANSPORT", "SAR", "MEDEVAC",
  // April 2026 field-use additions. These six "special" types ALWAYS
  // require at least one seat to be flown as Dual (instructor + student),
  // and the submit handler enforces that (see DUAL_REQUIRED_TYPES below).
  "IRT", "COURSE DAY", "COURSE NVG", "COURSE NIGHT",
  "EMERGENCY TRAINING", "STAND EVAL",
  "Other…",
];

// Sortie types where one of the two seats MUST carry status=Dual on
// submit. Comparison is case-insensitive so a custom "Other…" value typed
// as "irt" or "Stand Eval" still trips the rule.
const DUAL_REQUIRED_TYPES = new Set([
  "IRT", "COURSE DAY", "COURSE NVG", "COURSE NIGHT",
  "EMERGENCY TRAINING", "STAND EVAL",
]);
function isDualRequired(t: string): boolean {
  return DUAL_REQUIRED_TYPES.has(t.trim().toUpperCase());
}

type Condition = "Day" | "Night";
// Each seat carries its own status — Pilot can be 1st PLT while Co-Pilot is
// in Dual instruction, etc. Captain flag is also per-seat: a Pilot logged as
// 2nd PLT can still claim CAP hours if he holds the captain qualification on
// the airframe. This matches the April 2026 ops rebuild where the old
// "single firstSeat toggle + single captain checkbox" was found to mis-credit
// hours whenever the two seats had different statuses (e.g. dual eval).
type SeatStatus = "1st" | "2nd" | "Dual";

interface SeatState {
  id: string;
  status: SeatStatus;
  captain: boolean;
  // External (guest) pilot details. When `external` is set, the seat is
  // a guest from another squadron — `id` is left blank and the seat's
  // hours don't credit a local roster pilot. If the guest's home squadron
  // is in the cross-PC registry, `homePcId` carries that PC's id so the
  // submit handler can route a pending entry to that squadron.
  external?: ExternalPilotRef & { homePcId?: string; militaryNumber?: string };
}

interface FormState {
  id: string | null;
  date: string;
  acType: string;
  acNumber: string;
  pilot: SeatState;
  coPilot: SeatState;
  sortieType: string;
  sortieTypeOther: string;
  msnDuty: string;
  condition: Condition;
  nvg: boolean;                // valid only when Night — fully separate from Night currency
  time: string;
  dualHours: string;
  // Instrument Flight section
  instrumentFlight: boolean;
  ifSim: string;
  ifAct: string;
  ils: string;
  vor: string;
  remarks: string;
}

const blankSeat = (): SeatState => ({ id: "", status: "1st", captain: false });

const blankForm = (): FormState => ({
  id: null,
  date: new Date().toISOString().slice(0, 10),
  acType: "UH-60M",
  acNumber: "",
  pilot: { ...blankSeat(), status: "1st" },
  coPilot: { ...blankSeat(), status: "2nd" },
  sortieType: "TRG DAY",
  sortieTypeOther: "",
  msnDuty: "",
  condition: "Day",
  nvg: false,
  time: "",
  dualHours: "",
  instrumentFlight: false,
  ifSim: "",
  ifAct: "",
  ils: "",
  vor: "",
  remarks: "",
});

export default function AddSortie() {
  const { t, rankOf } = useI18n();
  const { toast } = useToast();
  const { data: PILOTS } = usePilots();
  const { data: SORTIES } = useSorties();
  const create = useCreateSortie();
  const update = useUpdateSortie();
  const del = useDeleteSortie();

  const auth = useAuth();
  // Squadron-level defaults: the operator-editable list of airframes the
  // squadron flies + the primary airframe used as the seed for new entries.
  // A NO.5 SQDN install with UH-60AIL configured shows that as the default
  // here; an AH-1F squadron sees AH-1F. Empty when the squadron has not
  // run the Setup Wizard — the form is then disabled.
  const [defaultsRev, setDefaultsRev] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void hydrateSquadronDefaultsFromDb(auth.squadron?.number).then(ok => {
      if (!cancelled && ok) setDefaultsRev(r => r + 1);
    });
    return () => { cancelled = true; };
  }, [auth.squadron?.number]);
  const sqdnDefaults = useMemo(
    () => loadSquadronDefaults(auth.squadron?.number),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.squadron?.number, defaultsRev],
  );
  const acTypeOptions = sqdnDefaults.airframes;
  const noAircraftConfigured = acTypeOptions.length === 0;
  const [form, setForm] = useState<FormState>(() => ({
    ...blankForm(),
    acType: sqdnDefaults.primaryAirframe || acTypeOptions[0] || "",
  }));
  const [confirmDel, setConfirmDel] = useState<Sortie | null>(null);
  // Pending edit waiting for the change-summary dialog. We capture both
  // the original record (for the diff + undo snapshot) and the proposed
  // new payload (already fully bucketed) so the dialog can render the
  // diff and the confirm handler can fire the mutation directly.
  const [pendingEdit, setPendingEdit] = useState<{ before: Sortie; after: Sortie } | null>(null);
  const frozen = useFrozenAccess();
  const lockedMessage =
    "Hours older than 12 months are frozen. Ask the super admin to authorize this PC from the Super Admin page.";
  const restore = useRestoreSortie();
  const mySquadronId = auth.squadron?.name ?? "";
  const { data: registeredPCs = [] } = useRegisteredPCs();
  const submitPending = useSubmitPending();

  // Seed pilot/co-pilot defaults once roster loads.
  useEffect(() => {
    if (!form.pilot.id && PILOTS[0]) {
      setForm(f => ({
        ...f,
        pilot: { ...f.pilot, id: PILOTS[0].id },
        coPilot: { ...f.coPilot, id: PILOTS[1]?.id ?? PILOTS[0].id },
      }));
    }
  }, [PILOTS, form.pilot.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));
  const setSeat = (which: "pilot" | "coPilot", patch: Partial<SeatState>) =>
    setForm(f => ({ ...f, [which]: { ...f[which], ...patch } }));

  // v1.1.35: pilot/co-pilot autofill defaults to the short Flight Name
  // when the pilot has one (e.g. "Falcon 1") — operators write
  // schedules with call signs, not full English names. Falls back to
  // "Rank Full Name" when Flight Name is empty. Saved value is the
  // pilot id, unchanged, so existing sortie rows are not affected.
  const pilotOpts = useMemo(
    () => PILOTS.map(p => ({
      value: p.id,
      label: p.flightName?.trim() || `${rankOf(p)} ${p.name}`,
    })),
    [PILOTS],
  );
  const pilotById = (id: string) => PILOTS.find(p => p.id === id);

  const todaySorties = useMemo(() => {
    const list = SORTIES.filter(s => s.date === form.date);
    return [...list].sort((a, b) => (a.id < b.id ? 1 : -1));
  }, [SORTIES, form.date]);

  const totals = useMemo(() => {
    let s = 0, h = 0;
    for (const r of todaySorties) {
      s += 1;
      const t = Number(r.time) || Number(r.actual) ||
        Number(r.day1 || 0) + Number(r.day2 || 0) + Number(r.dayDual || 0) +
        Number(r.night1 || 0) + Number(r.night2 || 0) + Number(r.nightDual || 0) +
        Number(r.nvg || 0);
      h += Number.isFinite(t) ? t : 0;
    }
    return { s, h: +h.toFixed(1) };
  }, [todaySorties]);

  const smartSignals = useMemo(() => {
    const time = parseFloat(form.time || "0") || 0;
    const dual = parseFloat(form.dualHours || "0") || 0;
    const sortieType = form.sortieType === "Other…"
      ? (form.sortieTypeOther.trim() || "OTHER")
      : form.sortieType;
    return analyzeSortieDraft({
      date: form.date,
      acType: form.acType,
      acNumber: form.acNumber,
      sortieType,
      condition: form.condition,
      nvg: form.nvg,
      time,
      dualHours: dual,
      instrumentFlight: form.instrumentFlight,
      ifSim: parseFloat(form.ifSim || "0") || 0,
      ifAct: parseFloat(form.ifAct || "0") || 0,
    }, todaySorties);
  }, [form, todaySorties]);

  const resetForm = () =>
    setForm(f => ({
      ...blankForm(),
      date: f.date, acType: f.acType, acNumber: f.acNumber,
      pilot: f.pilot, coPilot: f.coPilot,
    }));

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!form.acType.trim()) {
      toast({ title: "A/C Type required", variant: "destructive" });
      return;
    }
    const time = parseFloat(form.time || "0");
    const dual = parseFloat(form.dualHours || "0");
    if (!(time > 0) && !(dual > 0)) {
      toast({ title: "Hours required", description: "Enter Time and/or Dual hours.", variant: "destructive" });
      return;
    }
    if (
      !form.pilot.external &&
      !form.coPilot.external &&
      form.pilot.id === form.coPilot.id &&
      form.pilot.id
    ) {
      toast({ title: "Pilot and Co-Pilot are the same", variant: "destructive" });
      return;
    }
    if (form.pilot.external && !form.pilot.external.name.trim()) {
      toast({ title: "Guest pilot name required", variant: "destructive" });
      return;
    }
    if (form.coPilot.external && !form.coPilot.external.name.trim()) {
      toast({ title: "Guest co-pilot name required", variant: "destructive" });
      return;
    }
    // Require the visiting pilot's military number on guest seats so the
    // home-squadron matcher can credit the correct person. Without it the
    // downstream flow falls back to risky name-only matching, which can
    // mis-credit hours when two pilots share a similar name.
    if (form.pilot.external && !(form.pilot.external.militaryNumber ?? "").trim()) {
      toast({
        title: "Guest pilot military number required",
        description: "Ask the visiting pilot for their military number so credit goes to the right person.",
        variant: "destructive",
      });
      return;
    }
    if (form.coPilot.external && !(form.coPilot.external.militaryNumber ?? "").trim()) {
      toast({
        title: "Guest co-pilot military number required",
        description: "Ask the visiting pilot for their military number so credit goes to the right person.",
        variant: "destructive",
      });
      return;
    }
    if (smartSignals.errors.length > 0) {
      toast({
        title: "Sortie consistency check failed",
        description: smartSignals.errors[0],
        variant: "destructive",
      });
      return;
    }

    // The condition that drives bucketing: NVG overrides Night when checked.
    // Day/Night/NVG are independent currencies — the auto-bump in
    // squadron-data.ts only refreshes the matching expiry, never both.
    const cond: "Day" | "Night" | "NVG" =
      form.condition === "Day" ? "Day" : form.nvg ? "NVG" : "Night";

    // Per-seat status: each pilot independently flagged as 1st PLT, 2nd PLT,
    // or Dual. The sortie-level pilotPosition/coPilotPosition fields keep the
    // raw selection so reports can break down credit by seat. The legacy
    // "1st"/"2nd" enum is preserved by mapping Dual → "1st" on the canonical
    // pilotPosition (the seat that owns the captain flag), while the actual
    // dual flag controls bucket routing below.
    const pilotPosition: "1st" | "2nd" = form.pilot.status === "2nd" ? "2nd" : "1st";
    const coPilotPosition: "1st" | "2nd" = form.coPilot.status === "1st" ? "1st" : "2nd";

    // Captain credit is per-seat — a 2nd PLT can still hold CAP if qualified.
    const pilotIsCaptain = !!form.pilot.captain;
    const coPilotIsCaptain = !!form.coPilot.captain;

    // Bucket routing: the sortie-level Dual marker fires whenever EITHER seat
    // is in Dual status. Hours are split into a non-dual portion (`time`)
    // attributed to whichever seat is "1st" and a dual portion attributed to
    // the dual buckets — so a (Pilot=1st PLT, Co-Pilot=Dual) sortie correctly
    // accumulates flight + dual instruction hours on the same record.
    const eitherDual =
      form.pilot.status === "Dual" ||
      form.coPilot.status === "Dual" ||
      isDualRequired(
        form.sortieType === "Other…"
          ? (form.sortieTypeOther.trim() || "OTHER")
          : form.sortieType,
      );
    // Single seat-aware routing pass — both seats' statuses route the same
    // flight time into their respective bucket. The legacy "extra dual hours"
    // input is folded into the dual bucket via a second pass with both seats
    // forced to Dual (covers the case where a sortie logged additional dual
    // instruction time beyond the primary block).
    const sortieType = form.sortieType === "Other…"
      ? form.sortieTypeOther.trim() || "OTHER"
      : form.sortieType;

    // Special-sortie DUAL rule: IRT, the three COURSE types (DAY/NVG/NIGHT),
    // EMERGENCY TRAINING and STAND EVAL are instructional flights. The
    // captain's seat keeps whatever status the operator picked, but the
    // CO-PILOT's hours must always be credited as DUAL regardless of the
    // co-pilot's rank. We force it here at bucketing time so the totals,
    // currencies and reports reflect dual-instruction time correctly.
    const dualRequired = isDualRequired(sortieType);
    const effectiveCoPilotStatus = dualRequired ? "Dual" : form.coPilot.status;
    const totalTime = time + dual;
    const merged = deriveSortieBuckets({
      time: totalTime,
      condition: cond,
      pilotStatus: form.pilot.status,
      coPilotStatus: effectiveCoPilotStatus,
    });

    const ifSim = parseFloat(form.ifSim || "0") || 0;
    const ifAct = parseFloat(form.ifAct || "0") || 0;
    const payload: Omit<Sortie, "id"> = {
      date: form.date,
      acType: form.acType,
      acNumber: form.acNumber.trim(),
      pilotId: form.pilot.external ? "" : form.pilot.id,
      coPilotId: form.coPilot.external ? "" : form.coPilot.id,
      pilotExternal: form.pilot.external
        ? { name: form.pilot.external.name.trim(), squadron: form.pilot.external.squadron.trim() }
        : undefined,
      coPilotExternal: form.coPilot.external
        ? { name: form.coPilot.external.name.trim(), squadron: form.coPilot.external.squadron.trim() }
        : undefined,
      sortieType,
      name: form.msnDuty.trim() || sortieType,
      condition: cond,
      remarks: form.remarks.trim() || undefined,
      day1: merged.day1, day2: merged.day2, dayDual: merged.dayDual,
      night1: merged.night1, night2: merged.night2, nightDual: merged.nightDual,
      nvg: merged.nvg,
      nvg1: merged.nvg1 || undefined,
      nvg2: merged.nvg2 || undefined,
      nvgDual: merged.nvgDual || undefined,
      sim: ifSim, // legacy `sim` = IF SIM hours
      actual: time + dual,
      time: time + dual,
      dual: dual > 0 || eitherDual,
      pilotPosition,
      coPilotPosition,
      pilotSeatStatus: form.pilot.status,
      // For special sortie types (IRT/Course/Emergency/Stand Eval) the
      // co-pilot is treated as Dual no matter what the operator picked,
      // so the persisted seat status reflects how hours were credited.
      coPilotSeatStatus: effectiveCoPilotStatus,
      pilotIsCaptain,
      coPilotIsCaptain,
      msnDuty: form.msnDuty.trim() || undefined,
      instrumentFlight: form.instrumentFlight,
      ifSim: form.instrumentFlight ? ifSim : undefined,
      ifAct: form.instrumentFlight ? ifAct : undefined,
      ils: form.instrumentFlight ? (parseInt(form.ils || "0") || 0) : undefined,
      vor: form.instrumentFlight ? (parseInt(form.vor || "0") || 0) : undefined,
    };
    // Edits go through the change-summary dialog first. The dialog shows
    // the operator a side-by-side diff and, after they confirm, fires the
    // actual mutation + registers a 30-second undo. New entries skip the
    // diff (nothing to compare against) and commit directly.
    if (form.id) {
      const original = SORTIES.find(x => x.id === form.id);
      if (original) {
        setPendingEdit({ before: original, after: { ...payload, id: form.id } as Sortie });
        return;
      }
    }
    try {
      let savedId: string | null = form.id;
      if (form.id) {
        await update.mutateAsync({ sortie: { ...payload, id: form.id } as Sortie, actor: auth.user?.username });
        toast({ title: "Sortie updated" });
      } else {
        const created = await create.mutateAsync(payload);
        savedId = (created as Sortie | undefined)?.id ?? null;
        toast({ title: "Sortie added" });
      }
      // Cross-PC: when a guest seat carries a `homePcId`, push a pending
      // entry to that squadron's queue. Their ops officer reviews it on the
      // Pending Approvals page; on accept it cascades through their
      // useCreateSortie pipeline and bumps totals/currencies/captain hours.
      const seatsForPending: { which: "pilot" | "coPilot"; seat: typeof form.pilot }[] = [];
      if (form.pilot.external?.homePcId) seatsForPending.push({ which: "pilot", seat: form.pilot });
      if (form.coPilot.external?.homePcId) seatsForPending.push({ which: "coPilot", seat: form.coPilot });
      for (const { which, seat: s } of seatsForPending) {
        if (!s.external?.homePcId) continue;
        try {
          await submitPending.mutateAsync({
            hostingSquadronId: mySquadronId,
            hostingSquadronName: mySquadronId,
            homeSquadronId: s.external.homePcId,
            homeSquadronName: s.external.squadron,
            guestPilotName: s.external.name,
            guestPilotMilitaryNumber: s.external.militaryNumber,
            guestSeat: which,
            submittedBy: auth.user?.username ?? mySquadronId,
            submittedByDisplayName: auth.user?.displayName,
            submittedByRank: auth.user?.rank,
            submittedBySeatLabel: seatLabelFromRoleScope(auth.user?.role, auth.user?.scope),
            sortie: payload,
          });
        } catch {
          toast({ title: "Pending entry not sent", description: `Could not reach ${s.external.squadron}.`, variant: "destructive" });
        }
      }
      if (seatsForPending.length > 0) {
        toast({ title: `Sent to ${seatsForPending.length} squadron${seatsForPending.length > 1 ? "s" : ""} for approval` });
      }
      resetForm();
    } catch (err) {
      // The frozen-records gate throws `month_frozen` when this PC isn't
      // authorized to write into a date older than 12 months. Surface that
      // as a friendly message so the operator knows what to ask for.
      if (err instanceof Error && err.message === "month_frozen") {
        toast({ title: "Frozen records", description: lockedMessage, variant: "destructive" });
      }
      /* other errors surfaced by global error toast */
    }
  };

  const loadForEdit = (s: Sortie) => {
    const cond: Condition = s.condition === "Day" ? "Day" : "Night";
    const nvg = s.condition === "NVG";
    // Prefer the authoritative seat-status fields written by the rebuilt
    // Add Sortie page. Only fall back to legacy reconstruction (pilotPosition
    // / coPilotPosition + dual flag) for historical records that pre-date
    // the per-seat schema. The legacy fallback can't tell which seat was the
    // instructor, so it marks the 2nd PLT seat as Dual by default — the ops
    // officer can flip it before re-saving.
    const pilotStatus: SeatStatus = s.pilotSeatStatus
      ?? (s.dual
        ? (s.pilotPosition === "2nd" ? "Dual" : "1st")
        : (s.pilotPosition === "2nd" ? "2nd" : "1st"));
    const coPilotStatus: SeatStatus = s.coPilotSeatStatus
      ?? (s.dual
        ? (s.coPilotPosition === "1st" ? "1st" : "Dual")
        : (s.coPilotPosition === "1st" ? "1st" : "2nd"));
    // For seat-aware records the single `time` field is the authoritative
    // flight duration; treat it as non-dual unless the legacy schema split
    // it across `time` + dual hours.
    const seatAware = !!(s.pilotSeatStatus || s.coPilotSeatStatus);
    const dualHours = seatAware ? 0 : (s.dual ? (s.dayDual + s.nightDual + (s.nvgDual ?? 0)) : 0);
    const nonDualHours = seatAware
      ? ((s.time ?? s.actual) || 0)
      : (((s.time ?? s.actual) || 0) - dualHours);
    setForm({
      id: s.id,
      date: s.date,
      acType: s.acType || "UH-60M",
      acNumber: s.acNumber || "",
      pilot: {
        id: s.pilotId,
        status: pilotStatus,
        captain: !!s.pilotIsCaptain,
        external: s.pilotExternal
          ? { ...s.pilotExternal, homePcId: registeredPCs.find(p => p.squadronName === s.pilotExternal!.squadron)?.id }
          : undefined,
      },
      coPilot: {
        id: s.coPilotId,
        status: coPilotStatus,
        captain: !!s.coPilotIsCaptain,
        external: s.coPilotExternal
          ? { ...s.coPilotExternal, homePcId: registeredPCs.find(p => p.squadronName === s.coPilotExternal!.squadron)?.id }
          : undefined,
      },
      sortieType: SORTIE_TYPES.includes(s.sortieType) ? s.sortieType : "Other…",
      sortieTypeOther: SORTIE_TYPES.includes(s.sortieType) ? "" : s.sortieType,
      msnDuty: s.msnDuty ?? s.name ?? "",
      condition: cond,
      nvg,
      time: nonDualHours > 0 ? String(nonDualHours) : "",
      dualHours: dualHours > 0 ? String(dualHours) : "",
      instrumentFlight: !!s.instrumentFlight,
      ifSim: s.ifSim != null ? String(s.ifSim) : "",
      ifAct: s.ifAct != null ? String(s.ifAct) : "",
      ils: s.ils != null ? String(s.ils) : "",
      vor: s.vor != null ? String(s.vor) : "",
      remarks: s.remarks || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Snapshot the pilots that a sortie touches so an undo can restore both
  // their totals and their currency expiries (which only ever move forward
  // through applyCurrencyRefresh).
  const snapshotAffectedPilots = (s: Sortie): Pilot[] => {
    const ids = [s.pilotId, s.coPilotId].filter(Boolean);
    return ids
      .map(id => PILOTS.find(p => p.id === id))
      .filter((p): p is Pilot => !!p)
      .map(p => structuredClone(p));
  };

  const registerSortieUndo = (snapshot: { sortie: Sortie; pilots: Pilot[] }, label: string) => {
    showUndo({
      message: label,
      undo: async () => {
        try {
          await restore.mutateAsync({
            sortie: snapshot.sortie,
            pilots: snapshot.pilots,
            actor: auth.user?.username,
            reason: "undo",
          });
          toast({ title: "Action undone" });
        } catch {
          toast({ title: "Undo failed", variant: "destructive" });
        }
      },
    });
  };

  const confirmEdit = async () => {
    if (!pendingEdit) return;
    const { before, after } = pendingEdit;
    const pilotsBefore = snapshotAffectedPilots(before);
    try {
      await update.mutateAsync({ sortie: after, actor: auth.user?.username });
      registerSortieUndo({ sortie: before, pilots: pilotsBefore }, "Sortie edited.");
      setPendingEdit(null);
      resetForm();
    } catch {
      /* surfaced by global error toast */
    }
  };

  const doDelete = async () => {
    if (!confirmDel) return;
    const snapshotSortie = confirmDel;
    const pilotsBefore = snapshotAffectedPilots(snapshotSortie);
    try {
      await del.mutateAsync({ id: snapshotSortie.id, date: snapshotSortie.date, actor: auth.user?.username });
      registerSortieUndo({ sortie: snapshotSortie, pilots: pilotsBefore }, "Sortie deleted.");
    } finally {
      setConfirmDel(null);
    }
  };

  // Frozen-window gating for the Recent Sorties list. When a row's date is
  // older than 12 months and this PC isn't on the super admin's authorized
  // list, edit/delete are disabled with a tooltip pointing the operator to
  // the Super Admin page.
  const tryEdit = (s: Sortie) => {
    if (!frozen.canEdit(s.date)) {
      toast({ title: "Frozen records", description: lockedMessage, variant: "destructive" });
      return;
    }
    loadForEdit(s);
  };
  const tryDelete = (s: Sortie) => {
    if (!frozen.canEdit(s.date)) {
      toast({ title: "Frozen records", description: lockedMessage, variant: "destructive" });
      return;
    }
    setConfirmDel(s);
  };

  const seatLabel = (id: string, ext?: { name: string }) => {
    if (ext?.name) return ext.name;
    const p = pilotById(id);
    if (!p) return id || "—";
    return p.flightName?.trim() || `${rankOf(p)} ${p.name}`;
  };

  return (
    <div>
      <PageHead title={t("nav_addsortie")} subtitle="New flight entry" />

      {noAircraftConfigured && (
        <Card className="mb-4 border-amber-400/40 bg-amber-500/10">
          <div className="flex items-start gap-2 text-sm text-amber-100" data-testid="banner-no-aircraft">
            <Plane className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="font-semibold">No aircraft configured for this squadron yet.</div>
              <div className="text-xs text-amber-200/90 mt-0.5">
                You can still add sorties now by typing A/C Type manually.
                For consistent dropdown options across pages, add your squadron
                airframes under Monthly Report → Defaults.
              </div>
            </div>
            <a
              href="/monthly-report/defaults"
              className="px-2.5 py-1 rounded-md bg-amber-500/30 border border-amber-400/50 text-amber-100 text-xs font-semibold"
              data-testid="link-open-squadron-defaults"
            >
              Open Squadron Defaults
            </a>
          </div>
        </Card>
      )}

      <Card className="mb-4">
        <form onSubmit={submit} className="space-y-3" data-testid="form-add-sortie">
          <fieldset className="space-y-3 contents">
          {/* Row 1: flight info */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Mini label="Date" type="date" value={form.date} onChange={v => set("date", v)} />
            {noAircraftConfigured ? (
              <Mini
                label="A/C Type"
                value={form.acType}
                onChange={v => set("acType", v)}
                placeholder="e.g. UH-60M"
              />
            ) : (
              <MiniSelect label="A/C Type" value={form.acType} onChange={v => set("acType", v)} opts={acTypeOptions} />
            )}
            <Mini label="A/C No" value={form.acNumber} onChange={v => set("acNumber", v)} placeholder="e.g. 832" />
            <MiniSelect label="Sortie Type" value={form.sortieType} onChange={v => set("sortieType", v)} opts={SORTIE_TYPES} />
            <Mini label="Time (hrs)" type="number" step="0.1" value={form.time} onChange={v => set("time", v)} placeholder="0.0" />
            <Mini label="Dual (hrs)" type="number" step="0.1" value={form.dualHours} onChange={v => set("dualHours", v)} placeholder="0.0" />
          </div>

          {form.sortieType === "Other…" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Mini label="Custom sortie type" value={form.sortieTypeOther} onChange={v => set("sortieTypeOther", v)} placeholder="Type your own…" />
              <Mini label="MSN / Duty" value={form.msnDuty} onChange={v => set("msnDuty", v)} placeholder="Mission name / duty" />
            </div>
          )}
          {form.sortieType !== "Other…" && (
            <Mini label="MSN / Duty (optional)" value={form.msnDuty} onChange={v => set("msnDuty", v)} placeholder="Mission name / duty" />
          )}

          {/* Crew row — each seat carries its own pilot, status (1st/2nd/Dual)
              and captain flag. The two seats are fully independent. */}
          <div className="grid lg:grid-cols-2 gap-3">
            <SeatPanel
              label="Pilot"
              testIdPrefix="pilot"
              seat={form.pilot}
              opts={pilotOpts}
              onChange={patch => setSeat("pilot", patch)}
              registeredPCs={registeredPCs}
              mySquadronId={mySquadronId}
            />
            <SeatPanel
              label="Co-Pilot"
              testIdPrefix="copilot"
              seat={form.coPilot}
              opts={pilotOpts}
              onChange={patch => setSeat("coPilot", patch)}
              registeredPCs={registeredPCs}
              mySquadronId={mySquadronId}
            />
          </div>

          {/* Condition row */}
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Condition</div>
            <div className="flex gap-2" data-testid="condition-selector">
              <button
                type="button"
                onClick={() => { set("condition", "Day"); set("nvg", false); }}
                data-testid="button-condition-day"
                className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                  form.condition === "Day"
                    ? "bg-amber-400/20 border-amber-400 text-amber-200"
                    : "bg-secondary border-border text-muted-foreground"
                }`}
              >DAY</button>
              <button
                type="button"
                onClick={() => set("condition", "Night")}
                data-testid="button-condition-night"
                className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                  form.condition === "Night"
                    ? "bg-indigo-500/20 border-indigo-400 text-indigo-200"
                    : "bg-secondary border-border text-muted-foreground"
                }`}
              >NIGHT</button>
            </div>
            <label
              className={`inline-flex items-center gap-1.5 text-xs cursor-pointer select-none px-3 py-1.5 rounded-md border ${
                form.condition === "Day"
                  ? "opacity-40 cursor-not-allowed border-border bg-secondary"
                  : form.nvg
                  ? "bg-rose-500/20 border-rose-400 text-rose-200"
                  : "bg-secondary border-border"
              }`}
              data-testid="toggle-nvg"
            >
              <input
                type="checkbox"
                checked={form.nvg}
                disabled={form.condition === "Day"}
                onChange={e => set("nvg", e.target.checked)}
                className="h-3.5 w-3.5 accent-rose-400"
              />
              <span className="font-semibold">NVG</span>
            </label>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {form.id && (
                <button
                  type="button"
                  onClick={() => setForm(blankForm())}
                  className="px-3 py-2 rounded-md bg-secondary border border-border text-xs font-medium inline-flex items-center gap-1"
                  data-testid="button-cancel-edit"
                >
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
              )}
              <button
                disabled={create.isPending || update.isPending}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                data-testid="button-submit-sortie"
              >
                <Plane className="h-4 w-4" />
                {form.id ? "Save changes" : "ADD"}
              </button>
            </div>
          </div>

          {(smartSignals.errors.length > 0 || smartSignals.warnings.length > 0) && (
            <div
              className={`rounded-md border p-2 text-xs space-y-1 ${
                smartSignals.errors.length > 0
                  ? "border-destructive/60 bg-destructive/10 text-rose-200"
                  : "border-amber-400/40 bg-amber-500/10 text-amber-100"
              }`}
              data-testid="sortie-smart-signals"
            >
              <div className="font-semibold">
                {smartSignals.errors.length > 0 ? "Fix before saving" : "Smart checks"}
              </div>
              {smartSignals.errors.map((m, i) => (
                <div key={`err-${i}`}>- {m}</div>
              ))}
              {smartSignals.warnings.map((m, i) => (
                <div key={`warn-${i}`}>- {m}</div>
              ))}
            </div>
          )}

          {/* Instrument Flight section */}
          <div className="border border-border rounded-md p-3 bg-sky-500/5">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none mb-2" data-testid="toggle-instrument">
              <input
                type="checkbox"
                checked={form.instrumentFlight}
                onChange={e => set("instrumentFlight", e.target.checked)}
                className="h-4 w-4 accent-sky-400"
              />
              <span className="text-xs font-semibold uppercase tracking-wider">Instrument Flight</span>
            </label>
            {form.instrumentFlight && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Mini label="SIM (hrs)"   type="number" step="0.1" value={form.ifSim} onChange={v => set("ifSim", v)} placeholder="0.0" />
                <Mini label="Actual (hrs)" type="number" step="0.1" value={form.ifAct} onChange={v => set("ifAct", v)} placeholder="0.0" />
                <Mini label="ILS approaches" type="number" step="1" value={form.ils} onChange={v => set("ils", v)} placeholder="0" />
                <Mini label="VOR approaches" type="number" step="1" value={form.vor} onChange={v => set("vor", v)} placeholder="0" />
              </div>
            )}
          </div>

          {/* Remarks */}
          <div>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Remarks</span>
              <textarea
                value={form.remarks}
                onChange={e => set("remarks", e.target.value)}
                placeholder="Notes (weather, aborts, maintenance, etc.)"
                rows={2}
                data-testid="input-remarks"
                className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-xs resize-none"
              />
            </label>
          </div>
          </fieldset>
        </form>
      </Card>

      {/* Sortie list */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">{sqdnDefaults.sortieLogLabel || "QREG"} · {form.date} · {form.acType}</div>
          <div className="text-[11px] text-muted-foreground">All sorties for this date — click <span className="text-primary">edit</span> to load back into the form.</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-1.5 pr-2">DATE</th>
                <th className="pr-2">A/C</th>
                <th className="pr-2">PILOT</th>
                <th className="pr-2">CO-PILOT</th>
                <th className="pr-2">TYPE</th>
                <th className="pr-2">D/N</th>
                <th className="pr-2">DUAL</th>
                <th className="pr-2">IF</th>
                <th className="pr-2 text-right">TIME</th>
                <th className="pr-2 text-right">…</th>
              </tr>
            </thead>
            <tbody>
              {todaySorties.length === 0 && (
                <tr><td colSpan={10} className="py-3 text-center text-muted-foreground italic">No sorties logged on this date yet.</td></tr>
              )}
              {todaySorties.map(s => {
                const time = s.time ?? s.actual ?? (s.day1 + s.day2 + s.dayDual + s.night1 + s.night2 + s.nightDual + (s.nvg || 0));
                const dn = s.condition === "NVG" ? "NVG" : s.condition === "Night" ? "N" : "D";
                const isFrozen = frozen.isFrozen(s.date);
                const canEdit = frozen.canEdit(s.date);
                const locked = isFrozen && !canEdit;
                return (
                  <tr key={s.id} className={`border-b border-border/50 hover:bg-secondary/30 ${form.id === s.id ? "bg-primary/10" : ""} ${locked ? "opacity-90" : ""}`} data-testid={`sortie-row-${s.id}`}>
                    <td className="py-1.5 pr-2">
                      <span className="inline-flex items-center gap-1">
                        {s.date}
                        {locked && <Lock className="h-3 w-3 text-muted-foreground" aria-label="Frozen (older than 12 months)" />}
                        {isFrozen && canEdit && <Unlock className="h-3 w-3 text-amber-300" aria-label="Frozen — this PC is authorized to edit" />}
                      </span>
                    </td>
                    <td className="pr-2">{s.acType} {s.acNumber}</td>
                    <td className="pr-2">{seatLabel(s.pilotId, s.pilotExternal)}{s.pilotIsCaptain ? <span className="ml-1 text-[9px] text-amber-300">CAPT</span> : null}</td>
                    <td className="pr-2">{seatLabel(s.coPilotId, s.coPilotExternal)}{s.coPilotIsCaptain ? <span className="ml-1 text-[9px] text-amber-300">CAPT</span> : null}</td>
                    <td className="pr-2">{s.sortieType}</td>
                    <td className="pr-2">{dn}</td>
                    <td className="pr-2">{s.dual ? "✓" : ""}</td>
                    <td className="pr-2">{s.instrumentFlight ? "✓" : ""}</td>
                    <td className="pr-2 text-right">{Number(time || 0).toFixed(1)}</td>
                    <td className="pr-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => tryEdit(s)}
                        disabled={locked}
                        title={locked ? lockedMessage : "Edit"}
                        aria-disabled={locked}
                        className={`px-1.5 py-0.5 rounded border text-[10px] inline-flex items-center gap-0.5 mr-1 ${locked ? "border-border bg-secondary opacity-40 cursor-not-allowed" : "border-border bg-secondary"}`}
                        data-testid={`button-edit-${s.id}`}
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      <button
                        onClick={() => tryDelete(s)}
                        disabled={locked}
                        title={locked ? lockedMessage : "Delete"}
                        aria-disabled={locked}
                        className={`px-1.5 py-0.5 rounded border text-[10px] inline-flex items-center gap-0.5 ${locked ? "border-rose-400/40 bg-rose-500/10 text-rose-200 opacity-40 cursor-not-allowed" : "border-rose-400/40 bg-rose-500/10 text-rose-200"}`}
                        data-testid={`button-delete-${s.id}`}
                      >
                        <Trash2 className="h-3 w-3" /> Del
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {todaySorties.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={8} className="py-2 text-right">ALL TOTALS</td>
                  <td className="pr-2 text-right">{totals.h.toFixed(1)} hrs · {totals.s} sorties</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      {confirmDel && (
        <SortieDiffDialog
          mode="delete"
          before={confirmDel}
          onCancel={() => setConfirmDel(null)}
          onConfirm={doDelete}
          busy={del.isPending}
          pilotName={(id) => {
            const p = pilotById(id);
            if (!p) return id;
            return p.flightName?.trim() || `${rankOf(p)} ${p.name}`;
          }}
        />
      )}

      {pendingEdit && (
        <SortieDiffDialog
          mode="edit"
          before={pendingEdit.before}
          after={pendingEdit.after}
          onCancel={() => setPendingEdit(null)}
          onConfirm={confirmEdit}
          busy={update.isPending}
          pilotName={(id) => {
            const p = pilotById(id);
            if (!p) return id;
            return p.flightName?.trim() || `${rankOf(p)} ${p.name}`;
          }}
        />
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

type MiniProps = {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  step?: string;
};
function Mini({ label, value, onChange, type = "text", placeholder, step }: MiniProps) {
  if (type === "date") {
    // Sorties are always recorded for a flight that has *already happened*
    // — there is no legitimate reason for ops to log a sortie dated in the
    // future. We pin the date picker's `max` to today so the OS calendar
    // visually disables future cells AND the manual-typed validation in
    // DateInput still accepts past dates freely (back-dating an entry the
    // operator forgot to log earlier in the week is a normal workflow).
    const todayIso = new Date().toISOString().slice(0, 10);
    return (
      <label className="block">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <DateInput
          value={String(value)}
          onChange={onChange}
          max={todayIso}
          className="w-full mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono"
        />
      </label>
    );
  }
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        type={type}
        step={step}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="w-full mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono"
      />
    </label>
  );
}

interface SeatPanelProps {
  label: string;
  testIdPrefix: string;
  seat: SeatState;
  opts: { value: string; label: string }[];
  onChange: (patch: Partial<SeatState>) => void;
  registeredPCs: { id: string; squadronName: string; online: boolean; tier: import("@/lib/cross-pc").PcTier }[];
  mySquadronId: string;
}

// Independent per-seat panel: pilot picker + status (1st PLT / 2nd PLT /
// Dual) + Captain checkbox. Each seat is fully independent — both seats can
// be 1st PLT (rare but legal on multi-instructor evals), both can be Dual
// during conversion training, etc. Captain credit is per-seat too.
function SeatPanel({ label, testIdPrefix, seat, opts, onChange, registeredPCs, mySquadronId }: SeatPanelProps) {
  const guest = !!seat.external;
  const setGuest = (on: boolean) => {
    if (on) onChange({ id: "", external: { name: "", squadron: "" } });
    else onChange({ external: undefined });
  };
  const statuses: { v: SeatStatus; label: string; cls: string }[] = [
    { v: "1st", label: "1st PLT", cls: "bg-primary text-primary-foreground border-primary" },
    { v: "2nd", label: "2nd PLT", cls: "bg-sky-500/20 border-sky-400 text-sky-200" },
    { v: "Dual", label: "Dual", cls: "bg-violet-500/20 border-violet-400 text-violet-200" },
  ];
  return (
    <div className="border border-border rounded-md p-2.5 bg-secondary/20 space-y-2" data-testid={`seat-${testIdPrefix}`}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <button
          type="button"
          onClick={() => setGuest(!guest)}
          data-testid={`button-guest-${testIdPrefix}`}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold border inline-flex items-center gap-1 ${
            guest
              ? "bg-emerald-500/20 border-emerald-400 text-emerald-200"
              : "bg-secondary border-border text-muted-foreground hover:bg-secondary/80"
          }`}
          title="Toggle guest pilot from another squadron"
        >
          {guest ? <UserPlus className="h-3 w-3" /> : <User className="h-3 w-3" />}
          {guest ? "Guest" : "Roster"}
        </button>
      </div>
      {guest ? (
        <div className="space-y-1.5">
          {/* Squadron picker first — registered PCs are listed in the
              dropdown so accepted entries can be routed back to that
              squadron's app. The free-text option (or unrecognised value)
              becomes a manual-entry record that doesn't auto-route. */}
          <select
            className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
            value={(() => {
              const match = registeredPCs.find(p => p.squadronName === seat.external?.squadron && p.id !== mySquadronId && p.tier === "squadron");
              return match ? match.id : "__manual";
            })()}
            onChange={e => {
              const v = e.target.value;
              if (v === "__manual") onChange({ external: { ...(seat.external ?? { name: "" }), squadron: "", homePcId: undefined } });
              else {
                const pc = registeredPCs.find(p => p.id === v);
                onChange({ external: { ...(seat.external ?? { name: "" }), squadron: pc?.squadronName ?? "", homePcId: pc?.id } });
              }
            }}
            data-testid={`select-guest-pc-${testIdPrefix}`}
          >
            <option value="__manual">— Manual entry (squadron not registered) —</option>
            {/* Only squadron-tier PCs make sense as "home squadron" — wing/base/HQ
                entries do not own pilot rosters and cannot review guest sorties. */}
            {registeredPCs.filter(p => p.id !== mySquadronId && p.tier === "squadron").map(p => (
              <option key={p.id} value={p.id}>{p.squadronName} {p.online ? "● online" : "○ offline"}</option>
            ))}
          </select>
          {(() => {
            const match = registeredPCs.find(p => p.squadronName === seat.external?.squadron && p.id !== mySquadronId);
            if (match) return null;
            return (
              <input
                type="text"
                value={seat.external?.squadron ?? ""}
                onChange={e => onChange({ external: { ...(seat.external ?? { name: "" }), squadron: e.target.value } })}
                placeholder="Squadron name (e.g. 7 Sqn)"
                className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
                data-testid={`input-guest-squadron-${testIdPrefix}`}
              />
            );
          })()}
          <input
            type="text"
            value={seat.external?.name ?? ""}
            onChange={e => onChange({ external: { ...(seat.external ?? { squadron: "" }), name: e.target.value } })}
            placeholder="Pilot name (rank + name)"
            className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
            data-testid={`input-guest-name-${testIdPrefix}`}
          />
          <div className="space-y-0.5">
            <input
              type="text"
              required
              aria-required="true"
              value={seat.external?.militaryNumber ?? ""}
              onChange={e => onChange({ external: { ...(seat.external ?? { name: "", squadron: "" }), militaryNumber: e.target.value } })}
              placeholder="Military number (required) *"
              className={`w-full px-2 py-1.5 rounded-md bg-input border text-xs font-mono ${
                (seat.external?.militaryNumber ?? "").trim()
                  ? "border-border"
                  : "border-amber-500/60"
              }`}
              data-testid={`input-guest-mil-${testIdPrefix}`}
            />
            <p className="text-[10px] text-muted-foreground leading-tight">
              Ask the visiting pilot for their military number so credit goes to the right person.
            </p>
          </div>
        </div>
      ) : (
        <select
          className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-bold"
          value={seat.id}
          onChange={e => onChange({ id: e.target.value })}
          data-testid={`select-${testIdPrefix}`}
        >
          {opts.map(o => <option key={o.value} value={o.value} className="font-bold">{o.label}</option>)}
        </select>
      )}
      <div className="flex flex-wrap gap-1.5" data-testid={`status-${testIdPrefix}`}>
        {statuses.map(s => (
          <button
            key={s.v}
            type="button"
            onClick={() => onChange({ status: s.v })}
            data-testid={`button-status-${testIdPrefix}-${s.v.toLowerCase()}`}
            className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold border transition-colors ${
              seat.status === s.v ? s.cls : "bg-secondary border-border text-muted-foreground hover:bg-secondary/80"
            }`}
          >{s.label}</button>
        ))}
      </div>
      <label className="inline-flex items-center gap-2 cursor-pointer select-none px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] w-full" data-testid={`toggle-captain-${testIdPrefix}`}>
        <input
          type="checkbox"
          checked={seat.captain}
          onChange={e => onChange({ captain: e.target.checked })}
          className="h-3.5 w-3.5 accent-amber-400"
        />
        <span className="font-semibold text-amber-300">Count as Captain (CAP)</span>
      </label>
    </div>
  );
}

function MiniSelect({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: string[] }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-xs"
      >
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
