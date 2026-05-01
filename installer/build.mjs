// build.mjs
//
// Cross-platform entry for `pnpm --filter @workspace/installer run build`.
// On Windows, it shells out to build.ps1. On Linux/macOS (where Inno
// Setup is unavailable), it prints a friendly notice and exits 0 so
// the workspace-wide `pnpm -r build` does not fail in CI on those
// hosts.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.platform !== "win32") {
  console.log(
    "[installer] Skipping HawkEye-Setup.exe build — Inno Setup runs on Windows only.\n" +
    "[installer] Run installer/build.ps1 from a Windows machine with Inno Setup 6 installed.",
  );
  process.exit(0);
}

const script = join(__dirname, "build.ps1");
const args = [
  "-ExecutionPolicy", "Bypass",
  "-NoProfile",
  "-File", script,
  ...process.argv.slice(2),
];

const result = spawnSync("powershell.exe", args, { stdio: "inherit" });
if (result.error) {
  console.error("[installer] failed to launch powershell.exe:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
