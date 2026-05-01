// Acceptance test for the multi-tier read-scope filter that the
// api-server uses when scoping bulk SELECTs (pilots, sorties, schedule,
// etc.) to what a given LAN role is allowed to see. Failure here means
// a wing/base commander either sees nothing or sees too much.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSquadronReadFilter } from "../../api-server/src/lib/lan-authz";

test("super_admin and admin see everything (no filter)", () => {
  for (const role of ["super_admin", "admin"]) {
    const out = buildSquadronReadFilter({ role, squadronId: "S1" }, "p.squadron_id", 1);
    assert.equal(out, null, `${role} should not produce a filter`);
  }
});

test("ops at S1 may only read S1", () => {
  const out = buildSquadronReadFilter(
    { role: "ops", squadronId: "S1" },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  assert.match(out!.sql, /and p\.squadron_id::text = \$1/);
  assert.deepEqual(out!.params, ["S1"]);
});

test("ops with no squadron is fail-closed", () => {
  const out = buildSquadronReadFilter({ role: "ops", squadronId: null }, "p.squadron_id", 1);
  assert.ok(out);
  assert.equal(out!.sql, "and false");
  assert.deepEqual(out!.params, []);
});

test("commander_squadron behaves identically to ops for reads", () => {
  const out = buildSquadronReadFilter(
    { role: "commander_squadron", squadronId: "S1" },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  assert.match(out!.sql, /and p\.squadron_id::text = \$1/);
  assert.deepEqual(out!.params, ["S1"]);
});

test("commander_wing reads every squadron in their wing plus their own", () => {
  const out = buildSquadronReadFilter(
    { role: "commander_wing", squadronId: "S1", wingId: "W1" },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  // Should reference both wing_id ($1) and own squadron ($2).
  assert.match(out!.sql, /wing_id = \$1/);
  assert.match(out!.sql, /p\.squadron_id::text = \$2/);
  assert.deepEqual(out!.params, ["W1", "S1"]);
});

test("commander_wing with no wing_id falls back to their own squadron", () => {
  const out = buildSquadronReadFilter(
    { role: "commander_wing", squadronId: "S1", wingId: null },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  assert.equal(out!.sql, "and p.squadron_id::text = $1");
  assert.deepEqual(out!.params, ["S1"]);
});

test("commander_base reads every squadron on their base plus their own", () => {
  const out = buildSquadronReadFilter(
    { role: "commander_base", squadronId: "S1", baseId: "B1" },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  assert.match(out!.sql, /base_id = \$1/);
  assert.match(out!.sql, /p\.squadron_id::text = \$2/);
  assert.deepEqual(out!.params, ["B1", "S1"]);
});

test("unknown role is fail-closed", () => {
  const out = buildSquadronReadFilter(
    { role: "intern", squadronId: "S1" },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  assert.equal(out!.sql, "and false");
  assert.deepEqual(out!.params, []);
});

test("legacy 'commander' role gets squadron-only scope (fail-closed default)", () => {
  const out = buildSquadronReadFilter(
    { role: "commander", squadronId: "S1" },
    "p.squadron_id",
    1,
  );
  assert.ok(out);
  assert.equal(out!.sql, "and p.squadron_id::text = $1");
  assert.deepEqual(out!.params, ["S1"]);
});

test("firstParamIndex composes with caller-supplied bind params", () => {
  // Caller already used $1, $2 for an outer WHERE; filter should start at $3.
  const out = buildSquadronReadFilter(
    { role: "commander_wing", squadronId: "S1", wingId: "W1" },
    "p.squadron_id",
    3,
  );
  assert.ok(out);
  assert.match(out!.sql, /wing_id = \$3/);
  assert.match(out!.sql, /p\.squadron_id::text = \$4/);
});
