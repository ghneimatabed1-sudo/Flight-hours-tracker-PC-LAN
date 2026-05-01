// Unit + route-level coverage for the op.* audit-log expansion (task #408).
//
// Approach: stub the underlying `pool.query` so we can drive
// `appendInternalAudit` without a real Postgres, then exercise:
//
//   * `validateOpAuditEvent` — input validation rules,
//   * `recordOpAuditEvent`   — payload shaping + best-effort insert,
//   * `verifySystemIdentityToken` — constant-time compare + missing
//     token fail-closed behaviour,
//   * the `POST /audit/op-event` route — auth gating (super_admin OR
//     system-identity header) and basic happy/error paths.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Make sure the system-identity loader can resolve a token in test
// before any module that caches it gets imported.
process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "test-token-01234567890123456789";
process.env.INTERNAL_WRITE_SECRET ??= "test-secret";
process.env.HAWK_INTERNAL_SESSION_AUTH = "required"; // force real session check (canonical token)
// `@workspace/db` reads DATABASE_URL eagerly at import time. Provide a
// dummy value so the `new Pool({ ... })` constructor doesn't reach the
// network — we replace `.query` with our stub immediately after import.
process.env.DATABASE_URL ??= "postgres://stub:stub@127.0.0.1:1/stub";

// ──────────────────────────────────────────────────────────────────
// Stub the pg pool BEFORE importing any module that uses it. The
// real pool reaches for $DATABASE_URL on import which we don't have.
// ──────────────────────────────────────────────────────────────────

type QueryCall = { sql: string; params: ReadonlyArray<unknown> };
const queryCalls: QueryCall[] = [];
let queryImpl: (sql: string, params: ReadonlyArray<unknown>) => Promise<unknown> = async () => ({
  rows: [],
  rowCount: 0,
});

const dbModule = await import("@workspace/db");
const stubPool = {
  query: async (sql: string, params: ReadonlyArray<unknown> = []) => {
    queryCalls.push({ sql, params });
    return queryImpl(sql, params);
  },
};
// Drizzle-adjacent fields are read at import time elsewhere — but
// `appendInternalAudit` only ever touches `pool.query`, so reaching
// in and replacing the bound `query` is enough.
(dbModule.pool as unknown as { query: typeof stubPool.query }).query =
  stubPool.query;

const { recordOpAuditEvent, validateOpAuditEvent } = await import(
  "../src/lib/audit-log"
);
const {
  verifySystemIdentityToken,
  __resetSystemIdentityCache,
  getSystemIdentityHeaderName,
} = await import("../src/lib/system-identity");
const internalAuditRouter = (await import("../src/routes/internal-audit")).default;

before(() => {
  __resetSystemIdentityCache();
});

after(() => {
  delete process.env.HAWK_SYSTEM_IDENTITY_TOKEN;
});

function resetCalls() {
  queryCalls.length = 0;
  queryImpl = async () => ({ rows: [], rowCount: 0 });
}

// ── validateOpAuditEvent ────────────────────────────────────────

test("validateOpAuditEvent: accepts a fully-formed payload", () => {
  const err = validateOpAuditEvent({
    event_type: "op.release_verify",
    outcome: "success",
    summary: "GREEN — 7 pass / 0 fail / 0 skip",
    details: { passed: 7 },
  });
  assert.equal(err, null);
});

test("validateOpAuditEvent: rejects non-op event_type", () => {
  const err = validateOpAuditEvent({
    event_type: "internal.foo",
    outcome: "success",
    summary: "x",
  });
  assert.equal(err, "event_type_must_start_with_op");
});

test("validateOpAuditEvent: rejects bad outcome enum", () => {
  const err = validateOpAuditEvent({
    event_type: "op.backup_run",
    // @ts-expect-error — intentionally bad enum value
    outcome: "ok",
    summary: "x",
  });
  assert.equal(err, "outcome_invalid");
});

test("validateOpAuditEvent: rejects empty summary", () => {
  const err = validateOpAuditEvent({
    event_type: "op.backup_run",
    outcome: "success",
    summary: "   ",
  });
  assert.equal(err, "summary_required");
});

test("validateOpAuditEvent: rejects array details", () => {
  const err = validateOpAuditEvent({
    event_type: "op.backup_run",
    outcome: "success",
    summary: "x",
    // @ts-expect-error — intentionally wrong shape
    details: [1, 2, 3],
  });
  assert.equal(err, "details_must_be_object");
});

// ── recordOpAuditEvent ──────────────────────────────────────────

test("recordOpAuditEvent: writes one INSERT with merged detail JSON", async () => {
  resetCalls();
  await recordOpAuditEvent({
    event_type: "op.backup_run",
    outcome: "success",
    summary: "backup-postgres.ps1 completed successfully",
    actor_username: "local.admin",
    actor_user_id: "user-abc",
    evidence_path: "C:/Backups/2026-04-30.dump",
    details: { exit_code: 0, duration_ms: 12345, script: "backup-postgres.ps1" },
  });
  // appendInternalAudit emits a single INSERT INTO audit_log statement.
  const inserts = queryCalls.filter(c => /insert\s+into\s+audit_log/i.test(c.sql));
  assert.equal(inserts.length, 1, `expected 1 insert, got ${inserts.length}`);
  const [actor, type, detailJson] = inserts[0]!.params as [string, string, string];
  assert.equal(actor, "local.admin");
  assert.equal(type, "op.backup_run");
  const parsed = JSON.parse(detailJson);
  assert.equal(parsed.outcome, "success");
  assert.equal(parsed.exit_code, 0);
  assert.equal(parsed.evidence_path, "C:/Backups/2026-04-30.dump");
  assert.equal(parsed.actor_user_id, "user-abc");
  assert.equal(parsed.summary, "backup-postgres.ps1 completed successfully");
});

test("recordOpAuditEvent: marks actor 'unknown' + actor_unknown=true when no username", async () => {
  // `appendInternalAudit` deliberately rewrites a "system" actor to
  // the literal "unknown" with `actor_unknown: true` in detail so the
  // operator can grep for un-attributed writes. We rely on that
  // behaviour, so this test pins it down.
  resetCalls();
  await recordOpAuditEvent({
    event_type: "op.verify_backup_run",
    outcome: "failure",
    summary: "Verification failed",
  });
  const inserts = queryCalls.filter(c => /insert\s+into\s+audit_log/i.test(c.sql));
  assert.equal(inserts.length, 1);
  const [actor, , detailJson] = inserts[0]!.params as [string, string, string];
  assert.equal(actor, "unknown");
  const parsed = JSON.parse(detailJson);
  assert.equal(parsed.actor_unknown, true);
  assert.equal(parsed.outcome, "failure");
});

test("recordOpAuditEvent: throws on validation failure (no insert)", async () => {
  resetCalls();
  await assert.rejects(
    () =>
      recordOpAuditEvent({
        event_type: "internal.bad",
        outcome: "success",
        summary: "x",
      }),
    /event_type_must_start_with_op/,
  );
  assert.equal(queryCalls.length, 0);
});

test("recordOpAuditEvent: silently swallows 'audit_log table missing' window", async () => {
  resetCalls();
  // Mimic the shape appendInternalAudit recognises as the
  // pre-ensureFullSchema race condition.
  queryImpl = async () => {
    const err = new Error('relation "audit_log" does not exist') as Error & {
      code?: string;
    };
    err.code = "42P01";
    throw err;
  };
  await assert.doesNotReject(() =>
    recordOpAuditEvent({
      event_type: "op.backup_run",
      outcome: "success",
      summary: "x",
    }),
  );
});

// ── verifySystemIdentityToken ───────────────────────────────────

test("verifySystemIdentityToken: accepts the configured token", () => {
  __resetSystemIdentityCache();
  process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "test-token-01234567890123456789";
  assert.equal(verifySystemIdentityToken("test-token-01234567890123456789"), true);
});

test("verifySystemIdentityToken: rejects mismatched / empty / missing tokens", () => {
  __resetSystemIdentityCache();
  process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "test-token-01234567890123456789";
  assert.equal(verifySystemIdentityToken("wrong"), false);
  assert.equal(verifySystemIdentityToken(""), false);
  assert.equal(verifySystemIdentityToken(null), false);
  assert.equal(verifySystemIdentityToken(undefined), false);
});

test("verifySystemIdentityToken: fails closed when no token configured", () => {
  __resetSystemIdentityCache();
  delete process.env.HAWK_SYSTEM_IDENTITY_TOKEN;
  delete process.env.HAWK_SYSTEM_IDENTITY_TOKEN_FILE;
  delete process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN;
  delete process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE;
  assert.equal(verifySystemIdentityToken("anything"), false);
  // restore for downstream tests
  process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "test-token-01234567890123456789";
  __resetSystemIdentityCache();
});

test("verifySystemIdentityToken: HAWK_SYSTEM_IDENTITY_TOKEN wins over HAWKEYE_ legacy alias", () => {
  // The api-server prefers the canonical HAWK_ name but falls back to
  // the legacy HAWKEYE_ alias so installers / CI configs that already
  // set the older name continue to work. This pins the precedence and
  // matches the same chain in scripts/src/release-verify.mjs and
  // scripts/lan-host/verify-backup.ps1.
  __resetSystemIdentityCache();
  process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "canonical-token-1234567890";
  process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN = "legacy-token-9876543210";
  assert.equal(verifySystemIdentityToken("canonical-token-1234567890"), true);
  assert.equal(verifySystemIdentityToken("legacy-token-9876543210"), false);
  delete process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN;
  __resetSystemIdentityCache();
});

test("verifySystemIdentityToken: falls back to HAWKEYE_SYSTEM_IDENTITY_TOKEN when canonical is unset", () => {
  __resetSystemIdentityCache();
  delete process.env.HAWK_SYSTEM_IDENTITY_TOKEN;
  process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN = "legacy-token-9876543210";
  assert.equal(verifySystemIdentityToken("legacy-token-9876543210"), true);
  // restore
  delete process.env.HAWKEYE_SYSTEM_IDENTITY_TOKEN;
  process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "test-token-01234567890123456789";
  __resetSystemIdentityCache();
});

// ── POST /audit/op-event route ──────────────────────────────────

type FakeReq = {
  method: string;
  url: string;
  path: string;
  originalUrl: string;
  baseUrl: string;
  body: unknown;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  get(name: string): string | undefined;
  app: { get: () => undefined };
};

type FakeRes = {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  setHeader(): FakeRes;
};

function makeReq(opts: {
  body: unknown;
  headers?: Record<string, string>;
}): FakeReq {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  return {
    method: "POST",
    url: "/audit/op-event",
    path: "/audit/op-event",
    originalUrl: "/internal/audit/op-event",
    baseUrl: "/internal",
    body: opts.body,
    headers,
    cookies: {},
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    app: { get: () => undefined },
  };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res;
}

async function dispatch(req: FakeReq, res: FakeRes): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (internalAuditRouter as any).handle(req, res, (err?: unknown) => {
      if (err) reject(err);
      else resolve();
    });
    // Resolve once the route handler invokes res.json — the route
    // is async, so poll briefly in case the test races the handler.
    const start = Date.now();
    const tick = () => {
      if (res.body !== undefined) return resolve();
      if (Date.now() - start > 2000) return reject(new Error("route timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("POST /audit/op-event: 401 without auth (LAN session gate runs inline when no token)", async () => {
  // With session auth in 'required' mode and no system-identity token,
  // the route hands off to requireInternalLanSession, which rejects
  // with `lan_session_required` BEFORE the role check ever runs. The
  // role-check 403 path is exercised by the integration tests against
  // a real super_admin/non-super_admin LAN session.
  resetCalls();
  __resetSystemIdentityCache();
  const req = makeReq({
    body: {
      event_type: "op.backup_run",
      outcome: "success",
      summary: "x",
    },
  });
  const res = makeRes();
  await dispatch(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "lan_session_required" });
  // No audit_log INSERT was attempted.
  assert.equal(
    queryCalls.filter((c) => /insert\s+into\s+audit_log/i.test(c.sql)).length,
    0,
  );
});

test("POST /audit/op-event: accepts a valid system-identity header", async () => {
  resetCalls();
  __resetSystemIdentityCache();
  const req = makeReq({
    body: {
      event_type: "op.release_verify",
      outcome: "success",
      summary: "GREEN — 7 pass / 0 fail / 0 skip",
      details: { passed: 7 },
    },
    headers: {
      [getSystemIdentityHeaderName()]: "test-token-01234567890123456789",
    },
  });
  const res = makeRes();
  await dispatch(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  const inserts = queryCalls.filter(c => /insert\s+into\s+audit_log/i.test(c.sql));
  assert.equal(inserts.length, 1);
  const [actor, type, detailJson] = inserts[0]!.params as [string, string, string];
  assert.equal(type, "op.release_verify");
  // No LAN session, no actor_username — `appendInternalAudit` writes
  // actor='unknown' + actor_unknown=true so the operator can grep for
  // un-attributed entries later.
  assert.equal(actor, "unknown");
  const detail = JSON.parse(detailJson);
  assert.equal(detail.actor_unknown, true);
  assert.equal(detail.outcome, "success");
});

test("POST /audit/op-event: 400 on malformed payload", async () => {
  resetCalls();
  const req = makeReq({
    body: { event_type: "op.backup_run" /* missing outcome+summary */ },
    headers: {
      [getSystemIdentityHeaderName()]: "test-token-01234567890123456789",
    },
  });
  const res = makeRes();
  await dispatch(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_op_event_payload" });
  assert.equal(queryCalls.length, 0);
});

test("POST /audit/op-event: 400 when event_type is not op.*", async () => {
  resetCalls();
  const req = makeReq({
    body: {
      event_type: "internal.fake",
      outcome: "success",
      summary: "x",
    },
    headers: {
      [getSystemIdentityHeaderName()]: "test-token-01234567890123456789",
    },
  });
  const res = makeRes();
  await dispatch(req, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    ok: false,
    error: "event_type_must_start_with_op",
  });
});
