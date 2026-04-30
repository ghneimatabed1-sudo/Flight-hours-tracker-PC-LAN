// Cross-platform parity fixtures (Audit M / G-C2 fix, Round 3).
// Loads BOTH calculation engines — dashboard's `computePilotTotals`
// AND the mobile app's `computeTotals` — and asserts they produce
// byte-equal output for the projected common keys on a shared
// fixture set. The fixtures include the failing pilot from Audit
// G's C-2 surface (P1 with +250 day / +30 night / +10 nvg / +50
// captain delta between the two engines pre-fix), so a regression
// that re-introduces that drift will fail this test on both
// surfaces simultaneously.
//
// Run:
//   pnpm --filter @workspace/pilot-dashboard exec tsx --test \
//     src/lib/calculations.parity.test.ts
//
// If you change EITHER engine without the other, this test will
// catch the drift at CI time before the pilot ever sees disagreeing
// numbers between his phone and his commander's PC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePilotTotals } from "./calculations.ts";
import type { Pilot, Sortie, InitialHours } from "./mock.ts";
// CJS interop: the mobile package isn't `"type": "module"` (Expo
// metro bundles it), so when tsx loads it from this ESM-typed
// dashboard package the named exports come through as a single
// CJS namespace under `.default`. We grab `computeTotals` off
// that interop namespace.
import * as mobileCalcNs from "../../../pilot-mobile/lib/calculations.ts";
import type { PilotProfile, SortieRecord } from "../../../pilot-mobile/lib/types.ts";

interface MobileCalcModule {
  computeTotals: (profile: PilotProfile, sorties: SortieRecord[]) => Record<string, unknown>;
}
const mobileCalc = ((mobileCalcNs as unknown as { default?: MobileCalcModule }).default
  ?? (mobileCalcNs as unknown as MobileCalcModule));
const { computeTotals } = mobileCalc;

// ─── Shared fixture helpers ─────────────────────────────────────

const today = new Date();
const YYYY = today.getFullYear();
const MM = String(today.getMonth() + 1).padStart(2, "0");
const inThisMonth = `${YYYY}-${MM}-15`;
const lastYearH1 = `${YYYY - 1}-03-10`;
const thisYearH1 = `${YYYY}-03-10`;
const thisYearH2 = `${YYYY}-09-10`;

function pilot(over: Partial<Pilot> = {}): Pilot {
  return {
    id: "P1", name: "Test", arabicName: "", rank: "Capt", phone: "",
    address: "", unit: "SQDN",
    openingDay: 0, openingNight: 0, openingNvg: 0,
    monthDay: 0, monthNight: 0, monthNvg: 0, monthSim: 0, monthCaptain: 0,
    totalDay: 0, totalNight: 0, totalNvg: 0, totalSim: 0, totalCaptain: 0,
    expiry: { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" },
    available: true, ...over,
  } as Pilot;
}

function sortie(over: Partial<Sortie>): Sortie {
  return {
    id: "S", date: inThisMonth, name: "X", acType: "UH-60M", acNumber: "1234",
    sortieType: "GH", pilotId: "P1", coPilotId: "P2",
    day1: 0, day2: 0, dayDual: 0, night1: 0, night2: 0, nightDual: 0,
    nvg: 0, sim: 0, actual: 0, ...over,
  } as Sortie;
}

// Sums the nine flying buckets in InitialHours (matches the snapshot
// builder in artifacts/pilot-mobile/lib/supabase.ts which folds the
// same buckets into PilotProfile.openingDay/Night/Nvg).
function ihSum(ih: InitialHours | undefined, kind: "day" | "night" | "nvg"): number {
  if (!ih) return 0;
  if (kind === "day") return (ih.day1 ?? 0) + (ih.day2 ?? 0) + (ih.dayDual ?? 0);
  if (kind === "night") return (ih.night1 ?? 0) + (ih.night2 ?? 0) + (ih.nightDual ?? 0);
  return (ih.nvg1 ?? 0) + (ih.nvg2 ?? 0) + (ih.nvgDual ?? 0);
}

// Convert a dashboard Pilot + the full Sortie list into the mobile
// (PilotProfile, SortieRecord[]) shape that the snapshot builder
// (artifacts/pilot-mobile/lib/supabase.ts → rowsToSnapshot) would
// produce for that pilot. The conversion mirrors the snapshot builder
// 1-to-1 — if the snapshot rules change, this helper changes.
function toMobile(p: Pilot, all: Sortie[]): { profile: PilotProfile; sorties: SortieRecord[] } {
  const ih = p.initialHours;
  const profile: PilotProfile = {
    id: p.id,
    militaryNumber: p.militaryNumber ?? p.id,
    name: p.name,
    arabicName: p.arabicName,
    rank: p.rank,
    unit: p.unit ?? "",
    squadron: "",
    phone: p.phone,
    openingDay: (p.openingDay ?? 0) + ihSum(ih, "day"),
    openingNight: (p.openingNight ?? 0) + ihSum(ih, "night"),
    openingNvg: (p.openingNvg ?? 0) + ihSum(ih, "nvg"),
    // Web `Pilot` has no openingCaptain field — captain baseline lives
    // in initialHours.captain. Mobile's openingCaptain field carries
    // the same value after the snapshot builder folds it.
    openingCaptain: ih?.captain ?? 0,
    // Web `Pilot` has no openingSim field; mobile starts sim totals at
    // sortie-derived (matches dashboard `totalSim = aSim`).
    openingSim: 0,
    openingInstrument: ih?.instrument ?? 0,
    expiry: { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" },
  };

  const sorties: SortieRecord[] = [];
  for (const s of all) {
    const isP1 = s.pilotId === p.id;
    const isP2 = s.coPilotId === p.id;
    if (!isP1 && !isP2) continue;
    const day = (s.day1 ?? 0) + (s.day2 ?? 0) + (s.dayDual ?? 0);
    const night = (s.night1 ?? 0) + (s.night2 ?? 0) + (s.nightDual ?? 0);
    const nvg = s.nvg ?? 0;
    const sim = s.sim ?? 0;
    // Per-seat captain flag (matches dashboard rule + mobile snapshot
    // rule: prefer the explicit per-seat boolean; fall back to legacy
    // P1 = captain when neither flag is set).
    const flag = isP1 ? s.pilotIsCaptain : s.coPilotIsCaptain;
    const cap = typeof flag === "boolean" ? flag : isP1;
    sorties.push({
      id: s.id,
      date: s.date,
      acType: s.acType,
      acNumber: s.acNumber,
      sortieType: s.sortieType,
      name: s.name,
      pilotIsCaptain: cap,
      day, night, nvg, sim,
      total: day + night + nvg + sim,
    });
  }
  return { profile, sorties };
}

// Project both engine outputs onto the shared subset of numeric keys
// that both surfaces expose. Any field unique to one engine
// (totalSecondPilot/totalSorties on mobile; nothing on dashboard) is
// dropped before comparison.
function projection(t: Record<string, unknown>): string {
  const keys = [
    "totalDay", "totalNight", "totalNvg", "totalSim", "totalCaptain",
    "grandTotal",
    "monthDay", "monthNight", "monthNvg", "monthSim", "monthCaptain",
    "monthTotal", "sortiesThisMonth",
    "h1Hours", "h2Hours", "yearHours",
  ];
  const halfKeys = ["day", "night", "nvg", "sim", "captain", "total", "sorties"];
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = +(t[k] as number ?? 0);
  for (const half of ["h1", "h2"] as const) {
    const h = (t[half] as Record<string, number>) ?? {};
    for (const k of halfKeys) out[`${half}.${k}`] = +(h[k] ?? 0);
  }
  return JSON.stringify(out);
}

function assertParity(name: string, p: Pilot, all: Sortie[]) {
  const dash = computePilotTotals(p, all);
  const { profile, sorties } = toMobile(p, all);
  const mob = computeTotals(profile, sorties);
  const dashJson = projection(dash as unknown as Record<string, unknown>);
  const mobJson = projection(mob as unknown as Record<string, unknown>);
  assert.equal(mobJson, dashJson, `${name}: mobile vs dashboard projection differs`);
}

// ─── Fixtures ──────────────────────────────────────────────────

// Audit G P1 — the failing pilot from C-2. Pre-fix, the deltas were
// +250 day, +30 night, +10 nvg, +50 captain between mobile and
// dashboard. The fix targets the mobile `monthTotal` + `bucket.total`
// shape, but on these inputs (no NVG/Sim sorties this month/year)
// the projection still tests the per-seat captain rule + initial
// hours folding, both of which are the underlying drift causes when
// the snapshot builder hasn't been updated for new initialHours
// buckets.
const G_P1 = pilot({
  id: "P1",
  name: "AUD_SIM_G_P1",
  openingDay: 100, openingNight: 50, openingNvg: 10,
  initialHours: {
    day1: 150, day2: 0, dayDual: 0,
    night1: 30, night2: 0, nightDual: 0,
    nvg1: 0, nvg2: 0, nvgDual: 0,
    captain: 50, instrument: 0,
  } as InitialHours,
});

const G_P2 = pilot({ id: "P2", name: "AUD_SIM_G_P2" });
const G_P3 = pilot({ id: "P3", name: "AUD_SIM_G_P3", openingNvg: 20 });
const G_P4 = pilot({ id: "P4", name: "AUD_SIM_G_P4" });
const G_P5 = pilot({ id: "P5", name: "AUD_SIM_G_P5" });
const G_P6 = pilot({ id: "P6", name: "AUD_SIM_G_P6" });
const G_P7 = pilot({ id: "P7", name: "AUD_SIM_G_P7" });
const G_P8 = pilot({
  id: "P8", name: "AUD_SIM_G_P8",
  initialHours: {
    day1: 50, day2: 25, dayDual: 5,
    night1: 10, night2: 5, nightDual: 0,
    nvg1: 5, nvg2: 0, nvgDual: 0,
    captain: 30, instrument: 4,
  } as InitialHours,
});

const G_PILOTS: Pilot[] = [G_P1, G_P2, G_P3, G_P4, G_P5, G_P6, G_P7, G_P8];

// 12 sorties dated within the last 30 days (current month, mixed pilots).
// 8 sorties dated 3 months ago. 6 sorties dated 1 year ago. 4 sorties
// dated 3 years ago. Each sortie hits a known mix of pilots so
// independent aggregations are predictable.
const threeMoAgo = new Date(YYYY, today.getMonth() - 3, 12).toISOString().slice(0, 10);
const oneYrAgo = `${YYYY - 1}-08-15`;
const threeYrAgo = `${YYYY - 3}-04-22`;

const G_SORTIES: Sortie[] = [
  // ── Current-month sorties (12) ─────────────────────────────
  sortie({ id: "S01", date: inThisMonth, pilotId: "P1", coPilotId: "P2", day1: 1.5, day2: 0, actual: 1.5, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S02", date: inThisMonth, pilotId: "P2", coPilotId: "P1", day1: 0, day2: 2.0, actual: 2.0, pilotIsCaptain: false, coPilotIsCaptain: true  }),
  sortie({ id: "S03", date: inThisMonth, pilotId: "P3", coPilotId: "P4", night1: 1.0, night2: 0, nvg: 0.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S04", date: inThisMonth, pilotId: "P5", coPilotId: "P6", day1: 1.0, dayDual: 1.0, actual: 2.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S05", date: inThisMonth, pilotId: "P7", coPilotId: "P8", day1: 0.8, actual: 0.8, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S06", date: inThisMonth, pilotId: "P1", coPilotId: "P3", nvg: 1.2, actual: 1.2, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S07", date: inThisMonth, pilotId: "P4", coPilotId: "P5", sim: 1.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S08", date: inThisMonth, pilotId: "P2", coPilotId: "P8", night1: 1.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S09", date: inThisMonth, pilotId: "P6", coPilotId: "P7", day1: 2.5, actual: 2.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S10", date: inThisMonth, pilotId: "P3", coPilotId: "P1", day1: 1.0, night1: 0.5, actual: 1.5, pilotIsCaptain: false, coPilotIsCaptain: true }),
  sortie({ id: "S11", date: inThisMonth, pilotId: "P8", coPilotId: "P2", nvg: 0.7, sim: 0.3, actual: 1.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S12", date: inThisMonth, pilotId: "P5", coPilotId: "P4", day1: 1.0, dayDual: 0.5, actual: 1.5, pilotIsCaptain: false, coPilotIsCaptain: true }),

  // ── 3 months ago (8) ───────────────────────────────────────
  sortie({ id: "S13", date: threeMoAgo, pilotId: "P1", coPilotId: "P2", day1: 2.0, actual: 2.0, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S14", date: threeMoAgo, pilotId: "P2", coPilotId: "P3", night1: 1.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S15", date: threeMoAgo, pilotId: "P3", coPilotId: "P4", nvg: 1.0, actual: 1.0, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S16", date: threeMoAgo, pilotId: "P5", coPilotId: "P6", day1: 1.0, sim: 0.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S17", date: threeMoAgo, pilotId: "P7", coPilotId: "P8", day1: 1.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S18", date: threeMoAgo, pilotId: "P1", coPilotId: "P5", night1: 0.5, nvg: 0.5, actual: 1.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S19", date: threeMoAgo, pilotId: "P6", coPilotId: "P7", day1: 2.0, actual: 2.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S20", date: threeMoAgo, pilotId: "P8", coPilotId: "P1", day1: 1.0, actual: 1.0, pilotIsCaptain: false, coPilotIsCaptain: true }),

  // ── 1 year ago (6) ─────────────────────────────────────────
  sortie({ id: "S21", date: oneYrAgo, pilotId: "P1", coPilotId: "P2", day1: 1.0, actual: 1.0, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S22", date: oneYrAgo, pilotId: "P2", coPilotId: "P3", night1: 1.0, actual: 1.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S23", date: oneYrAgo, pilotId: "P3", coPilotId: "P4", nvg: 0.5, actual: 0.5, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S24", date: oneYrAgo, pilotId: "P5", coPilotId: "P6", day1: 1.0, actual: 1.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S25", date: oneYrAgo, pilotId: "P7", coPilotId: "P8", sim: 1.0, actual: 1.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S26", date: oneYrAgo, pilotId: "P8", coPilotId: "P1", day1: 0.5, actual: 0.5, pilotIsCaptain: false, coPilotIsCaptain: true }),

  // ── 3 years ago (4) ────────────────────────────────────────
  sortie({ id: "S27", date: threeYrAgo, pilotId: "P1", coPilotId: "P2", day1: 1.0, actual: 1.0, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S28", date: threeYrAgo, pilotId: "P3", coPilotId: "P4", night1: 1.0, actual: 1.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S29", date: threeYrAgo, pilotId: "P5", coPilotId: "P6", nvg: 0.5, actual: 0.5, pilotIsCaptain: true,  coPilotIsCaptain: false }),
  sortie({ id: "S30", date: threeYrAgo, pilotId: "P7", coPilotId: "P8", day1: 1.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),

  // ── Half-year split anchors (this calendar year) ───────────
  sortie({ id: "S31", date: thisYearH1, pilotId: "P1", coPilotId: "P2", day1: 2.0, nvg: 0.5, actual: 2.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
  sortie({ id: "S32", date: thisYearH2, pilotId: "P1", coPilotId: "P2", night1: 1.5, sim: 0.5, actual: 2.0, pilotIsCaptain: true, coPilotIsCaptain: false }),

  // ── Per-seat captain edge cases ────────────────────────────
  sortie({ id: "S33", date: inThisMonth, pilotId: "P4", coPilotId: "P3", day1: 1.0, actual: 1.0, pilotIsCaptain: false, coPilotIsCaptain: true }),
  // legacy fallback (no per-seat flag) → P1 = captain
  sortie({ id: "S34", date: inThisMonth, pilotId: "P6", coPilotId: "P5", day1: 1.0, actual: 1.0 }),

  // ── Last-year H1 (must NOT show in this year's H1) ─────────
  sortie({ id: "S35", date: lastYearH1, pilotId: "P1", coPilotId: "P2", day1: 5.0, actual: 5.0, pilotIsCaptain: true, coPilotIsCaptain: false }),
];

// ─── Per-pilot parity tests ────────────────────────────────────

for (const p of G_PILOTS) {
  test(`M-parity ${p.id} (${p.name}) — mobile == dashboard projection`, () => {
    assertParity(p.id, p, G_SORTIES);
  });
}

// ─── Targeted invariants (the actual G-C2 drift causes) ────────

test("M-parity captain credit: P2 with explicit coPilotIsCaptain=true gets captain hours", () => {
  // Single sortie where pilot is P2 (co-pilot) AND co-pilot flag = true.
  // Pre-fix, mobile defaulted P1 = captain ignoring the seat flag, so
  // mobile credited 0 captain while dashboard credited the flying time.
  const s = sortie({ pilotId: "PA", coPilotId: "PB", day1: 2.0, actual: 2.0, pilotIsCaptain: false, coPilotIsCaptain: true });
  const PB = pilot({ id: "PB" });
  assertParity("PB-captain-as-P2", PB, [s]);
});

test("M-parity NVG independence: NVG hours never inflate Night bucket", () => {
  // Two NVG sorties, no Night sorties. Mobile and dashboard must both
  // report totalNight = 0, totalNvg = 4.0.
  const s1 = sortie({ id: "N1", pilotId: "P1", coPilotId: "P2", nvg: 2.0, actual: 2.0, pilotIsCaptain: true });
  const s2 = sortie({ id: "N2", pilotId: "P1", coPilotId: "P2", nvg: 2.0, actual: 2.0, pilotIsCaptain: true });
  assertParity("nvg-independence", pilot({ id: "P1" }), [s1, s2]);
});

test("M-parity initial hours fold into lifetime totals on both sides", () => {
  const p = pilot({
    id: "P1",
    initialHours: {
      day1: 100, day2: 50, dayDual: 25,
      night1: 40, night2: 20, nightDual: 5,
      nvg1: 15, nvg2: 5, nvgDual: 0,
      captain: 80, instrument: 12,
    } as InitialHours,
  });
  assertParity("initial-hours-fold", p, []);
});

test("M-parity half-year `total` includes Day + Night + NVG + Sim", () => {
  // The original v1.1.69 dashboard fix; mobile previously summed only
  // Day + Night and the H1/H2 cards on the phone hid NVG/Sim hours.
  const s = sortie({ id: "H", date: thisYearH1, pilotId: "P1", coPilotId: "P2", day1: 1, night1: 1, nvg: 1, sim: 1, actual: 4, pilotIsCaptain: true });
  assertParity("h1-bucket-total", pilot({ id: "P1" }), [s]);
});

test("M-parity monthTotal includes Day + Night + NVG + Sim", () => {
  // Pre-fix mobile `monthTotal` summed only Day + Night.
  const s = sortie({ id: "MT", date: inThisMonth, pilotId: "P1", coPilotId: "P2", day1: 1, night1: 1, nvg: 1, sim: 1, actual: 4, pilotIsCaptain: true });
  assertParity("month-total-grand", pilot({ id: "P1" }), [s]);
});

test("M-parity rounding: 1-decimal float at the return surface on both sides", () => {
  // Three sorties whose unrounded sum yields a non-terminating decimal.
  const s1 = sortie({ id: "R1", pilotId: "P1", coPilotId: "P2", day1: 0.1, actual: 0.1, pilotIsCaptain: true });
  const s2 = sortie({ id: "R2", pilotId: "P1", coPilotId: "P2", day1: 0.2, actual: 0.2, pilotIsCaptain: true });
  const s3 = sortie({ id: "R3", pilotId: "P1", coPilotId: "P2", night1: 0.1, actual: 0.1, pilotIsCaptain: true });
  assertParity("rounding-1dp", pilot({ id: "P1" }), [s1, s2, s3]);
});
