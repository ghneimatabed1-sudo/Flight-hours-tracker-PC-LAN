// Pin computePilotTotals against a small fixed-seed roster so a future
// refactor of the totals engine cannot silently shift the per-pilot
// Day / Night / NVG / Sim / Captain / Total / H1 / H2 numbers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computePilotTotals } from "../src/lib/calculations.ts";
import type { Pilot, Sortie } from "../src/lib/mock.ts";

const YEAR = new Date().getFullYear();
const pad = (n: number) => String(n).padStart(2, "0");
const day = (m: number, d: number) => `${YEAR}-${pad(m)}-${pad(d)}`;

function mkPilot(p: Partial<Pilot> & Pick<Pilot, "id" | "name" | "rank">): Pilot {
  return {
    arabicName: p.name,
    phone: "",
    address: "",
    unit: "SQDN",
    openingDay: 0,
    openingNight: 0,
    openingNvg: 0,
    monthDay: 0,
    monthNight: 0,
    monthNvg: 0,
    monthSim: 0,
    monthCaptain: 0,
    totalDay: 0,
    totalNight: 0,
    totalNvg: 0,
    totalSim: 0,
    totalCaptain: 0,
    expiry: { day: "", night: "", nvg: "", irt: "", medical: "", sim: "" },
    ...p,
  } as Pilot;
}

function mkSortie(s: Partial<Sortie> & Pick<Sortie, "id" | "date" | "pilotId">): Sortie {
  return {
    acType: "F-16",
    acNumber: "001",
    coPilotId: "",
    sortieType: "Training",
    name: "",
    day1: 0, day2: 0, dayDual: 0,
    night1: 0, night2: 0, nightDual: 0,
    nvg: 0, sim: 0, actual: 0,
    ...s,
  } as Sortie;
}

function buildRoster(): { pilots: Pilot[]; sorties: Sortie[] } {
  const pilots: Pilot[] = [
    mkPilot({
      id: "alpha", name: "Alpha", rank: "Capt",
      openingDay: 100, openingNight: 20, openingNvg: 5,
    }),
    mkPilot({
      id: "bravo", name: "Bravo", rank: "Lt",
      initialHours: {
        day1: 50, day2: 0, dayDual: 10,
        night1: 5, night2: 0, nightDual: 0,
        nvg1: 0, nvg2: 0, nvgDual: 0,
        captain: 25,
      },
    }),
    mkPilot({
      id: "charlie", name: "Charlie", rank: "Maj",
      openingDay: 200, openingNight: 50,
    }),
  ];

  const sorties: Sortie[] = [
    // H1
    mkSortie({ id: "s1", date: day(2, 5),  pilotId: "alpha", coPilotId: "bravo",
      day1: 1.5, actual: 1.5, pilotIsCaptain: true, coPilotIsCaptain: false }),
    mkSortie({ id: "s2", date: day(3, 12), pilotId: "charlie",
      day1: 2.0, night1: 0.5, actual: 2.5, pilotIsCaptain: true }),
    mkSortie({ id: "s3", date: day(4, 1),  pilotId: "alpha", coPilotId: "bravo",
      nvg: 1.2, actual: 1.2, pilotIsCaptain: false, coPilotIsCaptain: true }),
    mkSortie({ id: "s4", date: day(5, 20), pilotId: "bravo",
      sim: 1.0, actual: 1.0, pilotIsCaptain: true }),
    // s5 — legacy P1=captain fallback (no per-seat flags)
    mkSortie({ id: "s5", date: day(6, 30), pilotId: "charlie", coPilotId: "alpha",
      dayDual: 1.0, actual: 1.0 }),
    // H2
    mkSortie({ id: "s6", date: day(7, 4),  pilotId: "alpha", coPilotId: "charlie",
      nightDual: 0.8, actual: 0.9, pilotIsCaptain: true, coPilotIsCaptain: false }),
    mkSortie({ id: "s7", date: day(8, 15), pilotId: "bravo",
      day1: 0.5, day2: 0.5, actual: 1.0, pilotIsCaptain: true }),
    mkSortie({ id: "s8", date: day(9, 9),  pilotId: "charlie", coPilotId: "bravo",
      day1: 0.5, nvg: 0.5, actual: 1.0, pilotIsCaptain: false, coPilotIsCaptain: true }),
    mkSortie({ id: "s9", date: day(10, 21), pilotId: "alpha", coPilotId: "bravo",
      day1: 1.0, day2: 0.5, actual: 0, pilotIsCaptain: true, coPilotIsCaptain: false }),
    mkSortie({ id: "s10", date: day(11, 11), pilotId: "charlie",
      sim: 0.7, actual: 0.7, pilotIsCaptain: true }),
  ];
  return { pilots, sorties };
}

test("computePilotTotals · alpha lifetime + half-year snapshot", () => {
  const { pilots, sorties } = buildRoster();
  const t = computePilotTotals(pilots.find((p) => p.id === "alpha")!, sorties);

  assert.equal(t.totalDay, 104.0);
  assert.equal(t.totalNight, 20.8);
  assert.equal(t.totalNvg, 6.2);
  assert.equal(t.totalSim, 0);
  assert.equal(t.totalCaptain, 3.9);
  assert.equal(t.grandTotal, 131.0);

  assert.equal(t.h1.day, 2.5);
  assert.equal(t.h1.night, 0);
  assert.equal(t.h1.nvg, 1.2);
  assert.equal(t.h1.sim, 0);
  assert.equal(t.h1.sorties, 3);
  assert.equal(t.h1.captain, 1.5);
  assert.equal(t.h1.total, 3.7);

  assert.equal(t.h2.day, 1.5);
  assert.equal(t.h2.night, 0.8);
  assert.equal(t.h2.nvg, 0);
  assert.equal(t.h2.sim, 0);
  assert.equal(t.h2.sorties, 2);
  assert.equal(t.h2.captain, 2.4);
  assert.equal(t.h2.total, 2.3);
});

test("computePilotTotals · bravo + initialHours snapshot", () => {
  const { pilots, sorties } = buildRoster();
  const t = computePilotTotals(pilots.find((p) => p.id === "bravo")!, sorties);

  // initialHours folds into lifetime totals only — never into bucketed totals.
  assert.equal(t.totalDay, 64.5);
  assert.equal(t.totalNight, 5.0);
  assert.equal(t.totalNvg, 1.7);
  assert.equal(t.totalSim, 1.0);
  assert.equal(t.totalCaptain, 29.2);
  assert.equal(t.grandTotal, 72.2);

  assert.equal(t.h1.day, 1.5);
  assert.equal(t.h1.night, 0);
  assert.equal(t.h1.nvg, 1.2);
  assert.equal(t.h1.sim, 1.0);
  assert.equal(t.h1.sorties, 3);
  assert.equal(t.h1.captain, 2.2);
  assert.equal(t.h1.total, 3.7);

  assert.equal(t.h2.day, 3.0);
  assert.equal(t.h2.nvg, 0.5);
  assert.equal(t.h2.sorties, 3);
  assert.equal(t.h2.captain, 2.0);
});

test("computePilotTotals · charlie pins legacy P1=captain fallback", () => {
  const { pilots, sorties } = buildRoster();
  const t = computePilotTotals(pilots.find((p) => p.id === "charlie")!, sorties);

  assert.equal(t.totalDay, 203.5);
  assert.equal(t.totalNight, 51.3);
  assert.equal(t.totalNvg, 0.5);
  assert.equal(t.totalSim, 0.7);
  assert.equal(t.totalCaptain, 4.2);
  assert.equal(t.grandTotal, 256.0);

  assert.equal(t.h1.day, 3.0);
  assert.equal(t.h1.night, 0.5);
  assert.equal(t.h1.sorties, 2);
  assert.equal(t.h2.day, 0.5);
  assert.equal(t.h2.night, 0.8);
  assert.equal(t.h2.nvg, 0.5);
  assert.equal(t.h2.sim, 0.7);
  assert.equal(t.h2.sorties, 3);
});

test("readiness snapshot · roster tally", () => {
  const { pilots, sorties } = buildRoster();
  const totals = pilots.map((p) => computePilotTotals(p, sorties));
  const sumGrand = +totals.reduce((s, t) => s + t.grandTotal, 0).toFixed(1);
  const sumYear = +totals.reduce((s, t) => s + t.yearHours, 0).toFixed(1);
  assert.equal(sumGrand, 459.2);
  assert.equal(sumYear, 19.2);
});
