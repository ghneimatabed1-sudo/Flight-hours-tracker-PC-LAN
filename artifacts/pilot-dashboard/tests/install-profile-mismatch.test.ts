// E2E (jsdom) test for the install-profile-mismatch banner on the
// LoginGate (Task #391, gap closed under #406).
//
// The dashboard build bakes `VITE_EXPECTED_INSTALL_PROFILE` (the
// install-time pin) into the bundle. On boot the dashboard probes
// `/api/healthz` for the running api-server's `installProfile`. When
// the two disagree the LoginGate must:
//
//   1. Render the red "Install profile mismatch" banner with the
//      correct expected/actual values.
//   2. *Block* the sign-in submit so the operator can never funnel
//      writes into the wrong topology (e.g. an aggregator front
//      hitting a hub backend).
//
// The hard-stop in onSubmit is the new piece — without it the banner
// was advisory only and #391 lab tests showed operators clicking past
// it. This test pins both halves so a future refactor can't quietly
// drop the block.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:install-profile-mismatch

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.TSX_TSCONFIG_PATH = resolve(__dirname, "tsconfig.json");

// ── jsdom bootstrap ────────────────────────────────────────────────
const dom = new JSDOM(
  "<!doctype html><html><body><div id=\"root\"></div></body></html>",
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
  matches: false,
  media: q,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// Seed the env BEFORE any dashboard module loads. The jsdom-env
// loader rewrites `import.meta.env` to read this object.
const TEST_ENV: Record<string, unknown> = {
  VITE_EXPECTED_INSTALL_PROFILE: "hub",
};
(globalThis as unknown as { __HAWK_TEST_VITE_ENV: typeof TEST_ENV })
  .__HAWK_TEST_VITE_ENV = TEST_ENV;

// ── lazy imports ──────────────────────────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider, __setInitialUserForTests } = await import(
  "../src/lib/auth.tsx"
);
const installProfile = await import("../src/lib/install-profile");
const LoginGate = (await import("../src/pages/Login")).default;
const apiClient = await import("../src/lib/api-client");

// Suppress noisy console output during the test runs.
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (/not wrapped in act/i.test(msg)) return;
  if (/wouter/i.test(msg)) return;
  origConsoleError(...args);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function flush() {
  await act(async () => { await sleep(0); });
  await act(async () => { await sleep(0); });
}

interface MountOpts {
  expectedProfile: string;
  actualProfile: installProfile.InstallProfile;
}

async function mountLogin(opts: MountOpts) {
  // Tweak the env between tests — the loader's rewrite reads it live.
  TEST_ENV.VITE_EXPECTED_INSTALL_PROFILE = opts.expectedProfile;

  // Reset module-level state between mounts so prior tests don't
  // leave a signed-in user or stale api-client wiring behind.
  __setInitialUserForTests(null);
  apiClient._resetApiClientStateForTests();
  w.localStorage.clear();
  w.sessionStorage.clear();

  const el = w.document.getElementById("root")!;
  while (el.firstChild) el.removeChild(el.firstChild);
  const root = createRoot(el);

  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(
          installProfile.InstallProfileProvider,
          { initialProfile: opts.actualProfile },
          React.createElement(AuthProvider, null,
            React.createElement(LoginGate),
          ),
        ),
      ),
    );
  });
  await flush();

  return {
    async unmount() {
      await act(async () => { root.unmount(); });
    },
  };
}

function $(sel: string): HTMLElement | null {
  return w.document.querySelector(sel);
}

function fillCredentials(username = "admin", password = "secret") {
  const u = $("[data-testid=input-login-username]") as HTMLInputElement;
  const p = $("[data-testid=input-login-password]") as HTMLInputElement;
  // React-controlled inputs need the value mutated through the
  // native setter so React's onChange picks up the synthetic event.
  const desc = Object.getOwnPropertyDescriptor(
    w.HTMLInputElement.prototype,
    "value",
  )!;
  desc.set!.call(u, username);
  u.dispatchEvent(new w.Event("input", { bubbles: true }));
  desc.set!.call(p, password);
  p.dispatchEvent(new w.Event("input", { bubbles: true }));
}

// ── tests ───────────────────────────────────────────────────────────

test("install-profile-mismatch: matching profile renders no banner and login submit is enabled", async () => {
  const m = await mountLogin({
    expectedProfile: "hub",
    actualProfile: "hub",
  });
  try {
    assert.equal(
      $("[data-testid=banner-install-profile-mismatch]"),
      null,
      "banner must NOT render when expected and actual agree",
    );
    await act(async () => { fillCredentials(); });
    await flush();
    const btn = $("[data-testid=button-login-submit]") as
      HTMLButtonElement | null;
    assert.ok(btn, "submit button must render");
    assert.equal(
      btn!.disabled,
      false,
      "submit must be enabled in the matching-profile case",
    );
  } finally {
    await m.unmount();
  }
});

test("install-profile-mismatch: aggregator-wing api-server with hub-pinned build renders the red banner", async () => {
  const m = await mountLogin({
    expectedProfile: "hub",
    actualProfile: "aggregator-wing",
  });
  try {
    const banner = $("[data-testid=banner-install-profile-mismatch]");
    assert.ok(banner, "banner must render when expected != actual");
    const text = banner!.textContent ?? "";
    // Banner must surface BOTH the expected and the actual profile so
    // the operator knows which side to fix.
    assert.match(text, /hub/i, "banner must show the expected profile");
    assert.match(
      text,
      /aggregator-wing/i,
      "banner must show the actual profile reported by api-server",
    );
  } finally {
    await m.unmount();
  }
});

test("install-profile-mismatch: submitting blocks login with a clear error and never calls auth.login()", async () => {
  const m = await mountLogin({
    expectedProfile: "hub",
    actualProfile: "aggregate-base",
  });
  try {
    // The banner must be visible BEFORE we even try to sign in.
    assert.ok(
      $("[data-testid=banner-install-profile-mismatch]"),
      "banner must be visible up-front",
    );

    // Type credentials and try to submit. Without the hard-stop in
    // onSubmit, the form would call auth.login() and the test would
    // see an HTTP-level rejection from a network we never set up.
    await act(async () => { fillCredentials(); });
    await flush();

    const form = w.document.querySelector("form");
    assert.ok(form, "login form must exist");
    await act(async () => {
      form!.dispatchEvent(
        new w.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flush();

    const errorEl = $("[data-testid=text-login-error]");
    assert.ok(
      errorEl,
      "submitting with profile-mismatch must surface a login error",
    );
    assert.match(
      errorEl!.textContent ?? "",
      /install_profile_mismatch/,
      "error must call out the profile mismatch by name",
    );

    // Banner is still on screen — the block is sticky until the
    // operator fixes the install.
    assert.ok(
      $("[data-testid=banner-install-profile-mismatch]"),
      "banner must remain visible after the blocked submit",
    );
  } finally {
    await m.unmount();
  }
});

// NOTE on the empty-VITE_EXPECTED_INSTALL_PROFILE branch: Login.tsx
// reads `EXPECTED_INSTALL_PROFILE` at module-evaluation time
// (a top-level IIFE), so once the module is loaded the value can't
// be flipped between sub-tests in this file. The "no expected
// profile" branch is covered by `failure-mode-banners.test.ts`,
// which loads its own module instance with an empty env.
