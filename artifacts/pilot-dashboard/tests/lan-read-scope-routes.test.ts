// End-to-end smoke test for the multi-tier RBAC read filter on the
// updated api-server routes. The unit test in `lan-read-scope.test.ts`
// pins the SQL fragment produced by `buildSquadronReadFilter`; this
// file pins that the *actual route handlers* wire that fragment into
// every read query so a wing/base commander gets command-wide
// visibility while ops / commander_squadron stay squadron-local.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:lan-read-scope-routes

// Set DATABASE_URL before any module import — `@workspace/db` throws
// at import time if it is unset, and we will replace `pool.query`
// with a mock immediately after import so no real connection is made.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

// Import @workspace/db via the source path — pilot-dashboard does not
// list it as a workspace dep (only api-server does), and this is a
// test-only import where we immediately replace the singleton's query
// method with a capturing mock.
import { pool } from "../../../lib/db/src/index";
import unavailableRouter from "../../api-server/src/routes/unavailable-internal";
import opsReadRouter from "../../api-server/src/routes/ops-read-lan";
import savedDutyWeeksRouter from "../../api-server/src/routes/saved-duty-weeks-internal";
import squadronAirframesRouter from "../../api-server/src/routes/squadron-airframes";

// Task #339 — pilot-links-internal and lan-users-reminders routers
// were retired with the multi-PC mesh feature set. Their per-route
// tests below were removed; the LAN-scope contract is still pinned
// here for the surviving routers.
import {
  canReadSquadronData,
  canWriteSquadronData,
  sameSquadron,
} from "../../api-server/src/lib/lan-authz";

type Captured = { sql: string; params: readonly unknown[] };

const captured: Captured[] = [];
let nextRows: unknown[] = [];

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async (sql: string, params?: readonly unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return { rows: nextRows };
  };

type ActorHeader = {
  role?: string;
  squadron_id?: string | null;
  wing_id?: string | null;
  base_id?: string | null;
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header("x-test-actor");
    if (raw) {
      try {
        const actor = JSON.parse(raw) as ActorHeader;
        (req as unknown as { lanUser: ActorHeader }).lanUser = actor;
      } catch {
        // ignore — leave req.lanUser unset
      }
    }
    next();
  });
  app.use("/", unavailableRouter);
  app.use("/", opsReadRouter);
  app.use("/", savedDutyWeeksRouter);
  app.use("/", squadronAirframesRouter);
  return app;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = makeApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind smoke-test server");
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { server, baseUrl } = await startServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function lastCapture(): Captured {
  assert.ok(captured.length > 0, "expected at least one pool.query call");
  return captured[captured.length - 1]!;
}

function reset() {
  captured.length = 0;
  nextRows = [];
}

async function get(baseUrl: string, path: string, actor: ActorHeader | null) {
  return fetch(`${baseUrl}${path}`, {
    headers: actor ? { "x-test-actor": JSON.stringify(actor) } : {},
  });
}

test("GET /unavailable: ops only sees own squadron", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/unavailable", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /left join pilots p on p\.id = u\.pilot_id/);
  assert.match(cap.sql, /and p\.squadron_id::text = \$1/);
  assert.deepEqual(cap.params, ["S1"]);
});

test("GET /unavailable: commander_wing sees every squadron in their wing", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/unavailable", {
      role: "commander_wing",
      squadron_id: "S1",
      wing_id: "W7",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /wing_id = \$1/);
  assert.match(cap.sql, /p\.squadron_id::text = \$2/);
  assert.deepEqual(cap.params, ["W7", "S1"]);
});

test("GET /unavailable: commander_base scopes by base_id", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/unavailable", {
      role: "commander_base",
      squadron_id: "S1",
      base_id: "B3",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /base_id = \$1/);
  assert.deepEqual(cap.params, ["B3", "S1"]);
});

test("GET /unavailable: super_admin sees everything (no filter)", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/unavailable", {
      role: "super_admin",
      squadron_id: null,
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.doesNotMatch(cap.sql, /squadron_id::text = \$/);
  assert.doesNotMatch(cap.sql, /and false/);
  assert.deepEqual(cap.params, []);
});

// Helper: stage the per-call return values for pool.query. Routes
// that fire a pilot/squadron lookup before the scoped read need this
// to feed deterministic rows for the first call (the lookup) and
// then fall back to empty rows for any follow-up.
function stageQueryReturns(returns: unknown[][]) {
  let callCount = 0;
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
    async (sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      const rows = returns[callCount] ?? [];
      callCount += 1;
      return { rows };
    };
}

function restoreSimpleMock() {
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
    async (sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: nextRows };
    };
}

test("GET /leaves: commander_wing year is $1 and wing filter starts at $2", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/leaves?year=2026", {
      role: "commander_wing",
      squadron_id: "S1",
      wing_id: "W7",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /where l\.year = \$1/);
  assert.match(cap.sql, /wing_id = \$2/);
  assert.match(cap.sql, /p\.squadron_id::text = \$3/);
  assert.deepEqual(cap.params, [2026, "W7", "S1"]);
});

test("GET /leaves: ops scoped to own squadron with year as $1", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/leaves?year=2026", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /where l\.year = \$1/);
  assert.match(cap.sql, /and p\.squadron_id::text = \$2/);
  assert.deepEqual(cap.params, [2026, "S1"]);
});

test("GET /leaves: super_admin gets year-only query (no scope filter)", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/leaves?year=2026", {
      role: "super_admin",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /where l\.year = \$1/);
  assert.doesNotMatch(cap.sql, /squadron_id::text = \$/);
  assert.deepEqual(cap.params, [2026]);
});

test("unknown role is fail-closed (and false) on /unavailable", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/unavailable", {
      role: "intern",
      squadron_id: "S1",
    });
    assert.equal(res.status, 200);
  });
  const cap = lastCapture();
  assert.match(cap.sql, /and false/);
  assert.deepEqual(cap.params, []);
});

// ── /saved-duty-weeks ───────────────────────────────────────────────
// saved_duty_weeks identifies its squadron by display name/number
// text rather than UUID, so the route resolves the requested
// squadron back to a `squadrons` row and gates on canReadSquadronData.

test("GET /saved-duty-weeks: ops cannot pull a foreign squadron's roster", async () => {
  reset();
  // First call: squadron lookup. Return foreign squadron.
  stageQueryReturns([[{ id: "S99", wing_id: "W9", base_id: "B9" }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=99 SQN", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 403);
  });
  restoreSimpleMock();
});

test("GET /saved-duty-weeks: ops succeeds for own squadron", async () => {
  reset();
  stageQueryReturns([[{ id: "S1", wing_id: "W1", base_id: "B1" }], []]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=1 SQN", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 200);
  });
  // Two queries fired: squadron lookup, then the actual read.
  assert.equal(captured.length, 2);
  assert.match(captured[0]!.sql, /from squadrons/);
  assert.match(captured[1]!.sql, /from saved_duty_weeks/);
  assert.deepEqual(captured[1]!.params, ["1 SQN"]);
  restoreSimpleMock();
});

test("GET /saved-duty-weeks: commander_wing may pull a sister squadron in their wing", async () => {
  reset();
  stageQueryReturns([[{ id: "S2", wing_id: "W7", base_id: "B1" }], []]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=2 SQN", {
      role: "commander_wing",
      squadron_id: "S1",
      wing_id: "W7",
    });
    assert.equal(res.status, 200);
  });
  restoreSimpleMock();
});

test("GET /saved-duty-weeks: commander_base rejected when target sits on a different base", async () => {
  reset();
  stageQueryReturns([[{ id: "S2", wing_id: "W2", base_id: "B9" }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=2 SQN", {
      role: "commander_base",
      squadron_id: "S1",
      base_id: "B3",
    });
    assert.equal(res.status, 403);
  });
  restoreSimpleMock();
});

test("GET /saved-duty-weeks: super_admin skips squadron lookup entirely", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=1 SQN", {
      role: "super_admin",
    });
    assert.equal(res.status, 200);
  });
  // Only one query: the actual read. No squadrons lookup.
  assert.equal(captured.length, 1);
  assert.match(captured[0]!.sql, /from saved_duty_weeks/);
});

test("GET /saved-duty-weeks: 404 when requested squadron does not exist (non-admin actor)", async () => {
  reset();
  stageQueryReturns([[]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=ghost", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 404);
  });
  restoreSimpleMock();
});

test("GET /saved-duty-weeks: unknown role is fail-closed", async () => {
  reset();
  stageQueryReturns([[{ id: "S1", wing_id: "W1", base_id: "B1" }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=1 SQN", {
      role: "intern",
      squadron_id: "S1",
    });
    assert.equal(res.status, 403);
  });
  restoreSimpleMock();
});

test("GET /saved-duty-weeks: missing squadron query param returns 400", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 400);
  });
  // No DB call should fire when validation fails.
  assert.equal(captured.length, 0);
});

// ── Fail-closed identity helpers ────────────────────────────────────
// `sameSquadron` and (transitively) `sameId` must NEVER match when
// either side is empty/null. Otherwise an actor with a missing scope
// ID could read or write a legacy row whose corresponding scope ID
// is also null. Pin the helper-level behaviour and the route-level
// behaviour for direct canReadSquadronData callers.

test("sameSquadron: null/empty on either side never matches", () => {
  assert.equal(sameSquadron(null, null), false);
  assert.equal(sameSquadron(undefined, undefined), false);
  assert.equal(sameSquadron("", ""), false);
  assert.equal(sameSquadron("   ", "   "), false);
  assert.equal(sameSquadron("S1", null), false);
  assert.equal(sameSquadron(null, "S1"), false);
  assert.equal(sameSquadron("S1", ""), false);
  assert.equal(sameSquadron("", "S1"), false);
  // sanity: real matches still work
  assert.equal(sameSquadron("S1", "S1"), true);
  assert.equal(sameSquadron("  s1 ", "S1"), true);
});

test("canReadSquadronData: commander_wing with NULL wing_id cannot read a target with NULL wing_id", () => {
  // Both sides have null wing_id; under the old `sameId` (where empty
  // strings matched) this would silently authorise the read.
  assert.equal(
    canReadSquadronData(
      { role: "commander_wing", squadronId: "S1", wingId: null, baseId: "B1" },
      { squadronId: "S99", wingId: null, baseId: "B1" },
    ),
    false,
  );
  // sanity: with valid matching wing_ids the commander_wing CAN read a
  // sister squadron's row.
  assert.equal(
    canReadSquadronData(
      { role: "commander_wing", squadronId: "S1", wingId: "W7", baseId: "B1" },
      { squadronId: "S2", wingId: "W7", baseId: "B1" },
    ),
    true,
  );
});

test("canReadSquadronData: commander_base with NULL base_id cannot read a target with NULL base_id", () => {
  assert.equal(
    canReadSquadronData(
      { role: "commander_base", squadronId: "S1", wingId: "W1", baseId: null },
      { squadronId: "S99", wingId: "W2", baseId: null },
    ),
    false,
  );
  assert.equal(
    canReadSquadronData(
      { role: "commander_base", squadronId: "S1", wingId: "W1", baseId: "B3" },
      { squadronId: "S2", wingId: "W2", baseId: "B3" },
    ),
    true,
  );
});

test("canWriteSquadronData: ops with NULL squadron_id cannot write a target with NULL squadron_id", () => {
  assert.equal(canWriteSquadronData("ops", null, null), false);
  assert.equal(canWriteSquadronData("commander_squadron", null, null), false);
  assert.equal(canWriteSquadronData("commander_wing", null, null), false);
  // sanity: same valid id → allowed
  assert.equal(canWriteSquadronData("ops", "S1", "S1"), true);
});

test("GET /saved-duty-weeks: commander_base with null base_id is rejected against null-base target", async () => {
  reset();
  stageQueryReturns([[{ id: "S99", wing_id: null, base_id: null }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/saved-duty-weeks?squadron=99 SQN", {
      role: "commander_base",
      squadron_id: "S1",
      base_id: null,
    });
    assert.equal(res.status, 403);
  });
  restoreSimpleMock();
});

// ── /squadron-airframes ─────────────────────────────────────────────
// Setup-wizard lookup. Open when no LAN actor is attached (initial
// bring-up), but scoped via canReadSquadronData when an actor is
// present so a squadron-tier user cannot pull another squadron's
// defaults.

test("GET /squadron-airframes: open when no LAN actor AND no lan_users yet (Setup Wizard)", async () => {
  reset();
  // 1st query: lan_users count → 0 (bring-up). 2nd: squadrons row.
  stageQueryReturns([
    [{ c: 0 }],
    [{
      id: "S1",
      base: "BASE A",
      wing: "WING 7",
      wing_id: "W7",
      base_id: "B3",
      default_aircraft: null,
      default_monthly_targets: null,
    }],
  ]);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/squadron-airframes?number=1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { found: boolean };
    assert.equal(body.found, true);
  });
  restoreSimpleMock();
});

test("GET /squadron-airframes: rejects no-actor request once lan_users have been bootstrapped", async () => {
  reset();
  // lan_users count → 1; route should refuse with 401 before the
  // squadron lookup even runs.
  stageQueryReturns([[{ c: 1 }]]);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/squadron-airframes?number=1`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "actor_required");
  });
  // Confirm we did NOT hit the squadrons table when refusing.
  const sqlSeen = captured.map((c) => c.sql.replace(/\s+/g, " ").trim());
  assert.equal(sqlSeen.length, 1);
  assert.match(sqlSeen[0]!, /from lan_users/i);
  restoreSimpleMock();
});

test("GET /squadron-airframes: ops cannot pull another squadron's defaults", async () => {
  reset();
  stageQueryReturns([[{
    id: "S99",
    base: "BASE B",
    wing: "WING 9",
    wing_id: "W9",
    base_id: "B9",
    default_aircraft: null,
    default_monthly_targets: null,
  }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/squadron-airframes?number=99", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 403);
  });
  restoreSimpleMock();
});

test("GET /squadron-airframes: commander_wing may pull a sister squadron in their wing", async () => {
  reset();
  stageQueryReturns([[{
    id: "S2",
    base: "BASE A",
    wing: "WING 7",
    wing_id: "W7",
    base_id: "B3",
    default_aircraft: null,
    default_monthly_targets: null,
  }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/squadron-airframes?number=2", {
      role: "commander_wing",
      squadron_id: "S1",
      wing_id: "W7",
    });
    assert.equal(res.status, 200);
  });
  restoreSimpleMock();
});

test("GET /squadron-airframes: super_admin pulls anything", async () => {
  reset();
  stageQueryReturns([[{
    id: "S99",
    base: "BASE Z",
    wing: "WING Z",
    wing_id: "W9",
    base_id: "B9",
    default_aircraft: null,
    default_monthly_targets: null,
  }]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/squadron-airframes?number=99", {
      role: "super_admin",
    });
    assert.equal(res.status, 200);
  });
  restoreSimpleMock();
});

test("GET /squadron-airframes: returns found=false when number is unknown", async () => {
  reset();
  stageQueryReturns([[]]);
  await withServer(async (baseUrl) => {
    const res = await get(baseUrl, "/squadron-airframes?number=ghost", {
      role: "ops",
      squadron_id: "S1",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { found: boolean };
    assert.equal(body.found, false);
  });
  restoreSimpleMock();
});
