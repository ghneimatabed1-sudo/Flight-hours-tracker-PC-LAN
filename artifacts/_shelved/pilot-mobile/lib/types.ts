export interface PilotProfile {
  id: string;
  militaryNumber: string;
  name: string;
  arabicName: string;
  rank: string;
  // Personal flight name / handle the pilot is known by within the squadron.
  // Purely a display field — shown as a subtitle on the home screen.
  flightName?: string;
  unit: string;
  squadron: string;
  phone?: string;
  openingDay: number;
  openingNight: number;
  openingNvg: number;
  openingCaptain: number;
  openingSim: number;
  // Lifetime instrument (ACT) hours — overlay label, not added to grand
  // total. Sourced from the dashboard baseline `data.initialHours.instrument`.
  // Surfaced on the home screen as an overlay chip alongside Captain/Sim
  // so the pilot can see the value without it inflating flight time. See
  // `.local/memory/initial-hours.md` for the canonical contract.
  openingInstrument?: number;
  expiry: {
    day: string;
    night: string;
    // NVG currency is fully independent of Night per RJAF SOP — flying a
    // Night sortie never refreshes NVG and vice versa. Each is tracked on
    // its own date and surfaced as a separate currency tile.
    nvg: string;
    irt: string;
    medical: string;
    // Kept on the type for back-compat with older snapshots, but the
    // mobile UI no longer surfaces sim as a currency. The pilot's last
    // simulator date lives in `lastSimDate` below — see
    // `.local/memory/currency-refresh.md`.
    sim: string;
  };
  // Last simulator session — monitoring date only, no currency window.
  // Mirrors `pilot.lastSimDate` on the dashboard. Surfaced as an info row
  // on the Currency screen so the pilot/commanders can see recency.
  lastSimDate?: string;
  // Currencies the squadron ops lead has marked N/A for this pilot (e.g. a
  // pilot who is not NVG-qualified). Hidden currencies are omitted from the
  // mobile currency screen entirely so the pilot doesn't see a stale tile.
  hiddenCurrencies?: ("day" | "night" | "nvg" | "irt" | "medical" | "sim")[];
}

export interface SortieRecord {
  id: string;
  date: string;
  acType: string;
  acNumber: string;
  sortieType: string;
  name: string;
  pilotIsCaptain: boolean;
  day: number;
  night: number;
  nvg: number;
  sim: number;
  total: number;
  condition?: "Day" | "Night" | "NVG";
  remarks?: string;
}

export interface NotamRecord {
  id: string;
  date: string;
  text: string;
}

// 3-level priority shared with NOTAMs and dashboard private messages.
// DB stores normal/medium/urgent; UI shows Normal / High / Very High.
export type AlertPriority = "normal" | "medium" | "urgent";

export interface AlertRecord {
  id: string;
  // ISO timestamp (date+time) — alerts are time-sensitive so we keep the
  // full timestamp instead of just a date, both for display and for the
  // phone-side TTL filter.
  postedAt: string;
  text: string;
  // Free-text label of who issued the alert (e.g. "Squadron Cmdr",
  // "Flight Cmdr A"). Stored as text so we don't have to schema-couple
  // the role enum into the mobile client.
  author?: string;
  // Defaults to "normal" when older rows pre-date the priority column.
  priority?: AlertPriority;
}

export interface PilotSnapshot {
  profile: PilotProfile;
  sorties: SortieRecord[];
  notams?: NotamRecord[];
  alerts?: AlertRecord[];
  fetchedAt: string;
}
