import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSortieDraft } from "../src/lib/add-sortie-smart";
import type { Sortie } from "../src/lib/mock";

type Draft = Parameters<typeof analyzeSortieDraft>[0];

function baseSortieDraft(): Draft {
  return {
    date: "2026-04-25",
    acType: "UH-60M",
    acNumber: "557",
    sortieType: "TRG DAY",
    condition: "Day",
    nvg: false,
    time: 1.2,
    dualHours: 0,
    instrumentFlight: false,
    ifSim: 0,
    ifAct: 0,
  };
}

test("add-sortie smart: blocks impossible IF total > sortie time", () => {
  const d = baseSortieDraft();
  d.instrumentFlight = true;
  d.ifSim = 1.0;
  d.ifAct = 0.9;
  d.time = 1.0;
  const out = analyzeSortieDraft(d, []);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /greater than sortie time/i);
});

test("add-sortie smart: warns on type/condition mismatch", () => {
  const d = baseSortieDraft();
  d.sortieType = "MSN NVG";
  d.condition = "Night";
  d.nvg = false;
  const out = analyzeSortieDraft(d, []);
  assert.equal(out.errors.length, 0);
  assert.ok(out.warnings.some(w => /type says NVG/i.test(w)));
});

test("add-sortie smart: warns when same aircraft is heavily used that day", () => {
  const d = baseSortieDraft();
  const rows: Sortie[] = Array.from({ length: 4 }, (_, i) => ({
    id: `S${i}`,
    date: d.date,
    acType: d.acType,
    acNumber: d.acNumber,
    pilotId: "p1",
    coPilotId: "p2",
    sortieType: "TRG DAY",
    name: "TRG DAY",
    day1: 1,
    day2: 0,
    dayDual: 0,
    night1: 0,
    night2: 0,
    nightDual: 0,
    nvg: 0,
    sim: 0,
    actual: 1,
    condition: "Day",
  }));
  const out = analyzeSortieDraft(d, rows);
  assert.ok(out.warnings.some(w => /already has 4 sorties/i.test(w)));
});

test("add-sortie smart: warns on likely duplicate sortie entry", () => {
  const d = baseSortieDraft();
  d.sortieType = "TRG DAY";
  d.condition = "Day";
  d.nvg = false;
  d.time = 1.5;
  const rows: Sortie[] = [{
    id: "Sx",
    date: d.date,
    acType: d.acType,
    acNumber: d.acNumber,
    pilotId: "p1",
    coPilotId: "p2",
    sortieType: "TRG DAY",
    name: "TRG DAY",
    day1: 1.5,
    day2: 0,
    dayDual: 0,
    night1: 0,
    night2: 0,
    nightDual: 0,
    nvg: 0,
    sim: 0,
    actual: 1.5,
    condition: "Day",
  }];
  const out = analyzeSortieDraft(d, rows);
  assert.ok(out.warnings.some(w => /possible duplicate sortie/i.test(w)));
});
