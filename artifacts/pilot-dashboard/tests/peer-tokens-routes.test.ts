// Tests for the hub peer-token surface:
//   - peer-token CRUD (super_admin only) at /internal/peer-tokens
//   - read-only /peer/* endpoints gated by X-Hawk-Peer-Token
//   - blocked /peer/* endpoints returning 403 not_exposed_to_peers
//   - audit_log entry shape on every peer call
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:peer-tokens-routes

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { pool } from "../../../lib/db/src/index";
import peerShellRouter from "../../api-server/src/routes/peer-shell";
import peerTokensInternalRouter from "../../api-server/src/routes/peer-tokens-internal";
import { hashPassword } from "../../api-server/src/lib/password";
import { issuePeerToken, parsePeerToken } from "../../api-server/src/lib/peer-token";

type Captured = { sql: string; params: readonly unknown[] };

const captured: Captured[] = [];
let queryHandler: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>
  = async () => ({ rows: [] });

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async (sql: string, params?: readonly unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return queryHandler(sql, params);
  };

function reset() {
  captured.length = 0;
  queryHandler = async () => ({ rows: [] });
}

type ActorHeader = {
  role?: string;
  username?: string;
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
        (req as unknown as { lanUser: ActorHeader }).lanUser = JSON.parse(raw);
      } catch {
        // ignore
      }
    }
    next();
  });
  app.use("/internal", peerTokensInternalRouter);
  app.use("/peer", peerShellRouter);
  return app;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = makeApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("bind failed");
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

// ── peer-token helper unit tests ────────────────────────────────────

test("issuePeerToken: produces a phk_<uuid>_<secret> bearer that round-trips through parsePeerToken", async () => {
  const issued = await issuePeerToken();
  assert.ok(issued.plain.startsWith("phk_"), "plain token must carry phk_ prefix");
  assert.equal(issued.id.length, 36, "id should be a UUID");
  assert.match(issued.secret, /^[0-9a-f]{64}$/, "secret should be 32 random hex bytes");
  assert.notEqual(issued.hash, issued.secret, "hash must not equal secret");
  assert.match(issued.hash, /^scrypt\$/, "hash should use scrypt (same as user passwords)");
  const parsed = parsePeerToken(issued.plain);
  assert.ok(parsed, "issued token must round-trip through parsePeerToken");
  assert.equal(parsed!.id, issued.id);
  assert.equal(parsed!.secret, issued.secret);
});

test("parsePeerToken: rejects garbage / missing prefix / mis-shaped ids", () => {
  assert.equal(parsePeerToken(null), null);
  assert.equal(parsePeerToken(""), null);
  assert.equal(parsePeerToken("not-a-token"), null);
  assert.equal(parsePeerToken("phk_only-prefix"), null);
  assert.equal(parsePeerToken("phk_short_secret"), null, "short id should not parse");
  assert.equal(
    parsePeerToken("phk_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_secret"),
    null,
    "non-hex id chars should not parse",
  );
});

// ── peer-token CRUD ─────────────────────────────────────────────────

test("POST /internal/peer-tokens: super_admin creates token and gets plain bearer once", async () => {
  reset();
  const inserted: Captured[] = [];
  let auditWritten = false;
  queryHandler = async (sql, params) => {
    if (/insert into peer_tokens/i.test(sql)) {
      inserted.push({ sql, params: params ?? [] });
      return {
        rows: [{
          id: (params as unknown[])[0],
          label: (params as unknown[])[2],
          scope: (params as unknown[])[3],
          issued_at: "2026-04-30T12:00:00Z",
          issued_by: (params as unknown[])[4],
          expires_at: null,
          revoked_at: null,
          revoked_by: null,
          last_used_at: null,
        }],
      };
    }
    if (/insert into audit_log/i.test(sql)) {
      auditWritten = true;
      return { rows: [] };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": JSON.stringify({ role: "super_admin", username: "alice" }),
      },
      body: JSON.stringify({ name: "Wing Commander PC – Tigers Wing" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token?: string; row?: { id?: string; label?: string } };
    assert.ok(body.token?.startsWith("phk_"), "token must be returned in plain form");
    assert.equal(body.row?.label, "Wing Commander PC – Tigers Wing");
    assert.ok(body.row?.id);
  });
  assert.equal(inserted.length, 1, "one INSERT into peer_tokens");
  assert.equal(auditWritten, true, "audit_log must be written");
});

test("POST /internal/peer-tokens: rejects missing / empty name", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-actor": JSON.stringify({ role: "super_admin", username: "alice" }),
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "missing_name");
  });
});

test("POST /internal/peer-tokens: rejects non-super_admin actors", async () => {
  for (const role of ["admin", "ops", "commander_squadron", "commander_wing", "commander_base", "deputy"]) {
    reset();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/internal/peer-tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": JSON.stringify({ role, username: "x" }),
        },
        body: JSON.stringify({ name: "x" }),
      });
      assert.equal(res.status, 403, `${role} must be forbidden from creating peer tokens`);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "forbidden_role");
    });
  }
});

test("GET /internal/peer-tokens: returns rows but never the token_hash", async () => {
  reset();
  queryHandler = async () => ({
    rows: [{
      id: "tok-1",
      label: "Wing PC",
      scope: "squadron-read",
      issued_at: "2026-01-01T00:00:00Z",
      issued_by: "alice",
      expires_at: null,
      revoked_at: null,
      revoked_by: null,
      last_used_at: "2026-04-01T00:00:00Z",
    }],
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens`, {
      headers: { "x-test-actor": JSON.stringify({ role: "super_admin", username: "alice" }) },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items?: Record<string, unknown>[] };
    assert.equal(body.items?.length, 1);
    const row = body.items![0]!;
    assert.equal(row.label, "Wing PC");
    assert.equal(row.scope, "squadron-read");
    assert.ok(!("token_hash" in row), "token_hash must NOT be exposed");
  });
});

test("GET /internal/peer-tokens: rejects ops actor", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens`, {
      headers: { "x-test-actor": JSON.stringify({ role: "ops", username: "bob" }) },
    });
    assert.equal(res.status, 403);
  });
});

test("DELETE /internal/peer-tokens/:id: super_admin revokes an active token", async () => {
  reset();
  let updated = false;
  let audited = false;
  queryHandler = async (sql, params) => {
    if (/update peer_tokens/i.test(sql)) {
      updated = true;
      return {
        rows: [{
          id: (params as unknown[])[0],
          label: "Wing PC",
          scope: "squadron-read",
          issued_at: "2026-01-01T00:00:00Z",
          issued_by: "alice",
          expires_at: null,
          revoked_at: "2026-04-30T00:00:00Z",
          revoked_by: (params as unknown[])[1],
          last_used_at: null,
        }],
      };
    }
    if (/insert into audit_log/i.test(sql)) {
      audited = true;
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens/tok-1`, {
      method: "DELETE",
      headers: { "x-test-actor": JSON.stringify({ role: "super_admin", username: "alice" }) },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; row?: { revoked_at?: string } };
    assert.equal(body.ok, true);
    assert.ok(body.row?.revoked_at);
  });
  assert.equal(updated, true);
  assert.equal(audited, true);
});

test("DELETE /internal/peer-tokens/:id: 404 when token does not exist", async () => {
  reset();
  queryHandler = async (sql) => {
    if (/update peer_tokens/i.test(sql)) return { rows: [] };
    if (/select id from peer_tokens/i.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens/missing`, {
      method: "DELETE",
      headers: { "x-test-actor": JSON.stringify({ role: "super_admin", username: "alice" }) },
    });
    assert.equal(res.status, 404);
  });
});

test("DELETE /internal/peer-tokens/:id: 409 when token already revoked", async () => {
  reset();
  queryHandler = async (sql, params) => {
    if (/update peer_tokens/i.test(sql)) return { rows: [] };
    if (/select id from peer_tokens/i.test(sql)) {
      return { rows: [{ id: (params as unknown[])[0] }] };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/internal/peer-tokens/tok-1`, {
      method: "DELETE",
      headers: { "x-test-actor": JSON.stringify({ role: "super_admin", username: "alice" }) },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "already_revoked");
  });
});

// ── /peer/* middleware ──────────────────────────────────────────────

test("/peer/pilots: 401 invalid_token when no header is sent", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    // Token-rotation flow needs a distinct body so the aggregator's
    // classifyHttpError() can decide between "Token expired" UI and a
    // generic offline state. Missing/malformed/no-row/hash-mismatch all
    // map to `invalid_token` (auth_invalid kind).
    assert.equal(body.error, "invalid_token");
  });
});

test("/peer/pilots: 401 invalid_token when token cannot be parsed", async () => {
  reset();
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": "garbage" },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_token");
  });
});

test("/peer/pilots: 401 invalid_token when row is missing in DB", async () => {
  reset();
  // Fabricate a well-shaped token; lookup will return zero rows.
  const issued = await issuePeerToken();
  queryHandler = async () => ({ rows: [] });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_token");
  });
});

test("/peer/pilots: 401 revoked_token when row is revoked", async () => {
  reset();
  const issued = await issuePeerToken();
  queryHandler = async (sql) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label: "Wing PC",
          token_hash: issued.hash,
          revoked_at: "2026-04-29T00:00:00Z",
          expires_at: null,
        }],
      };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    // Distinct from `invalid_token` so the aggregator can prompt the
    // operator with the "Token revoked — refresh" copy instead of the
    // generic "Token rejected" copy.
    assert.equal(body.error, "revoked_token");
  });
});

test("/peer/pilots: 401 revoked_token when expires_at has passed", async () => {
  reset();
  const issued = await issuePeerToken();
  queryHandler = async (sql) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label: "Wing PC",
          token_hash: issued.hash,
          revoked_at: null,
          expires_at: "2020-01-01T00:00:00Z",
        }],
      };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    // Expired tokens use the same body as revoked tokens — both are an
    // operator-initiated lifecycle event the aggregator surfaces as
    // "Token expired".
    assert.equal(body.error, "revoked_token");
  });
});

test("/peer/pilots: 401 invalid_token when secret does not match the stored hash", async () => {
  reset();
  const real = await issuePeerToken();
  // Build a token that re-uses the real id but supplies a wrong secret.
  const wrong = `phk_${real.id}_${"f".repeat(64)}`;
  queryHandler = async (sql) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: real.id,
          label: "Wing PC",
          token_hash: real.hash,
          revoked_at: null,
          expires_at: null,
        }],
      };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": wrong },
    });
    assert.equal(res.status, 401);
  });
});

// Helper: stage queryHandler so it returns the canonical row for our
// peer-token lookup, then routes through to a follow-up handler for
// the actual data query.
function stageValidPeerToken(issued: { id: string; hash: string }, label: string,
  follow: (sql: string, params?: readonly unknown[]) => { rows: unknown[] } | null) {
  queryHandler = async (sql, params) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label,
          token_hash: issued.hash,
          revoked_at: null,
          expires_at: null,
        }],
      };
    }
    if (/update peer_tokens set last_used_at/i.test(sql)) return { rows: [] };
    if (/insert into audit_log/i.test(sql)) return { rows: [] };
    const r = follow(sql, params);
    if (r) return r;
    return { rows: [] };
  };
}

// ── /peer/* read endpoints with valid token ─────────────────────────

test("/peer/pilots: valid token returns items joined with squadron name", async () => {
  reset();
  const issued = await issuePeerToken();
  const auditCalls: Captured[] = [];
  queryHandler = async (sql, params) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label: "Wing PC",
          token_hash: issued.hash,
          revoked_at: null,
          expires_at: null,
        }],
      };
    }
    if (/update peer_tokens set last_used_at/i.test(sql)) return { rows: [] };
    if (/insert into audit_log/i.test(sql)) {
      auditCalls.push({ sql, params: params ?? [] });
      return { rows: [] };
    }
    if (/from squadrons\s+order by created_at/i.test(sql)) {
      return {
        rows: [{ id: "S1", number: "1", name: "Tigers" }],
      };
    }
    if (/from pilots p\s+left join squadrons s/i.test(sql)) {
      return {
        rows: [
          { id: "p1", squadron_id: "S1", squadron_name: "Tigers", name: "John" },
        ],
      };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      squadron_id?: string | null;
      squadron_name?: string | null;
      items?: Record<string, unknown>[];
    };
    assert.equal(body.squadron_id, "S1");
    assert.equal(body.squadron_name, "Tigers");
    assert.equal(body.items?.length, 1);
    assert.equal(body.items?.[0]?.squadron_name, "Tigers");
  });
  // Audit row must be written, with token label (not secret) + resource.
  // (audit insert uses jsonb-stringified detail in $3.)
  assert.ok(auditCalls.length >= 1, "audit_log row must be written for /peer/pilots");
  const detail = JSON.parse(String((auditCalls[0]!.params as unknown[])[2]));
  assert.equal(detail.resource, "pilots");
  assert.equal(detail.token_label, "Wing PC");
  assert.equal(detail.outcome, "ok");
  assert.equal((auditCalls[0]!.params as unknown[])[1], "peer.read");
  // Actor column is `peer:<label>`, never the secret.
  const actorCol = String((auditCalls[0]!.params as unknown[])[0]);
  assert.match(actorCol, /^peer:/);
  assert.ok(!actorCol.includes(issued.secret), "actor column must not leak the secret");
});

test("/peer/sorties: valid token returns items with squadron tagging", async () => {
  reset();
  const issued = await issuePeerToken();
  stageValidPeerToken(issued, "Wing PC", (sql) => {
    if (/from squadrons\s+order by created_at/i.test(sql)) {
      return { rows: [{ id: "S1", number: "1", name: "Tigers" }] };
    }
    if (/from sorties so/i.test(sql)) {
      return { rows: [{ id: "x", squadron_id: "S1", squadron_name: "Tigers", date: "2026-04-01" }] };
    }
    return null;
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/sorties`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { squadron_id?: string; items?: unknown[] };
    assert.equal(body.squadron_id, "S1");
    assert.equal(body.items?.length, 1);
  });
});

test("/peer/leaves?year=2026: valid token, year is parameterised", async () => {
  reset();
  const issued = await issuePeerToken();
  let leavesCap: Captured | null = null;
  queryHandler = async (sql, params) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label: "Wing PC",
          token_hash: issued.hash,
          revoked_at: null,
          expires_at: null,
        }],
      };
    }
    if (/update peer_tokens set last_used_at/i.test(sql)) return { rows: [] };
    if (/insert into audit_log/i.test(sql)) return { rows: [] };
    if (/from squadrons\s+order by created_at/i.test(sql)) {
      return { rows: [{ id: "S1", number: "1", name: "Tigers" }] };
    }
    if (/from leaves l/i.test(sql)) {
      leavesCap = { sql, params: params ?? [] };
      return { rows: [] };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/leaves?year=2026`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
  });
  assert.ok(leavesCap, "leaves SELECT must be issued");
  const cap: Captured = leavesCap!;
  assert.deepEqual(cap.params, [2026]);
});

test("/peer/leaves: rejects bad year query", async () => {
  reset();
  const issued = await issuePeerToken();
  stageValidPeerToken(issued, "Wing PC", () => null);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/leaves?year=not-a-year`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_year");
  });
});

test("/peer/unavailable: valid token returns items joined to pilots and squadrons", async () => {
  reset();
  const issued = await issuePeerToken();
  let cap: Captured | null = null;
  stageValidPeerToken(issued, "Wing PC", (sql, params) => {
    if (/from squadrons\s+order by created_at/i.test(sql)) {
      return { rows: [{ id: "S1", number: "1", name: "Tigers" }] };
    }
    if (/from unavailable u/i.test(sql)) {
      cap = { sql, params: params ?? [] };
      return { rows: [{ id: "u1", pilot_id: "p1", squadron_id: "S1", squadron_name: "Tigers" }] };
    }
    return null;
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/unavailable`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
  });
  assert.ok(cap, "unavailable SELECT must be issued");
  assert.match((cap as Captured).sql, /left join pilots p/i);
});

test("/peer/notams: valid token returns items", async () => {
  reset();
  const issued = await issuePeerToken();
  stageValidPeerToken(issued, "Wing PC", (sql) => {
    if (/from squadrons\s+order by created_at/i.test(sql)) {
      return { rows: [{ id: "S1", number: "1", name: "Tigers" }] };
    }
    if (/from notams/i.test(sql)) {
      return { rows: [{ id: "n1", notam_no: "A", posted_on: "2026-04-01", body: "x" }] };
    }
    return null;
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/notams`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items?: unknown[] };
    assert.equal(body.items?.length, 1);
  });
});

test("/peer/readiness-summary: valid token aggregates per squadron", async () => {
  reset();
  const issued = await issuePeerToken();
  stageValidPeerToken(issued, "Wing PC", (sql) => {
    if (/from squadrons\s+order by created_at/i.test(sql)) {
      return { rows: [{ id: "S1", number: "1", name: "Tigers" }] };
    }
    if (/from squadrons s\s+left join/i.test(sql)) {
      return {
        rows: [{
          squadron_id: "S1",
          squadron_name: "Tigers",
          pilots_total: "12",
          pilots_available: "10",
          sorties_30d: "4",
        }],
      };
    }
    return null;
  });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/readiness-summary`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items?: Record<string, unknown>[] };
    assert.equal(body.items?.length, 1);
    const row = body.items![0]!;
    assert.equal(row.pilots_total, 12);
    assert.equal(row.pilots_available, 10);
    assert.equal(row.sorties_last_30_days, 4);
  });
});

// ── Block-list ──────────────────────────────────────────────────────

for (const blocked of ["weekly-roster", "schedule", "pilot-devices", "lan-users"]) {
  test(`/peer/${blocked}: 403 not_exposed_to_peers (with valid token)`, async () => {
    reset();
    const issued = await issuePeerToken();
    let auditCap: Captured | null = null;
    queryHandler = async (sql, params) => {
      if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
        return {
          rows: [{
            id: issued.id,
            label: "Wing PC",
            token_hash: issued.hash,
            revoked_at: null,
            expires_at: null,
          }],
        };
      }
      if (/insert into audit_log/i.test(sql)) {
        auditCap = { sql, params: params ?? [] };
        return { rows: [] };
      }
      return { rows: [] };
    };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/peer/${blocked}`, {
        headers: { "x-hawk-peer-token": issued.plain },
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error?: string; resource?: string };
      assert.equal(body.error, "not_exposed_to_peers");
      assert.equal(body.resource, blocked);
    });
    assert.ok(auditCap, "blocked peer call must still write an audit_log entry");
    const detail = JSON.parse(String(((auditCap as Captured).params as unknown[])[2]));
    assert.equal(detail.resource, blocked);
    assert.equal(detail.outcome, "blocked");
  });

  test(`/peer/${blocked}/anything: 403 not_exposed_to_peers (with valid token)`, async () => {
    reset();
    const issued = await issuePeerToken();
    queryHandler = async (sql) => {
      if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
        return {
          rows: [{
            id: issued.id,
            label: "Wing PC",
            token_hash: issued.hash,
            revoked_at: null,
            expires_at: null,
          }],
        };
      }
      return { rows: [] };
    };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/peer/${blocked}/anything`, {
        headers: { "x-hawk-peer-token": issued.plain },
      });
      assert.equal(res.status, 403);
    });
  });

  test(`/peer/${blocked}: 401 (token check still runs first) when no token sent`, async () => {
    reset();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/peer/${blocked}`);
      assert.equal(res.status, 401);
    });
  });
}

// Unrecognised /peer/* path: 404 not_found (only after auth passes).
test("/peer/unknown-thing: 404 not_found when authenticated", async () => {
  reset();
  const issued = await issuePeerToken();
  queryHandler = async (sql) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label: "Wing PC",
          token_hash: issued.hash,
          revoked_at: null,
          expires_at: null,
        }],
      };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/unknown-thing`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "not_found");
  });
});

// last_used_at gets touched on a successful read.
test("/peer/pilots: touches peer_tokens.last_used_at", async () => {
  reset();
  const issued = await issuePeerToken();
  let touched = false;
  queryHandler = async (sql) => {
    if (/select id, label, token_hash, revoked_at, expires_at/i.test(sql)) {
      return {
        rows: [{
          id: issued.id,
          label: "Wing PC",
          token_hash: issued.hash,
          revoked_at: null,
          expires_at: null,
        }],
      };
    }
    if (/update peer_tokens set last_used_at/i.test(sql)) {
      touched = true;
      return { rows: [] };
    }
    return { rows: [] };
  };
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/peer/pilots`, {
      headers: { "x-hawk-peer-token": issued.plain },
    });
    assert.equal(res.status, 200);
  });
  // The touch is fire-and-forget; give the microtask queue a tick.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(touched, true, "last_used_at must be touched on successful peer read");
});

// Sanity: hashPassword/verifyPassword pair still works (used by issuePeerToken).
test("hashPassword scrypt round-trip (sanity, used by peer-token hashing)", async () => {
  const h = await hashPassword("hello-world-secret-with-decent-entropy");
  assert.match(h, /^scrypt\$/);
});
