// Unit test for adaptSnapshotPilot — Round 4 AA3 / #268.
//
// The snapshot adapter is the consumer side of the publisher change in
// src/lib/cross-pc.ts. The schema-drift parity test in supabase/tests/
// validates the JSONB math in SQL against live prod, but does NOT
// exercise the TypeScript adapter (the path the dashboard actually
// renders). This unit test plugs that gap by calling adaptSnapshotPilot
// directly with three payload shapes and asserting the resulting
// DashPilot fields:
//
//   1. Fully-populated payload — all five hour fields present, all
//      finite. Adapter must echo them and compute
//      grandTotalHours = day + night + nvg.
//   2. Sparse payload (legacy / pre-AA3 publisher) — hour fields
//      missing entirely. Adapter must fall through to 0 across the
//      board, matching the pre-AA3 behaviour.
//   3. Mixed null/undefined payload — some fields explicitly null,
//      some undefined. Adapter must coerce both to 0 (Number(null) is
//      0 but Number(undefined) is NaN, so the `?? 0` guard is what
//      makes this test meaningful).

import { test } from "node:test";
import assert from "node:assert/strict";

import { adaptSnapshotPilot } from "../src/lib/dash-pilots";
import type { SquadronSnapshotPilot } from "../src/lib/cross-pc";

test("adaptSnapshotPilot echoes fully-populated hour fields and sums grandTotalHours", () => {
  const snap: SquadronSnapshotPilot = {
    id: "P1",
    callSign: "Falcon-1",
    flightName: "Alpha",
    rank: "Capt",
    name: "Test Pilot 1",
    expDay: "2026-12-31",
    expNight: "2026-12-31",
    expNvg: "2026-12-31",
    expIrt: "2026-12-31",
    expMedical: "2026-12-31",
    dayHours: 250,
    nightHours: 30,
    nvgHours: 10,
    simHours: 12,
    captainHours: 50,
  };
  const out = adaptSnapshotPilot(snap, "AlphaSqn");
  assert.equal(out.dayHours, 250);
  assert.equal(out.nightHours, 30);
  assert.equal(out.nvgTotalHours, 10); // snap.nvgHours -> Pilot.nvgTotalHours
  assert.equal(out.simHours, 12);
  assert.equal(out.captainHours, 50);
  assert.equal(out.grandTotalHours, 290); // 250 + 30 + 10
  assert.equal(out.squadronId, "AlphaSqn");
});

test("adaptSnapshotPilot falls through to 0 for pre-AA3 (sparse) payloads", () => {
  const snap: SquadronSnapshotPilot = {
    id: "P2",
    callSign: "Falcon-2",
    rank: "Lt",
    name: "Test Pilot 2",
    expDay: "2026-12-31",
    expNight: "2026-12-31",
    expNvg: "2026-12-31",
    expIrt: "2026-12-31",
    expMedical: "2026-12-31",
    // No hour fields at all — emulates pre-AA3 publisher output.
  };
  const out = adaptSnapshotPilot(snap, "BravoSqn");
  assert.equal(out.dayHours, 0);
  assert.equal(out.nightHours, 0);
  assert.equal(out.nvgTotalHours, 0);
  assert.equal(out.simHours, 0);
  assert.equal(out.captainHours, 0);
  assert.equal(out.grandTotalHours, 0);
});

test("adaptSnapshotPilot guards against non-finite (NaN/Infinity/junk) hour fields", () => {
  const snap = {
    id: "P4",
    callSign: "Falcon-4",
    rank: "Capt",
    name: "Test Pilot 4",
    expDay: "2026-12-31",
    expNight: "2026-12-31",
    expNvg: "2026-12-31",
    expIrt: "2026-12-31",
    expMedical: "2026-12-31",
    dayHours: NaN,
    nightHours: Infinity,
    nvgHours: "not-a-number",
    simHours: 7,
    captainHours: -Infinity,
  } as unknown as SquadronSnapshotPilot;
  const out = adaptSnapshotPilot(snap, "DeltaSqn");
  assert.equal(out.dayHours, 0);
  assert.equal(out.nightHours, 0);
  assert.equal(out.nvgTotalHours, 0);
  assert.equal(out.simHours, 7);
  assert.equal(out.captainHours, 0);
  // grandTotalHours must not be NaN — proves the guard prevents
  // poison values from cascading into the rollup arithmetic.
  assert.equal(Number.isFinite(out.grandTotalHours), true);
  assert.equal(out.grandTotalHours, 0);
});

test("adaptSnapshotPilot coerces null and undefined hour fields to 0", () => {
  const snap = {
    id: "P3",
    callSign: "Falcon-3",
    rank: "Maj",
    name: "Test Pilot 3",
    expDay: "2026-12-31",
    expNight: "2026-12-31",
    expNvg: "2026-12-31",
    expIrt: "2026-12-31",
    expMedical: "2026-12-31",
    dayHours: 100,
    nightHours: null,
    nvgHours: undefined,
    simHours: 5,
    captainHours: null,
  } as unknown as SquadronSnapshotPilot;
  const out = adaptSnapshotPilot(snap, "CharlieSqn");
  assert.equal(out.dayHours, 100);
  assert.equal(out.nightHours, 0);
  assert.equal(out.nvgTotalHours, 0);
  assert.equal(out.simHours, 5);
  assert.equal(out.captainHours, 0);
  assert.equal(out.grandTotalHours, 100); // 100 + 0 + 0
});
