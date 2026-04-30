// Driven test for the Wing / Base / HQ commander empty-state reasoner
// (audit finding F-B-01). Each test simulates a HQ / Wing / Base
// commander signing in under one of the four documented failure modes
// (no registry, no snapshots, stale snapshots, empty rosters) and
// asserts the reasoner picks the matching reason code so the UI can
// render the right copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCommanderEmptyState,
  renderCommanderEmptyCopy,
  type EmptyStateScope,
  type EmptyStateSurface,
} from "./commander-empty-state.ts";

const NOW = Date.parse("2026-04-25T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
function isoHoursAgo(h: number): string {
  return new Date(NOW - h * HOUR_MS).toISOString();
}

// ─── no_registry ─────────────────────────────────────────────────────
// The wing commander is the first PC online. Nobody has registered a
// squadron PC, so there is literally nothing to aggregate. UI must
// instruct: "register a squadron PC".
test("no squadron PC registered → reason='no_registry' for HQ/Wing/Base", () => {
  for (const _scope of ["hq", "wing", "base"]) {
    const s = computeCommanderEmptyState({
      registeredSquadronCount: 0,
      snapshots: [],
      now: NOW,
    });
    assert.equal(s.reason, "no_registry");
    assert.equal(s.snapshotCount, 0);
    assert.equal(s.latestSnapshotAt, null);
    assert.equal(s.ageHours, null);
    assert.equal(s.totalPilots, 0);
  }
});

// ─── no_snapshots ────────────────────────────────────────────────────
// Squadron PCs exist in the registry but none has published a row to
// xpc_squadron_snapshot yet. Distinct from no_registry because the fix
// is on the squadron PC ("start the publish loop"), not on the
// commander side.
test("squadron PCs registered, none has published → 'no_snapshots'", () => {
  const s = computeCommanderEmptyState({
    registeredSquadronCount: 3,
    snapshots: [],
    now: NOW,
  });
  assert.equal(s.reason, "no_snapshots");
  assert.equal(s.registeredSquadronCount, 3);
  assert.equal(s.snapshotCount, 0);
});

// ─── stale ───────────────────────────────────────────────────────────
// Snapshots exist but the newest is older than the freshness budget
// (default 24h). Squadron Ops PC is probably offline — commander needs
// to know the picture they are looking at is no longer current.
test("newest snapshot >24h old → 'stale' with ageHours surfaced", () => {
  const s = computeCommanderEmptyState({
    registeredSquadronCount: 2,
    snapshots: [
      { squadronId: "8SQN", snapshotAt: isoHoursAgo(30), pilotCount: 12 },
      { squadronId: "5SQN", snapshotAt: isoHoursAgo(48), pilotCount: 9 },
    ],
    now: NOW,
  });
  assert.equal(s.reason, "stale");
  assert.equal(s.snapshotCount, 2);
  assert.equal(s.latestSnapshotAt, isoHoursAgo(30));
  assert.ok(s.ageHours !== null && Math.abs(s.ageHours - 30) < 0.001);
  assert.equal(s.totalPilots, 21);
});

test("custom staleHours respected", () => {
  const s = computeCommanderEmptyState({
    registeredSquadronCount: 1,
    snapshots: [{ squadronId: "8SQN", snapshotAt: isoHoursAgo(10), pilotCount: 5 }],
    now: NOW,
    staleHours: 6,
  });
  assert.equal(s.reason, "stale");
  assert.equal(s.staleHours, 6);
});

// ─── empty ───────────────────────────────────────────────────────────
// Snapshot exists, fresh, but rolled-up roster is zero pilots. The
// squadrons genuinely have no pilots enrolled — distinct from "the
// publish never ran" so commander knows not to chase the squadron Ops
// officer for a missing publish.
test("fresh snapshots but zero pilots → 'empty'", () => {
  const s = computeCommanderEmptyState({
    registeredSquadronCount: 2,
    snapshots: [
      { squadronId: "8SQN", snapshotAt: isoHoursAgo(2), pilotCount: 0 },
      { squadronId: "5SQN", snapshotAt: isoHoursAgo(1), pilotCount: 0 },
    ],
    now: NOW,
  });
  assert.equal(s.reason, "empty");
  assert.equal(s.totalPilots, 0);
});

// ─── ok ──────────────────────────────────────────────────────────────
// Fresh snapshot AND non-zero pilots → no banner needed.
test("fresh snapshot with pilots → 'ok' (no empty-state banner)", () => {
  const s = computeCommanderEmptyState({
    registeredSquadronCount: 2,
    snapshots: [
      { squadronId: "8SQN", snapshotAt: isoHoursAgo(1), pilotCount: 12 },
      { squadronId: "5SQN", snapshotAt: isoHoursAgo(0.5), pilotCount: 9 },
    ],
    now: NOW,
  });
  assert.equal(s.reason, "ok");
  assert.equal(s.totalPilots, 21);
});

// ─── precedence ──────────────────────────────────────────────────────
// no_registry beats no_snapshots beats stale beats empty.
test("classification precedence: registry > snapshots > stale > empty", () => {
  // Even with hypothetical snapshots in the input, zero registry rows
  // mean the registry has been wiped — surface that first.
  const a = computeCommanderEmptyState({
    registeredSquadronCount: 0,
    snapshots: [{ squadronId: "x", snapshotAt: isoHoursAgo(1), pilotCount: 5 }],
    now: NOW,
  });
  assert.equal(a.reason, "no_registry");

  // Stale + empty rosters → stale wins (commander needs to know the
  // picture is out of date, not that the rosters happen to read zero
  // through that stale window).
  const b = computeCommanderEmptyState({
    registeredSquadronCount: 1,
    snapshots: [{ squadronId: "x", snapshotAt: isoHoursAgo(48), pilotCount: 0 }],
    now: NOW,
  });
  assert.equal(b.reason, "stale");
});

// ─── malformed input ─────────────────────────────────────────────────
test("malformed ISO timestamps degrade gracefully (no crash, freshness=null)", () => {
  const s = computeCommanderEmptyState({
    registeredSquadronCount: 1,
    snapshots: [{ squadronId: "x", snapshotAt: "not-a-date", pilotCount: 3 }],
    now: NOW,
  });
  // Cannot parse the timestamp → treat as "freshness unknown" rather
  // than crash. The reasoner falls through past the stale check and
  // classifies based on roster content (3 pilots → ok).
  assert.equal(s.latestSnapshotAt, null);
  assert.equal(s.ageHours, null);
  assert.equal(s.totalPilots, 3);
  assert.equal(s.reason, "ok");
});

// ─── render-level (copy) tests ───────────────────────────────────────
// Audit F-B-01 done-criteria: HQ / Wing / Base must each see copy that
// names their tier and the cause. We can exercise the renderer
// directly because it is pure (React-free) — no jsdom needed.

const SCOPES: EmptyStateScope[] = ["wing", "base", "hq"];
const SURFACES: EmptyStateSurface[] = [
  "overview",
  "pilots",
  "alerts",
  "currencies",
];

test("render: HQ/Wing/Base + no_registry name their tier and the cause", () => {
  const state = computeCommanderEmptyState({
    registeredSquadronCount: 0,
    snapshots: [],
    now: NOW,
  });
  assert.equal(state.reason, "no_registry");
  for (const scope of SCOPES) {
    const copy = renderCommanderEmptyCopy(state, "overview", scope);
    assert.match(copy.title, /No squadron PC has registered/i);
    const tierWord = scope === "hq" ? "HQ" : scope === "wing" ? "Wing" : "Base";
    assert.ok(
      copy.body.includes(tierWord),
      `expected body to mention "${tierWord}" for scope=${scope}, got: ${copy.body}`,
    );
    assert.ok(copy.action && copy.action.length > 0);
    assert.match(copy.diagnostics ?? "", /xpc_registry/);
  }
});

test("render: HQ/Wing/Base + no_snapshots include registered count", () => {
  const state = computeCommanderEmptyState({
    registeredSquadronCount: 3,
    snapshots: [],
    now: NOW,
  });
  assert.equal(state.reason, "no_snapshots");
  for (const scope of SCOPES) {
    const copy = renderCommanderEmptyCopy(state, "alerts", scope);
    assert.match(copy.title, /no daily snapshot yet/i);
    assert.ok(copy.body.includes("3"), `expected "3" in body, got: ${copy.body}`);
    assert.match(copy.body, /currency alerts/);
    assert.match(copy.diagnostics ?? "", /xpc_squadron_snapshot: 0/);
    void scope;
  }
});

test("render: stale reason includes age in hours and threshold", () => {
  const state = computeCommanderEmptyState({
    registeredSquadronCount: 2,
    snapshots: [
      { squadronId: "a", snapshotAt: isoHoursAgo(48), pilotCount: 5 },
    ],
    now: NOW,
  });
  assert.equal(state.reason, "stale");
  for (const scope of SCOPES) {
    const copy = renderCommanderEmptyCopy(state, "currencies", scope);
    assert.match(copy.title, /stale/i);
    assert.match(copy.body, /48 hours? old/);
    assert.match(copy.body, /threshold: 24h/);
    assert.match(copy.body, /currency rows/);
    void scope;
  }
});

test("render: empty reason references the commander's tier in lowercase", () => {
  const state = computeCommanderEmptyState({
    registeredSquadronCount: 1,
    snapshots: [{ squadronId: "a", snapshotAt: isoHoursAgo(1), pilotCount: 0 }],
    now: NOW,
  });
  assert.equal(state.reason, "empty");
  for (const scope of SCOPES) {
    const copy = renderCommanderEmptyCopy(state, "pilots", scope);
    assert.match(copy.title, /squadrons report no pilots/i);
    const tierLower = scope === "hq" ? "hq" : scope === "wing" ? "wing" : "base";
    assert.ok(
      copy.body.includes(tierLower),
      `expected body to mention "${tierLower}" for scope=${scope}, got: ${copy.body}`,
    );
    assert.match(copy.diagnostics ?? "", /pilots total/);
  }
});

test("render: every reason × every surface produces non-empty title and body", () => {
  const fixtures = [
    computeCommanderEmptyState({
      registeredSquadronCount: 0,
      snapshots: [],
      now: NOW,
    }),
    computeCommanderEmptyState({
      registeredSquadronCount: 2,
      snapshots: [],
      now: NOW,
    }),
    computeCommanderEmptyState({
      registeredSquadronCount: 1,
      snapshots: [
        { squadronId: "a", snapshotAt: isoHoursAgo(72), pilotCount: 4 },
      ],
      now: NOW,
    }),
    computeCommanderEmptyState({
      registeredSquadronCount: 1,
      snapshots: [
        { squadronId: "a", snapshotAt: isoHoursAgo(2), pilotCount: 0 },
      ],
      now: NOW,
    }),
  ];
  for (const fx of fixtures) {
    for (const surface of SURFACES) {
      for (const scope of SCOPES) {
        const copy = renderCommanderEmptyCopy(fx, surface, scope);
        assert.ok(copy.title.length > 0, `empty title: ${fx.reason}/${surface}/${scope}`);
        assert.ok(copy.body.length > 0, `empty body: ${fx.reason}/${surface}/${scope}`);
      }
    }
  }
});
