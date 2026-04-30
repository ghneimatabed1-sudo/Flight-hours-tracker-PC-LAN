import { test } from "node:test";
import assert from "node:assert/strict";
import { userFromLanAuthProfile } from "../src/lib/lan-user-map";
import type { LanAuthUser } from "../src/lib/lan-user-map";

function row(partial: Partial<LanAuthUser> & Pick<LanAuthUser, "username" | "role">): LanAuthUser {
  return {
    id: partial.id ?? "u1",
    username: partial.username,
    displayName: partial.displayName ?? "Display",
    role: partial.role,
    squadronId: partial.squadronId ?? null,
  };
}

test("LAN user map: super_admin", () => {
  const u = userFromLanAuthProfile(row({ username: "a1", role: "super_admin" }), "A");
  assert.equal(u.role, "super_admin");
  assert.equal(u.username, "a1");
});

test("LAN user map: ops + squadron id", () => {
  const u = userFromLanAuthProfile(
    row({ username: "o1", role: "ops", squadronId: "sq-1" }),
    "O",
  );
  assert.equal(u.role, "ops");
  assert.deepEqual(u.squadronIds, ["sq-1"]);
});

test("LAN user map: commander:wing", () => {
  const u = userFromLanAuthProfile(row({ username: "c1", role: "commander:wing" }), "C");
  assert.equal(u.role, "commander");
  assert.equal(u.scope, "wing");
});

test("LAN user map: loose wing token", () => {
  const u = userFromLanAuthProfile(row({ username: "c2", role: "wing" }), "C");
  assert.equal(u.role, "commander");
  assert.equal(u.scope, "wing");
});
