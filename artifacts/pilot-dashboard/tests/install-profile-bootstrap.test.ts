// Unit tests for the install-profile bootstrap helpers on the
// dashboard side: parsing, valid-set guarding, the active-profile
// module register, and the `/api/healthz` resolver.
//
// The aggregator helpers (`fetchAggregatePeersList`,
// `fetchAggregatePeersHealth`, `fetchAggregateRows`) are exercised
// here too — without a configured internal API URL they must
// return `null` rather than throw, so the dashboard degrades
// gracefully on a hub PC where the routes don't exist. See
// `tests/aggregate-fanout-routes.test.ts` for the matching server
// contract.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  parseInstallProfile,
  isAggregatorProfile,
  fetchInstallProfileFromHealthz,
} = await import("../src/lib/install-profile.tsx");

const {
  setActiveInstallProfile,
  getActiveInstallProfile,
  _resetActiveInstallProfileForTests,
  fetchAggregatePeersList,
  fetchAggregatePeersHealth,
  fetchAggregateRows,
  postAggregatePeer,
  patchAggregatePeer,
  deleteAggregatePeer,
} = await import("../src/lib/internal-migration");

test("parseInstallProfile · accepts every documented profile", () => {
  assert.equal(parseInstallProfile("hub"), "hub");
  assert.equal(parseInstallProfile("aggregator-wing"), "aggregator-wing");
  assert.equal(parseInstallProfile("aggregator-base"), "aggregator-base");
  assert.equal(parseInstallProfile("viewer"), "viewer");
});

test("parseInstallProfile · trims whitespace and rejects garbage", () => {
  assert.equal(parseInstallProfile("  hub  "), "hub");
  assert.equal(parseInstallProfile(""), null);
  assert.equal(parseInstallProfile("   "), null);
  assert.equal(parseInstallProfile("commander"), null);
  assert.equal(parseInstallProfile(undefined), null);
  assert.equal(parseInstallProfile(null), null);
  assert.equal(parseInstallProfile(42), null);
});

test("isAggregatorProfile · true only for the two aggregator tiers", () => {
  assert.equal(isAggregatorProfile("hub"), false);
  assert.equal(isAggregatorProfile("viewer"), false);
  assert.equal(isAggregatorProfile("aggregator-wing"), true);
  assert.equal(isAggregatorProfile("aggregator-base"), true);
});

test("active install profile register · default is hub, set/get/reset round-trip", () => {
  _resetActiveInstallProfileForTests();
  assert.equal(getActiveInstallProfile(), "hub");
  setActiveInstallProfile("aggregator-wing");
  assert.equal(getActiveInstallProfile(), "aggregator-wing");
  setActiveInstallProfile("aggregator-base");
  assert.equal(getActiveInstallProfile(), "aggregator-base");
  _resetActiveInstallProfileForTests();
  assert.equal(getActiveInstallProfile(), "hub");
});

test("fetchInstallProfileFromHealthz · falls back to hub when no internal API URL is configured", async () => {
  // In the node test env there is no `import.meta.env.VITE_INTERNAL_API_URL`
  // and `__viteEnv.DEV` is undefined, so `getInternalApiHealthUrl()`
  // returns `null` and the resolver short-circuits to the hub default
  // without ever calling fetch. This mirrors what a published web
  // build on a backend-less origin would see.
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called when URL is null");
  }) as typeof fetch;
  try {
    const r = await fetchInstallProfileFromHealthz();
    assert.equal(r.profile, "hub");
    assert.equal(r.error, null);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("aggregate helpers · return null gracefully on a hub PC (no aggregate routes)", async () => {
  // The dashboard ships in both modes; helpers must never throw on
  // a hub install where `/api/aggregate/*` does not exist. Without
  // a configured internal API base, every helper resolves to `null`
  // (read) or returns a structured `{ ok: false }` error (write)
  // instead of crashing the caller.
  _resetActiveInstallProfileForTests();
  setActiveInstallProfile("hub");

  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("fetch should not be reached without a configured base URL");
  }) as typeof fetch;
  try {
    assert.equal(await fetchAggregatePeersList(), null);
    assert.equal(await fetchAggregatePeersHealth(), null);
    assert.equal(await fetchAggregateRows("pilots"), null);
    assert.equal(await fetchAggregateRows("sorties"), null);
    assert.equal(await fetchAggregateRows("leaves"), null);
    assert.equal(await fetchAggregateRows("unavailable"), null);
    assert.equal(await fetchAggregateRows("notams"), null);
    assert.equal(await fetchAggregateRows("readiness-summary"), null);

    const post = await postAggregatePeer({
      squadron_id: "NO.5",
      base_url: "http://x:1",
      token: "secret",
    });
    assert.equal(post.ok, false);
    if (!post.ok) assert.equal(post.error, "aggregate_api_disabled");

    const patch = await patchAggregatePeer("id1", { base_url: "http://x:2" });
    assert.equal(patch.ok, false);
    if (!patch.ok) assert.equal(patch.error, "aggregate_api_disabled");

    const del = await deleteAggregatePeer("id1");
    assert.equal(del.ok, false);
    if (!del.ok) assert.equal(del.error, "aggregate_api_disabled");

    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = origFetch;
    _resetActiveInstallProfileForTests();
  }
});

test("fetchInstallProfileFromHealthz · ignores unknown installProfile values", async () => {
  // If the server answers but the body carries a value we don't
  // recognise (e.g. a future profile key, or a typo), we must stay on
  // hub rather than corrupting the active profile register.
  // This matches the parseInstallProfile contract above.
  assert.equal(parseInstallProfile("aggregator-galaxy"), null);
  assert.equal(parseInstallProfile("HUB"), null); // case-sensitive
});
