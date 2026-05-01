// Canonical totals contract — kept byte-for-byte equivalent to the
// dashboard's `computePilotTotals` (artifacts/pilot-dashboard/src/lib/
// calculations.ts). A pilot looking at his phone must see the SAME
// lifetime / monthly / half-year numbers as his squadron commander
// sees on the PC. If you change any rule below — captain credit, NVG
// independence, opening-hours folding, half-year bucket totals, or the
// 1-decimal rounding shape — change the dashboard equivalent in the
// same commit AND extend the parity fixtures in
// `artifacts/pilot-dashboard/src/lib/calculations.parity.test.ts`.
// See `.local/reports/audit-2026-04-27/M-mobile-dashboard-totals.md`
// for the diagnosis that locked this contract in (Audit M, G-C2 fix).
import type { PilotProfile, SortieRecord } from "./types";

export interface HalfYearBreakdown {
  day: number;
  night: number;
  nvg: number;
  sim: number;
  captain: number;
  total: number;
  sorties: number;
}

export interface PilotTotals {
  totalDay: number;
  totalNight: number;
  totalNvg: number;
  totalSim: number;
  totalCaptain: number;
  // Hours flown as the non-captain crew member (second pilot / co-pilot).
  // Derived as grandTotal − totalCaptain so it always stays consistent with
  // whatever definition of "captain" the upstream sortie uses.
  totalSecondPilot: number;
  grandTotal: number;
  totalSorties: number;
  monthDay: number;
  monthNight: number;
  monthNvg: number;
  monthSim: number;
  monthCaptain: number;
  monthTotal: number;
  sortiesThisMonth: number;
  // Year-to-date rollups, split into calendar halves so the pilot can see
  // training load in the first and second half of the current year at a
  // glance (matches the old APK's "1st 6 / 2nd 6" cards).
  h1: HalfYearBreakdown;
  h2: HalfYearBreakdown;
  h1Hours: number;
  h2Hours: number;
  yearHours: number;
}

const emptyHalf = (): HalfYearBreakdown => ({
  day: 0,
  night: 0,
  nvg: 0,
  sim: 0,
  captain: 0,
  total: 0,
  sorties: 0,
});

function safeNum(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export function computeTotals(
  profile: PilotProfile,
  sorties: SortieRecord[]
): PilotTotals {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = now.getMonth();

  let mDay = 0,
    mNight = 0,
    mNvg = 0,
    mSim = 0,
    mCap = 0,
    mCount = 0;
  let aDay = 0,
    aNight = 0,
    aNvg = 0,
    aSim = 0,
    aCap = 0;
  // Half-year buckets (full category breakdown, matches old APK
  // "1st 6 months / 2nd 6 months" summary page).
  const h1: HalfYearBreakdown = emptyHalf();
  const h2: HalfYearBreakdown = emptyHalf();

  for (const s of sorties) {
    const day = safeNum(s.day);
    const night = safeNum(s.night);
    const nvg = safeNum(s.nvg);
    const sim = safeNum(s.sim);
    const total = safeNum(s.total);
    const cap = s.pilotIsCaptain ? total : 0;

    aDay += day;
    aNight += night;
    aNvg += nvg;
    aSim += sim;
    aCap += cap;

    // Parse date as local Y/M/D to avoid timezone off-by-one issues.
    const parts = (s.date || "").split("-");
    if (parts.length === 3) {
      const y = Number(parts[0]);
      const m = Number(parts[1]) - 1;
      if (y === yyyy && m === mm) {
        mDay += day;
        mNight += night;
        mNvg += nvg;
        mSim += sim;
        mCap += cap;
        mCount += 1;
      }
      // Half-year bucketing uses only the current calendar year so the
      // pilot never sees last year's flights counted in "this year's" halves.
      if (y === yyyy) {
        const bucket = m <= 5 ? h1 : h2;
        bucket.day += day;
        bucket.night += night;
        bucket.nvg += nvg;
        bucket.sim += sim;
        bucket.captain += cap;
        // Audit M (Round 3) — half-year `total` previously summed only
        // Day + Night, so the pilot's H1/H2 cards on the phone hid NVG
        // and Sim hours and never matched the squadron commander's
        // dashboard. Now mirrors the full bucket so totals reconcile
        // with `artifacts/pilot-dashboard/src/lib/calculations.ts`
        // byte-for-byte. See `.local/reports/audit-2026-04-27/
        // M-mobile-dashboard-totals.md`.
        bucket.total += day + night + nvg + sim;
        bucket.sorties += 1;
      }
    }
  }

  const totalDay = safeNum(profile.openingDay) + aDay;
  const totalNight = safeNum(profile.openingNight) + aNight;
  const totalNvg = safeNum(profile.openingNvg) + aNvg;
  const totalSim = safeNum(profile.openingSim) + aSim;
  const totalCaptain = safeNum(profile.openingCaptain) + aCap;

  // Captain / Second Pilot is a split of *actual flying hours only* (Day +
  // Night). NVG and Sim are tracked separately and must never be charged
  // against the P1/P2 split — they are not stick-time on a real aircraft.
  const flyingTotal = totalDay + totalNight;
  // Grand Total *does* include NVG + Sim so it matches the squadron PC
  // dashboard exactly. Canonical formula, kept identical on both surfaces.
  const grandTotal = flyingTotal + totalNvg + totalSim;
  // Audit M (Round 3) — `monthTotal` previously summed only Day + Night,
  // hiding NVG/Sim hours flown this month from the pilot. Dashboard's
  // `monthTotal` includes all four categories; mobile now matches.
  const monthTotal = mDay + mNight + mNvg + mSim;
  // Audit M (Round 3) — round to 1 decimal at the return surface to
  // match the dashboard's `+x.toFixed(1)` shape exactly so a JSON.stringify
  // diff between the two engines yields zero bytes for the projected
  // common keys. `h1` / `h2` stay raw (mirrors dashboard).
  const r1 = (v: number) => +v.toFixed(1);
  return {
    totalDay: r1(totalDay),
    totalNight: r1(totalNight),
    totalNvg: r1(totalNvg),
    totalSim: r1(totalSim),
    totalCaptain: r1(totalCaptain),
    totalSecondPilot: r1(Math.max(0, flyingTotal - totalCaptain)),
    grandTotal: r1(grandTotal),
    totalSorties: sorties.length,
    monthDay: r1(mDay),
    monthNight: r1(mNight),
    monthNvg: r1(mNvg),
    monthSim: r1(mSim),
    monthCaptain: r1(mCap),
    monthTotal: r1(monthTotal),
    sortiesThisMonth: mCount,
    h1,
    h2,
    h1Hours: h1.total,
    h2Hours: h2.total,
    yearHours: h1.total + h2.total,
  };
}

// ─── Periodic Summary (paper-logbook) ─────────────────────────────
// Mirrors the dashboard's `exportPeriodicSummary` PDF for an arbitrary
// (year, scope) tuple so the pilot can pull up his own H1 / H2 / Annual
// flying summary on the phone — same numbers the squadron commander sees
// on the PC. SortieRecord on mobile carries the flat day/night/nvg/sim
// fields plus pilotIsCaptain, so we surface a compact 6-line summary
// (no per-seat 1P/2P/Dual split — that breakdown only exists on the PC
// dashboard's Sortie shape).
export type PeriodicScope = "H1" | "H2" | "FULL";

export interface PeriodicSummary {
  year: number;
  scope: PeriodicScope;
  startISO: string;   // YYYY-MM-DD
  endISO: string;     // YYYY-MM-DD
  day: number;
  night: number;
  nvg: number;
  sim: number;
  captain: number;
  secondPilot: number;
  instrument: number;
  total: number;      // Day + Night (canonical 6-col total)
  grandTotal: number; // Day + Night + NVG + Sim
  sorties: number;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function isoDate(y: number, m1: number, d: number): string {
  return `${y}-${pad2(m1)}-${pad2(d)}`;
}

export function computePeriodicSummary(
  profile: PilotProfile,
  sorties: SortieRecord[],
  year: number,
  scope: PeriodicScope,
): PeriodicSummary {
  // H1 = Jan-Jun (months 0-5); H2 = Jul-Dec (months 6-11); FULL = whole year.
  const startMonth = scope === "H2" ? 6 : 0;
  const endMonth = scope === "H1" ? 5 : 11;
  // Last day of endMonth: trick is `new Date(y, endMonth+1, 0)` → day 0 of
  // the next month rolls back to the last day of endMonth. Local TZ-safe.
  const lastDay = new Date(year, endMonth + 1, 0).getDate();

  const opening = {
    day: safeNum(profile.openingDay),
    night: safeNum(profile.openingNight),
    nvg: safeNum(profile.openingNvg),
    sim: safeNum(profile.openingSim),
    captain: safeNum(profile.openingCaptain),
    instrument: safeNum(profile.openingInstrument),
  };
  void opening; // baseline is NOT added to periodic summary — paper logbook
                // periodic page covers ONLY sorties flown within the period.

  let day = 0, night = 0, nvg = 0, sim = 0, cap = 0, instr = 0, count = 0;

  for (const s of sorties) {
    const parts = (s.date || "").split("-");
    if (parts.length !== 3) continue;
    const y = Number(parts[0]);
    const m = Number(parts[1]) - 1;
    if (!Number.isFinite(y) || !Number.isFinite(m)) continue;
    if (y !== year) continue;
    if (m < startMonth || m > endMonth) continue;

    const sd = safeNum(s.day);
    const sn = safeNum(s.night);
    const sg = safeNum(s.nvg);
    const ss = safeNum(s.sim);

    day += sd;
    night += sn;
    nvg += sg;
    sim += ss;
    // Captain attribution = flying time only (Day + Night), matching the
    // dashboard's exportPeriodicSummary which attributes `t = sortie.actual`
    // (stick time) and excludes sim. NVG folds into Night per paper-book
    // convention but is NOT separately added here — it's already counted
    // inside the night bucket on dashboard sorties; on mobile the sortie
    // shape carries day/night/nvg as independent fields, and the legacy
    // computeTotals treats night and nvg as separate buckets, so we keep
    // captain on Day+Night only to match the dashboard contract exactly.
    if (s.pilotIsCaptain) cap += sd + sn;
    // Mobile SortieRecord doesn't carry an instrument-actual field today;
    // when the dashboard publishes one to the mobile sortie shape we'll
    // surface it here. Until then it stays at 0 (matches what the pilot
    // sees in the rest of the app).
    void instr;
    count += 1;
  }

  const total = day + night;
  const grandTotal = day + night + nvg + sim;
  const secondPilot = Math.max(0, total - cap);

  return {
    year,
    scope,
    startISO: isoDate(year, startMonth + 1, 1),
    endISO: isoDate(year, endMonth + 1, lastDay),
    day, night, nvg, sim,
    captain: cap,
    secondPilot,
    instrument: instr,
    total,
    grandTotal,
    sorties: count,
  };
}

export interface CurrencyItem {
  key: "day" | "night" | "nvg" | "irt" | "medical" | "sim";
  label: string;
  expiry: string | null;
  daysRemaining: number | null;
  status: "expired" | "urgent" | "soon" | "ok" | "missing";
}

export function computeCurrencies(profile: PilotProfile): CurrencyItem[] {
  // NVG is a distinct currency from Night — surface its own tile so the
  // pilot sees both expiries side by side and never assumes Night = NVG.
  const items: { key: CurrencyItem["key"]; label: string }[] = [
    { key: "day", label: "Day" },
    { key: "night", label: "Night" },
    { key: "nvg", label: "NVG" },
    { key: "irt", label: "IRT" },
    { key: "medical", label: "Medical" },
    // Sim removed — not a currency. Dashboard treats it as a monitoring
    // date only; mobile displays the value via PilotProfile.lastSimDate
    // on the Currency screen footer. See `.local/memory/currency-refresh.md`.
  ];

  // Ops can mark a currency N/A for a pilot on the dashboard
  // (e.g. a non-NVG-qualified pilot). Hidden currencies are dropped from
  // the mobile list entirely so the pilot doesn't see a stale tile.
  const hidden = new Set(profile.hiddenCurrencies ?? []);
  const visible = items.filter((i) => !hidden.has(i.key));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return visible.map(({ key, label }) => {
    const raw = profile.expiry?.[key];
    if (!raw) {
      return { key, label, expiry: null, daysRemaining: null, status: "missing" };
    }
    const parts = raw.split("-");
    if (parts.length !== 3) {
      return { key, label, expiry: raw, daysRemaining: null, status: "missing" };
    }
    const exp = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const days = Math.floor((exp.getTime() - today.getTime()) / 86400000);
    let status: CurrencyItem["status"];
    if (days < 0) status = "expired";
    else if (days <= 14) status = "urgent";
    else if (days <= 45) status = "soon";
    else status = "ok";
    return { key, label, expiry: raw, daysRemaining: days, status };
  });
}

export function formatHours(n: number): string {
  if (!Number.isFinite(n)) return "0.0";
  return n.toFixed(1);
}
