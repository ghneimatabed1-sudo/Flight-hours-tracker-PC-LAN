import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pilot } from "../src/lib/mock";
import { preferredSchedulePilotName } from "../src/lib/schedule-names";

function mkPilot(overrides: Partial<Pilot> = {}): Pilot {
  return {
    id: "P-1",
    name: "Full Pilot Name",
    arabicName: "",
    rank: "Capt",
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
    expiry: { day: "2030-01-01", night: "2030-01-01", nvg: "2030-01-01", irt: "2030-01-01", medical: "2030-01-01", sim: "2030-01-01" },
    available: true,
    ...overrides,
  };
}

test("schedule name prefers flight name over full name", () => {
  const p = mkPilot({ flightName: "Falcon-1", callSign: "EAGLE-22", name: "Maj Ahmad Khalil" });
  assert.equal(preferredSchedulePilotName(p), "Falcon-1");
});

test("schedule name falls back to call sign when flight name missing", () => {
  const p = mkPilot({ flightName: "", callSign: "EAGLE-22", name: "Maj Ahmad Khalil" });
  assert.equal(preferredSchedulePilotName(p), "EAGLE-22");
});

test("schedule name falls back to pilot id (never full name)", () => {
  const p = mkPilot({ id: "P-777", flightName: "", callSign: "", name: "Maj Ahmad Khalil" });
  assert.equal(preferredSchedulePilotName(p), "P-777");
});
