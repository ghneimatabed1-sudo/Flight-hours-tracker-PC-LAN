// Render-variant tests for `FirstLaunchPairingCard`. We mount the
// real component under jsdom + react-dom/client + act and stub the
// LAN api-server with a `globalThis.fetch` interceptor, so each test
// asserts the visible UI for one branch of the view-state machine:
//
//   1. loading → no-hubs       (discovery returns empty list)
//   2. loading → ready         (discovery returns one hub; pair
//                               button click posts the request)
//   3. loading → in-flight     (outbox already contains a pending row)
//   4. loading → approved      (outbox contains a paired row → onPaired
//                               callback fires with token info)
//
// Pattern mirrors `peer-tokens-page.test.ts` — same loader hook
// (`peer-tokens-page-loader.mjs`) so static asset / CSS imports
// resolve and `import.meta.env` is rewritten to read our test-only
// `globalThis.__HAWK_TEST_VITE_ENV`.

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
    VITE_LAN_SESSION_LOGIN: "1",
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
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("HTMLInputElement", w.HTMLInputElement);
setG("HTMLButtonElement", w.HTMLButtonElement);
setG("HTMLDivElement", w.HTMLDivElement);
setG("Element", w.Element);
setG("Node", w.Node);
setG("Event", w.Event);
setG("CustomEvent", w.CustomEvent);
setG("KeyboardEvent", w.KeyboardEvent);
setG("MouseEvent", w.MouseEvent);
setG("FocusEvent", w.FocusEvent);
setG("PointerEvent", w.PointerEvent ?? w.MouseEvent);
setG("EventTarget", w.EventTarget);
setG("DOMRect", w.DOMRect);
setG("getComputedStyle", w.getComputedStyle.bind(w));
setG("requestAnimationFrame", (cb: FrameRequestCallback) =>
  Number(setTimeout(() => cb(performance.now()), 16)));
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
setG("matchMedia", (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
}));

// Suppress noisy SSR-style act warnings.
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (/not wrapped in act/i.test(msg)) return;
  origConsoleError(...args);
};

// ── mocked LAN api-server (fetch interceptor) ──────────────────────
type DiscoveryReport = {
  enabled: boolean;
  self: { hostname: string; role: string } | null;
  peers: Array<{
    hostname: string;
    role: string;
    address: string;
    port: number;
    last_seen_at: string;
    txt: Record<string, string>;
  }>;
};
type OutboundRow = {
  id: string;
  hub_hostname: string;
  hub_address: string;
  status: string;
  received_token_id: string | null;
  received_token_label: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
};

let discoveryReport: DiscoveryReport = {
  enabled: true,
  self: { hostname: "wing-pc-02", role: "aggregator-wing" },
  peers: [],
};
let outbox: OutboundRow[] = [];
let postedRequests: Array<{ url: string; body: unknown }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchImpl = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url = typeof input === "string"
    ? input
    : (input as { url?: string }).url ?? String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  let parsedBody: unknown = undefined;
  if (init?.body != null) {
    try { parsedBody = JSON.parse(String(init.body)); } catch { parsedBody = init.body; }
  }

  // Auth boot. The card itself doesn't render auth, but `i18n` and
  // helpers ride on the same env wiring used by other tests, so be
  // defensive and answer the lan/me probe with a super_admin user.
  if (url.endsWith("/api/internal/auth/lan/me") && method === "GET") {
    return jsonResponse({
      ok: true,
      user: {
        id: "u-super",
        username: "alice",
        displayName: "Alice Admin",
        role: "super_admin",
        squadronId: null,
      },
    });
  }

  if (url.endsWith("/api/internal/lan-discovery/peers") && method === "GET") {
    return jsonResponse(discoveryReport);
  }
  if (url.endsWith("/api/internal/lan-pairing/outbox") && method === "GET") {
    return jsonResponse({ items: outbox });
  }
  if (url.endsWith("/api/internal/lan-pairing/request") && method === "POST") {
    postedRequests.push({ url, body: parsedBody });
    const body = (parsedBody ?? {}) as { hub_hostname: string; hub_address: string };
    const id = `out-${outbox.length + 1}`;
    outbox = [
      {
        id,
        hub_hostname: body.hub_hostname,
        hub_address: body.hub_address,
        status: "pending",
        received_token_id: null,
        received_token_label: null,
        error_detail: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      ...outbox,
    ];
    return jsonResponse({ id }, 202);
  }
  if (/\/api\/internal\/lan-pairing\/outbox\/[^/]+$/.test(url) && method === "DELETE") {
    const id = url.split("/").pop() ?? "";
    outbox = outbox.filter((r) => r.id !== id);
    return jsonResponse({ ok: true });
  }
  // Catch-all: anything else from i18n / helpers we don't care about.
  return jsonResponse({ ok: true });
};

setG("fetch", fetchImpl);
w.localStorage.setItem("rjaf.lanSessionToken", "test-session-token");

// ── render harness ─────────────────────────────────────────────────
async function mountCard(opts: {
  onPaired?: (info: { tokenId: string; tokenLabel: string | null; hubHostname: string }) => void;
  required?: boolean;
} = {}): Promise<{
  container: HTMLDivElement;
  unmount: () => Promise<void>;
  flush: (ms?: number) => Promise<void>;
  waitFor: <T>(probe: () => T | null | undefined, label: string, timeoutMs?: number) => Promise<T>;
}> {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../src/lib/i18n.tsx");
  const { default: FirstLaunchPairingCard } = await import(
    "../src/components/FirstLaunchPairingCard.tsx"
  );

  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);

  const tree = React.createElement(
    I18nProvider,
    null,
    React.createElement(FirstLaunchPairingCard, {
      onPaired: opts.onPaired,
      required: opts.required,
    }),
  );

  await act(async () => { root.render(tree); });

  const flush = async (ms = 60) => {
    await act(async () => { await new Promise<void>((r) => setTimeout(r, ms)); });
  };

  async function waitFor<T>(
    probe: () => T | null | undefined,
    label: string,
    timeoutMs = 4000,
  ): Promise<T> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = probe();
      if (hit) return hit;
      await flush(40);
    }
    const snippet = (container.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    throw new Error(`timeout waiting for ${label}. body snippet: ${snippet}`);
  }

  const unmount = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  };

  return { container: container as HTMLDivElement, unmount, flush, waitFor };
}

function resetMockState() {
  discoveryReport = {
    enabled: true,
    self: { hostname: "wing-pc-02", role: "aggregator-wing" },
    peers: [],
  };
  outbox = [];
  postedRequests = [];
}

// ── tests ──────────────────────────────────────────────────────────

test("FirstLaunchPairingCard · renders no-hubs when discovery is empty", async () => {
  resetMockState();
  const { container, unmount, waitFor } = await mountCard();
  // Card always shows the title + the loading spinner first.
  await waitFor(
    () => container.querySelector('[data-testid="first-launch-pairing-card"]'),
    "first-launch-pairing-card root",
  );
  await waitFor(
    () => container.querySelector('[data-testid="state-no-hubs"]'),
    "state-no-hubs after empty discovery report",
  );
  // Reload button is visible so the operator can re-scan manually.
  assert.ok(
    container.querySelector('[data-testid="button-reload"]'),
    "reload button should render in no-hubs state",
  );
  // Manual-fallback hint is shown when `required` is not set.
  assert.match(
    (container.textContent ?? "").toLowerCase(),
    /manual|setup-aggregator|powershell/i,
    "manual-fallback hint should appear when not required",
  );
  await unmount();
});

test("FirstLaunchPairingCard · ready state lists hubs and POST request flips to in-flight", async () => {
  resetMockState();
  discoveryReport = {
    enabled: true,
    self: { hostname: "wing-pc-02", role: "aggregator-wing" },
    peers: [
      {
        hostname: "hq-hub.local",
        role: "hub",
        address: "10.0.0.10",
        port: 80,
        last_seen_at: new Date().toISOString(),
        txt: { squadron: "NO.8", version: "1.1.110" },
      },
    ],
  };
  const { container, unmount, flush, waitFor } = await mountCard();

  const hubRow = await waitFor(
    () => container.querySelector('[data-testid="hub-row-hq-hub.local"]'),
    "hub-row-hq-hub.local",
  );
  assert.match(hubRow.textContent ?? "", /hq-hub\.local/);
  assert.match(hubRow.textContent ?? "", /10\.0\.0\.10/);
  assert.match(hubRow.textContent ?? "", /NO\.8/);
  assert.match(hubRow.textContent ?? "", /v1\.1\.110/);

  const pairBtn = container.querySelector('[data-testid="button-pair-hq-hub.local"]') as HTMLButtonElement | null;
  assert.ok(pairBtn, "pair button should be present");
  await act(async () => { pairBtn!.click(); });
  await flush(120);

  // The POST should have been recorded with the discovered hub coords.
  assert.equal(postedRequests.length, 1, "exactly one pairing request POST");
  assert.deepEqual(postedRequests[0]!.body, {
    hub_hostname: "hq-hub.local",
    hub_address: "10.0.0.10",
    hub_port: 80,
  });

  // The card flips to in-flight because the next outbox poll returns
  // the pending row we just inserted.
  await waitFor(
    () => container.querySelector('[data-testid="state-inflight"]'),
    "state-inflight after pair POST",
  );
  assert.ok(
    container.querySelector('[data-testid="button-cancel"]'),
    "cancel button should be present in in-flight state",
  );
  await unmount();
});

test("FirstLaunchPairingCard · in-flight state appears when outbox already has pending row", async () => {
  resetMockState();
  outbox = [{
    id: "out-pre-1",
    hub_hostname: "hq-hub.local",
    hub_address: "10.0.0.10",
    status: "pending",
    received_token_id: null,
    received_token_label: null,
    error_detail: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }];
  const { container, unmount, waitFor } = await mountCard();
  await waitFor(
    () => container.querySelector('[data-testid="state-inflight"]'),
    "state-inflight on first render with pending outbox",
  );
  // No-hubs / ready / approved branches must not be present.
  assert.equal(container.querySelector('[data-testid="state-no-hubs"]'), null);
  assert.equal(container.querySelector('[data-testid="state-ready"]'), null);
  assert.equal(container.querySelector('[data-testid="state-approved"]'), null);
  await unmount();
});

test("FirstLaunchPairingCard · approved state fires onPaired with token info", async () => {
  resetMockState();
  outbox = [{
    id: "out-paired-1",
    hub_hostname: "hq-hub.local",
    hub_address: "10.0.0.10",
    status: "paired",
    received_token_id: "tok-22222222",
    received_token_label: "wing-pc-02",
    error_detail: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }];

  const callbacks: Array<{ tokenId: string; tokenLabel: string | null; hubHostname: string }> = [];
  const { container, unmount, waitFor } = await mountCard({
    onPaired: (info) => callbacks.push(info),
  });

  await waitFor(
    () => container.querySelector('[data-testid="state-approved"]'),
    "state-approved on first render with paired outbox row",
  );
  assert.ok(
    callbacks.length >= 1,
    "onPaired should have been invoked at least once",
  );
  assert.deepEqual(callbacks[0], {
    tokenId: "tok-22222222",
    tokenLabel: "wing-pc-02",
    hubHostname: "hq-hub.local",
  });

  // Manual-fallback hint should be hidden in approved state.
  const card = container.querySelector('[data-testid="first-launch-pairing-card"]');
  assert.ok(card);
  assert.doesNotMatch(
    (card.textContent ?? "").toLowerCase(),
    /manual fallback/i,
    "manual-fallback hint must not render in approved state",
  );
  await unmount();
});
