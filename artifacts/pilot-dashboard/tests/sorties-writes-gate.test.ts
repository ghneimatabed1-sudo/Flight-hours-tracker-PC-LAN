// Direct role + cross-squadron gate coverage for POST /sorties on the
// real sortiesWritesRouter. Also pins the guest-pilot behaviour: a
// sortie that names a guest pilot is saved + audited but does NOT
// create a row in the pilots table.

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../../../lib/db/src/index";
import sortiesWritesRouter from "../../api-server/src/routes/sorties-writes";

type SortieRow = {
  id: string;
  squadron_id: string;
  pilot_id: string;
  co_pilot_id: string | null;
  date: string;
  data: Record<string, unknown>;
};
type AuditRow = { actor: string; type: string; detail: Record<string, unknown> };

const sorties: SortieRow[] = [];
const pilots = new Map<string, unknown>();
const audit: AuditRow[] = [];

function reset(): void {
  sorties.length = 0;
  pilots.clear();
  audit.length = 0;
}

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async (sqlRaw: string, paramsRaw?: readonly unknown[]) => {
    const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
    const params = (paramsRaw ?? []) as unknown[];

    if (sql.startsWith("insert into sorties")) {
      const [
        squadronId, pilotId, coPilotId, date,
        , , , , dataJson,
      ] = params as [
        string, string, string | null, string,
        unknown, unknown, unknown, unknown, string,
      ];
      const row: SortieRow = {
        id: randomUUID(),
        squadron_id: squadronId,
        pilot_id: pilotId,
        co_pilot_id: coPilotId,
        date,
        data: JSON.parse(dataJson),
      };
      sorties.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.startsWith("insert into audit_log")) {
      const [actor, type, detailJson] = params as [string, string, string];
      audit.push({ actor, type, detail: JSON.parse(detailJson) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("insert into pilots")) {
      const id = params[0] as string;
      pilots.set(id, params);
      return { rows: [{ id }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

type LanActor = { username: string; role: string; squadron_id: string | null };
function injectLanActor(getActor: () => LanActor | null): RequestHandler {
  return (req, _res, next) => {
    const a = getActor();
    if (a) {
      (req as { lanUser?: unknown }).lanUser = {
        user_id: a.username, username: a.username, display_name: a.username,
        role: a.role, squadron_id: a.squadron_id, wing_id: null, base_id: null,
      };
    }
    next();
  };
}

async function startServer(getActor: () => LanActor | null) {
  const app: Express = express();
  app.use(express.json());
  app.use(injectLanActor(getActor));
  app.use("/", sortiesWritesRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sortieBody(opts: {
  squadronId: string;
  pilotId: string;
  coPilotId?: string;
  guest?: boolean;
}): Record<string, unknown> {
  return {
    squadron_id: opts.squadronId,
    pilot_id: opts.pilotId,
    co_pilot_id: opts.coPilotId ?? null,
    date: "2026-04-30",
    ac_type: "F-16",
    ac_number: "001",
    sortie_type: "Training",
    sortie_name: "TEST",
    data: opts.guest
      ? {
        pilotExternal: { kind: "guest", name: "Visiting Eagle 7", squadron: "Other" },
        day1: 1, actual: 1,
      }
      : { day1: 1, actual: 1 },
  };
}

test("POST /sorties: ops succeeds + audit row carries actor + role", async (t) => {
  reset();
  const squadron = randomUUID();
  let actor: LanActor | null = { username: "alice", role: "ops", squadron_id: squadron };
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  const resp = await fetch(`${srv.baseUrl}/sorties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sortieBody({ squadronId: squadron, pilotId: randomUUID() })),
  });
  assert.equal(resp.status, 200);
  assert.equal(sorties.length, 1);
  const inserts = audit.filter((a) => a.type === "internal.sorties.insert");
  assert.equal(inserts.length, 1, "audit type matches sorties-writes.ts:74");
  assert.equal(inserts[0]!.actor, "alice");
  assert.equal(inserts[0]!.detail.role, "ops");
});

test("POST /sorties: forbidden roles all 403 + nothing written", async (t) => {
  reset();
  const squadron = randomUUID();
  let actor: LanActor | null = null;
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  // The sorties-writes route hard-gates writes to ops/admin/super_admin.
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
    const resp = await fetch(`${srv.baseUrl}/sorties`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sortieBody({ squadronId: squadron, pilotId: randomUUID() })),
    });
    assert.equal(resp.status, 403, `${role} should be forbidden_role`);
    const body = await resp.json() as { error?: string };
    assert.equal(body.error, "forbidden_role");
  }
  assert.equal(sorties.length, 0);
  assert.equal(audit.length, 0);
});

test("POST /sorties: ops in squadron A cannot insert into squadron B", async (t) => {
  reset();
  const squadronA = randomUUID();
  const squadronB = randomUUID();
  let actor: LanActor | null = { username: "alice", role: "ops", squadron_id: squadronA };
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  const resp = await fetch(`${srv.baseUrl}/sorties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sortieBody({ squadronId: squadronB, pilotId: randomUUID() })),
  });
  assert.equal(resp.status, 403);
  const body = await resp.json() as { error?: string };
  assert.equal(body.error, "foreign_squadron_forbidden");
  assert.equal(sorties.length, 0);
});

test("POST /sorties with guest pilot: sortie saved, NO row added to pilots, audit captures sortie id", async (t) => {
  reset();
  const squadron = randomUUID();
  let actor: LanActor | null = { username: "alice", role: "ops", squadron_id: squadron };
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  const resp = await fetch(`${srv.baseUrl}/sorties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sortieBody({
      squadronId: squadron,
      pilotId: randomUUID(),
      guest: true,
    })),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json() as { row?: SortieRow };
  assert.ok(body.row, "sortie row returned");
  assert.equal(sorties.length, 1, "exactly one sortie written");
  const stored = sorties[0]!;
  const guestRef = (stored.data as { pilotExternal?: { name?: string } }).pilotExternal;
  assert.equal(guestRef?.name, "Visiting Eagle 7", "guest ref persisted on sortie data");
  assert.equal(pilots.size, 0, "guest pilot DOES NOT pollute pilots table");
  const inserts = audit.filter((a) => a.type === "internal.sorties.insert");
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0]!.detail.sortie_id, stored.id);
});

test("POST /sorties: re-using the same guest name later does not create a roster entry either", async (t) => {
  reset();
  const squadron = randomUUID();
  let actor: LanActor | null = { username: "alice", role: "ops", squadron_id: squadron };
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  for (const date of ["2026-04-30", "2026-05-15", "2026-06-01"]) {
    const resp = await fetch(`${srv.baseUrl}/sorties`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...sortieBody({ squadronId: squadron, pilotId: randomUUID(), guest: true }),
        date,
      }),
    });
    assert.equal(resp.status, 200, `sortie on ${date} accepted`);
  }
  assert.equal(sorties.length, 3, "three guest sorties saved");
  assert.equal(pilots.size, 0, "guest is sortie-scoped — never remembered as a pilot");
});
