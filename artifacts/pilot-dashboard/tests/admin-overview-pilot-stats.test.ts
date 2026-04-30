import { test } from "node:test";
import assert from "node:assert/strict";
import { worstStatusFromPilotData } from "../src/lib/admin-overview-pilot-stats";

test("admin overview stats picks worst status across currencies", () => {
  const status = worstStatusFromPilotData({
    expiry: {
      day: "2030-01-01",
      night: "2030-01-01",
      nvg: "2000-01-01",
      irt: "2030-01-01",
      medical: "2030-01-01",
    },
  });
  assert.equal(status, "expired");
});

test("admin overview stats handles empty data", () => {
  const status = worstStatusFromPilotData({});
  assert.equal(status, "unset");
});
