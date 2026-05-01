// Component tests for the three operator-visible failure-mode UI
// surfaces added in Task #372 / T-E:
//
//   1. VersionMismatchBanner — amber bar that warns when the
//      api-server has been upgraded out from under the dashboard's
//      cached HTML.
//   2. DiskFullOverlay      — red full-screen overlay shown when any
//      fetch returns HTTP 507 disk_full.
//   3. BackupVerifyBanner   — red site-wide banner shown to
//      super_admin operators when the quarterly verify-backup self
//      restore test is overdue / failed / never run.
//
// Pattern mirrors `tests/aggregator-ui.test.ts`: jsdom + react-dom/
// server.renderToString + memory wouter location. Module-level state
// in `lib/api-client.ts` is poked via the explicit `_set*ForTests`
// seams so we don't have to fake fetch wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ── jsdom bootstrap ──────────────────────────────────────────────────
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true },
);
const w = dom.window as unknown as Window & typeof globalThis;
function setG(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
setG("window", w);
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("Element", w.Element);
setG("Node", w.Node);
setG("getComputedStyle", w.getComputedStyle.bind(w));
setG("requestAnimationFrame", (cb: FrameRequestCallback) =>
  Number(setTimeout(() => cb(performance.now()), 16)),
);
setG("cancelAnimationFrame", (id: number) => clearTimeout(id));
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
setG("IntersectionObserver", NoopObserver);
setG("ResizeObserver", NoopObserver);
setG("MutationObserver", w.MutationObserver);
setG("matchMedia", (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
}));

// ── lazy imports (after globals) ────────────────────────────────────
const React = (await import("react")).default;
const { renderToString } = await import("react-dom/server");
const { Router } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");

// Suppress noisy SSR warnings that don't affect output.
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (/Missing getServerSnapshot/i.test(msg)) return;
  if (/not wrapped in act/i.test(msg)) return;
  origConsoleError(...args);
};

// `__APP_VERSION__` is normally Vite-injected. Hand a static value to
// the SSR pass so the version-compare logic has a concrete dashboard
// version to compare against.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "1.1.110";
(globalThis as unknown as { __GIT_SHORT_HASH__: string }).__GIT_SHORT_HASH__ = "deadbee";

const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider, __setInitialUserForTests } = await import(
  "../src/lib/auth.tsx"
);
const { userFromLanAuthProfile } = await import("../src/lib/lan-user-map");
const installProfile = await import("../src/lib/install-profile.tsx");

const apiClient = await import("../src/lib/api-client");
const VersionMismatchBanner = (await import(
  "../src/components/VersionMismatchBanner"
)).default;
const DiskFullOverlay = (await import("../src/components/DiskFullOverlay"))
  .default;
const BackupVerifyBanner = (await import(
  "../src/components/BackupVerifyBanner"
)).default;
const { classifyBackupVerifyMarker } = await import(
  "../src/components/BackupVerifyBanner"
);

// ── helpers ─────────────────────────────────────────────────────────
type UserShape = {
  username: string;
  displayName: string;
  role: string;
  scope?: string;
};

function setSession(user: UserShape | null) {
  const ls = w.localStorage;
  ls.clear();
  w.sessionStorage.clear();
  if (user) {
    ls.setItem("rjaf.user", JSON.stringify(user));
    ls.setItem("rjaf.licensed", "1");
    ls.setItem(
      "rjaf.squadron",
      JSON.stringify({ name: "NO.8", number: "NO.8", base: "MAFRAQ" }),
    );
    __setInitialUserForTests(
      userFromLanAuthProfile(
        {
          id: user.username,
          username: user.username,
          displayName: user.displayName,
          role: user.scope ? `${user.role}:${user.scope}` : user.role,
          squadronId: null,
        },
        user.username,
      ),
    );
  } else {
    __setInitialUserForTests(null);
  }
}

function withProviders(
  child: React.ReactElement,
  initialProfile: installProfile.InstallProfile = "hub",
): React.ReactElement {
  const { hook } = memoryLocation({ path: "/admin", static: true });
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(
      installProfile.InstallProfileProvider,
      { initialProfile },
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          Router as unknown as React.ComponentType<{
            hook: unknown;
            children: React.ReactNode;
          }>,
          { hook },
          child,
        ),
      ),
    ),
  );
}

function resetState() {
  apiClient._resetApiClientStateForTests();
  w.sessionStorage.clear();
}

// ─────────────────────────────────────────────────────────────────────
// 1. VersionMismatchBanner
// ─────────────────────────────────────────────────────────────────────

test("version-mismatch · renders nothing when api-server version is unknown", () => {
  resetState();
  setSession({
    username: "admin",
    displayName: "Super Admin",
    role: "super_admin",
  });
  const html = renderToString(
    withProviders(React.createElement(VersionMismatchBanner)),
  );
  assert.ok(
    !html.includes("banner-version-mismatch"),
    "VersionMismatchBanner should render nothing when apiServerVersion is null",
  );
});

test("version-mismatch · renders nothing when api-server matches dashboard", () => {
  resetState();
  apiClient._setApiServerVersionForTests("1.1.110");
  setSession({
    username: "admin",
    displayName: "Super Admin",
    role: "super_admin",
  });
  const html = renderToString(
    withProviders(React.createElement(VersionMismatchBanner)),
  );
  assert.ok(
    !html.includes("banner-version-mismatch"),
    "VersionMismatchBanner should be hidden when api-server == dashboard",
  );
});

test("version-mismatch · renders banner when api-server is strictly ahead", () => {
  resetState();
  apiClient._setApiServerVersionForTests("1.1.111");
  setSession({
    username: "admin",
    displayName: "Super Admin",
    role: "super_admin",
  });
  const html = renderToString(
    withProviders(React.createElement(VersionMismatchBanner)),
  );
  assert.ok(
    html.includes("banner-version-mismatch"),
    "VersionMismatchBanner should render when api-server > dashboard",
  );
  assert.ok(
    /1\.1\.111/.test(html) && /1\.1\.110/.test(html),
    "VersionMismatchBanner should display both api-server and dashboard versions",
  );
});

test("version-mismatch · renders banner when api-server is much newer", () => {
  resetState();
  apiClient._setApiServerVersionForTests("2.0.0");
  setSession({
    username: "ops",
    displayName: "Ops",
    role: "ops",
    scope: "squadron",
  });
  // Banner is role-agnostic — every operator sees it because every
  // operator's UI depends on the api-server's contract.
  const html = renderToString(
    withProviders(React.createElement(VersionMismatchBanner)),
  );
  assert.ok(
    html.includes("banner-version-mismatch"),
    "VersionMismatchBanner should render for non-admin operators too",
  );
});

test("version-mismatch · compareSemver handles equal, less, greater", () => {
  assert.equal(apiClient.compareSemver("1.1.110", "1.1.110"), 0);
  assert.equal(apiClient.compareSemver("1.1.109", "1.1.110"), -1);
  assert.equal(apiClient.compareSemver("1.1.111", "1.1.110"), 1);
  assert.equal(apiClient.compareSemver("2.0.0", "1.99.99"), 1);
  assert.equal(apiClient.compareSemver("1.2", "1.2.0"), 0);
});

// ─────────────────────────────────────────────────────────────────────
// 2. DiskFullOverlay
// ─────────────────────────────────────────────────────────────────────

test("disk-full · overlay is hidden when state is clean", () => {
  resetState();
  setSession({
    username: "admin",
    displayName: "Super Admin",
    role: "super_admin",
  });
  const html = renderToString(
    withProviders(React.createElement(DiskFullOverlay)),
  );
  assert.ok(
    !html.includes("disk-full-overlay"),
    "DiskFullOverlay should render nothing when isDiskFull() is false",
  );
});

test("disk-full · overlay is shown when isDiskFull() is true", () => {
  resetState();
  apiClient._setDiskFullForTests(true);
  setSession({
    username: "ops",
    displayName: "Ops",
    role: "ops",
    scope: "squadron",
  });
  const html = renderToString(
    withProviders(React.createElement(DiskFullOverlay)),
  );
  assert.ok(
    html.includes("disk-full-overlay"),
    "DiskFullOverlay should appear when disk-full state is set",
  );
  assert.ok(
    html.includes("disk-full-retry"),
    "DiskFullOverlay should expose the retry button",
  );
});

test("disk-full · overlay is role-agnostic (every signed-in user sees it)", () => {
  resetState();
  apiClient._setDiskFullForTests(true);
  // Even a low-privilege ops:flight operator must see the overlay —
  // disk-full means writes are blocked across the whole hub, so the
  // signal cannot be gated by role.
  setSession({
    username: "flightops",
    displayName: "Flight Ops",
    role: "ops",
    scope: "flight",
  });
  const html = renderToString(
    withProviders(React.createElement(DiskFullOverlay)),
  );
  assert.ok(
    html.includes("disk-full-overlay"),
    "DiskFullOverlay should render for ops operators too",
  );
});

test("disk-full · subscribeDiskFull notifies subscribers on state change", () => {
  resetState();
  const seen: boolean[] = [];
  const off = apiClient.subscribeDiskFull((v) => seen.push(v));
  apiClient._setDiskFullForTests(true);
  apiClient._setDiskFullForTests(true); // duplicate — no notify
  apiClient._setDiskFullForTests(false);
  off();
  apiClient._setDiskFullForTests(true); // after unsubscribe — no notify
  assert.deepEqual(
    seen,
    [true, false],
    "Subscribers should only be notified on true state transitions",
  );
});

// ─────────────────────────────────────────────────────────────────────
// 3. BackupVerifyBanner
// ─────────────────────────────────────────────────────────────────────

test("backup-verify · renders nothing for non-super_admin operators", () => {
  resetState();
  setSession({
    username: "ops",
    displayName: "Ops",
    role: "ops",
    scope: "squadron",
  });
  const html = renderToString(
    withProviders(React.createElement(BackupVerifyBanner)),
  );
  assert.ok(
    !html.includes("banner-backup-verify"),
    "BackupVerifyBanner must be hidden for non-super_admin",
  );
});

test("backup-verify · renders nothing on aggregator install profile", () => {
  resetState();
  setSession({
    username: "admin",
    displayName: "Super Admin",
    role: "super_admin",
  });
  const html = renderToString(
    withProviders(
      React.createElement(BackupVerifyBanner),
      "aggregator-wing",
    ),
  );
  assert.ok(
    !html.includes("banner-backup-verify"),
    "BackupVerifyBanner must be hidden on aggregator install profile",
  );
});

test("backup-verify · classifier returns ok for fresh successful marker", () => {
  const got = classifyBackupVerifyMarker({
    ok: true,
    observedAt: "2026-04-01T00:00:00.000Z",
    ageDays: 30,
    message: null,
  });
  assert.equal(got.kind, "ok");
});

test("backup-verify · classifier returns never for null marker", () => {
  const got = classifyBackupVerifyMarker(null);
  assert.equal(got.kind, "never");
});

test("backup-verify · classifier returns overdue when ageDays > 120", () => {
  const got = classifyBackupVerifyMarker({
    ok: true,
    observedAt: "2025-10-01T00:00:00.000Z",
    ageDays: 200,
    message: null,
  });
  assert.equal(got.kind, "overdue");
  if (got.kind === "overdue") {
    assert.equal(got.ageDays, 200);
  }
});

test("backup-verify · classifier returns failed when marker.ok is false", () => {
  const got = classifyBackupVerifyMarker({
    ok: false,
    observedAt: "2026-04-15T00:00:00.000Z",
    ageDays: 14,
    message: "restore mismatch",
  });
  assert.equal(got.kind, "failed");
  if (got.kind === "failed") {
    assert.equal(got.observedAt, "2026-04-15T00:00:00.000Z");
  }
});

test("backup-verify · classifier prefers failed over fresh-vs-overdue check", () => {
  // A failed run that's also recent should still be classified as
  // failed (not silently downgraded to "ok" because it's <120 days
  // old). This is the key safety invariant — a failure on the most
  // recent run is the loudest signal.
  const got = classifyBackupVerifyMarker({
    ok: false,
    observedAt: "2026-04-29T00:00:00.000Z",
    ageDays: 1,
    message: "checksum mismatch",
  });
  assert.equal(got.kind, "failed");
});

// ─────────────────────────────────────────────────────────────────────
// 4. LoginVersionHint (#386)
// ─────────────────────────────────────────────────────────────────────
//
// Pre-auth amber line that lives directly under the Sign In button
// when the api-server reports a version strictly newer than the
// dashboard bundle. Renders nothing while the version is unknown or
// matches — silence is the right pre-auth default. We render via SSR
// (no useEffect runs) and prime the module-level api-client state via
// the test-only setter that VersionMismatchBanner uses already.

const LoginVersionHint = (await import(
  "../src/components/LoginVersionHint"
)).default;

test("login-version-hint · renders nothing when api-server version is unknown (#386)", () => {
  resetState();
  const html = renderToString(
    withProviders(React.createElement(LoginVersionHint)),
  );
  assert.ok(
    !html.includes("login-version-hint"),
    "LoginVersionHint should stay silent until /api/healthz responds",
  );
});

test("login-version-hint · renders nothing when api-server matches dashboard (#386)", () => {
  resetState();
  apiClient._setApiServerVersionForTests("1.1.110");
  const html = renderToString(
    withProviders(React.createElement(LoginVersionHint)),
  );
  assert.ok(
    !html.includes("login-version-hint"),
    "LoginVersionHint should stay hidden when versions match",
  );
});

test("login-version-hint · renders the inline hint when api-server is ahead (#386)", () => {
  resetState();
  apiClient._setApiServerVersionForTests("1.1.111");
  const html = renderToString(
    withProviders(React.createElement(LoginVersionHint)),
  );
  assert.ok(
    html.includes("login-version-hint"),
    "LoginVersionHint should render when api-server > dashboard",
  );
  assert.ok(
    html.includes("login-version-hint-refresh"),
    "LoginVersionHint should expose the Refresh button",
  );
});
