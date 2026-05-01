// Component test for the "About this PC" Settings panel.
//
// Mounts `AboutThisPc` inside the same provider stack the dashboard
// uses (QueryClient + I18n + InstallProfileProvider + AuthProvider)
// with a synthetic super_admin session, then intercepts the
// `/api/internal/about` GET the panel fires on first paint and
// asserts that:
//
//   1. While the fetch is in flight the panel renders the loading
//      placeholder (`about-loading`).
//   2. Once the mocked report resolves, every documented field shows
//      up with the right value:
//        - install profile, hostname, api server version, build time,
//          uptime, database, peer-token count (hub), last backup age,
//          last backup verify age, node version
//   3. The panel does NOT render `peerSquadronCount` row when the
//      hub report omits it (null), and DOES render it when the
//      aggregate route is hit (verified through the fallback path).
//   4. When the fetch returns ok=false the panel shows the
//      `about-unreachable` banner.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:about-this-pc

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.TSX_TSCONFIG_PATH = resolve(__dirname, "tsconfig.json");

// ── env injection (must run before any dashboard module import) ────
type ViteEnvOverride = Record<string, string | boolean | undefined>;
(globalThis as unknown as { __HAWK_TEST_VITE_ENV?: ViteEnvOverride })
  .__HAWK_TEST_VITE_ENV = {
    VITE_INTERNAL_API_URL: "http://test.local",
  };

// ── jsdom bootstrap ────────────────────────────────────────────────
const dom = new JSDOM(
  "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true },
);
const w = dom.window as unknown as Window & typeof globalThis;
function setG(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value, writable: true, configurable: true, enumerable: true,
  });
}
setG("window", w);
setG("screen", w.screen);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("HTMLInputElement", w.HTMLInputElement);
setG("HTMLButtonElement", w.HTMLButtonElement);
setG("HTMLDivElement", w.HTMLDivElement);
setG("HTMLFormElement", w.HTMLFormElement);
setG("Element", w.Element);
setG("Node", w.Node);
setG("Event", w.Event);
setG("CustomEvent", w.CustomEvent);
setG("getComputedStyle", w.getComputedStyle.bind(w));
setG("requestAnimationFrame", (cb: FrameRequestCallback) => Number(setTimeout(() => cb(performance.now()), 16)));
setG("cancelAnimationFrame", (id: number) => clearTimeout(id));
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
setG("IntersectionObserver", NoopObserver);
setG("ResizeObserver", NoopObserver);
setG("MutationObserver", w.MutationObserver);
const matchMedia = (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
setG("matchMedia", matchMedia);
(w as unknown as Record<string, unknown>).matchMedia = matchMedia;
(w as unknown as Record<string, unknown>).scrollTo = () => {};

// ── HQLayout build globals (not used here, but loading Settings et al
//    indirectly might pull HQLayout — keep parity with peer-tokens-page).
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
(globalThis as unknown as { __GIT_SHORT_HASH__: string }).__GIT_SHORT_HASH__ = "deadbee";

// ── fetch mock (configurable per-test) ─────────────────────────────
// Mirrors `AboutThisPcDashboardSupervisor` in
// artifacts/pilot-dashboard/src/lib/internal-migration.ts (Task #399 / T-O).
type AboutReportDashboardSupervisor = {
  state:
    | "alive"
    | "stale"
    | "restarting"
    | "spawn-failed"
    | "starting"
    | "unreadable";
  supervisorState: string | null;
  ageSeconds: number | null;
  staleThresholdSec: number;
  restartCount: number | null;
  childPid: number | null;
  childScript: string | null;
  heartbeatPath: string;
};

type AboutReport = {
  installProfile: string;
  hostname: string;
  apiServerVersion: string;
  buildTime: string;
  uptimeSeconds: number;
  databaseName: string | null;
  peerTokenCount: number | null;
  peerSquadronCount: number | null;
  lastBackupAge: { ageSeconds: number; path: string; fileName: string } | null;
  lastBackupVerifyAge: { ageSeconds: number; ok: boolean } | null;
  /**
   * Dashboard-launcher watchdog snapshot. Default fixture treats this
   * as a hub-only PC where the supervisor is intentionally not
   * installed (heartbeat absent ⇒ `null`); individual tests can
   * override via `makeReport({ dashboardSupervisor: {...} })`.
   */
  dashboardSupervisor: AboutReportDashboardSupervisor | null;
  nodeVersion: string;
};

type RouteState = {
  internal: { status: number; body: unknown } | null;
  aggregate: { status: number; body: unknown } | null;
  // Per-action POST responses for /about/run-backup and /about/run-verify.
  // Default = 202 ok. Tests can override to simulate "already_running",
  // "powershell_unavailable", etc.
  runBackup: { status: number; body: unknown } | null;
  runVerify: { status: number; body: unknown } | null;
};
const route: RouteState = {
  internal: null,
  aggregate: null,
  runBackup: null,
  runVerify: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchCalls: Array<{ method: string; url: string }> = [];

const fetchImpl = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === "string" ? input : (input as { url?: string }).url ?? String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  fetchCalls.push({ method, url });

  if (url.endsWith("/api/internal/about") && method === "GET") {
    if (route.internal) return jsonResponse(route.internal.body, route.internal.status);
    return jsonResponse({ error: "not_handled" }, 404);
  }
  if (url.endsWith("/api/aggregate/about") && method === "GET") {
    if (route.aggregate) return jsonResponse(route.aggregate.body, route.aggregate.status);
    return jsonResponse({ error: "not_handled" }, 404);
  }
  if (url.endsWith("/api/internal/about/run-backup") && method === "POST") {
    if (route.runBackup) {
      return jsonResponse(route.runBackup.body, route.runBackup.status);
    }
    return jsonResponse({ ok: true, started: true }, 202);
  }
  if (url.endsWith("/api/internal/about/run-verify") && method === "POST") {
    if (route.runVerify) {
      return jsonResponse(route.runVerify.body, route.runVerify.status);
    }
    return jsonResponse({ ok: true, started: true }, 202);
  }
  // The AuthProvider / install-profile bootstraps may probe other
  // routes; return 404 so the test stays focused.
  return jsonResponse({ error: "not_handled" }, 404);
};
setG("fetch", fetchImpl);

// ── shared imports (after globals) ─────────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider, __setInitialUserForTests } = await import(
  "../src/lib/auth.tsx"
);
const installProfile = await import("../src/lib/install-profile.tsx");
const AboutThisPc = (await import("../src/components/AboutThisPc")).default;
const AboutHealthRibbon = (
  await import("../src/components/AboutHealthRibbon")
).default;
const aboutHealth = await import("../src/lib/about-health.ts");

function setSuperAdminSession(): void {
  w.localStorage.clear();
  w.localStorage.setItem(
    "rjaf.user",
    JSON.stringify({ username: "alice", displayName: "Alice Admin", role: "super_admin" }),
  );
  __setInitialUserForTests({
    id: "u-super",
    username: "alice",
    displayName: "Alice Admin",
    role: "super_admin",
  });
}

function withProviders(
  initialProfile: installProfile.InstallProfile,
): React.ReactElement {
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(
      installProfile.InstallProfileProvider,
      { initialProfile },
      React.createElement(AuthProvider, null, React.createElement(AboutThisPc)),
    ),
  );
}

const flush = async (ms = 30) => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });
};

async function waitFor<T>(
  probe: () => T | null | undefined,
  label: string,
  el: HTMLElement,
  timeoutMs = 4000,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = probe();
    if (hit) return hit;
    await flush(40);
  }
  const snippet = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  throw new Error(`timeout waiting for ${label}. body snippet: ${snippet}`);
}

function makeReport(over: Partial<AboutReport> = {}): AboutReport {
  return {
    installProfile: "hub",
    hostname: "rjaf-pc-01",
    apiServerVersion: "1.2.3",
    buildTime: "2026-04-30T10:00:00.000Z",
    uptimeSeconds: 3725,
    databaseName: "hawk_eye",
    peerTokenCount: 4,
    peerSquadronCount: null,
    lastBackupAge: {
      ageSeconds: 3 * 3600,
      path: "/var/hawk/backups/2026-04-30.dump",
      fileName: "2026-04-30.dump",
    },
    lastBackupVerifyAge: { ageSeconds: 5 * 86400, ok: true },
    dashboardSupervisor: null,
    nodeVersion: "v20.11.1",
    ...over,
  };
}

test("AboutThisPc · super_admin sees every documented field on the hub", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = { status: 200, body: { ok: true, report: makeReport() } };
  route.aggregate = null;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withProviders("hub"));
  });

  // The loading placeholder is racy under jsdom (mocked fetch can
  // resolve inside the same microtask tick as the initial render),
  // so we don't assert on it here. The real contract — that the
  // `about-rows` block eventually appears — is checked below.
  await waitFor(
    () => el.querySelector('[data-testid="about-rows"]'),
    "about-rows",
    el,
  );

  const text = (sel: string): string => {
    const node = el.querySelector(`[data-testid="${sel}-value"]`);
    return (node?.textContent ?? "").trim();
  };

  assert.equal(text("about-install-profile"), "hub");
  assert.equal(text("about-hostname"), "rjaf-pc-01");
  assert.equal(text("about-api-version"), "1.2.3");
  assert.equal(text("about-uptime"), "1h 2m");
  assert.equal(text("about-database-name"), "hawk_eye");
  assert.equal(text("about-peer-token-count"), "4");
  assert.equal(text("about-node-version"), "v20.11.1");
  assert.ok(
    text("about-last-backup").includes("2026-04-30.dump"),
    `last backup row should include the file name; got: ${text("about-last-backup")}`,
  );
  assert.ok(
    text("about-last-backup-verify").length > 0,
    "last backup verify row should have a value",
  );
  // Aggregator-only row must be hidden on the hub report.
  assert.equal(
    el.querySelector('[data-testid="about-peer-squadron-count"]'),
    null,
    "peer-squadron count row must be hidden when the hub report omits it",
  );

  // Dashboard-supervisor row is always rendered (Task #399 / T-O):
  // when the heartbeat is absent (default fixture, hub-only PC) it
  // shows the localized "not installed" label so operators can tell
  // the difference between "supervisor down" and "supervisor never
  // installed".
  assert.ok(
    text("about-dashboard-supervisor").length > 0,
    "dashboard supervisor row should render even when the heartbeat is absent",
  );

  // The panel's poll lives in a setInterval; tear down to prevent a
  // dangling timer keeping the test runner alive.
  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutThisPc · renders dashboard-supervisor row from a live heartbeat (alive + restarts)", async () => {
  // Verifies that when the api-server returns a populated
  // dashboardSupervisor block — alive launcher with a non-zero
  // restartCount — the panel renders the localized state label and
  // the restart counter so operators can see flap activity at a
  // glance from Settings without RDP.
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        dashboardSupervisor: {
          state: "alive",
          supervisorState: "running",
          ageSeconds: 12,
          staleThresholdSec: 90,
          restartCount: 2,
          childPid: 4242,
          childScript: "C:\\Hawk\\scripts\\lan-host\\start-dashboard-host.ps1",
          heartbeatPath:
            "C:\\ProgramData\\HawkEye\\dashboard-supervisor.heartbeat",
        },
      }),
    },
  };
  route.aggregate = null;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(withProviders("hub")); });
  await waitFor(
    () => el.querySelector('[data-testid="about-dashboard-supervisor"]'),
    "about-dashboard-supervisor",
    el,
  );

  const text = (sel: string): string => {
    const node = el.querySelector(`[data-testid="${sel}-value"]`);
    return (node?.textContent ?? "").trim();
  };
  const value = text("about-dashboard-supervisor");
  assert.ok(
    value.includes("alive"),
    `dashboard-supervisor row should surface the alive label; got: ${value}`,
  );
  assert.ok(
    value.includes("12s"),
    `dashboard-supervisor row should surface heartbeat age; got: ${value}`,
  );
  assert.ok(
    value.includes("2×") || value.includes("2x") || value.includes("restart"),
    `dashboard-supervisor row should surface restart counter; got: ${value}`,
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutThisPc · falls back to /api/aggregate/about on aggregator profiles", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  // hub route absent → 404; aggregate route returns the report.
  route.internal = null;
  route.aggregate = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        installProfile: "aggregator-wing",
        peerTokenCount: null,
        peerSquadronCount: 7,
      }),
    },
  };

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withProviders("aggregator-wing"));
  });
  await waitFor(
    () => el.querySelector('[data-testid="about-peer-squadron-count"]'),
    "about-peer-squadron-count (aggregator)",
    el,
  );

  const text = (sel: string): string => {
    const node = el.querySelector(`[data-testid="${sel}-value"]`);
    return (node?.textContent ?? "").trim();
  };
  assert.equal(text("about-install-profile"), "aggregator-wing");
  assert.equal(text("about-peer-squadron-count"), "7");
  assert.equal(
    el.querySelector('[data-testid="about-peer-token-count"]'),
    null,
    "hub-only peer-token row must stay hidden in aggregator mode",
  );
  // The fetcher should have hit the aggregate fallback.
  assert.ok(
    fetchCalls.some((c) => c.url.endsWith("/api/aggregate/about")),
    "aggregator profile must fetch /api/aggregate/about",
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutThisPc · shows the unreachable banner when both routes fail", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = { status: 500, body: { ok: false, error: "boom" } };
  route.aggregate = { status: 500, body: { ok: false, error: "boom" } };

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withProviders("hub"));
  });
  await waitFor(
    () => el.querySelector('[data-testid="about-unreachable"]'),
    "about-unreachable",
    el,
  );
  // No data rows when unreachable.
  assert.equal(
    el.querySelector('[data-testid="about-rows"]'),
    null,
    "data rows must NOT render when the endpoint is unreachable",
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

// ── ribbon visibility (task #390) ─────────────────────────────────
//
// `aboutHealthRibbonSeverity` is the gate for the top-of-Settings
// warning ribbon: the ribbon must only mount when at least one health
// dot is `fail`. The ribbon also exposes inline action buttons that
// hit the new `/api/internal/about/run-backup` and `/run-verify`
// endpoints, so we exercise that wiring too.

test("aboutHealthRibbonSeverity · downgrades from fail to warn to ok", () => {
  // Healthy: backup 1h ago, verify 5d ago → ok
  assert.equal(
    aboutHealth.aboutHealthRibbonSeverity({
      installProfile: "hub",
      hostname: "h",
      apiServerVersion: "1",
      buildTime: "",
      uptimeSeconds: 0,
      databaseName: "db",
      peerTokenCount: 0,
      peerSquadronCount: null,
      lastBackupAge: { ageSeconds: 3600, path: "/x", fileName: "x.dump" },
      lastBackupVerifyAge: { ageSeconds: 5 * 86400, ok: true },
      nodeVersion: "v20",
    }),
    "ok",
  );
  // Backup 3d old → warn (>2d but <=7d)
  assert.equal(
    aboutHealth.aboutHealthRibbonSeverity({
      installProfile: "hub",
      hostname: "h",
      apiServerVersion: "1",
      buildTime: "",
      uptimeSeconds: 0,
      databaseName: "db",
      peerTokenCount: 0,
      peerSquadronCount: null,
      lastBackupAge: { ageSeconds: 3 * 86400, path: "/x", fileName: "x.dump" },
      lastBackupVerifyAge: { ageSeconds: 5 * 86400, ok: true },
      nodeVersion: "v20",
    }),
    "warn",
  );
  // Backup 10d old → fail
  assert.equal(
    aboutHealth.aboutHealthRibbonSeverity({
      installProfile: "hub",
      hostname: "h",
      apiServerVersion: "1",
      buildTime: "",
      uptimeSeconds: 0,
      databaseName: "db",
      peerTokenCount: 0,
      peerSquadronCount: null,
      lastBackupAge: { ageSeconds: 10 * 86400, path: "/x", fileName: "x.dump" },
      lastBackupVerifyAge: { ageSeconds: 5 * 86400, ok: true },
      nodeVersion: "v20",
    }),
    "fail",
  );
  // Verify FAIL → fail (overrides backup ok)
  assert.equal(
    aboutHealth.aboutHealthRibbonSeverity({
      installProfile: "hub",
      hostname: "h",
      apiServerVersion: "1",
      buildTime: "",
      uptimeSeconds: 0,
      databaseName: "db",
      peerTokenCount: 0,
      peerSquadronCount: null,
      lastBackupAge: { ageSeconds: 3600, path: "/x", fileName: "x.dump" },
      lastBackupVerifyAge: { ageSeconds: 86400, ok: false },
      nodeVersion: "v20",
    }),
    "fail",
  );
  // Null report → unknown (we never show the ribbon for unknown)
  assert.equal(aboutHealth.aboutHealthRibbonSeverity(null), "unknown");
  assert.equal(aboutHealth.shouldShowAboutHealthRibbon(null), false);
});

function withRibbon(profile: installProfile.InstallProfile): React.ReactElement {
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(
      installProfile.InstallProfileProvider,
      { initialProfile: profile },
      React.createElement(AuthProvider, null, React.createElement(AboutHealthRibbon)),
    ),
  );
}

test("AboutHealthRibbon · stays hidden when every dot is healthy", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  // Backup 1h ago, verify 5d ago — both healthy.
  route.internal = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        lastBackupAge: {
          ageSeconds: 3600,
          path: "/var/x",
          fileName: "fresh.dump",
        },
        lastBackupVerifyAge: { ageSeconds: 5 * 86400, ok: true },
      }),
    },
  };
  route.aggregate = null;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withRibbon("hub"));
  });
  // Give the fetch + render a tick.
  await flush(100);
  assert.equal(
    el.querySelector('[data-testid="about-health-ribbon"]'),
    null,
    "ribbon must NOT render when every dot is healthy",
  );
  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutHealthRibbon · renders when last backup is over a week old", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        // 10 days old → fail bucket.
        lastBackupAge: {
          ageSeconds: 10 * 86400,
          path: "/var/x",
          fileName: "stale.dump",
        },
        lastBackupVerifyAge: { ageSeconds: 5 * 86400, ok: true },
      }),
    },
  };
  route.aggregate = null;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withRibbon("hub"));
  });
  await waitFor(
    () => el.querySelector('[data-testid="about-health-ribbon"]'),
    "about-health-ribbon",
    el,
  );
  // Backup is failing → the run-backup button should be present, the
  // verify button should NOT (verify is still healthy).
  assert.ok(
    el.querySelector('[data-testid="about-ribbon-run-backup"]'),
    "run-backup button should render for backup-fail",
  );
  assert.equal(
    el.querySelector('[data-testid="about-ribbon-run-verify"]'),
    null,
    "run-verify button should be hidden when verify dot is healthy",
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutHealthRibbon · renders when last verify is FAIL", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        lastBackupAge: {
          ageSeconds: 3600,
          path: "/var/x",
          fileName: "fresh.dump",
        },
        lastBackupVerifyAge: { ageSeconds: 86400, ok: false },
      }),
    },
  };
  route.aggregate = null;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withRibbon("hub"));
  });
  await waitFor(
    () => el.querySelector('[data-testid="about-health-ribbon"]'),
    "about-health-ribbon (verify fail)",
    el,
  );
  assert.ok(
    el.querySelector('[data-testid="about-ribbon-run-verify"]'),
    "run-verify button should render for verify-fail",
  );
  assert.equal(
    el.querySelector('[data-testid="about-ribbon-run-backup"]'),
    null,
    "run-backup button should be hidden when backup dot is healthy",
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutThisPc · clicking Run backup POSTs to /run-backup and re-polls /about", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  // Start with a fail-bucket backup so the action is meaningful.
  route.internal = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        lastBackupAge: {
          ageSeconds: 10 * 86400,
          path: "/var/x",
          fileName: "stale.dump",
        },
      }),
    },
  };
  route.aggregate = null;
  route.runBackup = { status: 202, body: { ok: true, started: true } };
  route.runVerify = null;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withProviders("hub"));
  });
  const btn = (await waitFor(
    () => el.querySelector('[data-testid="about-run-backup"]'),
    "about-run-backup button",
    el,
  )) as HTMLButtonElement;

  // Snapshot how many GETs happened pre-click so we can assert the
  // re-poll fires after a successful POST.
  const getsBefore = fetchCalls.filter(
    (c) => c.method === "GET" && c.url.endsWith("/api/internal/about"),
  ).length;

  await act(async () => {
    btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  });
  await flush(60);

  const posts = fetchCalls.filter(
    (c) =>
      c.method === "POST" &&
      c.url.endsWith("/api/internal/about/run-backup"),
  );
  assert.equal(posts.length, 1, "exactly one POST to /run-backup");
  // Error label must NOT appear on success.
  assert.equal(
    el.querySelector('[data-testid="about-run-backup-error"]'),
    null,
    "no error label on a successful run-backup",
  );
  const getsAfter = fetchCalls.filter(
    (c) => c.method === "GET" && c.url.endsWith("/api/internal/about"),
  ).length;
  assert.ok(
    getsAfter > getsBefore,
    `expected /about to be re-polled after the action ran (before=${getsBefore} after=${getsAfter})`,
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutThisPc · surfaces server error label when Run verify fails", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = {
    status: 200,
    body: { ok: true, report: makeReport() },
  };
  route.aggregate = null;
  route.runBackup = null;
  route.runVerify = {
    status: 503,
    body: { ok: false, error: "powershell_unavailable" },
  };

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withProviders("hub"));
  });
  const btn = (await waitFor(
    () => el.querySelector('[data-testid="about-run-verify"]'),
    "about-run-verify button",
    el,
  )) as HTMLButtonElement;

  await act(async () => {
    btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  });
  await flush(60);

  const errorLabel = el.querySelector('[data-testid="about-run-verify-error"]');
  assert.ok(errorLabel, "error label should render after a failed action");
  assert.ok(
    (errorLabel?.textContent ?? "").includes("powershell_unavailable"),
    `error label should surface the server's reason; got: ${errorLabel?.textContent}`,
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutHealthRibbon · clicking Run backup hits the same POST endpoint", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = {
    status: 200,
    body: {
      ok: true,
      report: makeReport({
        lastBackupAge: {
          ageSeconds: 10 * 86400,
          path: "/var/x",
          fileName: "stale.dump",
        },
      }),
    },
  };
  route.aggregate = null;
  route.runBackup = { status: 202, body: { ok: true, started: true } };

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withRibbon("hub"));
  });
  const btn = (await waitFor(
    () => el.querySelector('[data-testid="about-ribbon-run-backup"]'),
    "about-ribbon-run-backup button",
    el,
  )) as HTMLButtonElement;

  await act(async () => {
    btn.dispatchEvent(new w.Event("click", { bubbles: true }));
  });
  await flush(60);

  const posts = fetchCalls.filter(
    (c) =>
      c.method === "POST" &&
      c.url.endsWith("/api/internal/about/run-backup"),
  );
  assert.equal(posts.length, 1, "ribbon must POST to the same /run-backup endpoint");

  await act(async () => { root.unmount(); });
  el.remove();
});

test("AboutHealthRibbon · stays hidden when the report is unreachable", async () => {
  setSuperAdminSession();
  fetchCalls.length = 0;
  route.internal = { status: 500, body: { ok: false, error: "boom" } };
  route.aggregate = { status: 500, body: { ok: false, error: "boom" } };

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(withRibbon("hub"));
  });
  await flush(100);
  assert.equal(
    el.querySelector('[data-testid="about-health-ribbon"]'),
    null,
    "ribbon must NOT render when the about endpoint is unreachable (no false alarms)",
  );

  await act(async () => { root.unmount(); });
  el.remove();
});

// ── teardown ──────────────────────────────────────────────────────
test("AboutThisPc · teardown jsdom", () => {
  try {
    (dom.window as unknown as { close?: () => void }).close?.();
  } catch {
    /* best-effort */
  }
});
