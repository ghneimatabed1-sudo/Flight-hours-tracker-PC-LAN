/**
 * LAN auto-discovery service (Task T-R).
 *
 * Hawk Eye broadcasts each PC's role (hub / aggregator-wing /
 * aggregator-base / viewer) on the local segment via the
 * `_hawkeye._tcp` mDNS/Bonjour service type. Every PC also continuously
 * browses the same service so the dashboard can render a live "PCs on
 * this LAN" panel and offer one-click pairing for newly-arrived
 * aggregators / viewers.
 *
 * The actual mDNS browser is split out as a `LanDiscoveryTransport`:
 *
 *  - `dnsSdBrowseTransport` (lib/lan-discovery-dnssd.ts) is the
 *    production transport and shells out to the bundled
 *    `dns-sd.exe -B _hawkeye._tcp` (Apple Bonjour). It's the only
 *    cross-Windows mDNS browser we ship, so we cannot hard-depend on
 *    a Node binding that needs a vendored DLL the customer's IT team
 *    will refuse to whitelist.
 *
 *  - `MockLanBus` (in tests) gives multiple in-process services a
 *    shared event bus so two-server discovery can be exercised
 *    deterministically without touching the real LAN.
 *
 * The service tracks each discovered peer in an in-memory map, evicts
 * entries that haven't re-announced in `staleMs`, and emits an
 * `"announce"` event whenever a peer is added or refreshed. The
 * dashboard polls `GET /api/internal/lan-discovery/peers` (5s default)
 * to render the panel — the eviction window is intentionally
 * generous (~90s) so a momentary multicast hiccup does not flap a
 * peer in and out of the UI.
 */

import { EventEmitter } from "node:events";
import os from "node:os";

import type { InstallProfile } from "./install-profile";

/**
 * The four roles the LAN broadcast uses. Mirrors the install-profile
 * enum 1:1 — kept as its own type so a future role split (e.g.
 * dedicated readonly viewer) doesn't need an install-profile rename.
 */
export type LanPeerRole =
  | "hub"
  | "aggregator-wing"
  | "aggregator-base"
  | "viewer";

export const ALL_LAN_PEER_ROLES: readonly LanPeerRole[] = [
  "hub",
  "aggregator-wing",
  "aggregator-base",
  "viewer",
] as const;

export function isLanPeerRole(v: unknown): v is LanPeerRole {
  return typeof v === "string" && (ALL_LAN_PEER_ROLES as readonly string[]).includes(v);
}

export function installProfileToRole(p: InstallProfile): LanPeerRole {
  // The install-profile and lan-peer-role enums are intentionally
  // identical strings so this never has to fan out into a switch.
  return p as LanPeerRole;
}

/** A single mDNS announce as observed on the LAN. */
export type LanPeerAnnounce = {
  /** Lowercase hostname; the discovery service deduplicates on this. */
  hostname: string;
  role: LanPeerRole;
  /** Best-effort IPv4 address; may be empty if not yet resolved. */
  address: string;
  port: number;
  /** Raw TXT key/value pairs from the announce. */
  txt: Record<string, string>;
};

export type LanDiscoveredPeer = LanPeerAnnounce & {
  firstSeenAt: number;
  lastSeenAt: number;
};

export type LanDiscoveryTransportHandlers = {
  onAnnounce: (a: LanPeerAnnounce) => void;
  onError: (err: Error) => void;
};

export type LanDiscoveryTransport = {
  /**
   * Start observing the LAN. Implementations should be idempotent —
   * the discovery service will not call `start` twice without a
   * `stop` in between.
   */
  start(handlers: LanDiscoveryTransportHandlers): Promise<void> | void;
  stop(): Promise<void> | void;
};

export type LanDiscoveryConfig = {
  selfHostname: string;
  selfRole: LanPeerRole;
  selfPort: number;
  selfTxt: Record<string, string>;
  transport: LanDiscoveryTransport;
  /** Peers not seen for at least this many ms are evicted. */
  staleMs?: number;
  /** How often the eviction sweep runs (ms). */
  sweepMs?: number;
  /** Optional clock injection for tests. */
  now?: () => number;
  /** Optional logger; defaults to a noop so this lib can be used in tests. */
  logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
};

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_SWEEP_MS = 15_000;

const noopLogger = {
  warn: () => undefined,
  info: () => undefined,
};

export class LanDiscoveryService extends EventEmitter {
  private peers = new Map<string, LanDiscoveredPeer>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly cfg: Required<Omit<LanDiscoveryConfig, "logger">> & {
    logger: NonNullable<LanDiscoveryConfig["logger"]>;
  };

  constructor(cfg: LanDiscoveryConfig) {
    super();
    this.cfg = {
      staleMs: cfg.staleMs ?? DEFAULT_STALE_MS,
      sweepMs: cfg.sweepMs ?? DEFAULT_SWEEP_MS,
      now: cfg.now ?? (() => Date.now()),
      logger: cfg.logger ?? noopLogger,
      selfHostname: cfg.selfHostname,
      selfRole: cfg.selfRole,
      selfPort: cfg.selfPort,
      selfTxt: cfg.selfTxt,
      transport: cfg.transport,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await Promise.resolve(
        this.cfg.transport.start({
          onAnnounce: (a) => this.handleAnnounce(a),
          onError: (err) =>
            this.cfg.logger.warn({ err }, "lan-discovery transport error"),
        }),
      );
    } catch (err) {
      this.started = false;
      throw err;
    }
    this.sweepTimer = setInterval(() => this.sweepStale(), this.cfg.sweepMs);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    try {
      await Promise.resolve(this.cfg.transport.stop());
    } catch (err) {
      this.cfg.logger.warn({ err }, "lan-discovery transport stop failed");
    }
  }

  /** Visible for tests. */
  handleAnnounce(a: LanPeerAnnounce): void {
    if (!a || typeof a.hostname !== "string" || a.hostname.trim() === "") return;
    if (!isLanPeerRole(a.role)) return;
    const key = a.hostname.trim().toLowerCase();
    const now = this.cfg.now();
    const existing = this.peers.get(key);
    const peer: LanDiscoveredPeer = {
      hostname: key,
      role: a.role,
      address: a.address ?? existing?.address ?? "",
      port: a.port > 0 ? a.port : existing?.port ?? 0,
      txt: { ...(existing?.txt ?? {}), ...(a.txt ?? {}) },
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    this.peers.set(key, peer);
    this.emit("announce", peer);
  }

  listPeers(): LanDiscoveredPeer[] {
    return [...this.peers.values()].sort((a, b) =>
      a.hostname.localeCompare(b.hostname),
    );
  }

  getSelf(): LanDiscoveredPeer {
    const now = this.cfg.now();
    return {
      hostname: this.cfg.selfHostname.toLowerCase(),
      role: this.cfg.selfRole,
      address: firstLocalIp() ?? "127.0.0.1",
      port: this.cfg.selfPort,
      txt: this.cfg.selfTxt,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }

  /** Visible for tests. */
  __peerCount(): number {
    return this.peers.size;
  }

  private sweepStale(): void {
    const cutoff = this.cfg.now() - this.cfg.staleMs;
    for (const [k, p] of this.peers) {
      if (p.lastSeenAt < cutoff) this.peers.delete(k);
    }
  }
}

export function firstLocalIp(): string | null {
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const i of list) {
        // Node's NetworkInterfaceInfo `family` was a string in <18 and
        // a numeric `4 | 6` since 18. Accept both.
        const fam = (i as { family: unknown }).family;
        const isV4 = fam === "IPv4" || fam === 4;
        if (isV4 && !i.internal && i.address) return i.address;
      }
    }
  } catch {
    /* noop */
  }
  return null;
}

// ── Module-level singleton ──────────────────────────────────────────
//
// `index.ts` constructs and starts a single discovery service per
// boot; the routes read it back through `getLanDiscoveryService()`
// so they don't have to know how it was wired.

let __singleton: LanDiscoveryService | null = null;

export function getLanDiscoveryService(): LanDiscoveryService | null {
  return __singleton;
}

export function setLanDiscoveryService(s: LanDiscoveryService | null): void {
  __singleton = s;
}

// ── Test-only mock transport ────────────────────────────────────────
//
// `MockLanBus` lets multiple in-process discovery services share a
// pretend mDNS bus: every announce written to the bus by one service
// is delivered to every other attached service. Production code
// never constructs this; it's exported here so the api-server tests
// can exercise the discovery loop without spawning dns-sd.exe.

export class MockLanBus extends EventEmitter {
  private static channel = "announce";

  publish(a: LanPeerAnnounce): void {
    this.emit(MockLanBus.channel, a);
  }

  subscribe(cb: (a: LanPeerAnnounce) => void): () => void {
    this.on(MockLanBus.channel, cb);
    return () => this.off(MockLanBus.channel, cb);
  }
}

export type MockLanTransportOptions = {
  bus: MockLanBus;
  /** Self announce that this transport will also re-publish on `start()`. */
  selfAnnounce?: LanPeerAnnounce | null;
  /** When set, ignore self-announces echoed back from the bus. */
  filterSelfHostname?: string;
};

export function makeMockLanTransport(
  opts: MockLanTransportOptions,
): LanDiscoveryTransport {
  let unsub: (() => void) | null = null;
  return {
    start({ onAnnounce }) {
      unsub = opts.bus.subscribe((a) => {
        if (
          opts.filterSelfHostname &&
          a.hostname.toLowerCase() === opts.filterSelfHostname.toLowerCase()
        ) {
          return;
        }
        onAnnounce(a);
      });
      if (opts.selfAnnounce) {
        // Re-announce ourselves on the bus on start so peers that
        // were already listening pick us up immediately.
        opts.bus.publish(opts.selfAnnounce);
      }
    },
    stop() {
      if (unsub) {
        unsub();
        unsub = null;
      }
    },
  };
}
