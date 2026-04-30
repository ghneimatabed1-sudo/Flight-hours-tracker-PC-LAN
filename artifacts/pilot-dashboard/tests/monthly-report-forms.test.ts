import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForm1Rows,
  buildForm3,
  buildSixMonths,
  defaultInputs,
  deriveForm3Stats,
  suggestNextMonthPlanFrom,
} from "../src/lib/monthly-report";
import type { Pilot, Sortie } from "../src/lib/mock";

function mkPilot(id: string, rank = "CPT"): Pilot {
  return {
    id,
    name: `Pilot ${id}`,
    arabicName: "",
    rank,
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
    available: true,
  };
}

function mkSortie(row: Partial<Sortie> & Pick<Sortie, "id" | "date" | "pilotId" | "coPilotId">): Sortie {
  return {
    id: row.id,
    date: row.date,
    acType: row.acType ?? "UH-60M",
    acNumber: row.acNumber ?? "557",
    pilotId: row.pilotId,
    coPilotId: row.coPilotId,
    sortieType: row.sortieType ?? "TRG DAY",
    name: row.name ?? "",
    day1: row.day1 ?? 0,
    day2: row.day2 ?? 0,
    dayDual: row.dayDual ?? 0,
    night1: row.night1 ?? 0,
    night2: row.night2 ?? 0,
    nightDual: row.nightDual ?? 0,
    nvg: row.nvg ?? 0,
    sim: row.sim ?? 0,
    actual: row.actual ?? 0,
    instrumentFlight: row.instrumentFlight,
  };
}

test("monthly report form1: blank status unless explicitly set", () => {
  const pilots = [mkPilot("P1"), mkPilot("P2")];
  const sorties: Sortie[] = [
    mkSortie({
      id: "S1",
      date: "2026-04-06",
      pilotId: "P1",
      coPilotId: "P2",
      day1: 1.2,
      day2: 1.2,
      dayDual: 0.3,
      sim: 0.4,
      actual: 0.8,
    }),
  ];

  const rows = buildForm1Rows(pilots, sorties, "2026-04", {
    perPilotStatus: {},
    perPilotRemarks: {},
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "");
  assert.equal(rows[0].totalForMonth, 1.5);
  assert.equal(rows[0].ifSim, 0.4);
  assert.equal(rows[0].ifAct, 0.8);
});

test("monthly report form3: IRT contributes to IF bucket and percentages", () => {
  const sorties: Sortie[] = [
    mkSortie({
      id: "S1",
      date: "2026-04-02",
      pilotId: "P1",
      coPilotId: "P2",
      sortieType: "IRT",
      day1: 1,
      day2: 1,
    }),
    mkSortie({
      id: "S2",
      date: "2026-04-03",
      pilotId: "P1",
      coPilotId: "",
      sortieType: "MSN",
      day1: 1,
    }),
  ];
  const computed = buildForm3(sorties, "2026-04");
  assert.equal(computed.missionTotals.IF.sorties, 1);
  assert.equal(computed.totalSorties, 2);
  assert.equal(computed.totalHours, 3);

  const stats = deriveForm3Stats(
    {
      squadronStrength: 0,
      ops: 0,
      attached: 0,
      course: 0,
      sickLeave: 0,
      sickRatePct: 0,
      morale: "HIGH",
      incidents: "NIL",
      accidents: "NIL",
      plannedSorties: 4,
      plannedHours: 6,
      weatherAbortS: 1,
      weatherAbortH: 0.5,
      maintAbortS: 0,
      maintAbortH: 0,
      opsAbortS: 0,
      opsAbortH: 0,
      airAbortS: 0,
      airAbortH: 0,
      lectures: [],
      nextMonthPlanFor: "2026-05",
      pilotsAvailableNext: 0,
      opsNext: 0,
      nextPlan: [],
      ammoPrev: { rkt275: "-", mm127: "-", mm762: "-" },
      ammoReq: { rkt275: "-", mm127: "-", mm762: "-" },
      perPilotStatus: {},
      perPilotRemarks: {},
    },
    computed,
  );
  assert.equal(stats.achievementSortiesPct, 50);
  assert.equal(stats.achievementHoursPct, 50);
  assert.equal(stats.weatherAbortPct, 33.3);
});

test("monthly report six-months: seat hours are attributed per pilot", () => {
  const pilots = [mkPilot("P1"), mkPilot("P2")];
  const sorties: Sortie[] = [
    mkSortie({
      id: "S1",
      date: "2026-04-10",
      pilotId: "P1",
      coPilotId: "P2",
      day1: 1.5,
      day2: 1.5,
    }),
    mkSortie({
      id: "S2",
      date: "2026-03-15",
      pilotId: "P1",
      coPilotId: "",
      day1: 2,
    }),
  ];

  const rows = buildSixMonths(pilots, sorties, "2026-04", 4);
  const p1 = rows.find((r) => r.pilot.id === "P1");
  const p2 = rows.find((r) => r.pilot.id === "P2");
  assert.ok(p1);
  assert.ok(p2);
  assert.equal(p1.total6mo, 3.5);
  assert.equal(p1.flag, "LOW");
  assert.equal(p2.total6mo, 1.5);
  assert.equal(p2.flag, "UNDER");
});

test("monthly report form4 defaults: next-month plan rows use defaults and period roll", () => {
  const pilots = [mkPilot("P1"), mkPilot("P2"), mkPilot("P3")];
  const inputs = defaultInputs("2026-04", pilots, {
    base: "",
    wing: "",
    monthlySortieTarget: 0,
    primaryAirframe: "UH-60M",
    sortieFuelBurnLbPerHour: 1100,
    exercises: ["GH", "IF", "NVG"],
    lectures: ["EMER. & LIMIT."],
    ammoPlaceholder: "NIL",
    minSixMonthHours: 12,
    morale: "HIGH",
    incidentsDefault: "NIL",
    accidentsDefault: "NIL",
  });

  assert.equal(inputs.nextMonthPlanFor, "2026-05");
  assert.equal(inputs.pilotsAvailableNext, 3);
  assert.deepEqual(inputs.nextPlan.map((r) => r.exercise), ["GH", "IF", "NVG"]);
  assert.equal(inputs.nextPlan[0].ammo275, "NIL");
});

test("monthly report form4 helper: suggest plan mirrors previous achieved", () => {
  const suggested = suggestNextMonthPlanFrom({ sorties: 42, hours: 63.5 });
  assert.deepEqual(suggested, { plannedSorties: 42, plannedHours: 63.5 });
});
