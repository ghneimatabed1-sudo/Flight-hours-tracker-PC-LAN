// Tests for the magic LAN auto-discovery library
// (`api-server/src/lib/lan-discovery.ts`).
//
// These tests intentionally bypass dns-sd.exe by using `MockLanBus`,
// the in-process pretend-mDNS bus the lib exports for exactly this
// purpose. Two `LanDiscoveryService` instances share one bus; we
// assert each sees the other's announce and that the eviction sweep
// drops a peer that hasn't re-announced for `staleMs`.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:lan-discovery

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LanDiscoveryService,
  MockLanBus,
  isLanPeerRole,
  installProfileToRole,
  makeMockLanTransport,
  type LanPeerAnnounce,
} from "../../api-server/src/lib/lan-discovery";

function makeService(opts: {
  bus: MockLanBus;
  hostname: string;
  role: ReturnType<typeof installProfileToRole>;
  port: number;
  txt: Record<string, string>;
  now?: () => number;
  staleMs?: number;
}): LanDiscoveryService {
  const self: LanPeerAnnounce = {
    hostname: opts.hostname,
    role: opts.role,
    address: "10.0.0.5",
    port: opts.port,
    txt: opts.txt,
  };
  const transport = makeMockLanTransport({
    bus: opts.bus,
    selfAnnounce: self,
    filterSelfHostname: opts.hostname,
  });
  return new LanDiscoveryService({
    selfHostname: opts.hostname,
    selfRole: opts.role,
    selfPort: opts.port,
    selfTxt: opts.txt,
    transport,
    staleMs: opts.staleMs,
    sweepMs: 5,
    now: opts.now,
  });
}

test("isLanPeerRole accepts the four roles only", () => {
  assert.equal(isLanPeerRole("hub"), true);
  assert.equal(isLanPeerRole("aggregator-wing"), true);
  assert.equal(isLanPeerRole("aggregator-base"), true);
  assert.equal(isLanPeerRole("viewer"), true);
  assert.equal(isLanPeerRole("super-aggregator"), false);
  assert.equal(isLanPeerRole(""), false);
  assert.equal(isLanPeerRole(null), false);
});

test("installProfileToRole maps every install profile", () => {
  assert.equal(installProfileToRole("hub"), "hub");
  assert.equal(installProfileToRole("aggregator-wing"), "aggregator-wing");
  assert.equal(installProfileToRole("aggregator-base"), "aggregator-base");
  assert.equal(installProfileToRole("viewer"), "viewer");
});

test("two discovery services on the same MockLanBus see each other", async () => {
  const bus = new MockLanBus();
  const hubSelf: LanPeerAnnounce = {
    hostname: "HUB-PC-01",
    role: "hub",
    address: "10.0.0.5",
    port: 3847,
    txt: { wing: "1st-air-wing", base: "azraq-ab", version: "1.1.110" },
  };
  const wingSelf: LanPeerAnnounce = {
    hostname: "WING-PC-02",
    role: "aggregator-wing",
    address: "10.0.0.5",
    port: 3847,
    txt: { wing: "1st-air-wing", version: "1.1.110" },
  };
  const hub = makeService({
    bus,
    hostname: hubSelf.hostname,
    role: hubSelf.role,
    port: hubSelf.port,
    txt: hubSelf.txt,
  });
  const wing = makeService({
    bus,
    hostname: wingSelf.hostname,
    role: wingSelf.role,
    port: wingSelf.port,
    txt: wingSelf.txt,
  });

  await hub.start();
  await wing.start();
  // The mock bus is fire-and-forget (no replay), so the wing's
  // subscriber missed the hub's start-time announce. Re-publish each
  // side now that both subscribers are listening to bridge the
  // race the way periodic mDNS re-announces do on a real LAN.
  bus.publish(hubSelf);
  bus.publish(wingSelf);

  // Each service filters its own announce; so the hub sees only the
  // wing in `listPeers()` (and vice versa). Self is exposed via
  // `getSelf()` separately.
  const hubPeers = hub.listPeers();
  const wingPeers = wing.listPeers();
  assert.equal(hubPeers.length, 1, "hub should see exactly one peer (the wing)");
  assert.equal(hubPeers[0]!.hostname, "wing-pc-02");
  assert.equal(hubPeers[0]!.role, "aggregator-wing");
  assert.equal(hubPeers[0]!.txt.wing, "1st-air-wing");
  assert.equal(wingPeers.length, 1, "wing should see exactly one peer (the hub)");
  assert.equal(wingPeers[0]!.hostname, "hub-pc-01");
  assert.equal(wingPeers[0]!.role, "hub");
  assert.equal(wingPeers[0]!.txt.base, "azraq-ab");

  await hub.stop();
  await wing.stop();
});

test("getSelf reports the correct role / port / TXT", async () => {
  const bus = new MockLanBus();
  const svc = makeService({
    bus,
    hostname: "viewer-1",
    role: "viewer",
    port: 5174,
    txt: { wing: "x", version: "1.1.110" },
  });
  await svc.start();
  const self = svc.getSelf();
  assert.equal(self.hostname, "viewer-1");
  assert.equal(self.role, "viewer");
  assert.equal(self.port, 5174);
  assert.equal(self.txt.wing, "x");
  await svc.stop();
});

test("re-announce refreshes lastSeenAt without duplicating peers", async () => {
  const bus = new MockLanBus();
  let now = 1_000_000;
  const hub = makeService({
    bus,
    hostname: "HUB-PC-01",
    role: "hub",
    port: 3847,
    txt: {},
    now: () => now,
  });
  const wing = makeService({
    bus,
    hostname: "WING-PC-02",
    role: "aggregator-wing",
    port: 3847,
    txt: {},
    now: () => now,
  });
  await hub.start();
  await wing.start();
  const first = hub.listPeers()[0]!;
  // Advance time and re-announce manually (the hub.handleAnnounce is
  // exposed for tests). Should bump lastSeenAt but keep firstSeenAt
  // stable and not duplicate the row.
  now += 30_000;
  hub.handleAnnounce({
    hostname: "wing-pc-02",
    role: "aggregator-wing",
    address: "10.0.0.7",
    port: 3847,
    txt: { fresh: "1" },
  });
  const peers = hub.listPeers();
  assert.equal(peers.length, 1, "must not duplicate same hostname");
  assert.equal(peers[0]!.firstSeenAt, first.firstSeenAt);
  assert.equal(peers[0]!.lastSeenAt, now);
  assert.equal(peers[0]!.txt.fresh, "1");
  await hub.stop();
  await wing.stop();
});

test("eviction sweep drops peers older than staleMs", async () => {
  const bus = new MockLanBus();
  let now = 2_000_000;
  const hub = makeService({
    bus,
    hostname: "HUB-PC-01",
    role: "hub",
    port: 3847,
    txt: {},
    now: () => now,
    staleMs: 1_000,
  });
  await hub.start();
  hub.handleAnnounce({
    hostname: "wing-pc-02",
    role: "aggregator-wing",
    address: "10.0.0.7",
    port: 3847,
    txt: {},
  });
  assert.equal(hub.listPeers().length, 1, "peer should be present before sweep");
  // Advance past staleMs, wait for sweep tick (sweepMs=5ms).
  now += 5_000;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hub.listPeers().length, 0, "stale peer should be evicted");
  await hub.stop();
});

test("handleAnnounce ignores empty hostname or unknown role", async () => {
  const bus = new MockLanBus();
  const svc = makeService({
    bus,
    hostname: "self",
    role: "hub",
    port: 80,
    txt: {},
  });
  await svc.start();
  const before = svc.listPeers().length;
  // Bad role.
  svc.handleAnnounce({
    hostname: "rogue",
    role: "evil-bot" as never,
    address: "1.2.3.4",
    port: 80,
    txt: {},
  });
  // Empty hostname.
  svc.handleAnnounce({
    hostname: "",
    role: "hub",
    address: "1.2.3.4",
    port: 80,
    txt: {},
  });
  assert.equal(svc.listPeers().length, before);
  await svc.stop();
});
