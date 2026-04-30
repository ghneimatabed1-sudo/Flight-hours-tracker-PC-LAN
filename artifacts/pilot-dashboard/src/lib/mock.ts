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
  // Optional English equivalent of the Arabic `rank`. Auto-filled from
  // the RJAF rank lookup on the Add/Edit Pilot form, but the operator
  // can override. Every English UI render site reads this (with a
  // tolerant fallback to the lookup table) via `pilotRank()` so the
  // roster shows "Maj" instead of "رائد طيار" in English mode.
  rankEn?: string;
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
    // NVG is a fully independent currency from Night per RJAF SOP — flying
    // a Night sortie never refreshes NVG and vice versa. Tracked as its
    // own date and surfaced as a separate column on the ops Currency view.
    nvg: string;
    irt: string;
    medical: string;
    sim: string;
    // Mission qualification expiry — recurrent mission-set check that
    // RJAF SOP tracks per pilot (e.g. CAS, NVG mountain, SAR). Stored
    // alongside the other expiry slots in the JSONB `data` blob; no
    // schema migration required. The Add Pilot form replaced the
    // old "Last Medical" entry with this so the form's six "Last X
    // flown" cells align with what the operator actually tracks.
    missionQual?: string;
  };
  // Currencies the ops officer has marked as not applicable for this pilot
  // (e.g. a pilot who only flies NVG and has no night currency to track).
  // Hidden currencies render as "N/A" everywhere and are excluded from
  // expired/warning counts and alerts.
  hiddenCurrencies?: ("day" | "night" | "nvg" | "irt" | "medical" | "sim")[];
  available: boolean;
  imported?: boolean;
  importedAt?: string;
  // Pilot qualifications (e.g. "MTP", "QHI", "IP"). Manually entered by ops
  // officer; reflected on commander / HQ dashboards.
  qualifications?: string[];
  // v1.1.74 — joined qualification string (the "existing qualification
  // column" in storage terms). Persisted alongside the array so the
  // Add Pilot multi-segment input can round-trip the operator's chosen
  // separator (`/` or `-`) without a schema change. Read sites continue
  // to use `qualifications` (array of chips); writes set both.
  qualification?: string;
  // The separator the operator picked in the Add Pilot multi-segment
  // input. Defaults to `/`. Persisted so re-opening the form restores
  // the same look the operator chose last time.
  qualificationSeparator?: "/" | "-";
  // Date of the pilot's most recent simulator session. Visible only to the
  // squadron commander on the dashboard.
  lastSimDate?: string;
  // Other-aircraft experience the pilot has flown outside the unit's
  // primary type (e.g. UH-1H, AH-1F, sim-only types). Free-form so units
  // can capture whatever airframes matter to them; rendered as a small
  // section on the pilot detail page so commanders can see the wider
  // background at a glance.
  otherAircraft?: OtherAircraftEntry[];
  // INITIAL HOURS (baseline) — pre-Hawk-Eye lifetime hours the operator
  // enters once when adding a pilot mid-career. Folded into lifetime
  // totals (Ranking & Totals, Individual Pilot Record PDF) but DELIBERATELY
  // excluded from currency/expiry calculations and from Monthly Report
  // (Forms 1–4) — see `.local/memory/initial-hours.md` for the canonical
  // rule. Eleven independent buckets matching what the rest of the app
  // already tracks per sortie, so totals add cleanly.
  initialHours?: InitialHours;
}

export interface InitialHours {
  day1: number;
  day2: number;
  dayDual: number;
  night1: number;
  night2: number;
  nightDual: number;
  nvg1: number;
  nvg2: number;
  nvgDual: number;
  captain: number;
  instrument: number;
}

export const EMPTY_INITIAL_HOURS: InitialHours = {
  day1: 0, day2: 0, dayDual: 0,
  night1: 0, night2: 0, nightDual: 0,
  nvg1: 0, nvg2: 0, nvgDual: 0,
  captain: 0, instrument: 0,
};

// v1.1.80 — Sum the NINE time-buckets that actually add to lifetime
// flight time: Day (1st/2nd/Dual) + Night (1st/2nd/Dual) + NVG
// (1st/2nd/Dual). Captain and Instrument are OVERLAY labels — a captain
// hour is also a Day or Night hour, an instrument hour is also a Day or
// Night hour. They're stored and shown separately as overlays, but they
// must not be added a second time into the baseline sum or the lifetime
// Grand Total. This matches the legacy NO.8 SQDN log convention. See
// `.local/memory/initial-hours.md`.
export function sumInitialHours(ih: InitialHours | undefined): number {
  if (!ih) return 0;
  const n = (v: unknown) => (Number.isFinite(v as number) ? Number(v) : 0);
  return +(
    n(ih.day1) + n(ih.day2) + n(ih.dayDual) +
    n(ih.night1) + n(ih.night2) + n(ih.nightDual) +
    n(ih.nvg1) + n(ih.nvg2) + n(ih.nvgDual)
  ).toFixed(1);
}

export interface OtherAircraftEntry {
  type: string;        // e.g. "UH-1H"
  hours?: number;      // total hours on type
  notes?: string;      // optional comments / role / dates
}

export type CurrencyKey = "day" | "night" | "nvg" | "irt" | "medical" | "sim";

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
  // v1.1.70 — NVG sorties follow the same 9-bucket scheme as Day and Night
  // (1st seat / 2nd seat / Dual). The legacy single `nvg` field is kept as
  // the canonical total for backwards compatibility, while these per-seat
  // buckets carry the breakdown so the totals engine can credit each pilot
  // correctly. Optional because pre-rebuild records didn't have them.
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
  // Per-seat seat status — independent of the legacy 1st/2nd position field.
  // The simple-mode Add Sortie page lets each seat carry its own status
  // ("1st", "2nd", or "Dual") so a single flight can credit one pilot as
  // P1-flying while the other gets dual-instruction hours. Authoritative for
  // the new shared totals engine; falls back to legacy day1/day2/dayDual sum
  // when missing (historical records).
  pilotSeatStatus?: "1st" | "2nd" | "Dual";
  coPilotSeatStatus?: "1st" | "2nd" | "Dual";
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
