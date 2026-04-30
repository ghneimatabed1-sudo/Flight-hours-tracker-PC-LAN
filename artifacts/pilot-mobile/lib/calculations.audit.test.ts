// Section M parity fixtures (Task #152). Mirrors the dashboard's
// calc audit: pins captain credit, NVG independence, H1/H2 split,
// month-bucket isolation, NaN guards, opening-hours folding for
// the mobile engine. The mobile shape is simpler (flat day/night/
// nvg/sim per sortie, single pilotIsCaptain flag) but the rules
// must agree with the dashboard so a pilot's hours never disagree
// between the two surfaces.
//
// Run with:
//   pnpm --filter @workspace/pilot-mobile exec tsx --test lib/calculations.audit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTotals } from "./calculations.ts";
import type { PilotProfile, SortieRecord } from "./types.ts";

const today = new Date();
const YYYY = today.getFullYear();
const MM = String(today.getMonth() + 1).padStart(2, "0");
const inThisMonth = `${YYYY}-${MM}-15`;
const lastYear = `${YYYY - 1}-03-10`;
const thisYearH1 = `${YYYY}-03-10`;
const thisYearH2 = `${YYYY}-09-10`;

function profile(over: Partial<PilotProfile> = {}): PilotProfile {
  return {
    id: "P1", militaryNumber: "0001", name: "Test", arabicName: "",
    rank: "Capt", unit: "SQDN", squadron: "NO.8 SQDN",
    openingDay: 0, openingNight: 0, openingNvg: 0,
    openingCaptain: 0, openingSim: 0,
    expiry: { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" },
    ...over,
  } as PilotProfile;
}

function sortie(over: Partial<SortieRecord>): SortieRecord {
  return {
    id: "S", date: inThisMonth, acType: "UH-60M", acNumber: "1234",
    sortieType: "GH", name: "Test",
    pilotIsCaptain: true,
    day: 0, night: 0, nvg: 0, sim: 0, total: 0, ...over,
  } as SortieRecord;
}

test("M1 empty roster yields all zeros", () => {
  const t = computeTotals(profile(), []);
  assert.equal(t.grandTotal, 0);
  assert.equal(t.monthTotal, 0);
  assert.equal(t.h1.total + t.h2.total, 0);
});

test("M2 opening hours fold into totals only, not month/half buckets", () => {
  const p = profile({ openingDay: 100, openingNight: 50, openingNvg: 25, openingCaptain: 75 });
  const t = computeTotals(p, []);
  assert.equal(t.totalDay, 100);
  assert.equal(t.totalNight, 50);
  assert.equal(t.totalNvg, 25);
  assert.equal(t.totalCaptain, 75);
  assert.equal(t.monthDay, 0);
  assert.equal(t.h1.day, 0);
});

test("M3 captain credit equals total when pilotIsCaptain=true", () => {
  const s = sortie({ day: 2, total: 2, pilotIsCaptain: true });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.totalCaptain, 2);
});

test("M4 NO captain credit when pilotIsCaptain=false", () => {
  const s = sortie({ day: 2, total: 2, pilotIsCaptain: false });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.totalCaptain, 0);
});

test("M5 NVG hours never fold into Night bucket", () => {
  const s = sortie({ nvg: 3, total: 3 });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.totalNvg, 3);
  assert.equal(t.totalNight, 0);
});

test("M6 H1/H2 split honours June (m=5) cutoff", () => {
  const a = sortie({ id: "A", date: thisYearH1, day: 5, total: 5 });
  const b = sortie({ id: "B", date: thisYearH2, day: 7, total: 7 });
  const t = computeTotals(profile(), [a, b]);
  assert.equal(t.h1.day, 5);
  assert.equal(t.h2.day, 7);
});

test("M7 H1/H2 ignore prior calendar year", () => {
  const ly = sortie({ id: "LY", date: lastYear, day: 100, total: 100 });
  const t = computeTotals(profile(), [ly]);
  assert.equal(t.h1.day, 0);
  assert.equal(t.h2.day, 0);
  // Lifetime total still reflects the sortie:
  assert.equal(t.totalDay, 100);
});

test("M8 backdated sortie into prior month: month buckets clean, lifetime updated", () => {
  // Pick a date that is definitely not this month (use Jan 02 of this year,
  // unless we're in January in which case use Jan 02 of prior year).
  const isJan = today.getMonth() === 0;
  const back = isJan ? `${YYYY - 1}-06-02` : `${YYYY}-01-02`;
  const s = sortie({ date: back, day: 4, total: 4 });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.monthDay, 0);
  assert.equal(t.totalDay, 4);
});

test("M9 sortiesThisMonth counts current-month appearances per sortie", () => {
  const a = sortie({ id: "A", date: inThisMonth, day: 1, total: 1 });
  const b = sortie({ id: "B", date: lastYear, day: 1, total: 1 });
  const c = sortie({ id: "C", date: inThisMonth, day: 1, total: 1 });
  const t = computeTotals(profile(), [a, b, c]);
  assert.equal(t.sortiesThisMonth, 2);
});

test("M10 invalid date string is silently skipped (no NaN leak)", () => {
  const s = sortie({ date: "not-a-date", day: 5, total: 5 });
  const t = computeTotals(profile(), [s]);
  assert.equal(Number.isFinite(t.grandTotal), true);
  assert.equal(t.monthDay, 0);
  // Sortie still counts toward lifetime via aDay because parts.length !== 3
  // path skipped only month/half bucketing — the running sum still added day.
  // This documents the current behaviour so any future change is intentional.
  assert.equal(t.totalDay, 5);
});

test("M11 numeric coercion: string-typed values treated as numbers", () => {
  const s = sortie({ day: "2" as unknown as number, total: "2" as unknown as number });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.totalDay, 2);
});

test("M12 NaN/Infinity guarded against in inputs", () => {
  const s = sortie({ day: NaN as unknown as number, total: Infinity as unknown as number });
  const t = computeTotals(profile(), [s]);
  assert.equal(Number.isFinite(t.grandTotal), true);
  assert.equal(t.totalDay, 0);
});

test("M13 grandTotal includes Day+Night+NVG+Sim (matches dashboard)", () => {
  const p = profile({ openingDay: 11, openingNight: 6, openingNvg: 4, openingSim: 1 });
  const t = computeTotals(p, []);
  assert.equal(t.grandTotal, 11 + 6 + 4 + 1);
});

test("M14 totalSecondPilot = max(0, flying - captain)", () => {
  const a = sortie({ id: "A", day: 10, total: 10, pilotIsCaptain: true });
  const b = sortie({ id: "B", day: 4, total: 4, pilotIsCaptain: false });
  const t = computeTotals(profile(), [a, b]);
  assert.equal(t.totalDay, 14);
  assert.equal(t.totalCaptain, 10);
  assert.equal(t.totalSecondPilot, 4);
});

test("M15 yearHours = h1Hours + h2Hours", () => {
  const a = sortie({ id: "A", date: thisYearH1, day: 5, total: 5 });
  const b = sortie({ id: "B", date: thisYearH2, day: 7, total: 7 });
  const t = computeTotals(profile(), [a, b]);
  assert.equal(t.yearHours, t.h1Hours + t.h2Hours);
});

// ─── Audit M (Round 3) — G-C2 fix lock-in ───────────────────────
// These pin the canonical contract that mobile and dashboard agree
// on `monthTotal`, the half-year `bucket.total`, and 1-decimal
// rounding. Drift here breaks parity with the dashboard. See
// `.local/reports/audit-2026-04-27/M-mobile-dashboard-totals.md`.

test("M16 monthTotal includes Day + Night + NVG + Sim (matches dashboard)", () => {
  const s = sortie({ date: inThisMonth, day: 1, night: 1, nvg: 1, sim: 1, total: 4 });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.monthTotal, 4);
});

test("M17 half-year bucket.total includes Day + Night + NVG + Sim", () => {
  const s = sortie({ id: "H1", date: thisYearH1, day: 1, night: 1, nvg: 1, sim: 1, total: 4 });
  const t = computeTotals(profile(), [s]);
  assert.equal(t.h1.total, 4);
  assert.equal(t.h1Hours, 4);
  assert.equal(t.yearHours, 4);
});

test("M18 outputs are rounded to 1 decimal at the return surface", () => {
  // 0.1 + 0.2 famously yields 0.30000000000000004 in IEEE-754. The
  // mobile engine must round to 0.3 so JSON.stringify against the
  // dashboard projection is byte-equal.
  const a = sortie({ id: "A", day: 0.1, total: 0.1 });
  const b = sortie({ id: "B", day: 0.2, total: 0.2 });
  const t = computeTotals(profile(), [a, b]);
  assert.equal(t.totalDay, 0.3);
  assert.equal(t.monthDay, 0.3);
  assert.equal(t.grandTotal, 0.3);
});
