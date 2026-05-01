// Centralised fetch wrapper for the dashboard's two visible-failure
// banners (Task #372 / T-E):
//
//   1. `/api/healthz` reads `apiServerVersion` and compares it against
//      the bundled `__APP_VERSION__`. When the api-server has been
//      upgraded out from under the dashboard's cached HTML the
//      `VersionMismatchBanner` watches `subscribeVersionMismatch` and
//      shows a non-dismissable amber bar at the top of the screen.
//
//   2. The disk-guard middleware on the api-server returns
//      `HTTP 507 { ok:false, error:"disk_full" }` when free disk is
//      below 1%. Every fetch the dashboard makes goes through a
//      monkey-patched `window.fetch` that watches for that response;
//      when it sees one, the `DiskFullOverlay` is unblanked and writes
//      are blocked across the whole UI until the operator clears the
//      disk and clicks "I've fixed it, retry".
//
// The two pieces of state are kept here (module-level) rather than in
// React context so that:
//   - `installFetchInterceptor()` can flip them from the bare
//     monkey-patched `window.fetch` (no React tree available there).
//   - Tests can drive the state directly without mounting React at
//     all.

import {
  getInternalApiHealthUrl,
  fetchInternalApiHealth,
} from "./internal-migration";

// ── Disk-full state ──────────────────────────────────────────────────

type DiskFullSubscriber = (full: boolean) => void;

let diskFull = false;
const diskFullSubscribers = new Set<DiskFullSubscriber>();

function setDiskFull(next: boolean): void {
  if (diskFull === next) return;
  diskFull = next;
  for (const cb of diskFullSubscribers) {
    try { cb(diskFull); } catch { /* never let a subscriber tear down others */ }
  }
}

export function isDiskFull(): boolean {
  return diskFull;
}

export function subscribeDiskFull(cb: DiskFullSubscriber): () => void {
  diskFullSubscribers.add(cb);
  return () => { diskFullSubscribers.delete(cb); };
}

/**
 * Re-checks `/api/healthz`. If the api-server now responds successfully
 * (which means the disk-guard middleware would let writes through
 * again), the disk-full state is cleared and subscribers are notified.
 *
 * Returns `true` when the overlay was dismissed, `false` when the
 * server is still unhappy (or unreachable).
 */
export async function retryAfterDiskFull(): Promise<boolean> {
  try {
    const r = await fetchInternalApiHealth();
    if (r.ok) {
      setDiskFull(false);
      return true;
    }
  } catch {
    /* ignore — leave overlay up */
  }
  return false;
}

/** Test-only seam to wipe local state between cases. */
export function _resetApiClientStateForTests(): void {
  diskFull = false;
  diskFullSubscribers.clear();
  apiServerVersion = null;
  versionMismatchSubscribers.clear();
  intercepterInstalled = false;
}

/** Test-only seam to push a disk-full state without going via fetch. */
export function _setDiskFullForTests(next: boolean): void {
  setDiskFull(next);
}

/** Test-only seam to push an api-server version without going via fetch. */
export function _setApiServerVersionForTests(v: string | null): void {
  setApiServerVersion(v);
}

// ── API server version state ─────────────────────────────────────────

type VersionSubscriber = (apiVersion: string | null) => void;

let apiServerVersion: string | null = null;
const versionMismatchSubscribers = new Set<VersionSubscriber>();

function setApiServerVersion(next: string | null): void {
  if (apiServerVersion === next) return;
  apiServerVersion = next;
  for (const cb of versionMismatchSubscribers) {
    try { cb(apiServerVersion); } catch { /* ignore */ }
  }
}

export function getApiServerVersion(): string | null {
  return apiServerVersion;
}

export function subscribeApiServerVersion(cb: VersionSubscriber): () => void {
  versionMismatchSubscribers.add(cb);
  return () => { versionMismatchSubscribers.delete(cb); };
}

/**
 * Compare two semver-like strings (e.g. `1.1.110`). Pure numeric
 * compare, padded with zeros for missing segments. Anything we can't
 * parse compares as equal so we never *false alarm* on a malformed
 * version — the operator sees the banner only when we are confident
 * the api-server is genuinely ahead.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * `true` when the api-server reports a strictly higher semver than the
 * bundled dashboard build. The amber "please refresh" banner watches
 * this.
 */
export function isApiServerAhead(dashboardVersion: string): boolean {
  if (!apiServerVersion) return false;
  return compareSemver(apiServerVersion, dashboardVersion) > 0;
}

/**
 * One-shot poll of `/api/healthz`. Stores the api-server version into
 * the module-level state so subscribers can react. Best-effort —
 * silently no-ops when the internal API isn't configured (e.g. browser
 * served straight off a published web build with no proxy). The
 * `VersionMismatchBanner` calls this on mount and every 60s after.
 */
export async function pollApiServerVersion(): Promise<void> {
  const url = getInternalApiHealthUrl();
  if (!url) return;
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { apiServerVersion?: unknown };
    const v = String(body?.apiServerVersion ?? "").trim();
    if (v) setApiServerVersion(v);
  } catch {
    /* ignore — leave previous value */
  }
}

// ── Fetch interceptor ────────────────────────────────────────────────

let intercepterInstalled = false;

/**
 * Wraps `window.fetch` exactly once. Every response is inspected for
 * `HTTP 507` and the `disk_full` body shape; when seen we flip the
 * disk-full module state which the `DiskFullOverlay` is subscribed to.
 *
 * Idempotent — calling it twice is a no-op so tests can install it in
 * setup without worrying about double-wrap.
 */
export function installFetchInterceptor(): void {
  if (intercepterInstalled) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return;
  }
  const original = window.fetch.bind(window);
  intercepterInstalled = true;
  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const res = await original(input, init);
    // 507 Insufficient Storage — clone to peek at the body without
    // disturbing the caller's read.
    if (res.status === 507) {
      try {
        const peek = res.clone();
        const body = (await peek.json()) as { error?: unknown };
        if (String(body?.error ?? "") === "disk_full") {
          setDiskFull(true);
        }
      } catch {
        // Body wasn't JSON or wasn't readable — still treat 507 as
        // disk-full because that's the only thing the api-server uses
        // it for.
        setDiskFull(true);
      }
    }
    return res;
  };
}
