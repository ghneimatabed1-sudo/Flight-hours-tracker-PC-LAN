import test from "node:test";
import assert from "node:assert/strict";
import {
  factoryDefaults,
  mergeSquadronsRemoteRowIntoDefaults,
} from "../src/lib/squadron-defaults";

test("merge remote row with empty default_aircraft only updates base/wing", () => {
  const cur = factoryDefaults();
  const merged = mergeSquadronsRemoteRowIntoDefaults(cur, {
    base: "King Abdullah II AB",
    wing: "8th Wing",
    default_aircraft: [],
    default_monthly_targets: {},
  });
  assert.equal(merged.airbase, "King Abdullah II AB");
  assert.equal(merged.base, "King Abdullah II AB");
  assert.equal(merged.wing, "8th Wing");
  assert.deepEqual(merged.airframes, cur.airframes);
});

test("merge remote row applies airframes, primary, fuel burn, monthly floor", () => {
  const cur = factoryDefaults();
  const merged = mergeSquadronsRemoteRowIntoDefaults(cur, {
    base: "B1",
    wing: "W1",
    default_aircraft: [
      { model: "UH-60M", fuelBurn: 580 },
      { model: "UH-60L", fuelBurn: 520 },
    ],
    default_monthly_targets: { hours_per_month: 7 },
  });
  assert.deepEqual(merged.airframes, ["UH-60M", "UH-60L"]);
  assert.equal(merged.primaryAirframe, "UH-60M");
  assert.equal(merged.fuelBurnByAirframe["UH-60M"], 580);
  assert.equal(merged.fuelBurnByAirframe["UH-60L"], 520);
  assert.equal(merged.minSixMonthHours, 42);
});

test("merge preserves lectures and unrelated fields", () => {
  const cur = { ...factoryDefaults(), lectures: ["CUSTOM"] };
  const merged = mergeSquadronsRemoteRowIntoDefaults(cur, {
    base: null,
    wing: null,
    default_aircraft: [{ model: "AH-1F" }],
    default_monthly_targets: {},
  });
  assert.deepEqual(merged.lectures, ["CUSTOM"]);
  assert.deepEqual(merged.airframes, ["AH-1F"]);
});
