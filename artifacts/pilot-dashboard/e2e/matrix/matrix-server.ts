// Per-cell stub server used by the role × profile × scenario Playwright
// matrix runner (task #361).
//
// Boots an Express app that:
//   - mounts the real `buildRouter(profile)` from api-server (so route
//     surfaces, role gates, install-profile mounting and the LAN session
//     middleware are all the production code paths)
//   - serves the prebuilt dashboard SPA (under `dist-matrix/public/`)
//     so a real Chromium can render the landing page
//   - replaces the @workspace/db pool.query with a deterministic stub
//     so no real Postgres is needed for the sweep
//
// One process owns at most a single "active actor" at a time — the spec
// switches it out between cells via `setActiveActor()`. The mocked
// `lan_sessions s join lan_users u …` lookup is what the real
// `requireInternalLanSession` middleware fires; we hand back the active
// actor whenever a session-token-shaped query comes in, so any non-empty
// `x-hawk-lan-session` header authenticates as that actor.

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
// Force the production-shaped LAN session middleware path so the bearer
// token in the dashboard's localStorage drives auth (instead of the
// "off → next()" dev shortcut).
process.env.HAWK_INTERNAL_SESSION_AUTH = "required";

import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { pool } from "../../../../lib/db/src/index";
import { buildRouter } from "../../../api-server/src/routes/index";
import {
  setActiveInstallProfile,
  type InstallProfile,
} from "../../../api-server/src/lib/install-profile";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Actor = {
  username: string;
  displayName: string;
  /** Raw LAN role string, e.g. "super_admin", "ops", "commander_squadron". */
  role: string;
  squadronId: string | null;
  wingId: string | null;
  baseId: string | null;
};

let activeActor: Actor | null = null;

export function setActiveActor(actor: Actor | null): void {
  activeActor = actor;
}

export function getActiveActor(): Actor | null {
  return activeActor;
}

// ── Stub pool.query ─────────────────────────────────────────────────
// Recognises just the queries fired by the `/api/healthz`, LAN session
// middleware and `/api/internal/auth/lan/me` paths. Every other query
// returns an empty result set — the dashboard tolerates empty data and
// the matrix run only needs the SPA to land + per-endpoint statuses.

const queryLog: Array<{ sql: string; params: readonly unknown[] }> = [];

(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query =
  async (sqlRaw: string, paramsRaw?: readonly unknown[]) => {
    const sql = String(sqlRaw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const params = (paramsRaw ?? []) as readonly unknown[];
    queryLog.push({ sql, params });

    // LAN session lookup (from lan-auth-middleware AND /auth/lan/me).
    // The middleware selects user_id/username/display_name/role/
    // squadron_id/wing_id/base_id; the route selects a slightly smaller
    // shape. We satisfy both by returning every column.
    if (
      sql.includes("from lan_sessions s") &&
      sql.includes("join lan_users u")
    ) {
      const token = String(params[0] ?? "");
      if (!token || !activeActor) return { rows: [] };
      return {
        rows: [
          {
            user_id: `u-${activeActor.username}`,
            username: activeActor.username,
            display_name: activeActor.displayName,
            role: activeActor.role,
            squadron_id: activeActor.squadronId,
            wing_id: activeActor.wingId,
            base_id: activeActor.baseId,
          },
        ],
      };
    }

    // Setup wizard / squadron-airframes route checks how many lan_users
    // exist before opening up the no-actor path. Pretend bring-up is
    // already done so the rest of the role gates apply.
    if (sql.includes("count(*)") && sql.includes("from lan_users")) {
      return { rows: [{ c: 1 }] };
    }

    // Default: behave like an empty Postgres so unguarded reads return
    // []/0 rather than crashing.
    return { rows: [] };
  };

export function drainQueryLog(): Array<{ sql: string; params: readonly unknown[] }> {
  const out = queryLog.slice();
  queryLog.length = 0;
  return out;
}

// ── Server lifecycle ───────────────────────────────────────────────

export interface MatrixServerHandle {
  url: string;
  profile: InstallProfile;
  close(): Promise<void>;
}

function resolveDistDir(): string {
  return path.resolve(__dirname, "..", "..", "dist-matrix", "public");
}

export async function startMatrixServer(
  profile: InstallProfile,
): Promise<MatrixServerHandle> {
  setActiveInstallProfile(profile);

  const distDir = resolveDistDir();
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error(
      `[matrix-server] missing build at ${distDir}/index.html ` +
        `— run \`pnpm --filter @workspace/pilot-dashboard exec tsx ` +
        `e2e/matrix/build-dashboard.mjs\` (the matrix script does this ` +
        `automatically before tests).`,
    );
  }

  const app: Express = express();
  app.use(express.json());

  // Mount the real api-server router only for profiles that have a
  // backend. The viewer profile intentionally has no /api/* routes —
  // the dashboard's healthz probe will 404 and the install-profile
  // detector will fall back to "hub", which mirrors how viewer PCs
  // behave in production when their remote backend is unreachable.
  if (profile !== "viewer") {
    app.use("/api", buildRouter(profile));
  }

  // Static SPA + SPA fallback.
  app.use(
    express.static(distDir, {
      index: "index.html",
      cacheControl: false,
      etag: false,
      lastModified: false,
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });

  // Final 404 — used for /api/* on viewer and for unknown POSTs.
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("[matrix-server] failed to bind");
  }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    profile,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
