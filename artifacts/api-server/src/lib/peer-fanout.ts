import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { normalizeLanRole, type LanUserContext } from "./lan-authz";

/**
 * Aggregator fan-out client.
 *
 * On a Wing or Base Commander PC the api-server is configured with a
 * list of squadron hub PCs (`peer_squadrons`). For each aggregate
 * read endpoint we fire one parallel HTTPS call per peer, merge the
 * responses, and tag every row with the squadron it came from.
 *
 * This file owns the pure fan-out machinery. The route handlers in
 * `routes/aggregate-data.ts` are thin wrappers around `fanOutResource()`.
 *
 * Design notes:
 *
 *  - The fetch + cache implementations are injectable (`FanoutDeps`)
 *    so the unit tests in `pilot-dashboard/tests/aggregate-fanout-routes.test.ts`
 *    can spin up two in-process Express "fake hubs" and a stubbed
 *    cache without touching the real Postgres pool.
 *
 *  - Auth: every fan-out request carries `Authorization: Bearer <plaintext>`
 *    and `x-hawk-peer-token: <plaintext>` so the producer can match
 *    whichever convention it prefers. The plaintext lives in
 *    `peer_squadrons.auth_token`; we never log it and it never leaves
 *    the box via any HTTP response (the address-book API only ever
 *    surfaces a `has_token: boolean`).
 *
 *  - SECURITY: storing the bearer in plaintext at rest is a deliberate
 *    contract decision. The producer side (peer hub) compares against
 *    `sha256(token)` so we cannot send the hash; we have to replay the
 *    original secret on every request. Mitigations:
 *      * `/api/aggregate/*` is gated by `requireInternalLanSession`
 *        and the address-book CRUD additionally requires `super_admin`,
 *        so only an authenticated admin can read/rotate the token.
 *      * The token is only writable, never readable, via the HTTP API.
 *      * Aggregator runs on a LAN-only Wing/Base PC; DB filesystem
 *        access already implies machine compromise.
 *    A future hardening pass should encrypt `auth_token` with an
 *    app-layer KEK held outside the DB.
 *
 *  - Failure model:
 *      * 2xx              → "online", overwrite cache
 *      * 4xx (incl. 401)  → "offline", `error: "<status> <body.error>"`,
 *                          no cache write, fall back to cache so the
 *                          dashboard doesn't go blank on a token typo
 *      * 5xx / network /  → "offline", fall back to cache
 *        timeout
 */

export type PeerSquadronRow = {
  id: string;
  squadron_id: string;
  squadron_name: string | null;
  base_url: string;
  auth_token: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
};

/**
 * Categorisation of why a peer call failed. `network_error` is the
 * "transient — try later" bucket (DNS, refused, timeout, 5xx). The
 * two `auth_*` kinds are surfaced to the operator dashboard so the
 * Squadron Status panel can show a "Token expired — paste new one"
 * affordance instead of the generic gray "Offline" badge. See
 * `routes/peer-shell.ts::requirePeerToken` for the producer-side
 * contract that decides which body each kind comes from.
 */
export type PeerErrorKind =
  | "network_error"
  | "auth_invalid"
  | "auth_revoked"
  | "other_http";

export type PeerStatus = {
  peer_squadron_id: string;
  squadron_id: string;
  squadron_name: string | null;
  status: "online" | "offline";
  last_success_at: string | null;
  served_from_cache: boolean;
  error?: string;
  /**
   * Set whenever `status === "offline"`. Lets the dashboard pick a
   * "Token expired" badge for `auth_invalid` / `auth_revoked` while
   * keeping the existing "Offline" badge for everything else.
   */
  error_kind?: PeerErrorKind;
  /**
   * Difference (peer clock − this PC's clock) in milliseconds, parsed
   * from the responder's `Date` header. Positive = peer is ahead of us.
   * `null` when we couldn't parse the header (e.g. cached/offline).
   */
  clock_skew_ms?: number | null;
};

export type FanoutResult<R> = {
  rows: R[];
  peers: PeerStatus[];
};

/**
 * Injectable seam used by the route handlers (real DB-backed) and by
 * the tests (in-memory).
 */
export type FanoutDeps = {
  fetchImpl?: typeof fetch;
  /** Called when a peer call succeeds. Default: write `peer_cache`. */
  setCache?: (
    peerSquadronId: string,
    kind: string,
    payload: unknown,
  ) => Promise<void>;
  /** Called when a peer call fails — return null if no cache. */
  getCache?: (
    peerSquadronId: string,
    kind: string,
  ) => Promise<{ payload: unknown; fetched_at: Date } | null>;
  /** Called when a peer call succeeds. Default: bump `last_ok_at`. */
  recordPeerOk?: (peerSquadronId: string) => Promise<void>;
  /**
   * Called when a peer call fails. Default: bump `last_error*`. The
   * `error_kind` argument lets callers branch on auth-vs-network vs
   * other-http without re-parsing the message string.
   */
  recordPeerError?: (
    peerSquadronId: string,
    error: string,
    error_kind: PeerErrorKind,
  ) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 5_000;

export function hashPeerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── Clock-skew tracking ────────────────────────────────────────────────
//
// Every successful peer call captures the responder's `Date` header and
// records the skew from this PC's clock. The System Health route reads
// the most-recent values to surface a warning on operator dashboards
// when one of the squadron PCs has a battery-dead CMOS or wandered
// time. We don't persist this to the DB — a transient in-process map
// is enough for "right now" health.
const recentPeerSkewMs = new Map<string, number>();

function recordPeerSkew(peerSquadronId: string, dateHeader: string | null): void {
  if (!dateHeader) return;
  const t = Date.parse(dateHeader);
  if (Number.isNaN(t)) return;
  // Positive skew = peer clock is ahead of ours.
  const skew = t - Date.now();
  recentPeerSkewMs.set(peerSquadronId, skew);
}

/** Snapshot of {peer_squadron_id: skew_ms} for the last call per peer. */
export function getRecentPeerSkewMs(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of recentPeerSkewMs.entries()) out[k] = v;
  return out;
}

/** Test-only: reset the in-process skew cache between cases. */
export function _resetRecentPeerSkewForTests(): void {
  recentPeerSkewMs.clear();
}

/** Read-only address-book listing for the route handlers. */
export async function listActivePeers(): Promise<PeerSquadronRow[]> {
  try {
    const q = await pool.query<PeerSquadronRow>(
      `
      select id::text as id,
             squadron_id,
             squadron_name,
             base_url,
             auth_token,
             last_ok_at,
             last_error,
             last_error_at
      from peer_squadrons
      where removed_at is null
      order by squadron_name nulls last, squadron_id
      `,
    );
    return q.rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_squadrons.* does not exist/i.test(msg)) return [];
    throw err;
  }
}

/**
 * Return the active peers that the given actor is authorised to read.
 *
 *  - super_admin / admin  → all active peers (no restriction)
 *  - commander_wing       → peers whose squadron is under the actor's
 *                           wing_id, plus the actor's own squadron
 *  - commander_base       → peers whose squadron is under the actor's
 *                           base_id, plus the actor's own squadron
 *  - all other roles      → only the peer matching the actor's own
 *                           squadron_id (fail-closed if missing)
 */
export async function listPeersForActor(
  actor: LanUserContext,
): Promise<PeerSquadronRow[]> {
  const all = await listActivePeers();
  const role = normalizeLanRole(actor.role);

  if (role === "super_admin" || role === "admin") return all;

  if (role === "commander_wing") {
    const wingId = (actor.wing_id ?? "").trim().toLowerCase();
    const ownSqId = (actor.squadron_id ?? "").trim().toLowerCase();
    if (!wingId && !ownSqId) return [];
    let wingSquadronIds: Set<string> = new Set();
    if (wingId) {
      try {
        const q = await pool.query<{ id: string }>(
          `select id::text as id from squadrons where lower(wing_id::text) = $1`,
          [wingId],
        );
        wingSquadronIds = new Set(q.rows.map((r) => r.id.toLowerCase()));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/relation .*squadrons.* does not exist/i.test(msg)) throw err;
      }
    }
    return all.filter((p) => {
      const sid = p.squadron_id.trim().toLowerCase();
      return (ownSqId && sid === ownSqId) || wingSquadronIds.has(sid);
    });
  }

  if (role === "commander_base") {
    const baseId = (actor.base_id ?? "").trim().toLowerCase();
    const ownSqId = (actor.squadron_id ?? "").trim().toLowerCase();
    if (!baseId && !ownSqId) return [];
    let baseSquadronIds: Set<string> = new Set();
    if (baseId) {
      try {
        const q = await pool.query<{ id: string }>(
          `select id::text as id from squadrons where lower(base_id::text) = $1`,
          [baseId],
        );
        baseSquadronIds = new Set(q.rows.map((r) => r.id.toLowerCase()));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/relation .*squadrons.* does not exist/i.test(msg)) throw err;
      }
    }
    return all.filter((p) => {
      const sid = p.squadron_id.trim().toLowerCase();
      return (ownSqId && sid === ownSqId) || baseSquadronIds.has(sid);
    });
  }

  // All other roles (ops, commander_squadron, commander, unknown):
  // restrict to only the actor's own squadron.
  const ownSqId = (actor.squadron_id ?? "").trim().toLowerCase();
  if (!ownSqId) return [];
  return all.filter((p) => p.squadron_id.trim().toLowerCase() === ownSqId);
}

async function defaultSetCache(
  peerSquadronId: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  try {
    await pool.query(
      `
      insert into peer_cache (peer_squadron_id, kind, payload, fetched_at)
      values ($1::uuid, $2, $3::jsonb, now())
      on conflict (peer_squadron_id, kind) do update set
        payload = excluded.payload,
        fetched_at = excluded.fetched_at
      `,
      [peerSquadronId, kind, JSON.stringify(payload)],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_cache.* does not exist/i.test(msg)) return;
    logger.warn({ err, peerSquadronId, kind }, "peer_cache write failed");
  }
}

async function defaultGetCache(
  peerSquadronId: string,
  kind: string,
): Promise<{ payload: unknown; fetched_at: Date } | null> {
  try {
    const q = await pool.query<{ payload: unknown; fetched_at: Date }>(
      `
      select payload, fetched_at
      from peer_cache
      where peer_squadron_id = $1::uuid and kind = $2
      limit 1
      `,
      [peerSquadronId, kind],
    );
    return q.rows[0] ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_cache.* does not exist/i.test(msg)) return null;
    logger.warn({ err, peerSquadronId, kind }, "peer_cache read failed");
    return null;
  }
}

async function defaultRecordPeerOk(peerSquadronId: string): Promise<void> {
  try {
    await pool.query(
      `
      update peer_squadrons
        set last_ok_at = now(),
            last_error = null,
            last_error_at = null
      where id = $1::uuid
      `,
      [peerSquadronId],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_squadrons.* does not exist/i.test(msg)) return;
    logger.warn({ err, peerSquadronId }, "peer_squadrons ok bump failed");
  }
}

async function defaultRecordPeerError(
  peerSquadronId: string,
  error: string,
  // `_error_kind` is part of the seam contract so tests and future
  // persistence layers can branch on it; the default DB writer keeps
  // the existing `last_error` text-only column untouched.
  _error_kind: PeerErrorKind,
): Promise<void> {
  try {
    await pool.query(
      `
      update peer_squadrons
        set last_error = $2,
            last_error_at = now()
      where id = $1::uuid
      `,
      [peerSquadronId, error],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_squadrons.* does not exist/i.test(msg)) return;
    logger.warn({ err, peerSquadronId }, "peer_squadrons error bump failed");
  }
}

function joinPeerUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const tail = path.replace(/^\/+/, "");
  return `${base}/${tail}`;
}

function tagRows<R extends Record<string, unknown>>(
  peer: PeerSquadronRow,
  rows: unknown,
): R[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[]).map((row) => ({
    ...row,
    squadron_id: peer.squadron_id,
    squadron_name: peer.squadron_name,
  })) as unknown as R[];
}

/**
 * Pull `items[]` out of a peer response, tolerating peers that returned
 * a bare array, `{ items }`, or `{ rows }`.
 */
function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.rows)) return obj.rows;
  }
  return [];
}

type PeerCallOutcome =
  | { kind: "ok"; payload: unknown; dateHeader: string | null }
  | {
      kind: "fail";
      error: string;
      transient: boolean;
      error_kind: PeerErrorKind;
    };

async function callPeer(
  peer: PeerSquadronRow,
  resourcePath: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<PeerCallOutcome> {
  const url = joinPeerUrl(peer.base_url, `/api/peer/${resourcePath.replace(/^\/+/, "")}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (peer.auth_token) {
      headers["authorization"] = `Bearer ${peer.auth_token}`;
      headers["x-hawk-peer-token"] = peer.auth_token;
    }
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: ctrl.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      const dateHeader = res.headers?.get?.("date") ?? null;
      recordPeerSkew(peer.id, dateHeader);
      return { kind: "ok", payload, dateHeader };
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `http_${res.status}`;
    // 4xx → not transient, won't fix itself; 5xx → transient.
    const transient = res.status >= 500;
    const error_kind = classifyHttpError(res.status, detail);
    return {
      kind: "fail",
      error: `${res.status} ${detail}`,
      transient,
      error_kind,
    };
  } catch (err) {
    const aborted =
      (err instanceof Error && err.name === "AbortError")
      || (err as { name?: string })?.name === "AbortError";
    const msg = aborted
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      kind: "fail",
      error: msg,
      transient: true,
      error_kind: "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a 4xx/5xx response onto one of the four `PeerErrorKind` buckets.
 *
 *  - 401 with body `invalid_token`  → `auth_invalid` (token doesn't
 *    match anything; almost always the squadron rotated their token
 *    via reset-peer-token.ps1 and the aggregator wasn't told).
 *  - 401 with body `revoked_token`  → `auth_revoked` (an admin clicked
 *    Revoke on the squadron hub's super-admin page, or the token's
 *    `expires_at` lapsed).
 *  - Other 4xx                       → `auth_invalid` if 401, else
 *                                      `other_http`.
 *  - 5xx                             → `network_error` (transient).
 *
 * The legacy `invalid_peer_token` body is treated as `auth_invalid` so
 * older squadron hubs that haven't shipped the new error-body contract
 * still trigger the operator prompt.
 */
function classifyHttpError(status: number, detail: string): PeerErrorKind {
  if (status >= 500) return "network_error";
  if (status === 401) {
    const d = detail.trim().toLowerCase();
    if (d === "revoked_token") return "auth_revoked";
    if (d === "invalid_token" || d === "invalid_peer_token") return "auth_invalid";
    return "auth_invalid";
  }
  return "other_http";
}

/**
 * Fan out one resource read to every active peer in parallel and return
 * `{ rows, peers }`. Rows are tagged with the originating squadron.
 */
export async function fanOutResource<R extends Record<string, unknown>>(
  peers: PeerSquadronRow[],
  resourcePath: string,
  opts: {
    timeoutMs?: number;
    cacheKind?: string;
    deps?: FanoutDeps;
    sortKey?: (row: R) => string | number | null;
    sortOrder?: "asc" | "desc";
  } = {},
): Promise<FanoutResult<R>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheKind = opts.cacheKind ?? resourcePath.replace(/^\/+/, "");
  const fetchImpl = opts.deps?.fetchImpl ?? fetch;
  const setCache = opts.deps?.setCache ?? defaultSetCache;
  const getCache = opts.deps?.getCache ?? defaultGetCache;
  const recordPeerOk = opts.deps?.recordPeerOk ?? defaultRecordPeerOk;
  const recordPeerError = opts.deps?.recordPeerError ?? defaultRecordPeerError;

  const settled = await Promise.all(
    peers.map(async (peer) => {
      const outcome = await callPeer(peer, resourcePath, timeoutMs, fetchImpl);
      if (outcome.kind === "ok") {
        await setCache(peer.id, cacheKind, outcome.payload);
        await recordPeerOk(peer.id);
        return { peer, outcome };
      }
      await recordPeerError(peer.id, outcome.error, outcome.error_kind);
      return { peer, outcome };
    }),
  );

  const allRows: R[] = [];
  const peerStatuses: PeerStatus[] = [];
  for (const { peer, outcome } of settled) {
    if (outcome.kind === "ok") {
      const items = extractItems(outcome.payload);
      const tagged = tagRows<R>(peer, items);
      allRows.push(...tagged);
      peerStatuses.push({
        peer_squadron_id: peer.id,
        squadron_id: peer.squadron_id,
        squadron_name: peer.squadron_name,
        status: "online",
        last_success_at: new Date().toISOString(),
        served_from_cache: false,
        clock_skew_ms: recentPeerSkewMs.get(peer.id) ?? null,
      });
    } else {
      const cached = await getCache(peer.id, cacheKind);
      if (cached) {
        const items = extractItems(cached.payload);
        const tagged = tagRows<R>(peer, items);
        allRows.push(...tagged);
      }
      peerStatuses.push({
        peer_squadron_id: peer.id,
        squadron_id: peer.squadron_id,
        squadron_name: peer.squadron_name,
        status: "offline",
        last_success_at: cached
          ? cached.fetched_at instanceof Date
            ? cached.fetched_at.toISOString()
            : new Date(String(cached.fetched_at)).toISOString()
          : peer.last_ok_at
            ? new Date(peer.last_ok_at).toISOString()
            : null,
        served_from_cache: cached != null,
        error: outcome.error,
        error_kind: outcome.error_kind,
      });
    }
  }

  if (opts.sortKey) {
    const sortKey = opts.sortKey;
    const dir = opts.sortOrder === "desc" ? -1 : 1;
    allRows.sort((a, b) => {
      const av = sortKey(a);
      const bv = sortKey(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  return { rows: allRows, peers: peerStatuses };
}

/**
 * Cheap per-peer ping for the `/api/aggregate/peers/health` endpoint.
 * Calls `/api/peer/healthz` with a short timeout; returns just the
 * status block (no row data).
 */
export async function pingPeers(
  peers: PeerSquadronRow[],
  opts: {
    timeoutMs?: number;
    deps?: Pick<FanoutDeps, "fetchImpl" | "recordPeerOk" | "recordPeerError">;
  } = {},
): Promise<PeerStatus[]> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const fetchImpl = opts.deps?.fetchImpl ?? fetch;
  const recordPeerOk = opts.deps?.recordPeerOk ?? defaultRecordPeerOk;
  const recordPeerError = opts.deps?.recordPeerError ?? defaultRecordPeerError;

  return Promise.all(
    peers.map(async (peer) => {
      const outcome = await callPeer(peer, "healthz", timeoutMs, fetchImpl);
      if (outcome.kind === "ok") {
        await recordPeerOk(peer.id);
        return {
          peer_squadron_id: peer.id,
          squadron_id: peer.squadron_id,
          squadron_name: peer.squadron_name,
          status: "online" as const,
          last_success_at: new Date().toISOString(),
          served_from_cache: false,
          clock_skew_ms: recentPeerSkewMs.get(peer.id) ?? null,
        };
      }
      await recordPeerError(peer.id, outcome.error, outcome.error_kind);
      return {
        peer_squadron_id: peer.id,
        squadron_id: peer.squadron_id,
        squadron_name: peer.squadron_name,
        status: "offline" as const,
        last_success_at: peer.last_ok_at
          ? new Date(peer.last_ok_at).toISOString()
          : null,
        served_from_cache: false,
        error: outcome.error,
        error_kind: outcome.error_kind,
      };
    }),
  );
}

/**
 * Single-shot peer health check used by the "Test" button in the
 * Refresh Peer Token dialog. Calls `/api/peer/healthz` with the
 * supplied bearer (NOT the stored one) and reports whether it works.
 *
 * Returns the same `error_kind` taxonomy as `pingPeers` so the dialog
 * can tell the operator "still revoked" vs "invalid token" vs
 * "network unreachable".
 */
export async function probePeerToken(
  baseUrl: string,
  token: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<
  | { ok: true }
  | { ok: false; error: string; error_kind: PeerErrorKind }
> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const fakePeer: PeerSquadronRow = {
    id: "probe",
    squadron_id: "probe",
    squadron_name: null,
    base_url: baseUrl,
    auth_token: token,
    last_ok_at: null,
    last_error: null,
    last_error_at: null,
  };
  const outcome = await callPeer(fakePeer, "healthz", timeoutMs, fetchImpl);
  if (outcome.kind === "ok") return { ok: true };
  return {
    ok: false,
    error: outcome.error,
    error_kind: outcome.error_kind,
  };
}
