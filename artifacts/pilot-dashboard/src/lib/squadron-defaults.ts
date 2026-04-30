/**
 * Squadron-level Monthly Report defaults.
 *
 * Why this exists
 * ───────────────
 * The Monthly Report has three kinds of fields:
 *   1. AUTO  — pulled from the Sortie log / Roster / Currency directly.
 *   2. DEFAULT — values that almost never change month-to-month for a given
 *      squadron (lecture topics, the standard exercise list, fuel-burn rate
 *      per airframe, the standard incidents/accidents wording, ammo
 *      placeholders). The operations pilot edits these once for their
 *      squadron and they prefill every month after.
 *   3. MANUAL — true commander judgement (sick rate, abort tallies, lecture
 *      hours/quiz scores, planned-vs-achieved figures). Filled per-month.
 *
 * This module owns category 2. Each squadron has its own set of defaults
 * keyed by `squadronNumber` so the same APK can be deployed to other
 * squadrons (with different airframes, different fuel rates, different
 * lecture syllabus) and each one keeps its own baseline.
 *
 * Storage is plain localStorage on the operations pilot PC — same scope as
 * the per-period saved inputs in monthly-report.ts.
 */

import { fetchInternalSquadronDefaultsRow } from "@/lib/internal-migration";

const KEY_PREFIX = "rjaf.monthlyReport.defaults.";

/** Default lecture topics taught every month at the squadron level. */
const FACTORY_LECTURES = [
  "EMERGENCY PROCEDURES",
  "AIRCRAFT SYSTEMS",
  "AERODYNAMICS",
  "INSTRUMENT PROCEDURES",
  "TACTICS",
  "SAFETY",
];

/** Default exercise types in the next-month plan grid. */
const FACTORY_EXERCISES = ["GH", "IF", "NVG", "NIGHT", "CONTINUATION TRNG", "MTF"];

/**
 * Aircraft models the squadron operates. Task #137 (zero-trouble
 * multi-squadron install): factory ships EMPTY so a fresh PC running the
 * Setup Wizard fills in its own airframes — no example-squadron leakage
 * onto unrelated squadrons. The wizard writes the per-squadron list to
 * the `squadrons.default_aircraft` jsonb column added by migration 0039,
 * and `loadSquadronDefaults()` overlays a per-PC localStorage cache for
 * offline starts.
 */
const FACTORY_AIRFRAMES: string[] = [];

/**
 * Per-airframe fuel burn rate (lb/hr). Factory is empty for the same
 * reason — each squadron writes its own table during the wizard.
 */
const FACTORY_FUEL_BURN: Record<string, number> = {};

export interface SquadronDefaults {
  /** Default lecture topics — operator can add/remove on the defaults page. */
  lectures: string[];
  /** Default exercise types in next-month plan grid. */
  exercises: string[];
  /** Default morale used when starting a brand-new period. */
  morale: "HIGH" | "MEDIUM" | "LOW";
  /** Default text for INCIDENTS field — almost always "NIL". */
  incidentsDefault: string;
  /** Default text for ACCIDENTS field — almost always "NIL". */
  accidentsDefault: string;
  /** Per-airframe fuel burn rate (lb/hr). Editable. */
  fuelBurnByAirframe: Record<string, number>;
  /** Default ammo placeholder text — workbook uses "-" or "NIL". */
  ammoPlaceholder: string;
  /** Default REMARKS suggestions enabled (auto-fill from leave/TDY records). */
  autoSuggestRemarks: boolean;
  /** Minimum hours required across the rolling 6-month window. Drives the
   *  currency flag on the printed SIX-MONTHS sheet. Typical UH-60M
   *  squadrons run 30 hrs / 6 months as the floor, but other airframes /
   *  other regulators may differ — operator edits per squadron. */
  minSixMonthHours: number;
  /** Higher-echelon name printed at the top of every Monthly Report sheet
   *  (above the squadron). For a UH-60 squadron this might be "QUICK
   *  REACTION FORCE GROUP"; for an attack squadron, "ATTACK HELICOPTER
   *  GROUP". Editing this once per APK install retitles the whole
   *  packet. */
  groupName: string;
  /** Acronym for the parent group, used as the prefix on every form name
   *  ("QRFG RCN FORM 1", "QRFG FUEL", "QRFG AUTHORIZATION", etc.) and on
   *  the unit block of F1/F2/F3. Defaults to "QRFG". Operators editing
   *  `groupName` should also update this. */
  groupAcronym: string;
  /** Primary airframe model (e.g. "UH-60M", "AH-1F", "UH-60AIL"). Used
   *  as the F1 unit-cell fallback, the Arabic-roster column header,
   *  and the FUEL helper text. Combined with the per-airframe burn rate
   *  in `fuelBurnByAirframe` to drive the Form 4 fuel formula. */
  primaryAirframe: string;
  /** All aircraft models the squadron operates, in the order they should
   *  appear in dropdowns. Drives the A/C Type select on Add Sortie, the
   *  Sortie Log edit form, and the seed value on every new Flight Program
   *  row. A UH-60 squadron might fly UH-60M / UH-60L / UH-60AIL plus
   *  AS332 as a crossover; an attack squadron would replace the list
   *  entirely. */
  airframes: string[];
  /** Air base name as captured by the Setup Wizard (e.g. "Main Air Base").
   *  Mirrors `squadrons.base` for offline reads. */
  airbase?: string;
  /** Free-form "Base" descriptor — used when the squadron sits under
   *  a base headquarters distinct from the physical airbase (e.g.
   *  "8th Air Base HQ"). Captured by the Setup Wizard. */
  base?: string;
  /** Wing the squadron sits under (e.g. "8th Wing"). Captured by the
   *  Setup Wizard alongside group/airbase so a fresh install can render
   *  full chain-of-command labels without hitting the central server. */
  wing?: string;
  /** Short label shown on the Sortie Log header on Add Sortie
   *  ("SQNLOG · 2026-04-23 · UH-60M"). Squadrons may use "QREG",
   *  "SQNREG", "FLTLOG", or any short tag of their choice. Editing
   *  this once per APK install retitles the daily log header. */
  sortieLogLabel: string;
}

export function factoryDefaults(): SquadronDefaults {
  return {
    lectures: [...FACTORY_LECTURES],
    exercises: [...FACTORY_EXERCISES],
    morale: "HIGH",
    incidentsDefault: "NIL",
    accidentsDefault: "NIL",
    fuelBurnByAirframe: { ...FACTORY_FUEL_BURN },
    ammoPlaceholder: "-",
    autoSuggestRemarks: true,
    minSixMonthHours: 30,
    // Task #137: factory text is now neutral so a fresh PC doesn't show
    // a leaked group / acronym / log label until the squadron's Setup
    // Wizard fills them in.
    groupName: "",
    groupAcronym: "",
    primaryAirframe: "",
    airframes: [...FACTORY_AIRFRAMES],
    sortieLogLabel: "SQNLOG",
  };
}

export function loadSquadronDefaults(squadronNumber: string | undefined): SquadronDefaults {
  const key = squadronNumber || "default";
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (!raw) return factoryDefaults();
    const parsed = JSON.parse(raw) as Partial<SquadronDefaults>;
    // Merge with factory so newly-added fields survive an upgrade.
    const f = factoryDefaults();
    return {
      lectures: parsed.lectures?.length ? parsed.lectures : f.lectures,
      exercises: parsed.exercises?.length ? parsed.exercises : f.exercises,
      morale: parsed.morale ?? f.morale,
      incidentsDefault: parsed.incidentsDefault ?? f.incidentsDefault,
      accidentsDefault: parsed.accidentsDefault ?? f.accidentsDefault,
      fuelBurnByAirframe: { ...f.fuelBurnByAirframe, ...(parsed.fuelBurnByAirframe || {}) },
      ammoPlaceholder: parsed.ammoPlaceholder ?? f.ammoPlaceholder,
      autoSuggestRemarks: parsed.autoSuggestRemarks ?? f.autoSuggestRemarks,
      minSixMonthHours: parsed.minSixMonthHours ?? f.minSixMonthHours,
      groupName: parsed.groupName ?? f.groupName,
      groupAcronym: parsed.groupAcronym ?? f.groupAcronym,
      primaryAirframe: parsed.primaryAirframe ?? f.primaryAirframe,
      airframes: parsed.airframes?.length ? parsed.airframes : f.airframes,
      sortieLogLabel: parsed.sortieLogLabel ?? f.sortieLogLabel,
    };
  } catch {
    return factoryDefaults();
  }
}

/**
 * Task #137 — read the squadron's DB-backed defaults
 * (`default_aircraft`, `default_monthly_targets` from migration 0039)
 * and overlay them onto the local cache so any sibling PC for the
 * same squadron picks up the wizard's output without re-running it.
 *
 * **Internal migration:** when `VITE_INTERNAL_API_URL` (or the dev Vite
 * proxy) is active, reads the same columns from the LAN `api-server` first;
 * if that returns no row, falls back to Supabase.
 *
 * Returns true when a squadron row was found and merged into local
 * storage (caller uses this to auto-mark the Setup Wizard "complete"
 * when identity fields exist, even if `default_aircraft` is still empty).
 * Returns false when both internal and Supabase paths are unavailable
 * or no matching squadron row exists.
 */
/**
 * Merges a `squadrons` defaults row (Supabase or internal API) into the
 * in-memory defaults object. Exported for unit tests.
 */
export function mergeSquadronsRemoteRowIntoDefaults(
  cur: SquadronDefaults,
  data: {
    base: string | null | undefined;
    wing: string | null | undefined;
    default_aircraft: unknown;
    default_monthly_targets: unknown;
  },
): SquadronDefaults {
  const ac = Array.isArray(data.default_aircraft) ? data.default_aircraft : [];
  if (ac.length === 0) {
    // Row exists but no aircraft configured yet — upgraded install
    // pre-dating migration 0039. Seed identity fields only.
    return {
      ...cur,
      airbase: (data.base as string | null) ?? cur.airbase,
      base: (data.base as string | null) ?? cur.base,
      wing: (data.wing as string | null) ?? cur.wing,
    };
  }
  const burn: Record<string, number> = { ...cur.fuelBurnByAirframe };
  const airframes: string[] = [];
  for (const row of ac as Array<{ model?: string; fuelBurn?: number }>) {
    const m = (row?.model || "").trim();
    if (!m) continue;
    airframes.push(m);
    if (typeof row.fuelBurn === "number") burn[m] = row.fuelBurn;
  }
  const targets =
    data.default_monthly_targets && typeof data.default_monthly_targets === "object"
      ? (data.default_monthly_targets as Record<string, number>)
      : {};
  const monthly = Object.values(targets).find(v => typeof v === "number" && v > 0);
  return {
    ...cur,
    airbase: (data.base as string | null) ?? cur.airbase,
    base: (data.base as string | null) ?? cur.base,
    wing: (data.wing as string | null) ?? cur.wing,
    airframes: airframes.length ? airframes : cur.airframes,
    primaryAirframe: airframes[0] || cur.primaryAirframe,
    fuelBurnByAirframe: burn,
    minSixMonthHours: monthly ? monthly * 6 : cur.minSixMonthHours,
  };
}

export async function hydrateSquadronDefaultsFromDb(
  squadronNumber: string | undefined,
): Promise<boolean> {
  if (!squadronNumber) return false;
  try {
    const internal = await fetchInternalSquadronDefaultsRow(squadronNumber);
    if (internal) {
      const cur = loadSquadronDefaults(squadronNumber);
      saveSquadronDefaults(
        squadronNumber,
        mergeSquadronsRemoteRowIntoDefaults(cur, internal),
      );
      return true;
    }

    const { supabase, supabaseConfigured } = await import("@/lib/supabase");
    if (!supabaseConfigured || !supabase) return false;
    const { data, error } = await supabase
      .from("squadrons")
      .select("number, name, base, wing, default_aircraft, default_monthly_targets")
      .eq("number", squadronNumber)
      .maybeSingle();
    if (error || !data) return false;
    const cur = loadSquadronDefaults(squadronNumber);
    saveSquadronDefaults(
      squadronNumber,
      mergeSquadronsRemoteRowIntoDefaults(cur, {
        base: data.base as string | null,
        wing: data.wing as string | null,
        default_aircraft: data.default_aircraft,
        default_monthly_targets: data.default_monthly_targets,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function saveSquadronDefaults(squadronNumber: string | undefined, d: SquadronDefaults): void {
  const key = squadronNumber || "default";
  try {
    localStorage.setItem(KEY_PREFIX + key, JSON.stringify(d));
  } catch { /* noop */ }
}

/**
 * Look up the burn rate for an airframe; fall back to UH-60M (576) and then
 * to a reasonable global default. Used by the Form 4 fuel formula.
 */
export function fuelBurnFor(d: SquadronDefaults, airframe: string | undefined): number {
  if (airframe && d.fuelBurnByAirframe[airframe] != null) return d.fuelBurnByAirframe[airframe];
  if (d.fuelBurnByAirframe["UH-60M"] != null) return d.fuelBurnByAirframe["UH-60M"];
  return 576;
}
