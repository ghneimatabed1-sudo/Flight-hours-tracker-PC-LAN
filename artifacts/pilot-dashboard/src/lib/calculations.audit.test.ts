// Section F audit fixtures (Task #152). Pure-function checks that pin
// the calculation engine behaviour relied on by every per-pilot total,
// the H1/H2 split, the captain credit rule, the per-seat captain flag
// fallback, and initial-hours folding. Run with:
//   pnpm --filter @workspace/pilot-dashboard exec tsx --test src/lib/calculations.audit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePilotTotals } from "./calculations.ts";
import type { Pilot, Sortie } from "./mock.ts";

const today = new Date();
const YYYY = today.getFullYear();
const MM = String(today.getMonth() + 1).padStart(2, "0");
const inThisMonth = `${YYYY}-${MM}-15`;
const lastYearH1 = `${YYYY - 1}-03-10`;
const thisYearH1 = `${YYYY}-03-10`;
const thisYearH2 = `${YYYY}-09-10`;

function basePilot(over: Partial<Pilot> = {}): Pilot {
  return {
    id: "P1", name: "Test Pilot", arabicName: "", rank: "Capt", phone: "", address: "",
    unit: "SQDN", openingDay: 0, openingNight: 0, openingNvg: 0,
    monthDay: 0, monthNight: 0, monthNvg: 0, monthSim: 0, monthCaptain: 0,
    totalDay: 0, totalNight: 0, totalNvg: 0, totalSim: 0, totalCaptain: 0,
    expiry: { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" },
    available: true, ...over,
  } as Pilot;
}

function sortie(over: Partial<Sortie>): Sortie {
  return {
    id: "S", date: inThisMonth, name: "X", airframe: "UH-60M", sortieType: "GH",
    pilotId: "P1", coPilotId: "P2",
    day1: 0, day2: 0, dayDual: 0, night1: 0, night2: 0, nightDual: 0,
    nvg: 0, sim: 0, actual: 0, ...over,
  } as Sortie;
}

test("F1 empty roster yields all zeros", () => {
  const t = computePilotTotals(basePilot(), []);
  assert.equal(t.grandTotal, 0);
  assert.equal(t.monthTotal, 0);
  assert.equal(t.h1.total + t.h2.total, 0);
});

test("F2 opening hours fold into totals only, not month/half buckets", () => {
  const p = basePilot({ openingDay: 100, openingNight: 50, openingNvg: 25 });
  const t = computePilotTotals(p, []);
  assert.equal(t.totalDay, 100);
  assert.equal(t.totalNight, 50);
  assert.equal(t.totalNvg, 25);
  assert.equal(t.monthDay, 0);
  assert.equal(t.h1.day, 0);
});

test("F3 P1 gets captain credit when captain flag is true", () => {
  const s = sortie({ day1: 2, actual: 2, pilotIsCaptain: true });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalCaptain, 2);
});

test("F4 P1 gets NO captain credit when explicit flag is false", () => {
  const s = sortie({ day1: 2, actual: 2, pilotIsCaptain: false, coPilotIsCaptain: true });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalCaptain, 0);
});

test("F5 P2 gets captain credit when coPilotIsCaptain=true", () => {
  const s = sortie({ day1: 2, actual: 2, pilotIsCaptain: false, coPilotIsCaptain: true });
  const p2 = basePilot({ id: "P2" });
  const t = computePilotTotals(p2, [s]);
  assert.equal(t.totalCaptain, 2);
});

test("F6 legacy fallback: missing flag → P1 = captain", () => {
  const s = sortie({ day1: 1, actual: 1 }); // no flags
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalCaptain, 1);
  const p2 = basePilot({ id: "P2" });
  assert.equal(computePilotTotals(p2, [s]).totalCaptain, 0);
});

test("F7 actual falls back to day+night+nvg+sim sum when blank", () => {
  const s = sortie({ day1: 1, night1: 1, nvg: 0.5, sim: 0.5, actual: 0, pilotIsCaptain: true });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalCaptain, 3);
});

test("F8 NVG never folded into Night — independent column", () => {
  const s = sortie({ nvg: 2, actual: 2 });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalNvg, 2);
  assert.equal(t.totalNight, 0);
});

test("F9 H1/H2 split honours June (m=5) cutoff", () => {
  const a = sortie({ id: "A", date: thisYearH1, day1: 1, actual: 1 });
  const b = sortie({ id: "B", date: thisYearH2, day1: 1, actual: 1 });
  const t = computePilotTotals(basePilot(), [a, b]);
  assert.equal(t.h1.day, 1, "March is H1");
  assert.equal(t.h2.day, 1, "September is H2");
});

test("F10 H1/H2 ignores last year — current calendar year only", () => {
  const a = sortie({ id: "A", date: lastYearH1, day1: 5, actual: 5 });
  const t = computePilotTotals(basePilot(), [a]);
  assert.equal(t.h1.day, 0);
  assert.equal(t.totalDay, 5, "lifetime still includes prior year");
});

test("F11 H bucket total includes Day+Night+NVG+Sim (post v1.1.69)", () => {
  const s = sortie({ date: thisYearH1, day1: 1, night1: 1, nvg: 1, sim: 1, actual: 4 });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.h1.total, 4);
});

test("F12 backdated sortie into prior month: month buckets unchanged, totals updated", () => {
  const lastMonth = new Date(YYYY, today.getMonth() - 1, 5).toISOString().slice(0, 10);
  const s = sortie({ date: lastMonth, day1: 3, actual: 3 });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.monthDay, 0, "current-month buckets stay clean");
  assert.equal(t.totalDay, 3, "lifetime captures the backdated hour");
});

test("F13 dual time sums into Day bucket (day1+day2+dayDual)", () => {
  const s = sortie({ day1: 1, day2: 0, dayDual: 2, actual: 3 });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalDay, 3);
});

test("F14 sortie not involving pilot is ignored", () => {
  const s = sortie({ pilotId: "OTHER", coPilotId: "OTHER2", day1: 5, actual: 5 });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalDay, 0);
});

test("F15 initial hours fold into totalCaptain via ih.captain", () => {
  const p = basePilot({ initialHours: { captain: 50 } as unknown as Pilot["initialHours"] });
  const t = computePilotTotals(p, []);
  assert.equal(t.totalCaptain, 50);
});

test("F16 grandTotal = day+night+nvg+sim (no double counting)", () => {
  const p = basePilot({ openingDay: 10, openingNight: 5, openingNvg: 3 });
  const s = sortie({ day1: 1, night1: 1, nvg: 1, sim: 1, actual: 4, pilotIsCaptain: true });
  const t = computePilotTotals(p, [s]);
  assert.equal(t.grandTotal, 11 + 6 + 4 + 1);
});

test("F17 sortiesThisMonth counts current-month appearances (one per sortie)", () => {
  const a = sortie({ id: "A", date: inThisMonth, day1: 1, actual: 1 });
  const b = sortie({ id: "B", date: lastYearH1, day1: 1, actual: 1 });
  const c = sortie({ id: "C", date: inThisMonth, day1: 1, actual: 1 });
  const t = computePilotTotals(basePilot(), [a, b, c]);
  // Two sorties this month → count 2. Engine increments per sortie row,
  // so a pilot appearing as P1 in two records this month sees count=2.
  assert.equal(t.sortiesThisMonth, 2);
});

test("F18 invalid date string is silently skipped (no NaN leak)", () => {
  const s = sortie({ date: "not-a-date", day1: 5, actual: 5 });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalDay, 5, "lifetime still adds (no date check on lifetime)");
  assert.ok(Number.isFinite(t.h1.day));
  assert.ok(Number.isFinite(t.monthDay));
});

test("F19 numeric coercion: string day1='2' is treated as 2", () => {
  const s = sortie({ day1: "2" as unknown as number, actual: "2" as unknown as number });
  const t = computePilotTotals(basePilot(), [s]);
  assert.equal(t.totalDay, 2);
});

test("F20 NaN/Infinity guarded against in inputs", () => {
  const s = sortie({ day1: NaN, actual: Infinity });
  const t = computePilotTotals(basePilot(), [s]);
  assert.ok(Number.isFinite(t.totalDay));
  assert.ok(Number.isFinite(t.grandTotal));
});
