/**
 * Cross-platform preinstall (replaces `sh -c '...'` which fails on stock Windows).
 * - Removes npm/yarn lockfiles so the workspace stays pnpm-only.
 * - Ensures installs run under pnpm, not npm/yarn.
 */
import { existsSync, unlinkSync } from "node:fs";

for (const f of ["package-lock.json", "yarn.lock"]) {
  try {
    if (existsSync(f)) unlinkSync(f);
  } catch {
    /* ignore */
  }
}

const ua = process.env.npm_config_user_agent ?? "";
if (!ua.includes("pnpm/")) {
  console.error("This monorepo must be installed with pnpm. Use: pnpm install");
  process.exit(1);
}
