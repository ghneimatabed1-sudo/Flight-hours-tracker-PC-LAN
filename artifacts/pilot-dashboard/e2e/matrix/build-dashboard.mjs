// One-shot dashboard build for the role × profile × scenario Playwright
// matrix runner (task #361).
//
// The regular `pnpm --filter @workspace/pilot-dashboard run build` is
// driven by the production deployment flow and writes to
// `artifacts/pilot-dashboard/dist/public/` — clobbering it from the
// matrix harness would be hostile to that flow. So we build a parallel
// bundle into `dist-matrix/public/` with two extra Vite envs:
//
//   VITE_LAN_SESSION_LOGIN=1      — opt the SPA into the LAN session
//                                    auth provider (token in localStorage,
//                                    `GET /api/internal/auth/lan/me`).
//   VITE_INTERNAL_API_URL=/       — same-origin API base, so the SPA
//                                    talks to the Express harness
//                                    serving it.
//
// Re-runs are skipped when `dist-matrix/public/index.html` already
// exists; pass `MATRIX_FORCE_BUILD=1` to force a rebuild after dashboard
// source changes.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashRoot = path.resolve(here, "..", "..");
const outDir = path.resolve(dashRoot, "dist-matrix", "public");
const indexHtml = path.join(outDir, "index.html");

if (process.env.MATRIX_FORCE_BUILD !== "1" && existsSync(indexHtml)) {
  console.log(
    `[matrix:build-dashboard] skipping rebuild — ${indexHtml} already exists ` +
      `(set MATRIX_FORCE_BUILD=1 to force).`,
  );
  process.exit(0);
}

console.log(
  "[matrix:build-dashboard] building dashboard with VITE_LAN_SESSION_LOGIN=1 " +
    "into dist-matrix/public/ …",
);

const env = {
  ...process.env,
  NODE_ENV: "production",
  // vite.config.ts hard-requires PORT and BASE_PATH at config-load time
  // even for `vite build`; supply throwaway values that satisfy the check.
  PORT: process.env.PORT || "9999",
  BASE_PATH: "/",
  VITE_LAN_SESSION_LOGIN: "1",
  VITE_INTERNAL_API_URL: "/",
};

const viteBin = path.resolve(dashRoot, "node_modules", ".bin", "vite");

const child = spawn(
  viteBin,
  [
    "build",
    "--config",
    "vite.config.ts",
    "--outDir",
    outDir,
    "--emptyOutDir",
  ],
  {
    cwd: dashRoot,
    env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (code === 0) {
    console.log(`[matrix:build-dashboard] done — ${indexHtml}`);
    process.exit(0);
  }
  console.error(
    `[matrix:build-dashboard] vite build failed (code=${code}, signal=${signal})`,
  );
  process.exit(typeof code === "number" && code !== 0 ? code : 1);
});
