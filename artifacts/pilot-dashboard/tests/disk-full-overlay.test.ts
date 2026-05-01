// E2E (jsdom) test for the DiskFullOverlay (#384, #406).
//
// Spec: when the global fetch interceptor sees an HTTP 507 response
// with body `{ error: "disk_full" }`, the red overlay must mount and
// be visible. Clicking the "I've fixed it, retry" button must call
// `/api/healthz`; a 200 dismisses the overlay, a non-200 leaves it up
// and shows the secondary "retry failed" hint.
//
// Existing coverage in `failure-mode-banners.test.ts` only exercised
// the SSR string render path with the test seam (`_setDiskFullForTests`).
// This test wires the *real* fetch interceptor against a stubbed
// `window.fetch` so a regression in interceptor body-peeking, the
// 200/non-200 branch in `retryAfterDiskFull`, or the React act/state
// flush around the retry button is caught.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:disk-full-overlay

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
setG("HTMLElement", w.HTMLElement);
setG("Element", w.Element);
setG("Node", w.Node);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// `getInternalApiHealthUrl()` returns null when neither
// `VITE_INTERNAL_API_URL` nor a Vite dev proxy is wired up. The
// jsdom-env loader rewrites every `import.meta.env` reference to
// `globalThis.__HAWK_TEST_VITE_ENV`; seed a fake internal base
// **before** any dashboard module is imported so `retryAfterDiskFull()`
// actually issues the healthz call we stub below.
(globalThis as unknown as { __HAWK_TEST_VITE_ENV: Record<string, unknown> })
  .__HAWK_TEST_VITE_ENV = {
  VITE_INTERNAL_API_URL: "http://hawk-api.test",
};

// ── lazy imports (after jsdom + env) ──────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const apiClient = await import("../src/lib/api-client");
const DiskFullOverlay = (await import("../src/components/DiskFullOverlay"))
  .default;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function flush() {
  await act(async () => { await sleep(0); });
}

// ── fetch stubbing ──────────────────────────────────────────────────
type StubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let nextFetchHandler: StubFetch = async () =>
  new Response("not stubbed", { status: 500 });

function setNextFetch(handler: StubFetch) {
  nextFetchHandler = handler;
}

function rebindFetch() {
  // Reset interceptor and install our stub fetch on `window.fetch`,
  // then let api-client wrap it once. The interceptor patches
  // `window.fetch` in place, so our stub becomes the inner call.
  apiClient._resetApiClientStateForTests();
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nextFetchHandler(input, init)) as typeof w.fetch;
  // Mirror onto globalThis so calls via the global `fetch` symbol use
  // the same stub. `getInternalApiHealthUrl` callers may use either
  // form depending on the call site.
  setG("fetch", w.fetch);
  apiClient.installFetchInterceptor();
}

// Helpful wrapper to mount the overlay inside the I18nProvider.
async function mountOverlay() {
  const el = w.document.getElementById("root")!;
  while (el.firstChild) el.removeChild(el.firstChild);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(DiskFullOverlay),
      ),
    );
  });
  return {
    root,
    async unmount() {
      await act(async () => { root.unmount(); });
    },
  };
}

function diskFullResponse(): Response {
  return new Response(JSON.stringify({ error: "disk_full" }), {
    status: 507,
    headers: { "Content-Type": "application/json" },
  });
}

function healthzOkResponse(): Response {
  // `fetchInternalApiHealth` requires `status === "ok"`. Without it
  // the helper reports `ok: false` even on HTTP 200, which would
  // leave the overlay up.
  return new Response(
    JSON.stringify({ status: "ok", apiServerVersion: "1.1.110" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── tests ───────────────────────────────────────────────────────────

test("disk-full overlay: hidden by default; mounts after a 507 disk_full response", async () => {
  rebindFetch();
  const m = await mountOverlay();
  try {
    // Before any 507 has flown by: overlay is not rendered.
    assert.equal(
      w.document.querySelector("[data-testid=disk-full-overlay]"),
      null,
      "overlay must be hidden until a 507 disk_full lands",
    );

    // Fire a fetch that returns 507 — the api-client interceptor
    // should peek the body, see `disk_full`, and flip the module flag.
    setNextFetch(async () => diskFullResponse());
    await act(async () => {
      const res = await w.fetch("/api/sorties");
      // Caller must still be able to read the response — the
      // interceptor may only `clone()` it, never consume it.
      assert.equal(res.status, 507);
    });
    await flush();

    const overlay = w.document.querySelector(
      "[data-testid=disk-full-overlay]",
    );
    assert.ok(overlay, "overlay must mount after a 507 disk_full response");
    const retryBtn = w.document.querySelector(
      "[data-testid=disk-full-retry]",
    ) as HTMLButtonElement | null;
    assert.ok(retryBtn, "retry button must be visible inside the overlay");
    assert.equal(retryBtn!.disabled, false);
  } finally {
    await m.unmount();
  }
});

test("disk-full overlay: clicking Retry → 200 healthz dismisses the overlay", async () => {
  rebindFetch();
  const m = await mountOverlay();
  try {
    // Trip the overlay first.
    setNextFetch(async () => diskFullResponse());
    await act(async () => { await w.fetch("/api/sorties"); });
    await flush();
    assert.ok(
      w.document.querySelector("[data-testid=disk-full-overlay]"),
      "overlay must be visible before retry",
    );

    // Operator fixes the disk; healthz now answers 200.
    let healthzCalls = 0;
    setNextFetch(async (input) => {
      const url = String(input);
      if (url.includes("/api/healthz")) {
        healthzCalls++;
        return healthzOkResponse();
      }
      return new Response("unexpected", { status: 500 });
    });

    const retryBtn = w.document.querySelector(
      "[data-testid=disk-full-retry]",
    ) as HTMLButtonElement;
    await act(async () => { retryBtn.click(); });
    await flush();

    assert.equal(healthzCalls, 1, "retry must hit /api/healthz exactly once");
    assert.equal(
      w.document.querySelector("[data-testid=disk-full-overlay]"),
      null,
      "overlay must unmount once healthz returns 200",
    );
    assert.equal(
      apiClient.isDiskFull(),
      false,
      "module-level disk-full flag must clear after a successful retry",
    );
  } finally {
    await m.unmount();
  }
});

test("disk-full overlay: failed Retry leaves overlay up and surfaces retry-failed hint", async () => {
  rebindFetch();
  const m = await mountOverlay();
  try {
    setNextFetch(async () => diskFullResponse());
    await act(async () => { await w.fetch("/api/sorties"); });
    await flush();

    // Operator clicks retry but the disk is still full → healthz 503.
    setNextFetch(async (input) => {
      if (String(input).includes("/api/healthz")) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const retryBtn = w.document.querySelector(
      "[data-testid=disk-full-retry]",
    ) as HTMLButtonElement;
    await act(async () => { retryBtn.click(); });
    await flush();

    assert.ok(
      w.document.querySelector("[data-testid=disk-full-overlay]"),
      "overlay must stay up when healthz still fails",
    );
    assert.ok(
      w.document.querySelector("[data-testid=disk-full-retry-failed]"),
      "the secondary 'retry failed' hint must be shown",
    );
    assert.equal(
      apiClient.isDiskFull(),
      true,
      "module-level disk-full flag must remain set",
    );
  } finally {
    await m.unmount();
  }
});
