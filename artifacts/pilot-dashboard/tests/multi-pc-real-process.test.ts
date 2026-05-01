// Multi-PC scenarios run against THREE real `api-server` processes —
// one Wing aggregator and two squadron hubs — each booted with its
// own `INSTALL_PROFILE` and its own isolated Postgres database, talking
// to each other over real HTTP sockets.
//
// This is the cross-process surface that `tests/multi-pc-cross.test.ts`
// only approximates: there, the fake squadron hubs share an in-process
// pool stub and run inside the test runner. Here, every PC owns:
//
//   - its own child node process running `dist/index.mjs`,
//   - its own TCP port,
//   - its own Postgres database in the shared cluster,
//
// so anything that lives below HTTP — filesystem state, per-process
// caches, database isolation — is exercised end-to-end.
//
// The per-PC database topology matches how the real PowerShell installer
// provisions each squadron and wing PC (one DB per PC, never shared
// search_path tricks), so this test exercises the same cross-DB query
// surface, transaction visibility, and connection-string handling that
// production does.
//
// Scenarios re-asserted against this real-process topology:
//
//   1. Hub recovery: aggregator fan-out succeeds → squadron PC2 is
//      killed → fan-out falls back to peer_cache and marks PC2 offline
//      → PC2 is restarted → fan-out clears the marker and serves fresh.
//   2. Two ops users on the same hub: last-write-wins on a shared
//      pilot id, both attempts in audit_log under their own actor.
//   3. Role gate: every non-(ops|admin|super_admin) role is 403
//      `forbidden_role` against /api/internal/pilots/upsert on PC2.
//   4. Cross-squadron gate: ops in squadron A cannot upsert into
//      squadron B (403 `foreign_squadron_forbidden`) on PC2.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:multi-pc-real-process

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { hashPeerToken } from "../../api-server/src/lib/peer-fanout";
import { hashPassword } from "../../api-server/src/lib/password";
import { issuePeerToken } from "../../api-server/src/lib/peer-token";
import { ensureApiServerBuiltCached } from "./helpers/api-server-build-cache";

const { Client } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const API_SERVER_DIR = resolve(REPO_ROOT, "artifacts/api-server");
const API_SERVER_DEST_DIST = resolve(API_SERVER_DIR, "dist");
const BUILD_CACHE_ROOT = resolve(
  REPO_ROOT,
  "node_modules/.cache/multi-pc-test-build",
);

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run multi-pc-real-process.test.ts " +
      "(this test spins up three real api-server processes against " +
      "isolated databases in the same cluster).",
  );
}
const MASTER_DATABASE_URL = process.env.DATABASE_URL;

// Resolved on first build / first cache hit by `before()`. Children
// spawn from this dir's `index.mjs`.
let API_SERVER_DIST = "";

// ─── Helpers ───────────────────────────────────────────────────────────

function databaseUrlForDb(dbName: string): string {
  // Per-PC database matches how the real PowerShell installer
  // provisions each squadron/wing PC. We rewrite only the pathname so
  // host, credentials, and query params (sslmode etc.) carry over.
  const u = new URL(MASTER_DATABASE_URL);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        rej(new Error("failed to allocate ephemeral port"));
        return;
      }
      const port = addr.port;
      srv.close(() => res(port));
    });
  });
}

async function withMasterClient<T>(
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: MASTER_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function withDbClient<T>(
  dbName: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: databaseUrlForDb(dbName) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// All tables an api-server (any profile) reads or writes. ensureFullSchema
// covers most of them but the four peer/install tables are owned by
// out-of-band PowerShell setup in production, so the test mints them
// itself in each isolated database.
const PEER_DDL = `
  create table if not exists install_profile_meta (
    id integer primary key check (id = 1),
    profile text not null,
    first_booted_at timestamptz not null default now(),
    last_seen_profile text,
    last_seen_at timestamptz not null default now()
  );

  create table if not exists peer_squadrons (
    id uuid primary key default gen_random_uuid(),
    squadron_id text not null,
    squadron_name text,
    base_url text not null,
    token_hash text,
    added_at timestamptz not null default now(),
    added_by text,
    last_ok_at timestamptz,
    last_error text,
    last_error_at timestamptz,
    removed_at timestamptz,
    auth_token text
  );
  create unique index if not exists peer_squadrons_squadron_idx
    on peer_squadrons (squadron_id) where removed_at is null;

  create table if not exists peer_cache (
    peer_squadron_id uuid not null
      references peer_squadrons (id) on delete cascade,
    kind text not null,
    payload jsonb not null,
    fetched_at timestamptz not null default now(),
    primary key (peer_squadron_id, kind)
  );
  create index if not exists peer_cache_fetched_at_idx
    on peer_cache (fetched_at desc);

  create table if not exists peer_tokens (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null,
    label text,
    scope text not null default 'squadron-read',
    issued_at timestamptz not null default now(),
    issued_by text,
    expires_at timestamptz,
    revoked_at timestamptz,
    revoked_by text,
    last_used_at timestamptz
  );
  create unique index if not exists peer_tokens_token_hash_idx
    on peer_tokens (token_hash);
  create index if not exists peer_tokens_active_idx
    on peer_tokens (revoked_at) where revoked_at is null;
`;

async function ensureDbAndPeerTables(dbName: string): Promise<void> {
  await withMasterClient(async (c) => {
    // CREATE DATABASE has no IF NOT EXISTS in Postgres; the per-PC
    // names are randomized so a duplicate would itself be a bug worth
    // surfacing rather than swallowing.
    await c.query(`create database "${dbName}"`);
  });
  // The api-server's own ensureFullSchema() will create lan_users,
  // squadrons, pilots, etc. on first boot. Pre-creating the peer/install
  // tables here means the boot path is fully no-op-able afterwards.
  await withDbClient(dbName, async (c) => {
    await c.query(PEER_DDL);
  });
}

async function dropDb(dbName: string): Promise<void> {
  await withMasterClient(async (c) => {
    // Kick out anything still attached (e.g. a child api-server that
    // hasn't fully exited yet) so DROP DATABASE doesn't 55006 us.
    await c.query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`,
      [dbName],
    );
    await c.query(`drop database if exists "${dbName}"`);
  });
}

// ─── Child api-server lifecycle ───────────────────────────────────────

type ApiChild = {
  proc: ChildProcess;
  port: number;
  dbName: string;
  baseUrl: string;
};

type SpawnOpts = {
  port: number;
  dbName: string;
  profile: "hub" | "aggregator-wing" | "aggregator-base";
  /**
   * Required = real lan_session validation (used for the hub PC so the
   * role + cross-squadron gates fire end-to-end).
   * Off = bring-up mode (used for the aggregator so we can hit
   * /api/aggregate/* without a session).
   */
  internalSessionAuth: "off" | "required";
};

// Every child the test spawns is registered here at spawn time so the
// `after()` teardown can SIGTERM/SIGKILL them even if `before()` fails
// before assigning `topo` (otherwise a botched setup would orphan
// half-booted api-server processes on the test runner box).
const spawnedChildren = new Set<ApiChild>();

function spawnApiServer(opts: SpawnOpts): ApiChild {
  if (!API_SERVER_DIST) {
    throw new Error(
      "API_SERVER_DIST not resolved — call ensureApiServerBuiltCached() first",
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(opts.port),
    INSTALL_PROFILE: opts.profile,
    DATABASE_URL: databaseUrlForDb(opts.dbName),
    HAWK_INTERNAL_SESSION_AUTH: opts.internalSessionAuth,
    NODE_ENV: "production",
    // Quiet the pino transport so the test runner output stays readable.
    PINO_LOG_LEVEL: "warn",
    // Belt-and-braces: never let a stray INTERNAL_WRITE_SECRET from the
    // outer environment lock the test out of /api/internal/pilots/upsert.
    INTERNAL_WRITE_SECRET: "",
    // Direct legacy export to a tmp dir per child so concurrent writes
    // can't collide on the same json.
    LAN_LEGACY_EXPORT_DIR: `/tmp/${opts.dbName}`,
  };
  const proc = spawn(process.execPath, [API_SERVER_DIST], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  // Surface child stderr only on noisy failures — most boots are silent.
  proc.stderr?.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    if (/error|fatal|exception/i.test(s)) {
      // eslint-disable-next-line no-console
      console.error(`[${opts.dbName}:${opts.port}] ${s.trimEnd()}`);
    }
  });
  const child: ApiChild = {
    proc,
    port: opts.port,
    dbName: opts.dbName,
    baseUrl: `http://127.0.0.1:${opts.port}`,
  };
  spawnedChildren.add(child);
  proc.once("exit", () => {
    spawnedChildren.delete(child);
  });
  return child;
}

async function waitForHealthz(
  baseUrl: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/api/healthz`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (resp.ok) return;
      lastErr = new Error(`status=${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `api-server at ${baseUrl} never returned healthz: ${String(lastErr)}`,
  );
}

async function killChild(child: ApiChild | null): Promise<void> {
  if (!child) return;
  const proc = child.proc;
  if (proc.exitCode != null || proc.signalCode != null) return;
  await new Promise<void>((resolveExit) => {
    const onExit = () => resolveExit();
    proc.once("exit", onExit);
    if (!proc.kill("SIGTERM")) {
      proc.off("exit", onExit);
      resolveExit();
      return;
    }
    // Force-kill if SIGTERM is ignored (api-server has its own SIGTERM
    // handler with a 10s grace; we don't want to wait that long in tests).
    setTimeout(() => {
      if (proc.exitCode == null && proc.signalCode == null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }, 3_000).unref();
  });
}

// ─── DB seeding helpers ───────────────────────────────────────────────

type SeededHub = {
  dbName: string;
  squadronId: string; // uuid string from squadrons.id
  squadronName: string;
  /** Plaintext peer token (`phk_<uuid>_<hex>`) installed in this hub. */
  peerToken: string;
};

async function seedHub(opts: {
  dbName: string;
  squadronName: string;
  squadronNumber: string;
  pilots: Array<{ id: string; rank: string; name: string }>;
  lanUsers: Array<{
    username: string;
    role: string;
    sessionToken: string;
  }>;
}): Promise<SeededHub> {
  const peer = await issuePeerToken();
  return await withDbClient(opts.dbName, async (c) => {
    const sq = await c.query<{ id: string }>(
      `insert into squadrons (number, name)
       values ($1, $2)
       on conflict (number) do update set name = excluded.name
       returning id::text as id`,
      [opts.squadronNumber, opts.squadronName],
    );
    const squadronId = sq.rows[0]!.id;

    for (const p of opts.pilots) {
      await c.query(
        `insert into pilots (id, squadron_id, rank, name, available)
         values ($1, $2::uuid, $3, $4, true)
         on conflict (id) do nothing`,
        [p.id, squadronId, p.rank, p.name],
      );
    }

    for (const u of opts.lanUsers) {
      const userId = randomUUID();
      const passwordHash = await hashPassword("unused-in-tests");
      await c.query(
        `insert into lan_users
           (id, username, display_name, role, squadron_id, password_hash)
         values ($1, $2, $2, $3, $4, $5)
         on conflict (id) do nothing`,
        [userId, u.username, u.role, squadronId, passwordHash],
      );
      await c.query(
        `insert into lan_sessions (id, user_id, token, expires_at)
         values ($1, $2, $3, now() + interval '1 hour')
         on conflict (id) do nothing`,
        [randomUUID(), userId, u.sessionToken],
      );
    }

    await c.query(
      `insert into peer_tokens (id, token_hash, label, issued_by)
       values ($1::uuid, $2, $3, $4)`,
      [peer.id, peer.hash, `aggregator-fanout-${opts.dbName}`, "test-bootstrap"],
    );

    return {
      dbName: opts.dbName,
      squadronId,
      squadronName: opts.squadronName,
      peerToken: peer.plain,
    };
  });
}

async function insertPeerSquadron(opts: {
  dbName: string;
  squadronId: string;
  squadronName: string;
  baseUrl: string;
  token: string;
}): Promise<string> {
  return await withDbClient(opts.dbName, async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into peer_squadrons
         (squadron_id, squadron_name, base_url, auth_token, token_hash, added_by)
       values ($1, $2, $3, $4, $5, $6)
       returning id::text as id`,
      [
        opts.squadronId,
        opts.squadronName,
        opts.baseUrl,
        opts.token,
        hashPeerToken(opts.token),
        "test-bootstrap",
      ],
    );
    return r.rows[0]!.id;
  });
}

async function countAuditUpserts(dbName: string): Promise<
  Array<{ actor: string; pilot_id: string }>
> {
  return await withDbClient(dbName, async (c) => {
    const r = await c.query<{
      actor: string;
      detail: { pilot_id?: string };
    }>(
      `select actor, detail
       from audit_log
       where type = 'internal.pilots.upsert'
       order by id`,
    );
    return r.rows.map((row) => ({
      actor: row.actor,
      pilot_id: String(row.detail.pilot_id ?? ""),
    }));
  });
}

// ─── Topology fixture ─────────────────────────────────────────────────

type Topology = {
  pc1: ApiChild; // aggregator-wing
  pc2: ApiChild; // hub: tigers
  pc3: ApiChild; // hub: hawks
  tigers: SeededHub;
  hawks: SeededHub;
  // Sessions on PC2 that the hub-side test scenarios need.
  aliceSession: string;
  bobSession: string;
  forbiddenSessions: Map<string, string>;
  /** A second squadron on PC2 used for the cross-squadron gate test. */
  squadronBId: string;
};

let topo: Topology | null = null;

// Names match the production installer convention (`hawkeye_<role>_pc<n>`)
// with a UUID suffix so concurrent CI / local runs don't collide on the
// same shared cluster. Postgres caps identifiers at 63 bytes; with the
// 32-char hex suffix we're well under that.
const DB_AGG = `hawkeye_test_pc1_${randomUUID().replace(/-/g, "")}`;
const DB_TIGERS = `hawkeye_test_pc2_${randomUUID().replace(/-/g, "")}`;
const DB_HAWKS = `hawkeye_test_pc3_${randomUUID().replace(/-/g, "")}`;

function buildApiServer(): void {
  const r = spawnSync(
    "pnpm",
    ["--filter", "@workspace/api-server", "build"],
    { stdio: "inherit", cwd: REPO_ROOT },
  );
  if (r.status !== 0) {
    throw new Error("Failed to build @workspace/api-server before test");
  }
}

before(async () => {
  const built = ensureApiServerBuiltCached({
    apiServerDir: API_SERVER_DIR,
    cacheRoot: BUILD_CACHE_ROOT,
    destDist: API_SERVER_DEST_DIST,
    build: buildApiServer,
  });
  API_SERVER_DIST = resolve(built.distDir, "index.mjs");

  await Promise.all([
    ensureDbAndPeerTables(DB_AGG),
    ensureDbAndPeerTables(DB_TIGERS),
    ensureDbAndPeerTables(DB_HAWKS),
  ]);

  const [portAgg, portTigers, portHawks] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);

  const pc1 = spawnApiServer({
    port: portAgg,
    dbName: DB_AGG,
    profile: "aggregator-wing",
    internalSessionAuth: "off",
  });
  const pc2 = spawnApiServer({
    port: portTigers,
    dbName: DB_TIGERS,
    profile: "hub",
    internalSessionAuth: "required",
  });
  const pc3 = spawnApiServer({
    port: portHawks,
    dbName: DB_HAWKS,
    profile: "hub",
    internalSessionAuth: "required",
  });

  await Promise.all([
    waitForHealthz(pc1.baseUrl),
    waitForHealthz(pc2.baseUrl),
    waitForHealthz(pc3.baseUrl),
  ]);

  const aliceSession = `tok-alice-${randomUUID()}`;
  const bobSession = `tok-bob-${randomUUID()}`;
  const forbiddenRoles = [
    "commander_squadron",
    "commander_wing",
    "commander_base",
    "commander",
    "flight_commander",
    "viewer",
    "unknown",
  ];
  const forbiddenSessions = new Map<string, string>(
    forbiddenRoles.map((r) => [r, `tok-${r}-${randomUUID()}`]),
  );

  const lanUsersPc2 = [
    { username: "alice", role: "ops", sessionToken: aliceSession },
    { username: "bob", role: "ops", sessionToken: bobSession },
    ...forbiddenRoles.map((role) => ({
      username: `u-${role}`,
      role,
      sessionToken: forbiddenSessions.get(role)!,
    })),
  ];

  const tigers = await seedHub({
    dbName: DB_TIGERS,
    squadronName: "Tigers",
    squadronNumber: `T-${Math.floor(Math.random() * 1_000_000)}`,
    pilots: [
      { id: "T-1", rank: "Capt", name: "Alpha" },
      { id: "T-2", rank: "Capt", name: "Bravo" },
    ],
    lanUsers: lanUsersPc2,
  });
  const hawks = await seedHub({
    dbName: DB_HAWKS,
    squadronName: "Hawks",
    squadronNumber: `H-${Math.floor(Math.random() * 1_000_000)}`,
    pilots: [{ id: "H-1", rank: "Capt", name: "Charlie" }],
    lanUsers: [],
  });

  // A second squadron lives on PC2 for the cross-squadron gate test.
  // alice is in squadron A (tigers); the route should reject any
  // attempt to write a row whose squadron_id is squadron B.
  const squadronBId = await withDbClient(DB_TIGERS, async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into squadrons (number, name)
       values ($1, 'Other')
       returning id::text as id`,
      [`B-${Math.floor(Math.random() * 1_000_000)}`],
    );
    return r.rows[0]!.id;
  });

  await Promise.all([
    insertPeerSquadron({
      dbName: DB_AGG,
      squadronId: tigers.squadronId,
      squadronName: tigers.squadronName,
      baseUrl: pc2.baseUrl,
      token: tigers.peerToken,
    }),
    insertPeerSquadron({
      dbName: DB_AGG,
      squadronId: hawks.squadronId,
      squadronName: hawks.squadronName,
      baseUrl: pc3.baseUrl,
      token: hawks.peerToken,
    }),
  ]);

  topo = {
    pc1,
    pc2,
    pc3,
    tigers,
    hawks,
    aliceSession,
    bobSession,
    forbiddenSessions,
    squadronBId,
  };
});

after(async () => {
  // Drain by the live child set rather than `topo` so a setup failure
  // mid-`before()` (where `topo` was never assigned) still leaves no
  // orphan api-server processes behind.
  const survivors = Array.from(spawnedChildren);
  await Promise.allSettled(survivors.map((c) => killChild(c)));
  await Promise.allSettled([
    dropDb(DB_AGG),
    dropDb(DB_TIGERS),
    dropDb(DB_HAWKS),
  ]);
});

// ─── Tests ────────────────────────────────────────────────────────────

function requireTopo(): Topology {
  if (!topo) throw new Error("topology not initialised");
  return topo;
}

type AggregatePilotsResp = {
  items: Array<{
    id: string;
    squadron_id: string;
    squadron_name?: string | null;
  }>;
  peers: Array<{
    squadron_id: string;
    status: "online" | "offline";
    served_from_cache: boolean;
    error?: string;
    /** Lifted from `body.error` on a 4xx peer response (e.g. `auth_revoked`). */
    error_kind?: string;
  }>;
};

async function fetchAggregatePilots(): Promise<AggregatePilotsResp> {
  const t = requireTopo();
  const r = await fetch(`${t.pc1.baseUrl}/api/aggregate/pilots`);
  assert.equal(r.status, 200, "aggregator should answer 200");
  return (await r.json()) as AggregatePilotsResp;
}

test("3-PC fan-out: happy path merges Tigers + Hawks rows over real HTTP", async () => {
  const t = requireTopo();
  const out = await fetchAggregatePilots();

  // Two tigers + one hawk.
  const ids = out.items.map((r) => r.id).sort();
  assert.deepEqual(ids, ["H-1", "T-1", "T-2"]);
  // Every row carries its squadron tag.
  for (const row of out.items) {
    assert.ok(
      row.squadron_id === t.tigers.squadronId
        || row.squadron_id === t.hawks.squadronId,
      `row ${row.id} should carry one of the seeded squadron ids`,
    );
  }
  // Both peers should have been online.
  for (const p of out.peers) {
    assert.equal(p.status, "online", `peer ${p.squadron_id} should be online`);
    assert.equal(p.served_from_cache, false);
  }
});

test("3-PC fan-out: hub recovery — kill PC2, fall back to peer_cache, restart, clear marker", async () => {
  const t = requireTopo();

  // Self-contain: do an explicit warm-up fan-out so peer_cache has a
  // fresh tigers payload regardless of which other tests ran first
  // (e.g. when running just this one with `node:test --test-name`).
  const warmup = await fetchAggregatePilots();
  const warmTigers = warmup.peers.find(
    (p) => p.squadron_id === t.tigers.squadronId,
  );
  assert.ok(
    warmTigers && warmTigers.status === "online",
    "warm-up fan-out must succeed before we can assert cache fallback",
  );

  await killChild(t.pc2);

  const cached = await fetchAggregatePilots();
  const cachedByPeer = Object.fromEntries(
    cached.peers.map((p) => [p.squadron_id, p]),
  );
  assert.equal(
    cachedByPeer[t.tigers.squadronId]?.status,
    "offline",
    "tigers should be marked offline after PC2 dies",
  );
  assert.equal(
    cachedByPeer[t.tigers.squadronId]?.served_from_cache,
    true,
    "tigers rows should be served from peer_cache",
  );
  assert.equal(
    cachedByPeer[t.hawks.squadronId]?.status,
    "online",
    "hawks PC3 is untouched and should still be live",
  );
  // The cached rows still flow through with their squadron tag.
  const tigerIds = cached.items
    .filter((r) => r.squadron_id === t.tigers.squadronId)
    .map((r) => r.id)
    .sort();
  assert.deepEqual(
    tigerIds,
    ["T-1", "T-2"],
    "tigers rows are served from cache, not lost",
  );

  // Restart PC2 against the same database + same port. The marker on
  // peer_squadrons.last_error should clear on the next successful call.
  const pc2Restarted = spawnApiServer({
    port: t.pc2.port,
    dbName: DB_TIGERS,
    profile: "hub",
    internalSessionAuth: "required",
  });
  topo = { ...t, pc2: pc2Restarted };
  await waitForHealthz(pc2Restarted.baseUrl);

  const recovered = await fetchAggregatePilots();
  const recoveredByPeer = Object.fromEntries(
    recovered.peers.map((p) => [p.squadron_id, p]),
  );
  assert.equal(
    recoveredByPeer[t.tigers.squadronId]?.status,
    "online",
    "tigers marker should clear once PC2 is back up",
  );
  assert.equal(
    recoveredByPeer[t.tigers.squadronId]?.served_from_cache,
    false,
    "post-recovery rows should come from the live PC2, not cache",
  );
});

// ─── Hub-side scenarios run against PC2 over real HTTP ────────────────

async function upsertPilotPc2(opts: {
  sessionToken: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; body: unknown }> {
  const t = requireTopo();
  const resp = await fetch(`${t.pc2.baseUrl}/api/internal/pilots/upsert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.sessionToken}`,
    },
    body: JSON.stringify(opts.body),
  });
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { status: resp.status, body };
}

test("PC2 last-write-wins: alice + bob upsert same pilot id, both audited", async () => {
  const t = requireTopo();
  const sharedId = `shared-${randomUUID()}`;

  const a = await upsertPilotPc2({
    sessionToken: t.aliceSession,
    body: {
      id: sharedId,
      squadron_id: t.tigers.squadronId,
      name: "Shared Pilot",
      rank: "Capt",
      phone: "111-AAA",
      available: true,
    },
  });
  assert.equal(a.status, 200, `alice's upsert should succeed (got ${a.status})`);

  const b = await upsertPilotPc2({
    sessionToken: t.bobSession,
    body: {
      id: sharedId,
      squadron_id: t.tigers.squadronId,
      name: "Shared Pilot",
      rank: "Capt",
      phone: "999-BBB",
      available: false,
    },
  });
  assert.equal(b.status, 200, `bob's upsert should succeed (got ${b.status})`);

  // Verify in the real PC2 database that bob's write won.
  const pilotRow = await withDbClient(DB_TIGERS, async (c) => {
    const r = await c.query<{ phone: string; available: boolean }>(
      `select phone, available from pilots where id = $1`,
      [sharedId],
    );
    return r.rows[0] ?? null;
  });
  assert.ok(pilotRow, "shared pilot row should exist on PC2");
  assert.equal(pilotRow!.phone, "999-BBB", "last writer wins on phone");
  assert.equal(pilotRow!.available, false, "last writer wins on available");

  const audits = await countAuditUpserts(DB_TIGERS);
  const forShared = audits.filter((a) => a.pilot_id === sharedId);
  assert.equal(forShared.length, 2, "both upserts logged in audit_log");
  const actors = forShared.map((a) => a.actor).sort();
  assert.deepEqual(actors, ["alice", "bob"]);
});

test("PC2 role gate: every non-write role gets 403 forbidden_role", async () => {
  const t = requireTopo();
  for (const [role, sessionToken] of t.forbiddenSessions.entries()) {
    const r = await upsertPilotPc2({
      sessionToken,
      body: {
        id: `gated-${role}-${randomUUID()}`,
        squadron_id: t.tigers.squadronId,
        name: "x",
        rank: "Capt",
        phone: "",
        available: true,
      },
    });
    assert.equal(r.status, 403, `${role} should be forbidden_role`);
    assert.deepEqual(r.body, { error: "forbidden_role" });
  }
});

test("PC2 cross-squadron gate: ops in A cannot upsert into B", async () => {
  const t = requireTopo();
  const r = await upsertPilotPc2({
    sessionToken: t.aliceSession,
    body: {
      id: `xs-${randomUUID()}`,
      squadron_id: t.squadronBId,
      name: "Foreign",
      rank: "Capt",
      phone: "",
      available: true,
    },
  });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: "foreign_squadron_forbidden" });
});

// ─── Peer-token revocation: end-to-end across two real api-servers ───
//
// Guards the most important LAN-mesh failure mode: an operator clicks
// "Revoke" on the squadron HQ's peer token (PC2) and the aggregator
// (PC1) MUST notice on the very next fan-out. Specifically:
//
//   * `/api/peer/*` on PC2 returns 401 `{error:"auth_revoked"}` (the
//     distinct error code added in T001 to peer-shell.ts).
//   * `lib/peer-fanout.ts` lifts that body code into PeerStatus.error_kind.
//   * `/api/aggregate/peers/health` and `/api/aggregate/pilots` both
//     surface `error_kind:"auth_revoked"` so the dashboard can show
//     "Revoked" instead of a generic "offline" pill.
//
// Run last so the destructive UPDATE doesn't hide tigers from earlier
// fan-out tests in this file.
test("3-PC fan-out: revoking PC2's peer token surfaces auth_revoked on PC1", async () => {
  const t = requireTopo();

  // Sanity: tigers must be reachable right now or the test below
  // proves nothing. (The "kill PC2 / restart" test above leaves PC2
  // healthy, but be defensive.)
  const before = await fetchAggregatePilots();
  const beforeTigers = before.peers.find(
    (p) => p.squadron_id === t.tigers.squadronId,
  );
  assert.ok(
    beforeTigers && beforeTigers.status === "online",
    "tigers must be online before we revoke its peer token",
  );

  // Flip the row in PC2's peer_tokens table directly. This is exactly
  // what `peer-tokens-routes.ts` does when the operator clicks Revoke
  // in the dashboard; doing it inline here means we don't have to
  // authenticate as super_admin against PC2.
  //
  // Note: `peer_tokens.token_hash` stores a scrypt hash of just the
  // SECRET portion of the token (compared via `verifyPeerSecret` in
  // peer-shell.ts) — NOT a sha256 of the full plaintext like
  // `peer_squadrons.token_hash` does. The simplest, hash-agnostic way
  // to revoke "the only peer token in this fresh test schema" is an
  // unscoped UPDATE; assert exactly-one-row to catch any future seed
  // change that adds a second token.
  await withSchemaClient(SCHEMA_TIGERS, async (c) => {
    const r = await c.query(
      `update peer_tokens
          set revoked_at = now()
        where revoked_at is null`,
    );
    assert.equal(
      r.rowCount, 1,
      "the test schema should contain exactly one active peer_token to revoke",
    );
  });

  // The next fan-out should mark tigers offline AND lift the auth_revoked
  // error code from peer-shell's body.error → PeerStatus.error_kind.
  const after = await fetchAggregatePilots();
  const afterTigers = after.peers.find(
    (p) => p.squadron_id === t.tigers.squadronId,
  );
  assert.ok(afterTigers, "tigers peer status must still be present in fan-out output");
  assert.equal(
    afterTigers!.status, "offline",
    "tigers must flip to offline once the peer token is revoked",
  );
  assert.equal(
    (afterTigers as { error_kind?: string }).error_kind,
    "auth_revoked",
    "fanOutResource must propagate body.error onto PeerStatus.error_kind",
  );

  // /aggregate/peers/health is a separate code path (pingPeers, not
  // fanOutResource) — verify it surfaces the same code so the
  // dashboard's status sidebar matches the row-level fan-out.
  const healthResp = await fetch(`${t.pc1.baseUrl}/api/aggregate/peers/health`);
  assert.equal(
    healthResp.status, 200,
    "/api/aggregate/peers/health should answer 200 (PC1 runs in bring-up auth mode)",
  );
  const health = (await healthResp.json()) as {
    peers: Array<{
      squadron_id: string;
      status: string;
      error_kind?: string;
    }>;
  };
  const healthTigers = health.peers.find(
    (p) => p.squadron_id === t.tigers.squadronId,
  );
  assert.ok(healthTigers, "tigers must appear in the /peers/health snapshot");
  assert.equal(
    healthTigers!.status, "offline",
    "/peers/health must also flip tigers to offline",
  );
  assert.equal(
    healthTigers!.error_kind, "auth_revoked",
    "pingPeers must propagate body.error onto PeerStatus.error_kind too",
  );
});
