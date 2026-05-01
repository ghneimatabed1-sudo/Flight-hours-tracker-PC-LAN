// Cross-PC scenarios not already covered by aggregate-fanout-routes:
//   - Hub recovery: offline -> cached -> back online clears the marker.
//   - Two distinct LAN actors hitting /pilots/upsert: last-write-wins
//     and audit_log records each actor + role.
//   - Role gate: only ops/admin/super_admin may upsert.
//   - Cross-squadron gate: ops in squadron A cannot write squadron B.

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../../../lib/db/src/index";
import {
  fanOutResource,
  hashPeerToken,
  type PeerSquadronRow,
} from "../../api-server/src/lib/peer-fanout";
import pilotsWritesRouter from "../../api-server/src/routes/pilots-writes";

type PilotRow = {
  id: string;
  squadron_id: string;
  rank: string;
  name: string;
  phone: string;
  available: boolean;
};
type AuditRow = {
  actor: string;
  type: string;
  detail: Record<string, unknown>;
};
type PeerCacheRow = {
  peer_squadron_id: string;
  kind: string;
  payload: unknown;
  fetched_at: Date;
};

const pilots = new Map<string, PilotRow>();
const audit: AuditRow[] = [];
const peerCache: PeerCacheRow[] = [];
const peerRows = new Map<string, {
  id: string;
  squadron_id: string;
  squadron_name: string | null;
  base_url: string;
  auth_token: string | null;
  token_hash: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  removed_at: Date | null;
}>();

function reset(): void {
  pilots.clear();
  audit.length = 0;
  peerCache.length = 0;
  peerRows.clear();
}

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async (sqlRaw: string, paramsRaw?: readonly unknown[]) => {
    const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
    const params = (paramsRaw ?? []) as unknown[];

    if (sql.startsWith("insert into pilots")) {
      const [id, squadronId, rank, name, , , phone, available] = params as [
        string, string, string, string, unknown, unknown, string, boolean,
      ];
      const row: PilotRow = {
        id, squadron_id: squadronId, rank, name, phone, available: !!available,
      };
      pilots.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("insert into audit_log")) {
      const [actor, type, detailJson] = params as [string, string, string];
      audit.push({ actor, type, detail: JSON.parse(detailJson) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("select") && sql.includes("from peer_squadrons")) {
      return { rows: Array.from(peerRows.values()).filter((p) => !p.removed_at) };
    }

    if (sql.startsWith("update peer_squadrons")) {
      const id = params[params.length - 1] as string;
      const row = peerRows.get(id);
      if (row) {
        if (sql.includes("last_ok_at = now()")) {
          row.last_ok_at = new Date();
          row.last_error = null;
          row.last_error_at = null;
        }
        if (sql.includes("last_error =")) {
          row.last_error = params[0] as string;
          row.last_error_at = new Date();
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("insert into peer_cache")) {
      const [peerId, kind, payloadJson] = params as [string, string, string];
      const idx = peerCache.findIndex(
        (c) => c.peer_squadron_id === peerId && c.kind === kind,
      );
      const payload = JSON.parse(payloadJson);
      const row = { peer_squadron_id: peerId, kind, payload, fetched_at: new Date() };
      if (idx >= 0) peerCache[idx] = row;
      else peerCache.push(row);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("select") && sql.includes("from peer_cache")) {
      const peerId = params[0] as string;
      const kind = params[1] as string;
      const hit = peerCache.find(
        (c) => c.peer_squadron_id === peerId && c.kind === kind,
      );
      return { rows: hit ? [hit] : [] };
    }

    return { rows: [], rowCount: 0 };
  };

function startFakeHub(opts: {
  squadronId: string;
  token: string;
  pilots: Array<{ id: string; name: string }>;
}): Promise<{
  baseUrl: string;
  server: Server;
  setMode: (m: "ok" | "down") => void;
  setPilots: (rows: Array<{ id: string; name: string }>) => void;
}> {
  return new Promise((resolveStart, reject) => {
    let mode: "ok" | "down" = "ok";
    let currentPilots = opts.pilots.slice();
    const app: Express = express();

    app.get("/api/peer/healthz", (req, res) => {
      if (mode === "down") { res.destroy(); return; }
      if (req.header("authorization") !== `Bearer ${opts.token}`) {
        res.status(401).json({ error: "unknown_token" });
        return;
      }
      res.json({ status: "ok", squadron_id: opts.squadronId });
    });

    app.get("/api/peer/:resource", (req, res) => {
      if (mode === "down") { res.destroy(); return; }
      if (req.header("authorization") !== `Bearer ${opts.token}`) {
        res.status(401).json({ error: "unknown_token" });
        return;
      }
      res.json({
        items: req.params.resource === "pilots" ? currentPilots : [],
      });
    });

    const server = createServer(app);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind"));
        return;
      }
      resolveStart({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        server,
        setMode: (m) => { mode = m; },
        setPilots: (rows) => { currentPilots = rows.slice(); },
      });
    });
  });
}

function stopHub(h: { server: Server }): Promise<void> {
  return new Promise((resolve) => h.server.close(() => resolve()));
}

function seedPeer(opts: {
  squadronId: string;
  squadronName: string;
  baseUrl: string;
  token: string;
}): PeerSquadronRow {
  const id = randomUUID();
  peerRows.set(id, {
    id,
    squadron_id: opts.squadronId,
    squadron_name: opts.squadronName,
    base_url: opts.baseUrl,
    auth_token: opts.token,
    token_hash: hashPeerToken(opts.token),
    last_ok_at: null,
    last_error: null,
    last_error_at: null,
    removed_at: null,
  });
  return {
    id,
    squadron_id: opts.squadronId,
    squadron_name: opts.squadronName,
    base_url: opts.baseUrl,
    auth_token: opts.token,
    last_ok_at: null,
    last_error: null,
    last_error_at: null,
  };
}

type LanActor = {
  username: string;
  role: string;
  squadron_id: string | null;
};

function injectLanActor(getActor: () => LanActor | null): RequestHandler {
  return (req, _res, next) => {
    const a = getActor();
    if (a) {
      (req as { lanUser?: unknown }).lanUser = {
        user_id: a.username,
        username: a.username,
        display_name: a.username,
        role: a.role,
        squadron_id: a.squadron_id,
        wing_id: null,
        base_id: null,
      };
    }
    next();
  };
}

async function startWritesServer(
  getActor: () => LanActor | null,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(injectLanActor(getActor));
  app.use("/", pilotsWritesRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("hub recovery: offline -> cached -> back online clears marker + serves fresh", async (t) => {
  reset();
  const hub = await startFakeHub({
    squadronId: "tigers",
    token: "tok-tigers",
    pilots: [{ id: "P-1", name: "Alpha" }, { id: "P-2", name: "Bravo" }],
  });
  t.after(() => stopHub(hub));

  const peer = seedPeer({
    squadronId: "tigers",
    squadronName: "Tigers",
    baseUrl: hub.baseUrl,
    token: "tok-tigers",
  });

  const r1 = await fanOutResource<{ id: string; squadron_id: string }>(
    [peer], "pilots",
  );
  assert.equal(r1.rows.length, 2);
  assert.equal(r1.peers[0]!.status, "online");
  assert.equal(r1.peers[0]!.served_from_cache, false);
  assert.equal(peerCache.length, 1, "cache warmed");

  hub.setMode("down");
  const r2 = await fanOutResource<{ id: string; squadron_id: string }>(
    [peer], "pilots",
  );
  assert.equal(r2.peers[0]!.status, "offline");
  assert.equal(r2.peers[0]!.served_from_cache, true);
  assert.equal(r2.rows.length, 2, "cached rows still flow");

  hub.setPilots([
    { id: "P-1", name: "Alpha" },
    { id: "P-2", name: "Bravo" },
    { id: "P-3", name: "Charlie (added while offline)" },
  ]);
  hub.setMode("ok");
  const r3 = await fanOutResource<{ id: string; squadron_id: string }>(
    [peer], "pilots",
  );
  assert.equal(r3.peers[0]!.status, "online", "marker cleared on recovery");
  assert.equal(r3.peers[0]!.served_from_cache, false);
  assert.equal(r3.rows.length, 3, "picks up the row added while offline");
  assert.ok(r3.rows.find((r) => r.id === "P-3"));

  const items = (peerCache[0]!.payload as { items?: unknown[] }).items ?? [];
  assert.equal(items.length, 3, "cache refreshed on recovery");
});

test("two ops users on the same hub: last-write-wins, both audited with their own actor", async (t) => {
  reset();
  const squadron = randomUUID();
  let actor: LanActor | null = null;
  const srv = await startWritesServer(() => actor);
  t.after(() => srv.close());

  const sharedId = randomUUID();

  actor = { username: "alice", role: "ops", squadron_id: squadron };
  const aResp = await fetch(`${srv.baseUrl}/pilots/upsert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: sharedId,
      squadron_id: squadron,
      name: "Shared Pilot",
      rank: "Capt",
      phone: "111-AAA",
      available: true,
    }),
  });
  assert.equal(aResp.status, 200, "alice's upsert succeeds");

  actor = { username: "bob", role: "ops", squadron_id: squadron };
  const bResp = await fetch(`${srv.baseUrl}/pilots/upsert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: sharedId,
      squadron_id: squadron,
      name: "Shared Pilot",
      rank: "Capt",
      phone: "999-BBB",
      available: false,
    }),
  });
  assert.equal(bResp.status, 200, "bob's upsert succeeds");

  const stored = pilots.get(sharedId)!;
  assert.equal(stored.phone, "999-BBB", "last writer wins on phone");
  assert.equal(stored.available, false, "last writer wins on available");

  const upserts = audit.filter((a) => a.type === "internal.pilots.upsert");
  assert.equal(upserts.length, 2, "both attempts in audit_log");
  assert.equal(upserts[0]!.actor, "alice");
  assert.equal(upserts[0]!.detail.role, "ops");
  assert.equal(upserts[0]!.detail.pilot_id, sharedId);
  assert.equal(upserts[1]!.actor, "bob");
  assert.equal(upserts[1]!.detail.role, "ops");
  assert.equal(upserts[1]!.detail.pilot_id, sharedId);
  assert.notEqual(upserts[0]!.actor, upserts[1]!.actor,
    "audit attributes each attempt to its own LAN user");
});

test("viewer / flight_commander cannot write a pilot — role gate fires", async (t) => {
  reset();
  const squadron = randomUUID();
  let actor: LanActor | null = null;
  const srv = await startWritesServer(() => actor);
  t.after(() => srv.close());

  // The pilots-writes route hard-gates writes to ops/admin/super_admin.
  // Every other LAN role must 403 with `forbidden_role`.
  for (const role of [
    "commander_squadron",
    "commander_wing",
    "commander_base",
    "commander",
    "flight_commander",
    "viewer",
    "unknown",
  ]) {
    actor = { username: `u-${role}`, role, squadron_id: squadron };
    const resp = await fetch(`${srv.baseUrl}/pilots/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        squadron_id: squadron,
        name: "x", rank: "Capt", phone: "", available: true,
      }),
    });
    assert.equal(resp.status, 403, `${role} should be forbidden_role`);
    const body = await resp.json() as { error?: string };
    assert.equal(body.error, "forbidden_role");
  }

  assert.equal(
    audit.filter((a) => a.type === "internal.pilots.upsert").length,
    0,
    "no audit row written when role gate fires",
  );
  assert.equal(pilots.size, 0, "no pilot row written when role gate fires");
});

test("ops in squadron A cannot upsert into squadron B — cross-squadron gate fires", async (t) => {
  reset();
  const squadronA = randomUUID();
  const squadronB = randomUUID();
  let actor: LanActor | null = { username: "alice", role: "ops", squadron_id: squadronA };
  const srv = await startWritesServer(() => actor);
  t.after(() => srv.close());

  const resp = await fetch(`${srv.baseUrl}/pilots/upsert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: randomUUID(),
      squadron_id: squadronB,
      name: "Foreign", rank: "Capt", phone: "", available: true,
    }),
  });
  assert.equal(resp.status, 403);
  const body = await resp.json() as { error?: string };
  assert.equal(body.error, "foreign_squadron_forbidden");
  assert.equal(pilots.size, 0);
});
