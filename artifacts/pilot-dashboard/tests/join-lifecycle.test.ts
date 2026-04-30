import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearPendingRequest,
  getPendingRequest,
  persistPendingRequest,
  type PendingRequest,
} from "../src/lib/unit-join";

function withFakeLocalStorage<T>(run: () => T): T {
  const prev = (globalThis as { localStorage?: Storage }).localStorage;
  const bag = new Map<string, string>();
  const fake: Storage = {
    get length() { return bag.size; },
    clear() { bag.clear(); },
    getItem(k: string) { return bag.has(k) ? bag.get(k)! : null; },
    key(i: number) { return Array.from(bag.keys())[i] ?? null; },
    removeItem(k: string) { bag.delete(k); },
    setItem(k: string, v: string) { bag.set(k, String(v)); },
  };
  (globalThis as { localStorage?: Storage }).localStorage = fake;
  try {
    return run();
  } finally {
    if (prev) (globalThis as { localStorage?: Storage }).localStorage = prev;
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test("join lifecycle: persist/get/clear pending request round-trip", () =>
  withFakeLocalStorage(() => {
    const row: PendingRequest = {
      requestId: "REQ-1",
      username: "ops.user",
      fingerprint: "FP-1234",
      claimToken: "abcd1234",
      password: "StrongPass123!",
      displayName: "Capt. Test",
      role: "ops",
      squadronNames: ["NO.8 SQDN"],
    };
    persistPendingRequest(row);
    const got = getPendingRequest();
    assert.ok(got);
    assert.equal(got.requestId, row.requestId);
    assert.equal(got.username, row.username);
    assert.equal(got.role, "ops");
    assert.deepEqual(got.squadronNames, ["NO.8 SQDN"]);

    clearPendingRequest();
    assert.equal(getPendingRequest(), null);
  }));

test("join lifecycle: malformed squadron list falls back to empty array", () =>
  withFakeLocalStorage(() => {
    persistPendingRequest({
      requestId: "REQ-2",
      username: "wing.user",
      fingerprint: "FP-9999",
      claimToken: "token9999",
      password: "StrongPass123!",
      displayName: "Col. Wing",
      role: "wing",
      squadronNames: ["NO.8 SQDN", "NO.2 SQDN"],
    });
    globalThis.localStorage.setItem("rjaf.joinPendingSquadrons", "{not-json");
    const got = getPendingRequest();
    assert.ok(got);
    assert.equal(got.role, "wing");
    assert.deepEqual(got.squadronNames, []);
  }));
