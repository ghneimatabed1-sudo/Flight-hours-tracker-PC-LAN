// Monthly Report engine — computes QRFG RCN Forms 1, 2, 3, 4 and the
// Arabic roster sheet from existing pilot + sortie data, leaving only the
// values that genuinely change month-to-month (squadron strength,
// discipline morale, planned sorties, lecture hours, etc.) for the ops
// pilot to enter through a small wizard.

import type { Pilot, Sortie } from "./mock";
import type { LeaveRow, UnavailEntry } from "./squadron-data";
import type { SquadronDefaults } from "./squadron-defaults";

export type MissionBucket =
  | "GH" | "IF" | "NF_NVG" | "FORM_NAV" | "COURSES"
  | "EVAL_STAND" | "EMER" | "MTF" | "GP_CONT" | "MSN" | "OTHER";

export const MISSION_BUCKETS: MissionBucket[] = [
  "GH","IF","NF_NVG","FORM_NAV","COURSES","EVAL_STAND","EMER","MTF","GP_CONT","MSN","OTHER",
];

export const MISSION_LABEL: Record<MissionBucket,string> = {
  GH: "GH", IF: "IF", NF_NVG: "NF & NVG", FORM_NAV: "FORM & NAV",
  COURSES: "COURSES", EVAL_STAND: "EVAL & STAND", EMER: "EMER",
  MTF: "MTF", GP_CONT: "GP CONT", MSN: "MSN", OTHER: "OTHER",
};

export const NEXT_PLAN_EXERCISES = ["GH","IF","NVG","NIGHT","CONTINUATION TRNG","MTF"] as const;
export type NextPlanExercise = typeof NEXT_PLAN_EXERCISES[number];

export const LECTURE_NAMES = [
  "BOLD FACE","EMER. & LIMIT.","NIGHT TOPICS","FLT MANUAL (-10)","HOT WEATHER TOPICS",
] as const;
export type LectureName = typeof LECTURE_NAMES[number];

export interface ReportInputs {
  /* Form 3 squadron header */
  squadronStrength: number;
  ops: number;
  attached: number;
  course: number;
  sickLeave: number;
  sickRatePct: number;
  morale: "HIGH" | "MEDIUM" | "LOW";
  incidents: string;
  accidents: string;
  /* Form 3 planned vs achieved (achieved auto-computed; planned is user input) */
  plannedSorties: number;
  plannedHours: number;
  weatherAbortS: number; weatherAbortH: number;
  maintAbortS: number;   maintAbortH: number;
  opsAbortS: number;     opsAbortH: number;
  airAbortS: number;     airAbortH: number;
  /* Form 3 lectures */
  lectures: { name: string; hours: number; quizPct: number; remarks: string }[];
  /* Form 4 next-month plan */
  nextMonthPlanFor: string; // "YYYY-MM"
  pilotsAvailableNext: number;
  opsNext: number;
  nextPlan: {
    exercise: string;
    pilots: number;
    sortiesPerPilot: number;
    durationPerSortie: number;
    /** Per-row override for fuel-burn rate (lb/hr). When undefined, the
     *  squadron default for the primary airframe is used. Lets the operator
     *  model an exercise on a different airframe without changing the
     *  squadron-wide default. Math is shown live in the Form 4 / FUEL block. */
    fuelPerHourOverride?: number;
    ammo275: string; ammo127: string; ammo762: string;
    remarks: string;
  }[];
  ammoPrev: { rkt275: string; mm127: string; mm762: string };
  ammoReq:  { rkt275: string; mm127: string; mm762: string };
  /* Form 1 per-pilot overrides */
  perPilotStatus: Record<string, string>;
  perPilotRemarks: Record<string, string>;
}

/* ───────────── helpers ───────────── */

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }

export function monthBounds(period: string): { start: Date; endExclusive: Date; eomInclusive: Date } {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const endExclusive = new Date(y, m, 1);
  const eomInclusive = new Date(y, m, 0);
  return { start, endExclusive, eomInclusive };
}

export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m, 1); // m is 0-based for next month after period
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function lastCompletedPeriod(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function periodLabel(period: string, _lang: "en"|"ar" = "en"): string {
  // MM-YYYY in line with the squadron-wide DD-MM-YYYY standard.
  const [y, m] = period.split("-");
  return `${m}-${y}`;
}

export function missionBucket(s: Sortie): MissionBucket {
  const t = ((s.sortieType || "") + " " + (s.name || "")).toUpperCase();
  if (/MTF|TEST FLIGHT/.test(t)) return "MTF";
  if (/EVAL|STAND/.test(t)) return "EVAL_STAND";
  if (/EMER/.test(t)) return "EMER";
  if (/GP\s*CONT/.test(t)) return "GP_CONT";
  if (/COURSE|\bCRS\b/.test(t)) return "COURSES";
  if (/FORM|NAV/.test(t)) return "FORM_NAV";
  if (/\bNF\b|\bNVG\b|NIGHT FLIGHT/.test(t)) return "NF_NVG";
  // IF (Instrument Flight) bucket — must catch:
  //   • the literal sortie type "IRT" (RJAF shorthand for Instrument
  //     Rating Training, what operators actually pick from the dropdown)
  //   • any "IF" / "INSTRUMENT" mention anywhere in the type+name string
  //   • a sortie whose `instrumentFlight` flag is on, even if the type
  //     itself is something else (e.g. a Day sortie with the Instrument
  //     box ticked still belongs under IF on Forms 2 + 3)
  if (s.instrumentFlight === true) return "IF";
  if (/\bIRT\b|\bIF\b|INSTRUMENT/.test(t)) return "IF";
  if (/\bGH\b|GENERAL HANDLING/.test(t)) return "GH";
  if (/\bMSN\b|MISSION/.test(t)) return "MSN";
  return "OTHER";
}

export function defaultPilotStatus(p: Pilot): string {
  const q = (p.qualifications || []).join(",").toUpperCase();
  if (/FLT\.?CMDR|FLIGHT CMDR/.test(q)) return "FLT.CMDR";
  if (/QHI/.test(q)) return "QHI+FL+MTP";
  if (/MTP/.test(q)) return "PILOT+MTP";
  if (/CO-?PILOT/.test(q)) return "CO-PILOT";
  // fall back by rank — senior officers default to PILOT, others to CO-PILOT
  if (/LTC|MAJ|CPT|CAPT/i.test(p.rank)) return "PILOT";
  return "CO-PILOT";
}

export function currencyState(expiry: string | undefined, eomInclusive: Date): "C" | "R" | "N/C" | "U/R" {
  if (!expiry) return "U/R";
  const e = new Date(expiry);
  if (Number.isNaN(e.getTime())) return "U/R";
  const days = Math.round((e.getTime() - eomInclusive.getTime()) / 86400000);
  if (days >= 30) return "C";
  if (days >= 0) return "R";
  if (days >= -30) return "N/C";
  return "U/R";
}

/* ───────────── per-pilot monthly totals ───────────── */

export interface PilotMonthRow {
  pilot: Pilot;
  status: string;
  day1: number; day2: number; dayDual: number;
  night1: number; night2: number; nightDual: number;
  nvg: number;
  totalForMonth: number;
  cap: number; sor: number;
  ifSim: number; ifAct: number;
  remarks: string;
}

export function buildForm1Rows(
  pilots: Pilot[],
  sorties: Sortie[],
  period: string,
  inputs: Pick<ReportInputs, "perPilotStatus" | "perPilotRemarks">,
): PilotMonthRow[] {
  const monthSorties = sorties.filter(s => (s.date || "").startsWith(period));
  return pilots.map(p => {
    const mine = monthSorties.filter(s => s.pilotId === p.id || s.coPilotId === p.id);
    let day1=0,day2=0,dayDual=0,night1=0,night2=0,nightDual=0,nvg=0,sim=0,act=0,cap=0,sor=0;
    for (const s of mine) {
      const isAsPilot = s.pilotId === p.id;
      const explicitCap = isAsPilot ? s.pilotIsCaptain : s.coPilotIsCaptain;
      const isPic = typeof explicitCap === "boolean" ? explicitCap : isAsPilot;
      const isCo  = s.coPilotId === p.id;
      if (isPic) { day1 += s.day1||0; night1 += s.night1||0; cap++; }
      if (isCo)  { day2 += s.day2||0; night2 += s.night2||0; }
      dayDual += (s.dayDual||0) / (isPic && isCo ? 1 : 1);
      nightDual += (s.nightDual||0);
      nvg += (s.nvg||0);
      sim += (s.sim||0);
      act += (s.actual||0);
      sor++;
    }
    const totalForMonth = round1(day1+day2+dayDual+night1+night2+nightDual);
    return {
      pilot: p,
      // Per the v1.0.6 directive: leave the status BLANK when the officer
      // hasn't filled it in. Previously we auto-guessed from rank/quals which
      // could mislead. The wizard's per-pilot override row is the only source.
      status: inputs.perPilotStatus[p.id] || "",
      day1: round1(day1), day2: round1(day2), dayDual: round1(dayDual),
      night1: round1(night1), night2: round1(night2), nightDual: round1(nightDual),
      nvg: round1(nvg),
      totalForMonth,
      cap, sor,
      ifSim: round1(sim), ifAct: round1(act),
      remarks: inputs.perPilotRemarks[p.id] || "",
    };
  });
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

/* ───────────── Form 2 ───────────── */

export interface PilotForm2Row {
  pilot: Pilot;
  totalForMonthAllTypes: number;
  grandTotal: number;
  currencyNF: "C" | "R" | "N/C" | "U/R";
  currencyIF: "C" | "R" | "N/C" | "U/R";
  ifSimMonth: number;
  ifActMonth: number;
  ifSimTotal: number;
  ifActTotal: number;
  ifExpiryDate: string;
  remarks: string;
}

export function buildForm2Rows(
  pilots: Pilot[],
  sorties: Sortie[],
  period: string,
  form1: PilotMonthRow[],
): PilotForm2Row[] {
  const { eomInclusive } = monthBounds(period);
  const allSortiesByPilot = new Map<string, Sortie[]>();
  for (const s of sorties) {
    [s.pilotId, s.coPilotId].filter(Boolean).forEach(id => {
      const arr = allSortiesByPilot.get(id) || [];
      arr.push(s);
      allSortiesByPilot.set(id, arr);
    });
  }
  return pilots.map((p, idx) => {
    const f1 = form1[idx];
    const all = allSortiesByPilot.get(p.id) || [];
    const cumDay = all.reduce((a,s) => a + (s.day1||0) + (s.day2||0) + (s.dayDual||0), 0);
    const cumNight = all.reduce((a,s) => a + (s.night1||0) + (s.night2||0) + (s.nightDual||0), 0);
    const cumNvg = all.reduce((a,s) => a + (s.nvg||0), 0);
    const cumSim = all.reduce((a,s) => a + (s.sim||0), 0);
    const cumAct = all.reduce((a,s) => a + (s.actual||0), 0);
    const grandTotal = round1((p.openingDay||0) + (p.openingNight||0) + (p.openingNvg||0) + cumDay + cumNight + cumNvg);
    return {
      pilot: p,
      totalForMonthAllTypes: f1.totalForMonth,
      grandTotal,
      currencyNF: currencyState(p.expiry?.day, eomInclusive),
      currencyIF: currencyState(p.expiry?.irt, eomInclusive),
      ifSimMonth: f1.ifSim,
      ifActMonth: f1.ifAct,
      ifSimTotal: round1(cumSim),
      ifActTotal: round1(cumAct),
      ifExpiryDate: p.expiry?.irt || "",
      remarks: f1.remarks,
    };
  });
}

/* ───────────── Form 3 ───────────── */

export interface Form3Computed {
  missionTotals: Record<MissionBucket, { sorties: number; hours: number }>;
  totalSorties: number;
  totalHours: number;
  achievedSorties: number;
  achievedHours: number;
}

/**
 * Derived percentages on top of Form 3 — these aren't stored, just rendered.
 * Achievement is achieved/planned (handles divide-by-zero).
 * Weather % is weather-aborted sorties as a share of attempted sorties.
 */
export function deriveForm3Stats(inputs: ReportInputs, computed: Form3Computed) {
  const planS = inputs.plannedSorties || 0;
  const planH = inputs.plannedHours  || 0;
  const totalAbortS = inputs.weatherAbortS + inputs.maintAbortS + inputs.opsAbortS + inputs.airAbortS;
  const totalAbortH = round1(inputs.weatherAbortH + inputs.maintAbortH + inputs.opsAbortH + inputs.airAbortH);
  const attempted = computed.achievedSorties + totalAbortS;
  return {
    achievementSortiesPct: planS ? round1((computed.achievedSorties / planS) * 100) : 0,
    achievementHoursPct:   planH ? round1((computed.achievedHours   / planH) * 100) : 0,
    totalAbortSorties: totalAbortS,
    totalAbortHours: totalAbortH,
    weatherAbortPct: attempted ? round1((inputs.weatherAbortS / attempted) * 100) : 0,
  };
}

/* Pre-fill helper used by the "Auto-fill" wizard button. Looks at the
 * previous month's actual achievement and proposes that as next month's
 * plan — a sensible starting point the officer can tweak in seconds. */
export function suggestNextMonthPlanFrom(prevAchieved: { sorties: number; hours: number }) {
  return {
    plannedSorties: prevAchieved.sorties,
    plannedHours: prevAchieved.hours,
  };
}

export function buildForm3(sorties: Sortie[], period: string): Form3Computed {
  const monthSorties = sorties.filter(s => (s.date || "").startsWith(period));
  const totals = Object.fromEntries(
    MISSION_BUCKETS.map(b => [b, { sorties: 0, hours: 0 }])
  ) as Record<MissionBucket, { sorties: number; hours: number }>;
  for (const s of monthSorties) {
    const b = missionBucket(s);
    totals[b].sorties += 1;
    totals[b].hours += (s.day1||0)+(s.day2||0)+(s.dayDual||0)+(s.night1||0)+(s.night2||0)+(s.nightDual||0);
  }
  for (const b of MISSION_BUCKETS) totals[b].hours = round1(totals[b].hours);
  const achievedSorties = monthSorties.length;
  const achievedHours = round1(monthSorties.reduce((a,s) =>
    a + (s.day1||0)+(s.day2||0)+(s.dayDual||0)+(s.night1||0)+(s.night2||0)+(s.nightDual||0), 0));
  return {
    missionTotals: totals,
    totalSorties: achievedSorties,
    totalHours: achievedHours,
    achievedSorties,
    achievedHours,
  };
}

/* ───────────── Arabic roster sheet ───────────── */

export interface ArabicRosterRow {
  pilot: Pilot;
  medicalExpiry: string;
  lastFlightDate: string;
  cumulativeHoursUH60M: number;
  monthHours: number;
}

export function buildArabicRoster(
  pilots: Pilot[],
  sorties: Sortie[],
  period: string,
  form1: PilotMonthRow[],
): ArabicRosterRow[] {
  return pilots.map((p, idx) => {
    const all = sorties.filter(s => s.pilotId === p.id || s.coPilotId === p.id);
    const lastFlight = all
      .map(s => s.date)
      .filter(Boolean)
      .sort()
      .pop() || "";
    const cum = all.reduce((a,s) =>
      a + (s.day1||0)+(s.day2||0)+(s.dayDual||0)+(s.night1||0)+(s.night2||0)+(s.nightDual||0), 0);
    const grand = round1((p.openingDay||0)+(p.openingNight||0)+(p.openingNvg||0) + cum);
    return {
      pilot: p,
      medicalExpiry: p.expiry?.medical || "",
      lastFlightDate: lastFlight,
      cumulativeHoursUH60M: grand,
      monthHours: form1[idx]?.totalForMonth || 0,
    };
  });
}

/* ───────────── persistence ───────────── */

const KEY_PREFIX = "rjaf.monthlyReport.";

export function loadInputs(period: string): ReportInputs | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + period);
    return raw ? JSON.parse(raw) as ReportInputs : null;
  } catch { return null; }
}

export function saveInputs(period: string, inputs: ReportInputs): void {
  try { localStorage.setItem(KEY_PREFIX + period, JSON.stringify(inputs)); } catch { /* noop */ }
}

export function defaultInputs(
  period: string,
  pilots: Pilot[],
  defaults?: SquadronDefaults,
): ReportInputs {
  const lectures = (defaults?.lectures?.length ? defaults.lectures : LECTURE_NAMES as readonly string[])
    .map(n => ({ name: n, hours: 0, quizPct: 0, remarks: "" }));
  const exercises = defaults?.exercises?.length ? defaults.exercises : NEXT_PLAN_EXERCISES as readonly string[];
  const ammoPh = defaults?.ammoPlaceholder ?? "-";
  return {
    squadronStrength: pilots.length,
    ops: 0, attached: 0, course: 0, sickLeave: 0,
    sickRatePct: 0,
    morale: defaults?.morale ?? "HIGH",
    incidents: defaults?.incidentsDefault ?? "NIL",
    accidents: defaults?.accidentsDefault ?? "NIL",
    plannedSorties: 0, plannedHours: 0,
    weatherAbortS: 0, weatherAbortH: 0,
    maintAbortS: 0,   maintAbortH: 0,
    opsAbortS: 0,     opsAbortH: 0,
    airAbortS: 0,     airAbortH: 0,
    lectures,
    nextMonthPlanFor: nextPeriod(period),
    pilotsAvailableNext: pilots.length,
    opsNext: 0,
    nextPlan: exercises.map(ex => ({
      exercise: ex, pilots: 0, sortiesPerPilot: 0, durationPerSortie: 0,
      ammo275: ammoPh, ammo127: ammoPh, ammo762: ammoPh, remarks: "",
    })),
    ammoPrev: { rkt275: ammoPh, mm127: ammoPh, mm762: ammoPh },
    ammoReq:  { rkt275: ammoPh, mm127: ammoPh, mm762: ammoPh },
    perPilotStatus: {},
    perPilotRemarks: {},
  };
}

/**
 * Resolve the inputs for `period`. Behaviour, in priority order:
 *
 *   1. If the operator has saved inputs for this period before, return
 *      those verbatim — never silently overwrite their work.
 *   2. Otherwise, look up last month's saved inputs and reuse the SLOW-
 *      moving fields (squadron strength, lectures structure, next-plan
 *      exercise list, ammo, fuel rates, per-pilot status overrides) but
 *      RESET the per-month achievement fields (sick rate, abort tallies,
 *      planned-vs-achieved, lecture hours/quiz scores, per-pilot remarks).
 *      This matches how the operations pilot has historically worked
 *      ("take last month's report and edit it") — but without the trap of
 *      accidentally publishing last month's incidents/abort counts.
 *   3. If neither exists, fall back to a fresh blank seeded by squadron
 *      defaults (lectures, exercises, morale, fuel rates, ammo placeholder).
 */
export function loadInputsOrPrefill(
  period: string,
  pilots: Pilot[],
  defaults?: SquadronDefaults,
): ReportInputs {
  const saved = loadInputs(period);
  if (saved) return saved;

  const prev = loadInputs(previousPeriod(period));
  if (prev) {
    const fresh = defaultInputs(period, pilots, defaults);
    return {
      // Keep the structural / slow-moving choices from last month
      squadronStrength: pilots.length || prev.squadronStrength,
      ops: prev.ops, attached: prev.attached, course: prev.course,
      sickLeave: 0,            // resets every month
      sickRatePct: 0,           // resets
      morale: prev.morale,
      incidents: defaults?.incidentsDefault ?? prev.incidents,
      accidents: defaults?.accidentsDefault ?? prev.accidents,
      plannedSorties: 0, plannedHours: 0,                        // resets
      weatherAbortS: 0, weatherAbortH: 0,
      maintAbortS: 0,   maintAbortH: 0,
      opsAbortS: 0,     opsAbortH: 0,
      airAbortS: 0,     airAbortH: 0,
      // Keep lecture topic list + remarks template, but zero hours+quiz so
      // the operator visibly sees they need this month's numbers.
      lectures: prev.lectures.map(l => ({ ...l, hours: 0, quizPct: 0 })),
      nextMonthPlanFor: nextPeriod(period),
      pilotsAvailableNext: pilots.length || prev.pilotsAvailableNext,
      opsNext: prev.opsNext,
      // Keep exercise list + fuel/hr overrides + ammo defaults, zero counts
      nextPlan: prev.nextPlan.map(r => ({
        ...r, pilots: 0, sortiesPerPilot: 0, durationPerSortie: 0, remarks: "",
      })),
      ammoPrev: { ...prev.ammoReq },              // last month's "required" rolls into this month's "available"
      ammoReq:  { ...fresh.ammoReq },
      perPilotStatus: { ...prev.perPilotStatus }, // qualification status carries forward
      perPilotRemarks: {},                          // remarks always reset (will be auto-suggested)
    };
  }

  return defaultInputs(period, pilots, defaults);
}

/* ───────────── per-pilot REMARKS auto-suggestion ───────────── */

/**
 * Generate a suggested REMARKS string for a pilot in the given report month
 * based on their leave matrix and unavailability records. Used by the
 * Monthly Report wizard as a placeholder — operator can accept by leaving
 * it as-is (placeholder text becomes the value if no override is typed) or
 * override by typing anything else. The wording style intentionally mirrors
 * the workbook's hand-typed remarks: "11 DAYS ANNUAL LEAVE", "7 DAYS TDY",
 * "48 HRS SICK LEAVE".
 *
 * Returns an empty string if nothing notable applies.
 */
export function suggestRemarksFor(
  pilot: Pilot,
  period: string,
  leaves: LeaveRow[] | undefined,
  unavail: UnavailEntry[] | undefined,
): string {
  const parts: string[] = [];
  const [, mStr] = period.split("-");
  const monthIdx = Math.max(0, Math.min(11, parseInt(mStr, 10) - 1));

  // Annual leave from the per-pilot months matrix (days)
  const lr = leaves?.find(r => r.pilotId === pilot.id);
  const leaveDays = lr?.months?.[monthIdx] ?? 0;
  if (leaveDays > 0) {
    parts.push(`${leaveDays} DAY${leaveDays === 1 ? "" : "S"} ANNUAL LEAVE`);
  }

  // Unavailability that overlaps the report month
  const { start, endExclusive } = monthBounds(period);
  const overlapping = (unavail || []).filter(u => {
    if (u.pilotId !== pilot.id) return false;
    const f = new Date(u.from);
    const t = new Date(u.to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return false;
    return f < endExclusive && t >= start;
  });
  for (const u of overlapping) {
    const f = new Date(u.from);
    const t = new Date(u.to);
    const winStart = f < start ? start : f;
    const winEnd   = t >= endExclusive ? new Date(endExclusive.getTime() - 86400000) : t;
    const days = Math.max(1, Math.round((winEnd.getTime() - winStart.getTime()) / 86400000) + 1);
    const reason = (u.reason || "").toUpperCase();
    let label = reason;
    if (/SICK|MEDICAL/.test(reason)) label = `${days} DAY${days === 1 ? "" : "S"} SICK LEAVE`;
    else if (/TDY|TEMPORARY DUTY|EXCHANGE|TRAVEL/.test(reason)) label = `${days} DAY${days === 1 ? "" : "S"} TDY`;
    else if (/COURSE|TRAINING/.test(reason)) label = `${days} DAY${days === 1 ? "" : "S"} COURSE`;
    else if (reason) label = `${days} DAY${days === 1 ? "" : "S"} ${reason}`;
    if (label) parts.push(label);
  }

  return parts.join(" + ");
}

/* ═════════════════════════════════════════════════════════════════════
 * APPENDIX SHEETS — derived from the same sortie / pilot / leave data
 * that already flows through the squadron PC. Every appendix row is
 * pure AUTO data: nothing here requires operator input. They mirror
 * the workbook's audit-appendix tabs (AUTHORIZATION, P MISSIONS SOLO,
 * P-LEAVES, 6 MONTHS RUNNING, DUAL) so the squadron commander gets
 * the same packet they're used to seeing.
 * ═══════════════════════════════════════════════════════════════════ */

/* ───────────── AUTHORIZATION (daily sortie log) ───────────── */

export interface AuthLogRow {
  no: number;
  date: string;
  acType: string;
  acNumber: string;
  mission: string;
  pcName: string;        // person flying as Pilot-in-Command (1st seat captain)
  piName: string;        // the other crewmember (2nd seat / dual student)
  day1: number; day2: number; dayDual: number;
  night1: number; night2: number; nightDual: number;
  nvg: number;
  ifSim: number; ifAct: number;
  total: number;
  remarks: string;
}

/**
 * Chronological sortie log for the period — every flown sortie, one
 * row each. This is the source-of-truth ledger; every other monthly
 * form derives from these rows. The squadron commander signs this
 * sheet (and only this sheet) to authorise the month's flying record.
 *
 * "PC" / "PI" naming follows RJAF convention:
 *   • PC = Pilot in Command. We pick the captain — `pilotIsCaptain` /
 *     `coPilotIsCaptain` flag wins; falls back to the `pilotId` slot.
 *   • PI = Pilot, the other crewmember (or "—" for solo flights).
 *
 * External pilots (visiting QHIs etc.) are rendered from
 * `pilot/coPilotExternal.name` so they appear in the log even when
 * they aren't in the squadron roster. Sorties with neither resolvable
 * crewmember are still listed (date + AC) so the operator can spot
 * data-entry gaps.
 */
export function buildAuthorizationLog(
  sorties: Sortie[],
  pilots: Pilot[],
  period: string,
): AuthLogRow[] {
  const byId = new Map(pilots.map(p => [p.id, p]));
  const monthSorties = sorties
    .filter(s => (s.date || "").startsWith(period))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const nameOf = (id: string, ext?: { name?: string } | undefined): string => {
    if (id && byId.has(id)) {
      const p = byId.get(id)!;
      return `${p.rank ? p.rank + " " : ""}${p.name}`;
    }
    if (ext?.name) return ext.name;
    return "—";
  };

  return monthSorties.map((s, i) => {
    // Decide PC vs PI by the explicit captain flags. Convention: the
    // captain seat is the PC; the other crewmember is the PI. If both
    // or neither are flagged captain, fall back to the pilotId slot.
    const pIsCap = s.pilotIsCaptain === true;
    const cIsCap = s.coPilotIsCaptain === true;
    const pcFromPilotSlot = pIsCap || (!pIsCap && !cIsCap);
    const pcName = pcFromPilotSlot
      ? nameOf(s.pilotId, s.pilotExternal)
      : nameOf(s.coPilotId, s.coPilotExternal);
    const piName = pcFromPilotSlot
      ? nameOf(s.coPilotId, s.coPilotExternal)
      : nameOf(s.pilotId, s.pilotExternal);

    const total = round1(
      (s.day1||0) + (s.day2||0) + (s.dayDual||0) +
      (s.night1||0) + (s.night2||0) + (s.nightDual||0)
    );

    return {
      no: i + 1,
      date: s.date,
      acType: s.acType || "",
      acNumber: s.acNumber || "",
      mission: (s.sortieType || s.name || "").toString(),
      pcName, piName,
      day1: round1(s.day1||0), day2: round1(s.day2||0), dayDual: round1(s.dayDual||0),
      night1: round1(s.night1||0), night2: round1(s.night2||0), nightDual: round1(s.nightDual||0),
      nvg: round1(s.nvg||0),
      ifSim: round1(s.sim||0), ifAct: round1(s.actual||0),
      total,
      remarks: s.remarks || "",
    };
  });
}

/* ───────────── MISSION SOLO (per-pilot non-dual sortie summary) ───────────── */

export interface MissionSoloRow {
  pilot: Pilot;
  /** Per-bucket count of solo sorties (where the pilot was not flying dual). */
  soloByBucket: Record<MissionBucket, number>;
  /** Per-bucket sum of solo hours. */
  hoursByBucket: Record<MissionBucket, number>;
  totalSorties: number;
  totalHours: number;
  /** ISO date of the most recent solo flight in the period (or empty). */
  lastSoloDate: string;
}

/**
 * "Solo" here follows the workbook's MISSIONS SOLO sheet convention:
 * a sortie counts as solo for a given pilot when that pilot was NOT
 * flying dual on it — i.e. they were credited with 1st-seat or 2nd-seat
 * hours but no dual hours. For UH-60M (always 2-pilot crew), this
 * captures sorties flown without an instructor on board, which is what
 * the standardisation officer cares about: who's been operating with
 * full PIC authority and how often.
 */
export function buildMissionSolo(
  pilots: Pilot[],
  sorties: Sortie[],
  period: string,
): MissionSoloRow[] {
  const monthSorties = sorties.filter(s => (s.date || "").startsWith(period));

  return pilots.map(p => {
    const soloByBucket = Object.fromEntries(
      MISSION_BUCKETS.map(b => [b, 0])
    ) as Record<MissionBucket, number>;
    const hoursByBucket = Object.fromEntries(
      MISSION_BUCKETS.map(b => [b, 0])
    ) as Record<MissionBucket, number>;

    let totalSorties = 0;
    let totalHours = 0;
    let lastSoloDate = "";

    for (const s of monthSorties) {
      const isPilot = s.pilotId === p.id;
      const isCo    = s.coPilotId === p.id;
      if (!isPilot && !isCo) continue;

      // Solo credit follows the per-seat bucket convention used by Form 1:
      //   • 1st-seat slot (pilotId)   gets day1 + night1
      //   • 2nd-seat slot (coPilotId) gets day2 + night2
      // A flight is "solo" for this pilot if they earned non-dual hours
      // on it AND nobody on the sortie was flying dual (dualSeat > 0
      // means the sortie was a dual-instruction event).
      // NVG hours are NOT added in — Form 1's totalForMonth treats NVG
      // as a subset of night hours (display column only), so adding
      // s.nvg here would double-count the night portion.
      const soloSeat = isPilot
        ? (s.day1||0) + (s.night1||0)
        : (s.day2||0) + (s.night2||0);
      const dualSeat = (s.dayDual||0) + (s.nightDual||0);
      if (soloSeat <= 0 || dualSeat > 0) continue;

      const bucket = missionBucket(s);
      soloByBucket[bucket] += 1;
      hoursByBucket[bucket] = round1(hoursByBucket[bucket] + soloSeat);
      totalSorties += 1;
      totalHours = round1(totalHours + soloSeat);
      if (!lastSoloDate || s.date > lastSoloDate) lastSoloDate = s.date;
    }

    return { pilot: p, soloByBucket, hoursByBucket, totalSorties, totalHours, lastSoloDate };
  });
}

/* ───────────── P-LEAVES (annual leave matrix) ───────────── */

export interface PLeavesRow {
  pilot: Pilot;
  months: number[];      // length 12, days taken per month (Jan = 0, Dec = 11)
  total: number;          // year-to-date days taken
}

/**
 * 12-month per-pilot annual leave grid. Mirrors the workbook's P-LEAVES
 * sheet: every pilot is a row, every column is a month, the cell is the
 * number of days that pilot took annual leave in that month. The data
 * already lives in this shape inside the leaves store, so this is a
 * view-shaping pass rather than a re-derivation.
 */
export function buildPLeaves(
  pilots: Pilot[],
  leaves: Array<{ pilotId: string; months: number[]; total: number }>,
): PLeavesRow[] {
  const byId = new Map(leaves.map(r => [r.pilotId, r]));
  return pilots.map(p => {
    const r = byId.get(p.id);
    // Always normalise to exactly 12 entries so the printed grid stays
    // aligned even if upstream storage drifts (truncated / extended array).
    const months = Array.from({ length: 12 }, (_, i) => r?.months?.[i] ?? 0);
    const total = r?.total ?? months.reduce((a, n) => a + n, 0);
    return { pilot: p, months, total };
  });
}

/* ───────────── SIX MONTHS RUNNING (currency) ───────────── */

export interface SixMonthsRow {
  pilot: Pilot;
  /** Six entries, oldest -> newest. monthLabel is "JAN", "FEB", … . */
  cells: { period: string; monthLabel: string; hours: number }[];
  total6mo: number;
  avgPerMo: number;
  /** Currency state vs the squadron's minimum hours floor:
   *  "OK" >= floor, "LOW" within 20% of the floor, "UNDER" otherwise. */
  flag: "OK" | "LOW" | "UNDER";
}

const MONTH_LABELS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

/**
 * Per-pilot rolling 6-month hours grid ending at the report period.
 * Output is 6 cells per pilot (oldest first), plus 6-month total,
 * average per month, and a 3-state currency flag against the
 * squadron's `minSixMonthHours` floor (set in Squadron Defaults).
 *
 * Hours counted = day1+day2+dayDual + night1+night2+nightDual.
 * NVG is NOT double-counted (workbook treats NVG as a subset of
 * night hours, which is how our sortie schema also stores it).
 */
export function buildSixMonths(
  pilots: Pilot[],
  sorties: Sortie[],
  period: string,
  minHoursFloor: number,
): SixMonthsRow[] {
  // Build the list of 6 periods ending at `period`, oldest first.
  const periods: string[] = [];
  const [y0, m0] = period.split("-").map(Number);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(y0, m0 - 1 - i, 1);
    periods.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  const periodSet = new Set(periods);
  const monthIndexOf = (period: string) => parseInt(period.split("-")[1], 10) - 1;

  // Bucket sorties per pilot, per month, attributing hours by SEAT (not
  // by full sortie). For a 1.5 hr flight where pilot A is 1st seat and
  // pilot B is 2nd seat, each pilot logs 1.5 hr of cockpit time — not
  // 3.0 hrs (which is what summing the whole sortie's day1+day2+… would
  // produce). Dual time is credited to whoever was in the seat, mirroring
  // Form 1's per-pilot accounting. NVG is excluded — it's a subset of
  // night hours per the workbook convention.
  const bucket = new Map<string, Map<string, number>>();
  const addTo = (id: string, period6: string, hrs: number) => {
    if (!id || hrs <= 0) return;
    let inner = bucket.get(id);
    if (!inner) { inner = new Map(); bucket.set(id, inner); }
    inner.set(period6, round1((inner.get(period6) || 0) + hrs));
  };
  for (const s of sorties) {
    const period6 = (s.date || "").slice(0, 7);
    if (!periodSet.has(period6)) continue;
    const dual = (s.dayDual||0) + (s.nightDual||0);
    const firstSeat  = (s.day1||0) + (s.night1||0) + dual;
    const secondSeat = (s.day2||0) + (s.night2||0) + dual;
    addTo(s.pilotId,   period6, firstSeat);
    addTo(s.coPilotId, period6, secondSeat);
  }

  return pilots.map(p => {
    const inner = bucket.get(p.id);
    const cells = periods.map(per => ({
      period: per,
      monthLabel: MONTH_LABELS[monthIndexOf(per)],
      hours: inner?.get(per) ?? 0,
    }));
    const total6mo = round1(cells.reduce((a, c) => a + c.hours, 0));
    const avgPerMo = round1(total6mo / 6);
    const flag: SixMonthsRow["flag"] =
      total6mo >= minHoursFloor ? "OK"
      : total6mo >= minHoursFloor * 0.8 ? "LOW"
      : "UNDER";
    return { pilot: p, cells, total6mo, avgPerMo, flag };
  });
}

/* ───────────── DUAL hours per pilot ───────────── */

export interface DualRow {
  pilot: Pilot;
  dayDual: number;
  nightDual: number;
  nvgDual: number;
  totalDual: number;
  totalSolo: number;     // day1+day2+night1+night2 — non-dual time
  /** Human-readable ratio "1 : 2.4" of dual hours to solo hours.
   *  "—" when one side is zero (so the printed sheet doesn't lie). */
  ratio: string;
}

/**
 * Per-pilot dual / solo hours breakdown for the period. Used by the
 * standardisation officer to spot pilots who are flying disproportionately
 * dual (need more solo authority) or disproportionately solo (might
 * need a check-ride). NVG dual is shown separately because it's the
 * scarcest resource and the most-reviewed datapoint.
 */
export function buildDualHours(
  pilots: Pilot[],
  sorties: Sortie[],
  period: string,
): DualRow[] {
  const monthSorties = sorties.filter(s => (s.date || "").startsWith(period));

  return pilots.map(p => {
    let dayDual = 0, nightDual = 0, nvgDual = 0, totalSolo = 0;
    for (const s of monthSorties) {
      const isPilot = s.pilotId === p.id;
      const isCo    = s.coPilotId === p.id;
      if (!isPilot && !isCo) continue;
      // Dual time is credited to whoever was in the seat (both pilots get
      // the dual hours when they were dual-flying together). NVG dual is
      // shown as informational and NOT added into totalDual — it overlaps
      // with night dual (NVG is night flight under goggles).
      dayDual   += (s.dayDual   || 0);
      nightDual += (s.nightDual || 0);
      nvgDual   += (s.nvgDual   || 0);
      // Solo time is per-seat (1st-seat slot earns day1+night1, 2nd-seat
      // earns day2+night2) — same convention as Form 1 / SIX-MONTHS.
      totalSolo += isPilot
        ? (s.day1||0) + (s.night1||0)
        : (s.day2||0) + (s.night2||0);
    }
    const totalDual = round1(dayDual + nightDual);
    totalSolo = round1(totalSolo);

    let ratio = "—";
    if (totalDual > 0 && totalSolo > 0) {
      // Express as "1 : X.X" of the smaller side, oriented so the larger
      // side is on the right — easier to read at a glance.
      const r = totalSolo > totalDual
        ? round1(totalSolo / totalDual)
        : round1(totalDual / totalSolo);
      ratio = totalSolo > totalDual
        ? `1 dual : ${r.toFixed(1)} solo`
        : `${r.toFixed(1)} dual : 1 solo`;
    } else if (totalDual > 0) {
      ratio = "all dual";
    } else if (totalSolo > 0) {
      ratio = "all solo";
    }

    return {
      pilot: p,
      dayDual: round1(dayDual),
      nightDual: round1(nightDual),
      nvgDual: round1(nvgDual),
      totalDual,
      totalSolo,
      ratio,
    };
  });
}
