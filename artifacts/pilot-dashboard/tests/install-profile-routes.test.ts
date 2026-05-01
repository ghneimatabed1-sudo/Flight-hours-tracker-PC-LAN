// Pins the four-PC install topology: which /api/* surfaces are mounted
// per profile, and that resolveInstallProfile rejects garbage.

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";

import { pool } from "../../../lib/db/src/index";
import { buildRouter } from "../../api-server/src/routes/index";
import {
  resolveInstallProfile,
  setActiveInstallProfile,
  _resetActiveInstallProfileForTests,
  type InstallProfile,
} from "../../api-server/src/lib/install-profile";

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async () => ({ rows: [] });

function makeApp(profile: InstallProfile): Express {
  setActiveInstallProfile(profile);
  const app = express();
  app.use(express.json());
  app.use("/api", buildRouter(profile));
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });
  return app;
}

async function withServer<T>(
  profile: InstallProfile,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const app = makeApp(profile);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind smoke-test server");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _resetActiveInstallProfileForTests();
  }
}

test("resolveInstallProfile: defaults to hub when env is unset or empty", () => {
  assert.equal(resolveInstallProfile(undefined), "hub");
  assert.equal(resolveInstallProfile(""), "hub");
  assert.equal(resolveInstallProfile("   "), "hub");
});

test("resolveInstallProfile: accepts every documented profile", () => {
  assert.equal(resolveInstallProfile("hub"), "hub");
  assert.equal(resolveInstallProfile("HUB"), "hub");
  assert.equal(resolveInstallProfile("aggregator-wing"), "aggregator-wing");
  assert.equal(resolveInstallProfile("aggregator-base"), "aggregator-base");
  assert.equal(resolveInstallProfile("viewer"), "viewer");
});

test("resolveInstallProfile: rejects unknown values", () => {
  assert.throws(() => resolveInstallProfile("commander"), /Invalid INSTALL_PROFILE/);
  assert.throws(() => resolveInstallProfile("hub-extra"), /Invalid INSTALL_PROFILE/);
});

test("buildRouter: viewer profile throws (no backend lives there)", () => {
  assert.throws(() => buildRouter("viewer"), /viewer install profile has no backend/);
});

for (const profile of ["hub", "aggregator-wing", "aggregator-base"] as const) {
  test(`GET /api/healthz on ${profile}: 200 + reports active profile`, async () => {
    await withServer(profile, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status?: string; installProfile?: string };
      assert.equal(body.status, "ok");
      assert.equal(body.installProfile, profile);
    });
  });
}

test("hub: /api/internal/* requires LAN session (401 when missing)", async () => {
  await withServer("hub", async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/internal/auth/lan/me`);
    assert.equal(res.status, 401);
  });
});

test("hub: /api/internal/lan-broadcast/restart is mounted (#403)", async () => {
  // Stand up the hub router with internal session auth disabled so
  // the super_admin gate short-circuits — same dev/bring-up
  // convention every other internal route uses. On Linux CI the
  // endpoint should return 503 (no schtasks); on Windows it would
  // attempt the actual restart. We just assert the route is wired,
  // not that schtasks succeeds.
  const prev = process.env["HAWK_INTERNAL_SESSION_AUTH"];
  process.env["HAWK_INTERNAL_SESSION_AUTH"] = "off";
  try {
    await withServer("hub", async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/internal/lan-broadcast/restart`, {
        method: "POST",
      });
      // On the Linux test host: 503 schtasks_unavailable_non_windows.
      // On a Windows CI host (rare): 200/500 with an exit code body.
      // Both prove the route handler exists.
      assert.notEqual(res.status, 404,
        "lan-broadcast/restart must be mounted under /api/internal");
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (process.platform !== "win32") {
        assert.equal(res.status, 503);
        assert.equal(body.error, "schtasks_unavailable_non_windows");
      }
    });
  } finally {
    if (prev === undefined) delete process.env["HAWK_INTERNAL_SESSION_AUTH"];
    else process.env["HAWK_INTERNAL_SESSION_AUTH"] = prev;
  }
});

test("hub: /api/peer/* mounts and rejects requests with no peer token (401)", async () => {
  await withServer("hub", async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/peer/pilots`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    // The peer middleware in `routes/peer-shell.ts` returns
    // `invalid_token` for missing/garbage headers. The legacy body
    // `invalid_peer_token` is still emitted by some sub-routes and
    // is treated as the same `auth_invalid` kind by the aggregator
    // (see peer-fanout.ts::classifyHttpError). Either one is a
    // valid "no peer auth" rejection.
    assert.ok(
      body.error === "invalid_token" || body.error === "invalid_peer_token",
      `expected invalid_token or invalid_peer_token, got ${body.error}`,
    );
  });
});

test("hub: /api/aggregate/* is NOT mounted (404)", async () => {
  await withServer("hub", async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/aggregate/anything`);
    assert.equal(res.status, 404);
  });
});

for (const profile of ["aggregator-wing", "aggregator-base"] as const) {
  test(`${profile}: /api/aggregate/* shell mounts and returns 404 surface for unknown subpaths`, async () => {
    await withServer(profile, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/aggregate/anything`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: string; surface?: string };
      assert.equal(body.error, "not_found");
      assert.equal(body.surface, "aggregate");
    });
  });

  test(`${profile}: /api/aggregate/peers exposes the address book`, async () => {
    await withServer(profile, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/aggregate/peers`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items?: unknown[] };
      assert.ok(Array.isArray(body.items));
    });
  });

  test(`${profile}: /api/internal/* is NOT mounted (404)`, async () => {
    await withServer(profile, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/internal/auth/lan/me`);
      assert.equal(res.status, 404);
    });
  });

  test(`${profile}: /api/peer/* is NOT mounted (404)`, async () => {
    await withServer(profile, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/peer/anything`);
      assert.equal(res.status, 404);
    });
  });
}
