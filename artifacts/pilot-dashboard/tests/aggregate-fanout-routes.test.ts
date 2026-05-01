// Aggregator fan-out + address-book end-to-end test.
//
// Spins up two in-process Express "fake hubs" that pretend to be
// squadron PCs and points the api-server's aggregator surface at
// them via a stubbed `peer_squadrons` table. Asserts:
//
//   - 2-peer happy path: rows from both hubs are merged and tagged
//     with `squadron_id` + `squadron_name`.
//   - 1-of-2 peer offline (cached path): fan-out falls back to the
//     last cached payload and marks the peer offline.
//   - Unknown-token rejection bubble-up: 401 from a peer surfaces
//     as a per-peer error string, not as a global failure.
//   - `/api/aggregate/peers/health` returns just the per-peer
//     status block.
//   - Address-book CRUD: POST → GET → PATCH → DELETE round trip.
//   - Concurrency safety: parallel fan-outs to many peers don't
//     deadlock, and rows are still tagged correctly.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:aggregate-fanout

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../../../lib/db/src/index";
import {
  fanOutResource,
  hashPeerToken,
  pingPeers,
  type PeerSquadronRow,
} from "../../api-server/src/lib/peer-fanout";
import { buildRouter } from "../../api-server/src/routes/index";
import {
  setActiveInstallProfile,
  _resetActiveInstallProfileForTests,
} from "../../api-server/src/lib/install-profile";

// ─── DB stub ──────────────────────────────────────────────────────────
//
// We simulate the few tables the routes actually touch:
//   peer_squadrons (id, squadron_id, squadron_name, base_url,
//                   auth_token, token_hash, added_by, last_ok_at,
//                   last_error, last_error_at, removed_at)
//   peer_cache     (peer_squadron_id, kind, payload, fetched_at)
//   audit_log      (insert is best-effort; we just no-op)
//
// The matcher is brittle by design: we recognise the exact SQL the
// new aggregator routes emit and otherwise fall through to an empty
// result so the route never accidentally talks to a real Postgres.

type PeerRow = {
  id: string;
  squadron_id: string;
  squadron_name: string | null;
  base_url: string;
  auth_token: string | null;
  token_hash: string | null;
  added_by: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  removed_at: Date | null;
};

type CacheRow = {
  peer_squadron_id: string;
  kind: string;
  payload: unknown;
  fetched_at: Date;
};

const peerRows: PeerRow[] = [];
const cacheRows: CacheRow[] = [];

function resetDb(): void {
  peerRows.length = 0;
  cacheRows.length = 0;
}

function findPeerById(id: string): PeerRow | undefined {
  return peerRows.find((p) => p.id === id && p.removed_at == null);
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async (sqlRaw: string, paramsRaw?: readonly unknown[]) => {
    const sql = normalizeSql(sqlRaw);
    const params = paramsRaw ?? [];

    // ── peer_squadrons ────────────────────────────────────────────
    if (
      sql.startsWith(
        "select id::text as id, squadron_id, squadron_name, base_url, auth_token, last_ok_at, last_error, last_error_at from peer_squadrons where removed_at is null",
      )
    ) {
      return {
        rows: peerRows
          .filter((p) => p.removed_at == null)
          .map((p) => ({
            id: p.id,
            squadron_id: p.squadron_id,
            squadron_name: p.squadron_name,
            base_url: p.base_url,
            auth_token: p.auth_token,
            last_ok_at: p.last_ok_at,
            last_error: p.last_error,
            last_error_at: p.last_error_at,
          })),
      };
    }

    // Single-peer base_url lookup used by POST /peers/:id/probe.
    if (
      sql.startsWith(
        "select base_url from peer_squadrons where id = $1::uuid and removed_at is null",
      )
    ) {
      const idParam = String(params[0] ?? "");
      const hit = peerRows.find(
        (p) => p.id === idParam && p.removed_at == null,
      );
      return { rows: hit ? [{ base_url: hit.base_url }] : [] };
    }

    if (sql.startsWith("insert into peer_squadrons")) {
      const id = randomUUID();
      const row: PeerRow = {
        id,
        squadron_id: String(params[0] ?? ""),
        squadron_name: params[1] == null ? null : String(params[1]),
        base_url: String(params[2] ?? ""),
        auth_token: params[3] == null ? null : String(params[3]),
        token_hash: params[4] == null ? null : String(params[4]),
        added_by: params[5] == null ? null : String(params[5]),
        last_ok_at: null,
        last_error: null,
        last_error_at: null,
        removed_at: null,
      };
      // Enforce the unique-by-active-squadron constraint.
      const dup = peerRows.find(
        (p) => p.removed_at == null && p.squadron_id === row.squadron_id,
      );
      if (dup) {
        const err = new Error(
          `duplicate key value violates unique constraint "peer_squadrons_squadron_idx"`,
        );
        throw err;
      }
      peerRows.push(row);
      return { rows: [{ id }] };
    }

    if (sql.startsWith("update peer_squadrons set ")) {
      // We only need to handle the small set the routes + fan-out
      // library actually emit:
      //   - PATCH /peers/:id              — id is the LAST param
      //   - DELETE /peers/:id             — id is $1
      //   - peer-fanout ok bumper          — id is $1
      //   - peer-fanout error bumper       — id is $1, error is $2
      // For each, we parse the id reference out of the WHERE clause
      // so the mock isn't sensitive to param order changes.
      const whereIdMatch = /where id = \$(\d+)::uuid/.exec(sql);
      const idIdx = whereIdMatch ? Number(whereIdMatch[1]) - 1 : params.length - 1;
      const idParam = String(params[idIdx] ?? "");
      const target = peerRows.find(
        (p) => p.id === idParam && p.removed_at == null,
      );
      if (!target) return { rows: [], rowCount: 0 };

      // DELETE soft-delete: `set removed_at = now()`
      if (sql.includes("set removed_at = now()")) {
        target.removed_at = new Date();
        return { rows: [], rowCount: 1 };
      }

      // peer-fanout success bump
      if (sql.includes("set last_ok_at = now()")) {
        target.last_ok_at = new Date();
        target.last_error = null;
        target.last_error_at = null;
        return { rows: [], rowCount: 1 };
      }

      // peer-fanout failure bump: `set last_error = $2, last_error_at = now()`
      if (
        sql.includes("set last_error = $2") && sql.includes("last_error_at = now()")
      ) {
        target.last_error = params[1] == null ? null : String(params[1]);
        target.last_error_at = new Date();
        return { rows: [], rowCount: 1 };
      }

      // PATCH route: dynamic SET list. Parse $N references in order.
      // Map $-placeholders to assignments in source order so we can
      // mutate the row.
      let pIdx = 0;
      const setExpr = sql
        .replace(/^update peer_squadrons set /, "")
        .replace(/ where .*/, "");
      for (const piece of setExpr.split(",").map((s) => s.trim())) {
        if (!piece) continue;
        if (piece === "last_error = null") {
          target.last_error = null;
          continue;
        }
        if (piece === "last_error_at = null") {
          target.last_error_at = null;
          continue;
        }
        const m = /^([a-z_]+)\s*=\s*\$(\d+)/.exec(piece);
        if (!m) continue;
        const col = m[1] as keyof PeerRow;
        const v = params[Number(m[2]) - 1];
        pIdx = Math.max(pIdx, Number(m[2]));
        switch (col) {
          case "squadron_name":
            target.squadron_name = v == null ? null : String(v);
            break;
          case "base_url":
            target.base_url = v == null ? "" : String(v);
            break;
          case "auth_token":
            target.auth_token = v == null ? null : String(v);
            break;
          case "token_hash":
            target.token_hash = v == null ? null : String(v);
            break;
          default:
            break;
        }
      }
      return { rows: [], rowCount: 1 };
    }

    // ── peer_cache ────────────────────────────────────────────────
    if (sql.startsWith("insert into peer_cache")) {
      const peerId = String(params[0] ?? "");
      const kind = String(params[1] ?? "");
      const payload = JSON.parse(String(params[2] ?? "null"));
      const existing = cacheRows.find(
        (c) => c.peer_squadron_id === peerId && c.kind === kind,
      );
      if (existing) {
        existing.payload = payload;
        existing.fetched_at = new Date();
      } else {
        cacheRows.push({
          peer_squadron_id: peerId,
          kind,
          payload,
          fetched_at: new Date(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (
      sql.startsWith(
        "select payload, fetched_at from peer_cache where peer_squadron_id = $1::uuid and kind = $2",
      )
    ) {
      const peerId = String(params[0] ?? "");
      const kind = String(params[1] ?? "");
      const hit = cacheRows.find(
        (c) => c.peer_squadron_id === peerId && c.kind === kind,
      );
      return { rows: hit ? [{ payload: hit.payload, fetched_at: hit.fetched_at }] : [] };
    }

    // ── audit_log: ignore ─────────────────────────────────────────
    if (sql.startsWith("insert into audit_log")) {
      return { rows: [], rowCount: 1 };
    }

    // Default: empty rowset.
    return { rows: [], rowCount: 0 };
  };

// ─── Fake hubs ────────────────────────────────────────────────────────

type FakeHubResources = {
  pilots?: unknown[];
  sorties?: unknown[];
  leaves?: unknown[];
  unavailable?: unknown[];
  notams?: unknown[];
  "readiness-summary"?: unknown[];
};

type FakeHub = {
  baseUrl: string;
  server: Server;
  squadronId: string;
  squadronName: string;
  token: string;
  /**
   * Mutate to flip a hub offline / mid-rotation mid-test.
   *  - "401-invalid": hub responds 401 `{error:"invalid_token"}` (the
   *    new body the squadron emits when a stale or hash-mismatched
   *    token is presented).
   *  - "401-revoked": hub responds 401 `{error:"revoked_token"}` (the
   *    body emitted when the row is marked revoked or expired). These
   *    two modes drive the new "Token expired" UI on the aggregator.
   */
  setBroken: (
    mode:
      | "ok"
      | "down"
      | "5xx"
      | "401-invalid"
      | "401-revoked"
      | "404-not-found",
  ) => void;
};

async function startFakeHub(opts: {
  squadronId: string;
  squadronName: string;
  token: string;
  resources: FakeHubResources;
}): Promise<FakeHub> {
  const app: Express = express();
  let mode:
    | "ok"
    | "down"
    | "5xx"
    | "401-invalid"
    | "401-revoked"
    | "404-not-found" = "ok";

  function maybeFail(res: express.Response): boolean {
    if (mode === "down") {
      res.destroy();
      return true;
    }
    if (mode === "5xx") {
      res.status(503).json({ error: "service_unavailable" });
      return true;
    }
    if (mode === "401-invalid") {
      res.status(401).json({ error: "invalid_token" });
      return true;
    }
    if (mode === "401-revoked") {
      res.status(401).json({ error: "revoked_token" });
      return true;
    }
    if (mode === "404-not-found") {
      // 404 from a peer is not an auth event — classifyHttpError must
      // bucket it as `other_http` so the dashboard does NOT prompt for
      // a token refresh. Lets us pin the fourth branch of the taxonomy.
      res.status(404).json({ error: "not_found" });
      return true;
    }
    return false;
  }

  app.get("/api/peer/healthz", (req, res) => {
    if (maybeFail(res)) return;
    const auth = String(req.header("authorization") ?? "");
    if (auth !== `Bearer ${opts.token}`) {
      res.status(401).json({ error: "unknown_token" });
      return;
    }
    res.json({ status: "ok", squadron_id: opts.squadronId });
  });

  app.get("/api/peer/:resource", (req, res) => {
    if (mode === "down") {
      res.destroy();
      return;
    }
    if (mode === "5xx") {
      res.status(500).json({ error: "boom" });
      return;
    }
    if (mode === "401-invalid") {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (mode === "401-revoked") {
      res.status(401).json({ error: "revoked_token" });
      return;
    }
    const auth = String(req.header("authorization") ?? "");
    if (auth !== `Bearer ${opts.token}`) {
      res.status(401).json({ error: "unknown_token" });
      return;
    }
    const key = req.params.resource as keyof FakeHubResources;
    const items = opts.resources[key] ?? [];
    res.json({ items });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind fake hub");
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    server,
    squadronId: opts.squadronId,
    squadronName: opts.squadronName,
    token: opts.token,
    setBroken: (m) => {
      mode = m;
    },
  };
}

async function stopFakeHub(h: FakeHub): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

// ─── Aggregator app ──────────────────────────────────────────────────

function makeAggregatorApp(): Express {
  setActiveInstallProfile("aggregator-wing");
  const app = express();
  app.use(express.json());
  app.use("/api", buildRouter("aggregator-wing"));
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });
  return app;
}

async function withAggregator<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = makeAggregatorApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("failed to bind aggregator");
    }
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _resetActiveInstallProfileForTests();
  }
}

function seedPeer(opts: {
  squadronId: string;
  squadronName: string;
  baseUrl: string;
  token: string;
}): PeerRow {
  const id = randomUUID();
  const row: PeerRow = {
    id,
    squadron_id: opts.squadronId,
    squadron_name: opts.squadronName,
    base_url: opts.baseUrl,
    auth_token: opts.token,
    token_hash: hashPeerToken(opts.token),
    added_by: "test",
    last_ok_at: null,
    last_error: null,
    last_error_at: null,
    removed_at: null,
  };
  peerRows.push(row);
  return row;
}

function asPeer(row: PeerRow): PeerSquadronRow {
  return {
    id: row.id,
    squadron_id: row.squadron_id,
    squadron_name: row.squadron_name,
    base_url: row.base_url,
    auth_token: row.auth_token,
    last_ok_at: row.last_ok_at,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

test("fanOutResource: 2-peer happy path merges + tags rows", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: { pilots: [{ id: "T-1", name: "Alpha" }, { id: "T-2", name: "Bravo" }] },
  });
  const b = await startFakeHub({
    squadronId: "hawks",
    squadronName: "Hawks",
    token: "tok-b",
    resources: { pilots: [{ id: "H-1", name: "Charlie" }] },
  });
  t.after(async () => {
    await stopFakeHub(a);
    await stopFakeHub(b);
  });

  const peerA = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  const peerB = seedPeer({
    squadronId: b.squadronId,
    squadronName: b.squadronName,
    baseUrl: b.baseUrl,
    token: b.token,
  });

  const out = await fanOutResource<{
    id: string;
    name: string;
    squadron_id: string;
    squadron_name: string | null;
  }>(
    [asPeer(peerA), asPeer(peerB)],
    "pilots",
    { sortKey: (r) => r.name.toLowerCase() },
  );

  assert.equal(out.rows.length, 3);
  assert.deepEqual(
    out.rows.map((r) => `${r.squadron_id}:${r.id}:${r.name}`),
    ["tigers:T-1:Alpha", "tigers:T-2:Bravo", "hawks:H-1:Charlie"],
  );
  // Every row carries squadron attribution.
  for (const r of out.rows) {
    assert.ok(r.squadron_id === "tigers" || r.squadron_id === "hawks");
    assert.ok(r.squadron_name === "Tigers" || r.squadron_name === "Hawks");
  }
  assert.equal(out.peers.length, 2);
  for (const p of out.peers) {
    assert.equal(p.status, "online");
    assert.equal(p.served_from_cache, false);
    assert.ok(p.last_success_at);
  }
  // Cache was written for both peers.
  assert.equal(cacheRows.filter((c) => c.kind === "pilots").length, 2);
});

test("fanOutResource: 1-of-2 offline returns cached payload + offline marker", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: { pilots: [{ id: "T-1", name: "Alpha" }] },
  });
  const b = await startFakeHub({
    squadronId: "hawks",
    squadronName: "Hawks",
    token: "tok-b",
    resources: { pilots: [{ id: "H-1", name: "Charlie" }] },
  });
  t.after(async () => {
    await stopFakeHub(a);
    await stopFakeHub(b);
  });

  const peerA = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  const peerB = seedPeer({
    squadronId: b.squadronId,
    squadronName: b.squadronName,
    baseUrl: b.baseUrl,
    token: b.token,
  });

  // Warm cache with a successful round.
  await fanOutResource([asPeer(peerA), asPeer(peerB)], "pilots");
  // Now break peer B and re-fetch — should serve cached payload for B.
  b.setBroken("5xx");
  const out = await fanOutResource<{
    id: string;
    squadron_id: string;
  }>([asPeer(peerA), asPeer(peerB)], "pilots");

  assert.equal(out.rows.length, 2);
  const peerStatuses = Object.fromEntries(
    out.peers.map((p) => [p.squadron_id, p]),
  );
  assert.equal(peerStatuses["tigers"]?.status, "online");
  assert.equal(peerStatuses["tigers"]?.served_from_cache, false);
  assert.equal(peerStatuses["hawks"]?.status, "offline");
  assert.equal(peerStatuses["hawks"]?.served_from_cache, true);
  assert.match(peerStatuses["hawks"]?.error ?? "", /500|503|boom/i);
  // Offline peer's row still flows through with squadron tag.
  assert.ok(out.rows.find((r) => r.squadron_id === "hawks"));
});

test("fanOutResource: unknown-token rejection bubbles up per-peer", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: { pilots: [{ id: "T-1", name: "Alpha" }] },
  });
  t.after(async () => {
    await stopFakeHub(a);
  });

  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: "WRONG-TOKEN",
  });

  const out = await fanOutResource([asPeer(peer)], "pilots");
  assert.equal(out.rows.length, 0);
  assert.equal(out.peers.length, 1);
  assert.equal(out.peers[0]!.status, "offline");
  assert.match(out.peers[0]!.error ?? "", /401|unknown_token/i);
  // Cache was NOT written for the failure.
  assert.equal(cacheRows.length, 0);
  // The peer row's last_error was bumped.
  const stored = peerRows.find((p) => p.id === peer.id)!;
  assert.match(stored.last_error ?? "", /401|unknown_token/i);
});

test("fanOutResource: parallel fan-out across many peers stays correct", async (t) => {
  resetDb();
  const N = 8;
  const hubs: FakeHub[] = [];
  for (let i = 0; i < N; i++) {
    const h = await startFakeHub({
      squadronId: `sq-${i}`,
      squadronName: `Squadron ${i}`,
      token: `tok-${i}`,
      resources: {
        pilots: Array.from({ length: 3 }, (_, j) => ({
          id: `P-${i}-${j}`,
          name: `Pilot ${i}-${j}`,
        })),
      },
    });
    hubs.push(h);
  }
  t.after(async () => {
    for (const h of hubs) await stopFakeHub(h);
  });

  const peers = hubs.map((h) =>
    asPeer(
      seedPeer({
        squadronId: h.squadronId,
        squadronName: h.squadronName,
        baseUrl: h.baseUrl,
        token: h.token,
      }),
    ),
  );

  // Fire several fan-outs in parallel.
  const runs = await Promise.all(
    Array.from({ length: 5 }, () => fanOutResource(peers, "pilots")),
  );
  for (const out of runs) {
    assert.equal(out.rows.length, N * 3);
    assert.equal(out.peers.length, N);
    for (const p of out.peers) assert.equal(p.status, "online");
  }
});

test("pingPeers: returns per-peer status without row data", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  const b = await startFakeHub({
    squadronId: "hawks",
    squadronName: "Hawks",
    token: "tok-b",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
    await stopFakeHub(b);
  });

  const peerA = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  const peerB = seedPeer({
    squadronId: b.squadronId,
    squadronName: b.squadronName,
    baseUrl: b.baseUrl,
    token: b.token,
  });

  b.setBroken("5xx");
  const statuses = await pingPeers([asPeer(peerA), asPeer(peerB)]);
  assert.equal(statuses.length, 2);
  const byId = Object.fromEntries(statuses.map((s) => [s.squadron_id, s]));
  assert.equal(byId["tigers"]?.status, "online");
  assert.equal(byId["hawks"]?.status, "offline");
  assert.match(byId["hawks"]?.error ?? "", /503|service_unavailable/i);
});

test("address-book CRUD round trip via /api/aggregate/peers", async () => {
  resetDb();
  await withAggregator(async (baseUrl) => {
    // Initially empty.
    let res = await fetch(`${baseUrl}/api/aggregate/peers`);
    assert.equal(res.status, 200);
    let body = (await res.json()) as { items: unknown[] };
    assert.equal(body.items.length, 0);

    // POST /peers.
    res = await fetch(`${baseUrl}/api/aggregate/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        squadron_id: "tigers",
        squadron_name: "Tigers",
        base_url: "https://hub-tigers.lan",
        token: "secret-token-1",
      }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as {
      id: string;
      squadron_id: string;
      base_url: string;
    };
    assert.equal(created.squadron_id, "tigers");
    assert.equal(created.base_url, "https://hub-tigers.lan");
    assert.ok(created.id);

    // List shows one entry; secrets are NOT exposed.
    res = await fetch(`${baseUrl}/api/aggregate/peers`);
    body = (await res.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(body.items.length, 1);
    const listed = body.items[0]!;
    assert.equal(listed.squadron_id, "tigers");
    assert.equal(listed.has_token, true);
    assert.equal(Object.prototype.hasOwnProperty.call(listed, "auth_token"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listed, "token_hash"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(listed, "token"), false);

    // Duplicate squadron_id rejected.
    res = await fetch(`${baseUrl}/api/aggregate/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        squadron_id: "tigers",
        base_url: "https://other.lan",
        token: "x",
      }),
    });
    assert.equal(res.status, 409);

    // PATCH rename + token swap.
    res = await fetch(`${baseUrl}/api/aggregate/peers/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        squadron_name: "Tigers Renamed",
        token: "secret-token-2",
      }),
    });
    assert.equal(res.status, 200);

    // Verify rename took effect; token still hidden.
    res = await fetch(`${baseUrl}/api/aggregate/peers`);
    body = (await res.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(body.items[0]!.squadron_name, "Tigers Renamed");
    // Underlying stored token was swapped.
    const stored = peerRows[0]!;
    assert.equal(stored.auth_token, "secret-token-2");
    assert.equal(stored.token_hash, hashPeerToken("secret-token-2"));

    // PATCH bad URL → 400.
    res = await fetch(`${baseUrl}/api/aggregate/peers/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_url: "ftp://nope" }),
    });
    assert.equal(res.status, 400);

    // DELETE.
    res = await fetch(`${baseUrl}/api/aggregate/peers/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);

    // Now empty again.
    res = await fetch(`${baseUrl}/api/aggregate/peers`);
    body = (await res.json()) as { items: unknown[] };
    assert.equal(body.items.length, 0);

    // DELETE on missing → 404.
    res = await fetch(`${baseUrl}/api/aggregate/peers/${created.id}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 404);
  });
});

test("address-book: POST validates payload", async () => {
  resetDb();
  await withAggregator(async (baseUrl) => {
    // Missing token.
    let res = await fetch(`${baseUrl}/api/aggregate/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ squadron_id: "x", base_url: "https://h.lan" }),
    });
    assert.equal(res.status, 400);

    // Invalid URL scheme.
    res = await fetch(`${baseUrl}/api/aggregate/peers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        squadron_id: "x",
        base_url: "ftp://h.lan",
        token: "t",
      }),
    });
    assert.equal(res.status, 400);
  });
});

test("auth gate: anonymous request to /api/aggregate/peers gets 401 when HAWK_INTERNAL_SESSION_AUTH=required", async () => {
  // Verifies the requireInternalLanSession middleware is mounted on
  // the aggregate router, not just on /api/internal/. Without this
  // gate the address book + fan-out reads would be wide open.
  resetDb();
  const prev = process.env.HAWK_INTERNAL_SESSION_AUTH;
  process.env.HAWK_INTERNAL_SESSION_AUTH = "required";
  try {
    const app = express();
    app.use(express.json());
    setActiveInstallProfile("aggregator-wing");
    app.use("/api", buildRouter("aggregator-wing"));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bind fail");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // No session header → 401
      const r1 = await fetch(`${baseUrl}/api/aggregate/peers`);
      assert.equal(r1.status, 401);

      // Bogus session header → 401
      const r2 = await fetch(`${baseUrl}/api/aggregate/peers`, {
        headers: { "x-hawk-lan-session": "not-a-real-token" },
      });
      assert.equal(r2.status, 401);

      // /peers/health is also gated
      const r3 = await fetch(`${baseUrl}/api/aggregate/peers/health`);
      assert.equal(r3.status, 401);

      // /pilots fan-out is also gated
      const r4 = await fetch(`${baseUrl}/api/aggregate/pilots`);
      assert.equal(r4.status, 401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      _resetActiveInstallProfileForTests();
    }
  } finally {
    if (prev === undefined) {
      delete process.env.HAWK_INTERNAL_SESSION_AUTH;
    } else {
      process.env.HAWK_INTERNAL_SESSION_AUTH = prev;
    }
  }
});

test("address-book role gate: non-super_admin gets 403 in session-required mode", async () => {
  resetDb();
  // Inject a non-super_admin LAN user via a header-bound middleware
  // and confirm the route refuses.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { lanUser: Record<string, unknown> }).lanUser = {
      role: "ops",
      squadron_id: "x",
    };
    next();
  });
  setActiveInstallProfile("aggregator-wing");
  app.use("/api", buildRouter("aggregator-wing"));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bind fail");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const res = await fetch(`${baseUrl}/api/aggregate/peers`);
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _resetActiveInstallProfileForTests();
  }
});

test("aggregate read endpoint: /api/aggregate/pilots merges + tags via fake hubs", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: { pilots: [{ id: "T-1", name: "Alpha" }] },
  });
  const b = await startFakeHub({
    squadronId: "hawks",
    squadronName: "Hawks",
    token: "tok-b",
    resources: { pilots: [{ id: "H-1", name: "Bravo" }] },
  });
  t.after(async () => {
    await stopFakeHub(a);
    await stopFakeHub(b);
  });

  seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  seedPeer({
    squadronId: b.squadronId,
    squadronName: b.squadronName,
    baseUrl: b.baseUrl,
    token: b.token,
  });

  await withAggregator(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/aggregate/pilots`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ id: string; squadron_id: string; squadron_name: string }>;
      peers: Array<{ status: string; squadron_id: string }>;
    };
    assert.equal(body.items.length, 2);
    assert.equal(body.peers.length, 2);
    assert.deepEqual(
      body.items.map((r) => `${r.squadron_id}:${r.id}`).sort(),
      ["hawks:H-1", "tigers:T-1"],
    );
    for (const p of body.peers) assert.equal(p.status, "online");
  });
});

test("aggregate read endpoint: /api/aggregate/peers/health pings both peers", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  const b = await startFakeHub({
    squadronId: "hawks",
    squadronName: "Hawks",
    token: "tok-b",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
    await stopFakeHub(b);
  });
  seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  seedPeer({
    squadronId: b.squadronId,
    squadronName: b.squadronName,
    baseUrl: b.baseUrl,
    token: b.token,
  });
  b.setBroken("5xx");

  await withAggregator(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/aggregate/peers/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      peers: Array<{ status: string; squadron_id: string; error?: string }>;
    };
    assert.equal(body.peers.length, 2);
    const byId = Object.fromEntries(
      body.peers.map((p) => [p.squadron_id, p]),
    );
    assert.equal(byId["tigers"]?.status, "online");
    assert.equal(byId["hawks"]?.status, "offline");
    // Body-level should not include `items` (no row data).
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "items"),
      false,
    );
  });
});

// ─── Token-rotation classification ─────────────────────────────────────
//
// These tests pin the contract for the "Token expired" UI on the
// aggregator. classifyHttpError() must inspect the JSON body — not just
// the 401 status — so the dashboard can distinguish:
//   - revoked_token → auth_revoked  (operator-initiated rotation)
//   - invalid_token → auth_invalid  (token doesn't match any row)
//   - 5xx           → network_error (transient, no UI prompt)
// We assert this end-to-end through pingPeers so a future refactor of
// the helper still has to satisfy what pingPeers exposes.

test("pingPeers: error_kind=auth_revoked when peer returns revoked_token", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  a.setBroken("401-revoked");
  const statuses = await pingPeers([asPeer(peer)]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.status, "offline");
  assert.equal(statuses[0]!.error_kind, "auth_revoked");
});

test("pingPeers: error_kind=auth_invalid when peer returns invalid_token", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  a.setBroken("401-invalid");
  const statuses = await pingPeers([asPeer(peer)]);
  assert.equal(statuses[0]!.error_kind, "auth_invalid");
});

test("pingPeers: error_kind=other_http on 404 (not an auth event)", async (t) => {
  // Pins the fourth branch of classifyHttpError. A 404 from the peer
  // means the squadron's healthz route is missing or its base_url is
  // wrong — neither of which should pop the "Token expired" UI.
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  a.setBroken("404-not-found");
  const statuses = await pingPeers([asPeer(peer)]);
  assert.equal(statuses[0]!.status, "offline");
  assert.equal(statuses[0]!.error_kind, "other_http");
});

test("pingPeers: error_kind=network_error on 5xx (no token prompt)", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  a.setBroken("5xx");
  const statuses = await pingPeers([asPeer(peer)]);
  assert.equal(statuses[0]!.error_kind, "network_error");
});

test("/api/aggregate/peers/health: surfaces error_kind in JSON", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "tok-a",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: a.token,
  });
  a.setBroken("401-revoked");
  await withAggregator(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/aggregate/peers/health`);
    const body = (await res.json()) as {
      peers: Array<{ squadron_id: string; status: string; error_kind?: string }>;
    };
    const tigers = body.peers.find((p) => p.squadron_id === "tigers");
    assert.equal(tigers?.status, "offline");
    assert.equal(tigers?.error_kind, "auth_revoked");
  });
});

// ─── /peers/:id/probe endpoint ─────────────────────────────────────────
//
// The Refresh Peer Token dialog calls this with a freshly-pasted token
// to verify it works against the squadron's healthz BEFORE saving. The
// endpoint must:
//   - 403 non-super_admins (gated like every other write).
//   - 400 on missing id / missing token.
//   - 404 when the peer row doesn't exist.
//   - {ok:true} when the supplied token works.
//   - {ok:false, error_kind:"auth_revoked"} when the squadron rejects
//     the token with a revoked body — so the dialog can localise the
//     "still revoked" copy. Crucially, the probe MUST NOT mutate the
//     stored auth_token (only PATCH does that).

test("POST /peers/:id/probe: ok=true when token works", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "good-token",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: "stored-stale-token",
  });
  await withAggregator(async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/aggregate/peers/${peer.id}/probe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_token: "good-token" }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });
  // Probe must not mutate stored token.
  assert.equal(peerRows.find((p) => p.id === peer.id)!.auth_token, "stored-stale-token");
});

test("POST /peers/:id/probe: ok=false + error_kind=auth_revoked when peer says revoked", async (t) => {
  resetDb();
  const a = await startFakeHub({
    squadronId: "tigers",
    squadronName: "Tigers",
    token: "good-token",
    resources: {},
  });
  t.after(async () => {
    await stopFakeHub(a);
  });
  const peer = seedPeer({
    squadronId: a.squadronId,
    squadronName: a.squadronName,
    baseUrl: a.baseUrl,
    token: "stored-stale-token",
  });
  a.setBroken("401-revoked");
  await withAggregator(async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/aggregate/peers/${peer.id}/probe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_token: "any-token" }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; error_kind?: string };
    assert.equal(body.ok, false);
    assert.equal(body.error_kind, "auth_revoked");
  });
});

test("POST /peers/:id/probe: 400 missing token, 404 missing peer, 400 malformed id", async () => {
  resetDb();
  await withAggregator(async (baseUrl) => {
    const fakeId = randomUUID();
    let res = await fetch(
      `${baseUrl}/api/aggregate/peers/${fakeId}/probe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(res.status, 400);
    let body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_token");

    res = await fetch(
      `${baseUrl}/api/aggregate/peers/${fakeId}/probe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_token: "x" }),
      },
    );
    assert.equal(res.status, 404);

    // A non-UUID id must surface as a 400 invalid_id, not bubble up
    // from Postgres as an opaque 500 — the dialog UX depends on
    // distinguishing "typo in route param" from "no such peer".
    res = await fetch(
      `${baseUrl}/api/aggregate/peers/not-a-uuid/probe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ auth_token: "x" }),
      },
    );
    assert.equal(res.status, 400);
    body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_id");
  });
});
