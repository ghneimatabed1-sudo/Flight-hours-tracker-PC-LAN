// Integration coverage for the op.* audit-log expansion (task #408).
//
// The unit-level coverage in `audit-op-event.test.ts` exercises the
// route handler in isolation. This file goes further: it stands up
// the *real* `buildRouter("hub")` Express app — including the global
// `requireInternalLanSession` middleware that gates `/api/internal/*`
// — and asserts the auth composition works end-to-end:
//
//   1. POST /api/internal/audit/op-event with NO auth          → 401 from
//      the LAN-session middleware (anonymous LAN clients are still locked
//      out).
//   2. POST with a valid `x-hawk-system-identity` header       → 200 and
//      writes a row, even with NO LAN-session cookie. This is the path
//      the verify-backup.ps1 scheduled task and release-verify.mjs use.
//   3. POST with a real LAN-session cookie for a super_admin   → 200 and
//      stamps the session's username on the audit row.
//   4. POST with a LAN-session cookie for a non-super_admin    → 403
//      (the LAN session passes the global middleware but the route
//      handler enforces the role).
//
// We stub `pool.query` so the LAN-session lookup, the `audit_log`
// INSERT, and the auth-mode check all run without a real Postgres.

process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "integration-token-abcdefghijkl";
process.env.HAWK_INTERNAL_SESSION_AUTH = "required";
process.env.DATABASE_URL ??= "postgres://stub:stub@127.0.0.1:1/stub";
process.env.INSTALL_PROFILE ??= "hub";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";

import { pool } from "../../../lib/db/src/index";

type QueryCall = { sql: string; params: ReadonlyArray<unknown> };
const queryCalls: QueryCall[] = [];

// Default stub: behave as if the DB has no LAN sessions and audit_log
// inserts succeed silently. Individual tests narrow this with
// `setQueryResponder`.
type Responder = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => Promise<{ rows: unknown[]; rowCount: number }>;
let responder: Responder = async () => ({ rows: [], rowCount: 0 });

(pool as unknown as { query: Responder }).query = async (sql, params = []) => {
  queryCalls.push({ sql, params });
  return responder(sql, params);
};

function resetQueryState(next?: Responder) {
  queryCalls.length = 0;
  responder = next ?? (async () => ({ rows: [], rowCount: 0 }));
}

// Import buildRouter AFTER the env + pool stub are in place so any
// module-init code reads the correct config.
const { buildRouter } = await import("../src/routes/index");
const {
  setActiveInstallProfile,
  _resetActiveInstallProfileForTests,
} = await import("../src/lib/install-profile");
const { __resetSystemIdentityCache, getSystemIdentityHeaderName } =
  await import("../src/lib/system-identity");

function makeApp(): Express {
  setActiveInstallProfile("hub");
  const app = express();
  app.use(express.json());
  app.use("/api", buildRouter("hub"));
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return app;
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = makeApp();
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind integration server");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _resetActiveInstallProfileForTests();
  }
}

const HEADER = getSystemIdentityHeaderName();
const SESSION_HEADER = "x-hawk-lan-session";

const VALID_BODY = {
  event_type: "op.release_verify",
  outcome: "success" as const,
  summary: "GREEN — 7 pass / 0 fail / 0 skip",
  details: { passed: 7, failed: 0, skipped: 0 },
};

function findAuditInsert() {
  return queryCalls.find((c) =>
    /insert\s+into\s+audit_log/i.test(c.sql),
  );
}

test("integration: anonymous POST → 401 from LAN-session gate", async () => {
  resetQueryState();
  __resetSystemIdentityCache();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/audit/op-event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "lan_session_required");
    assert.equal(findAuditInsert(), undefined, "no audit row written");
  });
});

test("integration: valid system-identity header bypasses LAN session and writes a row", async () => {
  resetQueryState();
  __resetSystemIdentityCache();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/audit/op-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER]: "integration-token-abcdefghijkl",
      },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
    const insert = findAuditInsert();
    assert.ok(insert, "expected one audit_log INSERT");
    const [actor, type] = insert.params as [string, string, string];
    // No LAN session, so appendInternalAudit rewrites actor → 'unknown'
    // (and stamps actor_unknown:true in detail). This pins the actual
    // production behaviour.
    assert.equal(actor, "unknown");
    assert.equal(type, "op.release_verify");
  });
});

test("integration: bogus system-identity header falls back to LAN gate → 401", async () => {
  resetQueryState();
  __resetSystemIdentityCache();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/audit/op-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER]: "this-is-not-the-token",
      },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 401);
    assert.equal(findAuditInsert(), undefined);
  });
});

test("integration: super_admin LAN session can post (no token needed)", async () => {
  __resetSystemIdentityCache();
  // The session middleware looks up: select ... from lan_sessions s
  //   join lan_users u on u.id = s.user_id where s.token=$1 ...
  // Stub it to return a super_admin row so the gate passes; everything
  // else (including the audit_log INSERT) returns the empty default.
  resetQueryState(async (sql) => {
    if (/from\s+lan_sessions/i.test(sql)) {
      return {
        rows: [
          {
            user_id: "user-sa-1",
            username: "sa.local",
            display_name: "Super Admin",
            role: "super_admin",
            squadron_id: null,
            wing_id: null,
            base_id: null,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/audit/op-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_HEADER]: "session-token-xyz",
      },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean };
    assert.equal(body.ok, true);
    const insert = findAuditInsert();
    assert.ok(insert, "expected one audit_log INSERT");
    const [actor, , detailJson] = insert.params as [string, string, string];
    // A real LAN session was attached, so the route stamps the
    // session's username as the actor (overriding any client-supplied
    // value).
    assert.equal(actor, "sa.local");
    const detail = JSON.parse(detailJson);
    assert.equal(detail.outcome, "success");
  });
});

test("integration: non-super_admin LAN session → 403 from role gate", async () => {
  __resetSystemIdentityCache();
  resetQueryState(async (sql) => {
    if (/from\s+lan_sessions/i.test(sql)) {
      return {
        rows: [
          {
            user_id: "user-viewer-1",
            username: "viewer.local",
            display_name: "Viewer",
            role: "viewer",
            squadron_id: null,
            wing_id: null,
            base_id: null,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/audit/op-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SESSION_HEADER]: "session-token-xyz",
      },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "system_identity_or_super_admin_required");
    assert.equal(findAuditInsert(), undefined, "no audit row written");
  });
});
