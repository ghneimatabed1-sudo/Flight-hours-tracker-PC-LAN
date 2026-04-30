import test from "node:test";
import assert from "node:assert/strict";
import { squadronsFromRemoteRows } from "../src/lib/squadron-store";

test("squadronsFromRemoteRows maps wing null to em dash placeholder", () => {
  const [s] = squadronsFromRemoteRows([
    {
      id: "11111111-1111-1111-1111-111111111111",
      number: "8",
      name: "NO.8 SQDN",
      base: "King Abdullah II AB",
      wing: null,
    },
  ]);
  assert.equal(s.wing, "—");
  assert.equal(s.code, "8");
  assert.equal(s.name, "NO.8 SQDN");
});

test("squadronsFromRemoteRows preserves wing text and uppercases code", () => {
  const [s] = squadronsFromRemoteRows([
    {
      id: "22222222-2222-2222-2222-222222222222",
      number: "12",
      name: "NO.12 SQDN",
      base: "North Base",
      wing: "4th Wing",
    },
  ]);
  assert.equal(s.wing, "4th Wing");
  assert.equal(s.code, "12");
});
