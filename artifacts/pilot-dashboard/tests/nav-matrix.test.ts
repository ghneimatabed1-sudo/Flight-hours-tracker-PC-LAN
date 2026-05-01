// Role × install-profile sidebar nav matrix.
//
// Companion to `aggregator-ui.test.ts` — that file checks the
// aggregator vs hub sidebar swap; this one walks the documented role
// matrix on top of every install profile so a future change to
// HQLayout that quietly grants a non-super_admin access to admin
// pages, or surfaces hub write-flow nav inside an aggregator install,
// trips a CI failure rather than slipping into production.
//
// Documented contracts (see `HQLayout.tsx` and Task #370):
//
//   hub + super_admin            → /admin, /admin/squadrons,
//                                  /admin/audit, /admin/security,
//                                  /admin/health, /admin/users,
//                                  /admin/peer-tokens, /settings
//                                  (no /aggregate, no /dashboard)
//
//   hub + commander/ops/deputy   → /dashboard… (no /admin/*, no
//                                  /aggregate)
//
//   aggregator-wing + super_admin
//   aggregator-base + super_admin
//                                → /aggregate + every /aggregate/*
//                                  read page + /admin/peer-squadrons
//                                  + /admin/audit + /admin/users +
//                                  /settings (no hub admin pages,
//                                  no /dashboard)
//
//   aggregator-* + commander/ops → /aggregate + read pages + /settings
//                                  ONLY (no peer-squadrons, audit,
//                                  users)
//
//   viewer + super_admin         → hub admin nav (viewer is not an
//                                  aggregator profile so it falls
//                                  through to the admin branch)
//
// Everything is rendered with the existing `renderToDom` pattern
// (createRoot → flush → snapshot innerHTML → unmount).

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ── jsdom bootstrap ────────────────────────────────────────────────
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true },
);
const w = dom.window as unknown as Window & typeof globalThis;
function setG(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value, writable: true, configurable: true, enumerable: true,
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
  takeRecords() { return []; }
}
setG("IntersectionObserver", NoopObserver);
setG("ResizeObserver", NoopObserver);
setG("MutationObserver", w.MutationObserver);
const matchMedia = (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
});
setG("matchMedia", matchMedia);
(w as unknown as Record<string, unknown>).matchMedia = matchMedia;
(w as unknown as Record<string, unknown>).scrollTo = () => {};

// ── lazy imports (after globals) ───────────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { Router } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");

const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (/Missing getServerSnapshot/i.test(msg)) return;
  if (/not wrapped in act/i.test(msg)) return;
  origConsoleError(...args);
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
(globalThis as unknown as { __GIT_SHORT_HASH__: string }).__GIT_SHORT_HASH__ = "deadbee";

const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider, __setInitialUserForTests } = await import(
  "../src/lib/auth.tsx"
);
const { userFromLanAuthProfile } = await import("../src/lib/lan-user-map");
const installProfile = await import("../src/lib/install-profile.tsx");
const { HQLayout } = await import("../src/components/HQLayout");

type Role = "super_admin" | "commander" | "ops" | "deputy";
type Scope = "flight" | "squadron" | "wing" | "base" | "hq";
type UserShape = { username: string; displayName: string; role: Role; scope?: Scope };

function setSession(u: UserShape) {
  const ls = w.localStorage;
  ls.clear();
  ls.setItem("rjaf.user", JSON.stringify(u));
  ls.setItem("rjaf.licensed", "1");
  ls.setItem(
    "rjaf.squadron",
    JSON.stringify({ name: "NO.8", number: "NO.8", base: "MAFRAQ" }),
  );
  ls.setItem("rjaf.setupWizard.NO.8.complete", "1");
  __setInitialUserForTests(
    userFromLanAuthProfile(
      {
        id: u.username,
        username: u.username,
        displayName: u.displayName,
        role: u.scope ? `${u.role}:${u.scope}` : u.role,
        squadronId: null,
      },
      u.username,
    ),
  );
}

function withProviders(
  child: React.ReactElement,
  path: string,
  initialProfile: installProfile.InstallProfile,
): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path, static: true });
  return React.createElement(
    QueryClientProvider,
    { client: qc },
    React.createElement(
      I18nProvider,
      null,
      React.createElement(
        installProfile.InstallProfileProvider,
        { initialProfile },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            Router as unknown as React.ComponentType<{ hook: unknown; children: React.ReactNode }>,
            { hook },
            child,
          ),
        ),
      ),
    ),
  );
}

async function renderNav(
  user: UserShape,
  initialProfile: installProfile.InstallProfile,
  path = "/",
): Promise<string> {
  setSession(user);
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      withProviders(
        React.createElement(
          HQLayout,
          null,
          React.createElement("div", null, "child"),
        ),
        path,
        initialProfile,
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  const html = container.innerHTML;
  await act(async () => { root.unmount(); });
  container.remove();
  return html;
}

function assertHas(html: string, hrefs: string[], label: string) {
  for (const h of hrefs) {
    assert.ok(
      html.includes(`href="${h}"`),
      `${label}: expected nav link href="${h}" to be present`,
    );
  }
}
function assertMissing(html: string, hrefs: string[], label: string) {
  for (const h of hrefs) {
    assert.ok(
      !html.includes(`href="${h}"`),
      `${label}: nav link href="${h}" must NOT be present`,
    );
  }
}

// Centralised hub admin nav contract (used by hub super_admin and the
// viewer-profile super_admin fall-through case).
const HUB_ADMIN_NAV = [
  "/admin",
  "/admin/squadrons",
  "/admin/audit",
  "/admin/security",
  "/admin/health",
  "/admin/users",
  "/admin/peer-tokens",
  "/settings",
];

const HUB_FORBIDDEN_FOR_NON_ADMIN = [
  "/admin",
  "/admin/squadrons",
  "/admin/audit",
  "/admin/security",
  "/admin/health",
  "/admin/users",
  "/admin/peer-tokens",
  "/aggregate",
];

const AGGREGATOR_READ_NAV = [
  "/aggregate",
  "/aggregate/pilots",
  "/aggregate/sorties",
  "/aggregate/currencies",
  "/aggregate/leaves",
  "/aggregate/unavailable",
  "/aggregate/notams",
  "/aggregate/readiness",
  "/settings",
];

const AGGREGATOR_ADMIN_EXTRAS = [
  "/admin/peer-squadrons",
  "/admin/audit",
  "/admin/users",
];

const AGGREGATOR_FORBIDDEN_HUB = [
  "/admin",
  "/admin/squadrons",
  "/admin/security",
  "/admin/health",
  "/admin/peer-tokens",
  "/dashboard",
  "/dashboard/pilots",
];

// ── hub × roles ────────────────────────────────────────────────────
test("nav-matrix · hub + super_admin shows the full admin sidebar", async () => {
  const html = await renderNav(
    { username: "alice", displayName: "Alice", role: "super_admin" },
    "hub",
    "/admin",
  );
  assertHas(html, HUB_ADMIN_NAV, "hub super_admin");
  assertMissing(html, ["/aggregate", "/dashboard"], "hub super_admin");
});

for (const r of [
  { role: "commander" as Role, scope: "wing" as Scope, label: "wing commander" },
  { role: "commander" as Role, scope: "squadron" as Scope, label: "squadron commander" },
  { role: "commander" as Role, scope: "flight" as Scope, label: "flight commander" },
  { role: "ops" as Role, scope: "squadron" as Scope, label: "ops officer" },
  { role: "deputy" as Role, scope: "squadron" as Scope, label: "deputy" },
]) {
  test(`nav-matrix · hub + ${r.label} sees dashboard nav and never hub admin/aggregator nav`, async () => {
    const html = await renderNav(
      { username: r.role, displayName: r.label, role: r.role, scope: r.scope },
      "hub",
      "/dashboard",
    );
    assertHas(
      html,
      ["/dashboard", "/dashboard/pilots", "/dashboard/alerts", "/dashboard/currencies", "/dashboard/sticky", "/dashboard/settings"],
      `hub ${r.label}`,
    );
    assertMissing(html, HUB_FORBIDDEN_FOR_NON_ADMIN, `hub ${r.label}`);
  });
}

// ── aggregator profiles × roles ───────────────────────────────────
for (const profile of ["aggregator-wing", "aggregator-base"] as const) {
  test(`nav-matrix · ${profile} + super_admin shows the aggregator nav with admin extras`, async () => {
    const html = await renderNav(
      { username: "admin", displayName: "Admin", role: "super_admin" },
      profile,
      "/aggregate",
    );
    assertHas(html, AGGREGATOR_READ_NAV, `${profile} super_admin`);
    assertHas(html, AGGREGATOR_ADMIN_EXTRAS, `${profile} super_admin`);
    assertMissing(html, AGGREGATOR_FORBIDDEN_HUB, `${profile} super_admin`);
  });

  for (const r of [
    { role: "commander" as Role, scope: "wing" as Scope, label: "wing commander" },
    { role: "commander" as Role, scope: "squadron" as Scope, label: "squadron commander" },
    { role: "ops" as Role, scope: "squadron" as Scope, label: "ops officer" },
    { role: "deputy" as Role, scope: "squadron" as Scope, label: "deputy" },
  ]) {
    test(`nav-matrix · ${profile} + ${r.label} sees aggregator read nav only (no admin extras)`, async () => {
      const html = await renderNav(
        { username: r.role, displayName: r.label, role: r.role, scope: r.scope },
        profile,
        "/aggregate",
      );
      assertHas(html, AGGREGATOR_READ_NAV, `${profile} ${r.label}`);
      assertMissing(html, AGGREGATOR_ADMIN_EXTRAS, `${profile} ${r.label}`);
      assertMissing(html, AGGREGATOR_FORBIDDEN_HUB, `${profile} ${r.label}`);
    });
  }
}

// ── viewer profile (treated as hub for nav purposes) ───────────────
test("nav-matrix · viewer + super_admin falls through to hub admin nav", async () => {
  const html = await renderNav(
    { username: "alice", displayName: "Alice", role: "super_admin" },
    "viewer",
    "/admin",
  );
  // viewer is NOT an aggregator profile, so the admin branch wins.
  assertHas(html, HUB_ADMIN_NAV, "viewer super_admin");
  assertMissing(html, ["/aggregate", "/dashboard"], "viewer super_admin");
});

// ── teardown ──────────────────────────────────────────────────────
test("nav-matrix · teardown jsdom", () => {
  try {
    (dom.window as unknown as { close?: () => void }).close?.();
  } catch {
    /* best-effort */
  }
});
