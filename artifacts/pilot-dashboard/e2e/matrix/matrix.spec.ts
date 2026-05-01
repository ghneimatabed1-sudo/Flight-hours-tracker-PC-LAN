// Role × profile × scenario sweep run through a real Chromium browser
// (task #361). For every cell the spec:
//
//   1. Spins a fresh stub api-server + static SPA on a random port,
//      pinned to the cell's install profile.
//   2. Switches the harness's "active actor" to the cell's role.
//   3. Boots a fresh browser context with a synthetic
//      `rjaf.lanSessionToken` already in localStorage so the SPA's
//      LAN session recovery effect lands the user straight on the
//      dashboard for that role.
//   4. Navigates to "/", waits for the install-profile probe to
//      settle, and screenshots the landing page.
//   5. Walks the cell's probe list (role-allowed and role-blocked
//      endpoints) via `page.request.fetch` and records the per-probe
//      status into a JSON network log.
//   6. Captures every browser `console` message into a text log and
//      every browser-driven request/response into a separate
//      `network.log` so the next sweep can diff against this one.
//   7. Writes the four files (screenshot.png, console.log,
//      network.log, probes.json) under
//      `artifacts/pilot-dashboard/test-evidence/<date>/<profile>/
//      <role>/`.

import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  startMatrixServer,
  setActiveActor,
} from "./matrix-server";
import { MATRIX_CELLS } from "./cells";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Evidence directory ────────────────────────────────────────────
const TODAY = (() => {
  const env = String(process.env.MATRIX_DATE ?? "").trim();
  if (env) return env;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
})();

const EVIDENCE_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "test-evidence",
  TODAY,
);

const SESSION_TOKEN = "matrix-test-session-token";

test.describe.configure({ mode: "serial" });

for (const cell of MATRIX_CELLS) {
  test(`${cell.profile} · ${cell.roleSlug}`, async ({ browser }) => {
    const cellDir = path.join(EVIDENCE_ROOT, cell.profile, cell.roleSlug);
    await mkdir(cellDir, { recursive: true });

    const server = await startMatrixServer(cell.profile);
    setActiveActor(cell.actor);

    const context = await browser.newContext({
      baseURL: server.url,
      viewport: { width: 1440, height: 900 },
    });

    // Seed the LAN session token so the SPA's auth recovery picks it
    // up before the first paint. addInitScript runs before any page
    // script, so this is race-free against the AuthProvider effect.
    await context.addInitScript(
      ({ token }) => {
        try {
          localStorage.setItem("rjaf.lanSessionToken", token);
        } catch {
          /* ignore */
        }
      },
      { token: SESSION_TOKEN },
    );

    const consoleLines: string[] = [];
    const networkLines: string[] = [];

    try {
      const page = await context.newPage();

      page.on("console", (msg) => {
        consoleLines.push(`[${msg.type()}] ${msg.text()}`);
      });
      page.on("pageerror", (err) => {
        consoleLines.push(`[pageerror] ${err.message}`);
      });
      page.on("requestfailed", (req) => {
        const f = req.failure();
        networkLines.push(
          `FAIL ${req.method()} ${req.url()} — ${f?.errorText ?? "unknown"}`,
        );
      });
      page.on("response", (resp) => {
        const req = resp.request();
        networkLines.push(
          `${resp.status()} ${req.method()} ${req.url()}`,
        );
      });

      // Navigate. Don't wait for `networkidle` — the dashboard fires
      // a steady drip of background queries, so we'd timeout.
      await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Give the auth recovery effect + install-profile probe a beat
      // to settle so the screenshot reflects the role-specific shell.
      await page.waitForTimeout(2_000);

      await page.screenshot({
        path: path.join(cellDir, "screenshot.png"),
        fullPage: true,
      });

      // Walk the probe list. Use `page.request` so probes inherit the
      // browser context's headers but skip the SPA's own fetch
      // wrappers — we want to pin the raw server response per role.
      const probeResults: Array<{
        label: string;
        method: string;
        path: string;
        expected: string;
        status: number | null;
        body_excerpt: string;
      }> = [];

      networkLines.push(
        "--- probes (role-allowed / role-blocked endpoints) ---",
      );
      for (const probe of cell.probes) {
        const url = `${server.url}${probe.path}`;
        try {
          const response = await page.request.fetch(url, {
            method: probe.method,
            headers: {
              "x-hawk-lan-session": SESSION_TOKEN,
              "content-type": "application/json",
            },
            data: probe.body ? JSON.stringify(probe.body) : undefined,
            timeout: 10_000,
            failOnStatusCode: false,
          });
          let bodyText = "";
          try {
            bodyText = await response.text();
          } catch {
            bodyText = "";
          }
          const status = response.status();
          probeResults.push({
            label: probe.label,
            method: probe.method,
            path: probe.path,
            expected: probe.expected,
            status,
            body_excerpt: bodyText.slice(0, 200),
          });
          networkLines.push(
            `PROBE ${status} ${probe.method} ${probe.path}` +
              ` — expected:${probe.expected} label:${probe.label}`,
          );
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          probeResults.push({
            label: probe.label,
            method: probe.method,
            path: probe.path,
            expected: probe.expected,
            status: null,
            body_excerpt: `network_error: ${errText}`,
          });
          networkLines.push(
            `PROBE FAIL ${probe.method} ${probe.path}` +
              ` — expected:${probe.expected} error:${errText}`,
          );
        }
      }

      await writeFile(
        path.join(cellDir, "probes.json"),
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            profile: cell.profile,
            role: cell.actor.role,
            role_slug: cell.roleSlug,
            actor: cell.actor,
            server_url: server.url,
            session_token: SESSION_TOKEN,
            results: probeResults,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      // Quick assertion: the SPA should at least have rendered SOMETHING
      // (i.e. the `<div id="root">` got a child). This catches a build
      // regression that would silently leave us with blank screenshots.
      await expect(page.locator("#root")).toBeVisible();
    } finally {
      await writeFile(
        path.join(cellDir, "console.log"),
        consoleLines.length === 0
          ? "(no browser console output)\n"
          : `${consoleLines.join("\n")}\n`,
        "utf8",
      );
      await writeFile(
        path.join(cellDir, "network.log"),
        networkLines.length === 0
          ? "(no browser network traffic)\n"
          : `${networkLines.join("\n")}\n`,
        "utf8",
      );
      await context.close();
      await server.close();
      setActiveActor(null);
    }
  });
}
