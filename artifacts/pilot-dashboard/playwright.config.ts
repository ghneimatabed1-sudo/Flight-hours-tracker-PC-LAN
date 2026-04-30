// artifacts/pilot-dashboard/playwright.config.ts
//
// Task #281 (Round 4 AA4) — Playwright bootstrap for the dashboard's
// end-to-end test suite. Lives alongside the existing tsx-based
// `tests/sidebar-smoke.test.ts` (which runs in jsdom and only catches
// synchronous render throws); Playwright handles real browser flows
// against a live Supabase universe.
//
// First and currently only spec:
//   e2e/commander-provisioning.spec.ts — the multi-squadron commander
//   provisioning flow that task #275 said the dashboard had no e2e
//   coverage for.
//
// How to run locally
// ──────────────────
//   pnpm --filter @workspace/pilot-dashboard exec playwright install --with-deps
//   E2E_SUPER_ADMIN_EMAIL=… \
//     E2E_SUPER_ADMIN_PASSWORD=… \
//     E2E_SUPER_ADMIN_TOTP_SECRET=… \
//     E2E_DASHBOARD_URL=http://localhost:5173 \
//     pnpm --filter @workspace/pilot-dashboard exec playwright test
//
// Tests skip themselves if the required E2E_* env vars are missing,
// so the same config is safe to load in environments (a fresh dev
// container, Replit) where no live universe is available.
//
// CI invocation lives in `.github/workflows/e2e-commander-provisioning.yml`
// — that workflow injects the secrets and runs only on PRs that touch
// the four files the test exercises (provision-commander, register-license,
// heal-claims, LicenseKeys.tsx).
import { defineConfig, devices } from "@playwright/test";

const BASE_URL =
  process.env.E2E_DASHBOARD_URL?.replace(/\/+$/, "") ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  // The provisioning flow walks 8 explicit steps; 90s gives PostgREST
  // refreshes + JWT propagation a comfortable budget without masking
  // a hung step.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // license-key creation mutates global state; serialise to keep runs deterministic.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ["list"],
        ["html", { outputFolder: "playwright-report", open: "never" }],
        ["junit", { outputFile: "playwright-report/junit.xml" }],
      ]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Match the dashboard default viewport so layout-driven assertions
    // don't differ between dev and CI.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
