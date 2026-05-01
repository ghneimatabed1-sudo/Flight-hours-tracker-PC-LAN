// Playwright config for the role × profile × scenario matrix runner
// (task #361). Lives alongside `playwright.config.ts` (which drives
// the existing commander-provisioning live-Supabase smoke spec) so
// each runner can stay opinionated about its own timeouts, workers,
// reporters and chromium executable.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:matrix-playwright
//
// The script first invokes `e2e/matrix/build-dashboard.mjs` so the
// SPA bundle exists under `dist-matrix/public/`; then this config
// drives one Chromium browser per cell and writes evidence under
// `artifacts/pilot-dashboard/test-evidence/<date>/<profile>/<role>/`.

import { defineConfig } from "@playwright/test";

// Replit ships a pre-installed Chromium binary — `playwright install`
// is unavailable in the dev container, so we point at it explicitly
// when present and let Playwright fall back to its own resolution
// logic everywhere else (CI runners that have run `playwright install`).
const CHROMIUM_EXECUTABLE = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || undefined;

export default defineConfig({
  testDir: "./e2e/matrix",
  // Each cell does a navigate + 2s settle + ~8 probe fetches; 60s is
  // a roomy ceiling that still surfaces a hung probe quickly.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Strictly serial: the harness's `setActiveActor` is a singleton,
  // running cells in parallel would corrupt each other's auth state.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "playwright-report-matrix",
        open: "never",
      },
    ],
  ],
  outputDir: "test-results-matrix",
  use: {
    // Sweep should never need a network proxy.
    ignoreHTTPSErrors: true,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],
});
