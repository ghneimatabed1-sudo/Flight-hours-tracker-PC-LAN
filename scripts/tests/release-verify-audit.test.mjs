// End-to-end coverage for the release-verify audit-posting path
// (task #408). The unit + integration tests in api-server prove the
// HTTP endpoint works; this file proves the *script side* defaults
// to localhost (no manual env tweaks needed) and would actually post.
//
// The key acceptance from the code review is "default-on": with NO
// HAWKEYE_RELEASE_VERIFY_AUDIT_URL set, release-verify still resolves
// a sensible URL and, given a system-identity token, hits it.
//
// We exercise:
//   1. resolveReleaseVerifyAuditUrl() — defaults to localhost:3847,
//      honours HAWK_API_PORT override, honours explicit URL override,
//      and treats "off" as the explicit opt-out signal.
//   2. resolveReleaseVerifySystemIdentityToken() — chains through env
//      var → fallback env var → file path (parity with the api-server
//      loader at artifacts/api-server/src/lib/system-identity.ts).
//   3. maybePostAuditRow() — with a token configured but the env URL
//      *unset*, a stub fetch sees exactly one POST land at the
//      localhost default URL with the system-identity header attached
//      and a payload that matches the OpEventSchema validator.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  resolveReleaseVerifyAuditUrl,
  resolveReleaseVerifySystemIdentityToken,
  maybePostAuditRow,
} = await import("../src/release-verify.mjs");

function withEnv(overrides, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── resolveReleaseVerifyAuditUrl ────────────────────────────────

test("resolveReleaseVerifyAuditUrl: defaults to 127.0.0.1:3847/api/internal/audit/op-event", () => {
  withEnv(
    {
      HAWKEYE_RELEASE_VERIFY_AUDIT_URL: undefined,
      HAWK_API_PORT: undefined,
    },
    () => {
      assert.equal(
        resolveReleaseVerifyAuditUrl(),
        "http://127.0.0.1:3847/api/internal/audit/op-event",
      );
    },
  );
});

test("resolveReleaseVerifyAuditUrl: honours HAWK_API_PORT override", () => {
  withEnv(
    {
      HAWKEYE_RELEASE_VERIFY_AUDIT_URL: undefined,
      HAWK_API_PORT: "8080",
    },
    () => {
      assert.equal(
        resolveReleaseVerifyAuditUrl(),
        "http://127.0.0.1:8080/api/internal/audit/op-event",
      );
    },
  );
});

test("resolveReleaseVerifyAuditUrl: explicit URL wins over default", () => {
  withEnv(
    {
      HAWKEYE_RELEASE_VERIFY_AUDIT_URL:
        "http://hub.lan:3000/api/internal/audit/op-event",
      HAWK_API_PORT: "3847",
    },
    () => {
      assert.equal(
        resolveReleaseVerifyAuditUrl(),
        "http://hub.lan:3000/api/internal/audit/op-event",
      );
    },
  );
});

// ── resolveReleaseVerifySystemIdentityToken ─────────────────────

test("resolveReleaseVerifySystemIdentityToken: HAWK_… (canonical) wins over HAWKEYE_… (legacy alias)", () => {
  // Pinning the canonical-first order matches the api-server loader at
  // artifacts/api-server/src/lib/system-identity.ts and the PowerShell
  // resolver in scripts/lan-host/verify-backup.ps1. Drift here would
  // mean release-verify could send a token the server rejects, leaving
  // a silent audit gap for that run.
  const realWarn = console.warn;
  const warns = [];
  console.warn = (msg) => warns.push(String(msg));
  try {
    withEnv(
      {
        HAWK_SYSTEM_IDENTITY_TOKEN: "tok-from-hawk-env",
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: "tok-from-hawkeye-env",
        HAWK_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
        HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
      },
      () => {
        assert.equal(
          resolveReleaseVerifySystemIdentityToken(),
          "tok-from-hawk-env",
        );
      },
    );
    assert.ok(
      warns.some((w) => /both set to different values/i.test(w)),
      "expected a precedence-warning when canonical and legacy disagree",
    );
  } finally {
    console.warn = realWarn;
  }
});

test("resolveReleaseVerifySystemIdentityToken: HAWKEYE_… (legacy alias) is honored when canonical is unset", () => {
  withEnv(
    {
      HAWK_SYSTEM_IDENTITY_TOKEN: undefined,
      HAWKEYE_SYSTEM_IDENTITY_TOKEN: "tok-from-hawkeye-env",
      HAWK_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
      HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
    },
    () => {
      assert.equal(
        resolveReleaseVerifySystemIdentityToken(),
        "tok-from-hawkeye-env",
      );
    },
  );
});

test("resolveReleaseVerifySystemIdentityToken: same value in canonical + legacy does NOT warn", () => {
  const realWarn = console.warn;
  const warns = [];
  console.warn = (msg) => warns.push(String(msg));
  try {
    withEnv(
      {
        HAWK_SYSTEM_IDENTITY_TOKEN: "same-token",
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: "same-token",
        HAWK_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
        HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
      },
      () => {
        assert.equal(resolveReleaseVerifySystemIdentityToken(), "same-token");
      },
    );
    assert.equal(
      warns.filter((w) => /both set to different values/i.test(w)).length,
      0,
      "should not warn when canonical and legacy are equal",
    );
  } finally {
    console.warn = realWarn;
  }
});

test("resolveReleaseVerifySystemIdentityToken: falls back to file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "hawk-rv-token-"));
  const file = join(dir, "system-identity.token");
  writeFileSync(file, "tok-from-file\n", "utf8");
  try {
    withEnv(
      {
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: undefined,
        HAWK_SYSTEM_IDENTITY_TOKEN: undefined,
        HAWK_SYSTEM_IDENTITY_TOKEN_FILE: file,
        HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
      },
      () => {
        assert.equal(
          resolveReleaseVerifySystemIdentityToken(),
          "tok-from-file",
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveReleaseVerifySystemIdentityToken: returns empty string when nothing is configured", () => {
  withEnv(
    {
      HAWKEYE_SYSTEM_IDENTITY_TOKEN: undefined,
      HAWK_SYSTEM_IDENTITY_TOKEN: undefined,
      HAWK_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
      HAWKEYE_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
    },
    () => {
      assert.equal(resolveReleaseVerifySystemIdentityToken(), "");
    },
  );
});

// ── maybePostAuditRow (default-on end-to-end) ───────────────────

test("maybePostAuditRow: default-on — posts to 127.0.0.1 when only the token is set", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await withEnv(
      {
        HAWKEYE_RELEASE_VERIFY_AUDIT_URL: undefined,
        HAWK_API_PORT: undefined,
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: "tok-default-on",
      },
      async () => {
        await maybePostAuditRow({
          date: "2026-04-30",
          verdict: { tag: "GREEN", recommendation: "ship it" },
          results: [
            { slug: "typecheck", label: "Typecheck", exitCode: 0, durationMs: 1000 },
            { slug: "playwright", label: "Playwright", exitCode: 0, durationMs: 5000 },
          ],
          drifts: [],
          baselineInitialized: false,
          evidenceDir: "/tmp/release-evidence/2026-04-30",
          reportPath: "/tmp/HAWKEYE-RELEASE-REPORT-2026-04-30.md",
          overallStartedAt: "2026-04-30T08:00:00Z",
          overallEndedAt: "2026-04-30T08:01:00Z",
        });
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1, "expected exactly one POST");
  const [call] = calls;
  assert.equal(
    call.url,
    "http://127.0.0.1:3847/api/internal/audit/op-event",
    "default URL should be the local hub api-server",
  );
  assert.equal(call.init.method, "POST");
  assert.equal(
    call.init.headers["x-hawk-system-identity"],
    "tok-default-on",
    "system-identity token must be on the wire",
  );
  const body = JSON.parse(call.init.body);
  assert.equal(body.event_type, "op.release_verify");
  assert.equal(body.outcome, "success");
  assert.equal(body.actor_username, "system:release-verify");
  assert.match(body.summary, /GREEN/);
  assert.equal(body.details.counts.passed, 2);
  assert.equal(body.details.counts.failed, 0);
});

test("maybePostAuditRow: HAWKEYE_RELEASE_VERIFY_AUDIT_URL=off is the explicit opt-out", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  try {
    await withEnv(
      {
        HAWKEYE_RELEASE_VERIFY_AUDIT_URL: "off",
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: "tok-anything",
      },
      async () => {
        await maybePostAuditRow({
          date: "2026-04-30",
          verdict: { tag: "GREEN", recommendation: "" },
          results: [],
          drifts: [],
          baselineInitialized: false,
          evidenceDir: "/tmp/x",
          reportPath: "/tmp/x.md",
          overallStartedAt: "2026-04-30T08:00:00Z",
          overallEndedAt: "2026-04-30T08:00:01Z",
        });
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(called, false, "opt-out must short-circuit before fetch");
});

test("maybePostAuditRow: when no token configured, logs a warning and does NOT call fetch", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  try {
    await withEnv(
      {
        HAWKEYE_RELEASE_VERIFY_AUDIT_URL: undefined,
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: undefined,
        HAWK_SYSTEM_IDENTITY_TOKEN: undefined,
        HAWK_SYSTEM_IDENTITY_TOKEN_FILE: undefined,
      },
      async () => {
        await maybePostAuditRow({
          date: "2026-04-30",
          verdict: { tag: "GREEN", recommendation: "" },
          results: [],
          drifts: [],
          baselineInitialized: false,
          evidenceDir: "/tmp/x",
          reportPath: "/tmp/x.md",
          overallStartedAt: "2026-04-30T08:00:00Z",
          overallEndedAt: "2026-04-30T08:00:01Z",
        });
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(called, false, "no token → no fetch (best-effort)");
});

// ── True end-to-end: release-verify → real api-server → audit_log ─

test("end-to-end: release-verify default URL hits the real api-server and writes an audit_log INSERT", async () => {
  // Stand up the actual hub Express app, stub the pg pool, then
  // override release-verify's HAWK_API_PORT to point at the bound
  // port. With no HAWKEYE_RELEASE_VERIFY_AUDIT_URL set and only the
  // system-identity token configured, the default URL should land
  // at this server and the route should write one audit_log INSERT.
  process.env.DATABASE_URL ??= "postgres://stub:stub@127.0.0.1:1/stub";
  process.env.HAWK_INTERNAL_SESSION_AUTH = "required";
  process.env.HAWK_SYSTEM_IDENTITY_TOKEN = "e2e-token-abcdefghijklmnop";

  const { pool } = await import("../../lib/db/src/index.ts");
  const queryCalls = [];
  pool.query = async (sql, params = []) => {
    queryCalls.push({ sql, params });
    return { rows: [], rowCount: 0 };
  };

  const { buildRouter } = await import(
    "../../artifacts/api-server/src/routes/index.ts"
  );
  const { setActiveInstallProfile, _resetActiveInstallProfileForTests } =
    await import(
      "../../artifacts/api-server/src/lib/install-profile.ts"
    );
  const { __resetSystemIdentityCache } = await import(
    "../../artifacts/api-server/src/lib/system-identity.ts"
  );
  __resetSystemIdentityCache();

  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  setActiveInstallProfile("hub");
  const app = express();
  app.use(express.json());
  app.use("/api", buildRouter("hub"));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await withEnv(
      {
        HAWKEYE_RELEASE_VERIFY_AUDIT_URL: undefined,
        HAWK_API_PORT: String(port),
        HAWKEYE_SYSTEM_IDENTITY_TOKEN: "e2e-token-abcdefghijklmnop",
      },
      async () => {
        await maybePostAuditRow({
          date: "2026-04-30",
          verdict: { tag: "AMBER", recommendation: "review drifts" },
          results: [
            { slug: "typecheck", label: "Typecheck", exitCode: 0, durationMs: 100 },
          ],
          drifts: [
            {
              profile: "hub",
              role_slug: "super_admin",
              label: "audit-log-page",
              before: "pass",
              after: "drift",
            },
          ],
          baselineInitialized: false,
          evidenceDir: "/tmp/release-evidence/2026-04-30",
          reportPath: "/tmp/HAWKEYE-RELEASE-REPORT-2026-04-30.md",
          overallStartedAt: "2026-04-30T08:00:00Z",
          overallEndedAt: "2026-04-30T08:01:00Z",
        });
      },
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    _resetActiveInstallProfileForTests();
  }

  const inserts = queryCalls.filter((c) =>
    /insert\s+into\s+audit_log/i.test(c.sql),
  );
  assert.equal(
    inserts.length,
    1,
    `expected exactly one audit_log INSERT to land, got ${inserts.length}`,
  );
  const [actor, type, detailJson] = inserts[0].params;
  assert.equal(type, "op.release_verify");
  // The script supplies actor_username="system:release-verify" so the
  // operator can grep by caller. (`appendInternalAudit` only rewrites
  // a literal "system" / empty actor to "unknown".)
  assert.equal(actor, "system:release-verify");
  const detail = JSON.parse(detailJson);
  assert.equal(detail.outcome, "partial"); // AMBER → partial
  // relFromRepo() in release-verify rewrites absolute paths into
  // repo-relative form. We just assert the tail so the test isn't
  // brittle across different repo roots.
  assert.match(detail.evidence_path, /release-evidence\/2026-04-30$/);
});
