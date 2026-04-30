import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUseCloudSquadronSync } from "../src/lib/squadron-store";

test("squadron store skips cloud sync in LAN mode", () => {
  assert.equal(shouldUseCloudSquadronSync(true, true), false);
});

test("squadron store uses cloud only when not LAN and configured", () => {
  assert.equal(shouldUseCloudSquadronSync(false, true), true);
  assert.equal(shouldUseCloudSquadronSync(false, false), false);
});
