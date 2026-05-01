// Unit test for the matrix evidence diff used by release-verify.mjs.
// The diff is the only piece of release-verify that can be tested in
// isolation cheaply — the rest of the runner shells out to the real
// pnpm scripts. If the diff regresses (e.g. forgets to flag added or
// removed probes) the AMBER verdict silently turns GREEN, which is
// exactly the regression `release:verify` exists to catch.
//
// Run:  pnpm --filter @workspace/scripts run test

import { test } from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error — release-verify is a sibling .mjs file with no
// .d.ts; we only consume its `diffMatrixEvidence` export, which has
// a documented JSDoc shape.
import { diffMatrixEvidence } from "../src/release-verify.mjs";

type Snapshot = Record<
  string,
  Record<string, Record<string, number | null>>
>;

type Drift = {
  profile: string;
  role_slug: string;
  label: string;
  baseline_status: number | null | undefined;
  current_status: number | null | undefined;
  kind: "changed" | "added" | "removed";
};

test("returns no drifts when current matches baseline exactly", () => {
  const baseline: Snapshot = {
    hub: {
      "super-admin": { healthz: 200, "pilots.list": 200 },
      viewer: { healthz: 200, "pilots.upsert": 403 },
    },
  };
  const current: Snapshot = {
    hub: {
      "super-admin": { healthz: 200, "pilots.list": 200 },
      viewer: { healthz: 200, "pilots.upsert": 403 },
    },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.deepEqual(drifts, []);
});

test("flags a probe whose status changed (200 → 403)", () => {
  const baseline: Snapshot = {
    hub: { viewer: { "pilots.upsert": 200 } },
  };
  const current: Snapshot = {
    hub: { viewer: { "pilots.upsert": 403 } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 1);
  assert.deepEqual(drifts[0], {
    profile: "hub",
    role_slug: "viewer",
    label: "pilots.upsert",
    baseline_status: 200,
    current_status: 403,
    kind: "changed",
  });
});

test("flags a probe present in current but missing from baseline as added", () => {
  const baseline: Snapshot = {
    hub: { viewer: { healthz: 200 } },
  };
  const current: Snapshot = {
    hub: { viewer: { healthz: 200, "audit.read": 403 } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.kind, "added");
  assert.equal(drifts[0]?.label, "audit.read");
  assert.equal(drifts[0]?.baseline_status, undefined);
  assert.equal(drifts[0]?.current_status, 403);
});

test("flags a probe present in baseline but missing from current as removed", () => {
  const baseline: Snapshot = {
    hub: { viewer: { healthz: 200, "audit.read": 403 } },
  };
  const current: Snapshot = {
    hub: { viewer: { healthz: 200 } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.kind, "removed");
  assert.equal(drifts[0]?.label, "audit.read");
  assert.equal(drifts[0]?.baseline_status, 403);
  assert.equal(drifts[0]?.current_status, undefined);
});

test("flags new (profile, role) cells that did not exist in baseline", () => {
  const baseline: Snapshot = {
    hub: { viewer: { healthz: 200 } },
  };
  const current: Snapshot = {
    hub: { viewer: { healthz: 200 } },
    "aggregator-wing": { commander: { healthz: 200 } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 1);
  assert.deepEqual(drifts[0], {
    profile: "aggregator-wing",
    role_slug: "commander",
    label: "healthz",
    baseline_status: undefined,
    current_status: 200,
    kind: "added",
  });
});

test("treats a network_error (status null) as drift from a numeric baseline", () => {
  const baseline: Snapshot = {
    hub: { viewer: { healthz: 200 } },
  };
  const current: Snapshot = {
    hub: { viewer: { healthz: null } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.kind, "changed");
  assert.equal(drifts[0]?.baseline_status, 200);
  assert.equal(drifts[0]?.current_status, null);
});

test("returns drifts in stable sorted order (profile, role_slug, label)", () => {
  const baseline: Snapshot = {
    hub: { viewer: { z: 200, a: 200 } },
    "aggregator-wing": { commander: { m: 200 } },
  };
  const current: Snapshot = {
    hub: { viewer: { z: 403, a: 403 } },
    "aggregator-wing": { commander: { m: 403 } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  const ordering = drifts.map(
    (d) => `${d.profile}/${d.role_slug}/${d.label}`,
  );
  assert.deepEqual(ordering, [
    "aggregator-wing/commander/m",
    "hub/viewer/a",
    "hub/viewer/z",
  ]);
});

test("handles empty baseline (first-ever run) by flagging every probe as added", () => {
  const baseline: Snapshot = {};
  const current: Snapshot = {
    hub: { viewer: { healthz: 200, "pilots.list": 200 } },
  };
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 2);
  assert.ok(drifts.every((d) => d.kind === "added"));
});

test("handles empty current (matrix step skipped) by flagging every baseline probe as removed", () => {
  const baseline: Snapshot = {
    hub: { viewer: { healthz: 200 } },
  };
  const current: Snapshot = {};
  const drifts: Drift[] = diffMatrixEvidence(baseline, current);
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0]?.kind, "removed");
});
