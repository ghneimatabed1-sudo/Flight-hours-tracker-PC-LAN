// Mock dataset that mimics what the Supabase backend would return.
// All component code reads from these helpers so swapping in the real
// Supabase client is a single-file change.

export interface Pilot {
  id: string;
  // Optional squadron call sign (e.g. "EAGLE-07"). Independent from `id`
  // (which is the immutable roster/service identifier). Ops officer can edit
  // freely; HQ dashboards show it alongside the pilot's name.
  callSign?: string;
  // Optional flight name — a personal handle the pilot goes by within the
  // squadron (e.g. "GHOST", "RAPTOR"). Distinct from the tactical callSign.
  // Displayed on commander / HQ views next to the callSign and on the mobile
  // app as the pilot's personal greeting.
  flightName?: string;
  name: string;
  arabicName: string;
  // Optional military service number (e.g. "20-1234"). Free text so units that
  // use letters/dashes can store them as-is. Shown on the roster, the pilot
  // detail page, and auto-displayed when the ops officer picks this pilot in
  // the Add Sortie form so they can confirm they chose the right person.
  militaryNumber?: string;
  rank: string;
  phone: string;
  address: string;
  unit: "SQDN" | "HQ Attached" | "Other" | "UH-60M" | "UH-60AIL" | "Both" | "RCN";
  openingDay: number;
  openingNight: number;
  openingNvg: number;
  doctorNote?: string;
  monthDay: number;
  monthNight: number;
  monthNvg: number;
  monthSim: number;
  monthCaptain: number;
  totalDay: number;
  totalNight: number;
  totalNvg: number;
  totalSim: number;
  totalCaptain: number;
  expiry: {
    day: string;
    night: string;
    irt: string;
    medical: string;
    sim: string;
  };
  // Currencies the ops officer has marked as not applicable for this pilot
  // (e.g. a pilot who only flies NVG and has no night currency to track).
  // Hidden currencies render as "N/A" everywhere and are excluded from
  // expired/warning counts and alerts.
  hiddenCurrencies?: ("day" | "night" | "irt" | "medical" | "sim")[];
  available: boolean;
  imported?: boolean;
  importedAt?: string;
  // Pilot qualifications (e.g. "MTP", "QHI", "IP"). Manually entered by ops
  // officer; reflected on commander / HQ dashboards.
  qualifications?: string[];
  // Date of the pilot's most recent simulator session. Visible only to the
  // squadron commander on the dashboard.
  lastSimDate?: string;
}

export type CurrencyKey = "day" | "night" | "irt" | "medical" | "sim";

export function isCurrencyHidden(p: Pick<Pilot, "hiddenCurrencies">, k: CurrencyKey): boolean {
  return Array.isArray(p.hiddenCurrencies) && p.hiddenCurrencies.includes(k);
}

// When a seat is flown by a pilot from a different squadron (a "guest"),
// `pilotId` / `coPilotId` stays empty and the free-text details are stored
// on `pilotExternal` / `coPilotExternal`. The external pilot doesn't exist
// in this squadron's roster, so their hours & currencies are NOT auto-
// updated here — instead the other squadron's ops officer can look up the
// flight on the External Pilots page and enter it in their own app.
export interface ExternalPilotRef {
  name: string;
  squadron: string;
}

export interface Sortie {
  id: string;
  date: string;
  acType: string;
  acNumber: string;
  pilotId: string;
  coPilotId: string;
  pilotExternal?: ExternalPilotRef;
  coPilotExternal?: ExternalPilotRef;
  sortieType: string;
  name: string;
  day1: number;
  day2: number;
  dayDual: number;
  night1: number;
  night2: number;
  nightDual: number;
  nvg: number;
  // NVG breakdown — 1st officer / 2nd officer / dual.
  // `nvg` remains the backward-compatible total (nvg1+nvg2+nvgDual).
  nvg1?: number;
  nvg2?: number;
  nvgDual?: number;
  sim: number;
  actual: number;
  // Primary flight condition selected by the ops officer. Independent from
  // per-category hour fields (which stay as the authoritative breakdown) but
  // gives a single-glance "this was a Day / Night / NVG sortie" tag used by
  // the sortie log and the mobile app.
  condition?: "Day" | "Night" | "NVG";
  // Free-text remarks entered by the ops officer (maintenance note, weather
  // abort, sortie cut short, etc.). Visible on the sortie log and on the
  // pilot's mobile app detail view.
  remarks?: string;
  imported?: boolean;
  importedAt?: string;
  // ── New simple-mode fields (added Apr 2026) ────────────────────────────
  // The simplified Add Sortie page enters a single Time number plus per-seat
  // metadata; we still derive the legacy day1/day2/night1/night2/dayDual/
  // nightDual buckets for backward compatibility with monthly reports and
  // the mobile app's roll-ups.
  time?: number;
  dual?: boolean;
  pilotPosition?: "1st" | "2nd";
  coPilotPosition?: "1st" | "2nd";
  // Per-seat role — independent for pilot and co-pilot.
  // "1st" = 1st Officer, "2nd" = 2nd Officer, "dual" = Dual instruction.
  // Stored alongside pilotPosition for backward compat; new code uses these.
  pilotStatus?: "1st" | "2nd" | "dual";
  coPilotStatus?: "1st" | "2nd" | "dual";
  pilotIsCaptain?: boolean;
  coPilotIsCaptain?: boolean;
  msnDuty?: string;
  // ── Instrument Flight (added Apr 2026, mirrors old mobile app) ─────────
  // Flag + breakdown fields. When `instrumentFlight` is true the sortie's
  // flight time also rolls up into the pilot's IF total. SIM and ACT are
  // tracked independently so reports can show "8.0 IF (SIM 5.0 / ACT 3.0)".
  instrumentFlight?: boolean;
  ifSim?: number;
  ifAct?: number;
  ils?: number;
  vor?: number;
}

function daysFromNow(d: number): string {
  const t = new Date();
  t.setDate(t.getDate() + d);
  return t.toISOString().slice(0, 10);
}

// Fresh install — no seeded roster, sorties, NOTAMs or duty roster. All arrays
// below are deliberately empty; the ops officer populates them through the UI.
// The structure of each record (types, export names) is preserved so every
// consumer continues to import without changes.

export const PILOTS: Pilot[] = [];

export const SORTIES: Sortie[] = [];

export const NOTAMS: { id: string; date: string; text: string }[] = [];

// Duty roster: one row per workday. Names resolve at render time; when the
// roster is empty, every cell reads "—" until the ops officer assigns real
// pilots. Uses optional chaining so an empty PILOTS array never throws.
export const DUTY_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu"].map((d, i) => ({
  day: d,
  mainDuty: PILOTS[i]?.name ?? "—",
  standby: PILOTS.length > 0 ? PILOTS[(i + 5) % PILOTS.length].name : "—",
  rcm: PILOTS.length > 0 ? PILOTS[(i + 9) % PILOTS.length].name : "—",
}));

// Standard RJAF six-month training cycle task codes. These are doctrine, not
// demo data, so they stay populated.
export const SIX_MONTH_TASKS = [
  "GH", "IF", "NF", "NVG", "MTF", "NAV", "NAV FOR", "EMER", "EVAL",
  "MSN DAY", "MSN NVG", "CRS DAY", "CRS NVG", "GP.C DAY", "CPC NVG",
];

// daysFromNow is exported for any callers that still compute relative dates.
export { daysFromNow };
