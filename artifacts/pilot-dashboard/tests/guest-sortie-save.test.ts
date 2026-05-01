// End-to-end persistence test for the GUEST-pilot path on a sortie.
//
// Mounts the real `sortiesWritesRouter` AND `sortiesReadRouter` against a
// shared in-memory store (the `pool.query` mock interprets just enough SQL
// to honour an INSERT into sorties + audit_log + a SELECT * FROM sorties
// round-trip). Then:
//
//   1. POST /sorties with `data.pilotExternal` (the same shape the
//      AddSortieWizard / legacy form emit when the operator picks
//      "guest pilot").
//   2. Assert the row was written + the pilots roster is untouched.
//   3. GET /sorties and assert the same `pilotExternal` blob comes back
//      verbatim — i.e. no UI helper flattens the guest reference into a
//      fake pilot id when reading the log.
//
// Server-side gating + role coverage is owned by `sorties-writes-gate`.
// This test only pins the GUEST persistence + read-back contract so a
// future schema migration or read-side projection can't silently strip
// `pilotExternal` without a regression.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:guest-sortie-save

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";

import { pool } from "../../../lib/db/src/index";
import sortiesWritesRouter from "../../api-server/src/routes/sorties-writes";
import sortiesReadRouter from "../../api-server/src/routes/sorties-read";

type SortieRow = {
  id: string;
  squadron_id: string;
  pilot_id: string;
  co_pilot_id: string | null;
  date: string;
  ac_type: string;
  ac_number: string;
  sortie_type: string;
  sortie_name: string;
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
        acType, acNumber, sortieType, sortieName, dataJson,
      ] = params as [
        string, string, string | null, string,
        string, string, string, string, string,
      ];
      const row: SortieRow = {
        id: randomUUID(),
        squadron_id: squadronId,
        pilot_id: pilotId,
        co_pilot_id: coPilotId,
        date,
        ac_type: acType,
        ac_number: acNumber,
        sortie_type: sortieType,
        sortie_name: sortieName,
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

    if (sql.startsWith("select * from sorties")) {
      // sortiesReadRouter passes [limit, ...filterParams]. With a
      // super_admin actor (no squadron/wing/base) buildSquadronReadFilter
      // returns null and we get just the limit. Either way we just return
      // every row in insertion-reverse order (matches `order by date desc`
      // closely enough for fixture data).
      const limit = Number(params[0] ?? 500);
      const items = [...sorties].slice(0, limit);
      return { rows: items, rowCount: items.length };
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
  app.use("/", sortiesReadRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const GUEST_PAYLOAD = {
  ac_type: "F-16",
  ac_number: "017",
  sortie_type: "Training",
  sortie_name: "GUEST-PIN",
  date: "2026-04-30",
  data: {
    pilotExternal: {
      kind: "guest",
      name: "Visiting Hawk 9",
      squadron: "Other Sqdn",
      militaryNumber: "X-9999",
    },
    coPilotExternal: undefined,
    day1: 1,
    actual: 1,
    time: 1,
    condition: "Day",
    pilotPosition: "1st",
    coPilotPosition: "2nd",
  },
};

test("guest sortie persists with pilotExternal and pilots table stays clean", async (t) => {
  reset();
  const squadron = randomUUID();
  const actor: LanActor = { username: "alice", role: "ops", squadron_id: squadron };
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  const post = await fetch(`${srv.baseUrl}/sorties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...GUEST_PAYLOAD,
      squadron_id: squadron,
      pilot_id: randomUUID(),
      co_pilot_id: null,
    }),
  });
  assert.equal(post.status, 200, "ops can save guest sortie");
  const postBody = await post.json() as { row?: SortieRow };
  assert.ok(postBody.row, "writes router echoes the inserted row");

  assert.equal(sorties.length, 1, "exactly one sortie row in the store");
  assert.equal(pilots.size, 0, "guest reference must not pollute pilots table");

  const stored = sorties[0]!;
  const guest = (stored.data as { pilotExternal?: { name?: string; squadron?: string } }).pilotExternal;
  assert.equal(guest?.name, "Visiting Hawk 9", "guest name persisted on sortie data");
  assert.equal(guest?.squadron, "Other Sqdn", "guest squadron persisted on sortie data");

  const inserts = audit.filter(a => a.type === "internal.sorties.insert");
  assert.equal(inserts.length, 1, "guest insert is audited");
  assert.equal(inserts[0]!.actor, "alice");
  assert.equal(inserts[0]!.detail.sortie_id, stored.id);
});

test("GET /sorties returns the guest sortie row with pilotExternal intact", async (t) => {
  reset();
  const squadron = randomUUID();
  // POST as a squadron-scoped ops user, then read back as super_admin
  // (no scope filter) so the read-side projection is exercised without
  // pulling in buildSquadronReadFilter's wing/base SQL.
  let actor: LanActor = { username: "alice", role: "ops", squadron_id: squadron };
  const srv = await startServer(() => actor);
  t.after(() => srv.close());

  const post = await fetch(`${srv.baseUrl}/sorties`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...GUEST_PAYLOAD,
      squadron_id: squadron,
      pilot_id: randomUUID(),
      co_pilot_id: null,
    }),
  });
  assert.equal(post.status, 200);
  assert.equal(sorties.length, 1);

  // Switch actor role so the read path skips the squadron filter.
  actor = { username: "root", role: "super_admin", squadron_id: null };
  const get = await fetch(`${srv.baseUrl}/sorties?limit=50`);
  assert.equal(get.status, 200, "GET /sorties succeeds for super_admin");
  const body = await get.json() as { items?: SortieRow[] };
  assert.ok(Array.isArray(body.items), "items is an array");
  assert.equal(body.items!.length, 1, "one guest sortie surfaces in the log");

  const row = body.items![0]!;
  const guest = (row.data as { pilotExternal?: { name?: string; militaryNumber?: string } }).pilotExternal;
  assert.equal(guest?.name, "Visiting Hawk 9", "GET preserves pilotExternal.name");
  assert.equal(guest?.militaryNumber, "X-9999", "GET preserves pilotExternal.militaryNumber");
  assert.equal(row.sortie_name, "GUEST-PIN", "GET preserves sortie_name");
});
