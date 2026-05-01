// E2E (jsdom) test for the LAN-broadcast badge a.k.a. `MdnsHealthCard`
// (Task #398, gap closed under #406).
//
// The card is the operator's only signal that the LAN mDNS supervisor
// is actually broadcasting hub discovery to other PCs. It has seven
// distinct visual states driven by the structured response from
// `/api/internal/system/mdns-health`. Every regression spotted in
// triage so far ("badge stuck on starting", "stale not red", "disabled
// is too noisy") has been a state-mapping bug, so this test pins each
// state's outward signal — the `data-mdns-state` attribute on the
// card and the rendered badge text.
//
// We mock `fetchInternalMdnsHealth` directly via the api-client style
// of dependency injection: install a one-shot `globalThis.fetch` stub
// that returns the structured payload the card expects, then mount
// the card and wait for its initial-load effect to flush.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:lan-broadcast-badge

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

// `getInternalApiPath()` returns null without `VITE_INTERNAL_API_URL`,
// which would short-circuit `fetchInternalMdnsHealth` straight to the
// "internal_api_disabled" branch and *hide* the card. Seed a fake URL
// before any module loads so the card actually queries the network.
(globalThis as unknown as { __HAWK_TEST_VITE_ENV: Record<string, unknown> })
  .__HAWK_TEST_VITE_ENV = {
  VITE_INTERNAL_API_URL: "http://hawk-api.test",
};

// ── lazy imports (after jsdom + env) ──────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { MdnsHealthCard } = await import(
  "../src/components/MdnsHealthCard"
);
import type { MdnsBadgeState } from "../src/lib/internal-migration";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function flushEffect() {
  // The card's first-load effect fires on mount, awaits a fetch, then
  // calls setState. Two microtask flushes are enough for that chain.
  await act(async () => { await sleep(0); });
  await act(async () => { await sleep(0); });
}

type StubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let fetchHandler: StubFetch = async () =>
  new Response("not stubbed", { status: 500 });

// `MdnsHealthCard` reads through whatever `fetchInternalMdnsHealth`
// dispatches, which under jsdom is the global `fetch`. Pin both
// `window.fetch` and `globalThis.fetch` so callers landing on either
// global hit our stub.
function setFetch(handler: StubFetch) {
  fetchHandler = handler;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof w.fetch;
  w.fetch = wrapped;
  setG("fetch", wrapped);
}

async function mountCard() {
  const el = w.document.getElementById("root")!;
  while (el.firstChild) el.removeChild(el.firstChild);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(MdnsHealthCard),
      ),
    );
  });
  await flushEffect();
  return {
    async unmount() {
      await act(async () => { root.unmount(); });
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function aliveReport(state: MdnsBadgeState) {
  return {
    state,
    supervisorState: state === "alive" ? "running" : "starting",
    ageSec: state === "stale" ? 95 : 4,
    staleThresholdSec: 60,
    restartCount: state === "restarting" ? 2 : 0,
    squadronName: "NO.8",
    apiPort: "3847",
    timestamp: "2026-04-30T12:00:00.000Z",
    heartbeatPath:
      "C:\\ProgramData\\HawkEye\\mdns-supervisor.heartbeat",
  };
}

function findCard(): HTMLElement {
  const card = w.document.querySelector(
    "[data-testid=mdns-health-card]",
  );
  assert.ok(card, "mdns-health-card must be rendered");
  return card as HTMLElement;
}

// ── tests ───────────────────────────────────────────────────────────

test("mdns badge: 'alive' renders the green ALIVE badge", async () => {
  setFetch(async () =>
    jsonResponse({ ok: true, report: aliveReport("alive") }),
  );
  const m = await mountCard();
  try {
    const card = findCard();
    assert.equal(card.getAttribute("data-mdns-state"), "alive");
    assert.match(
      card.textContent ?? "",
      /alive/i,
      "card body must surface the alive label",
    );
  } finally {
    await m.unmount();
  }
});

test("mdns badge: 'stale' renders the red STALE badge with age + threshold", async () => {
  setFetch(async () =>
    jsonResponse({ ok: true, report: aliveReport("stale") }),
  );
  const m = await mountCard();
  try {
    const card = findCard();
    assert.equal(card.getAttribute("data-mdns-state"), "stale");
    // Stale message includes the heartbeat age and the stale threshold,
    // so the operator can see *how* stale.
    assert.match(card.textContent ?? "", /95s/);
    assert.match(card.textContent ?? "", /60s/);
  } finally {
    await m.unmount();
  }
});

test("mdns badge: 'restarting' renders the amber RESTARTING badge", async () => {
  setFetch(async () =>
    jsonResponse({ ok: true, report: aliveReport("restarting") }),
  );
  const m = await mountCard();
  try {
    const card = findCard();
    assert.equal(card.getAttribute("data-mdns-state"), "restarting");
    assert.match(card.textContent ?? "", /restart/i);
  } finally {
    await m.unmount();
  }
});

test("mdns badge: 'spawn-failed' renders the red SPAWN-FAILED badge with operator hint", async () => {
  setFetch(async () =>
    jsonResponse({ ok: true, report: aliveReport("spawn-failed") }),
  );
  const m = await mountCard();
  try {
    const card = findCard();
    assert.equal(card.getAttribute("data-mdns-state"), "spawn-failed");
    // Operator-actionable: the card surfaces the PowerShell command
    // they should run when the supervisor cannot spawn.
    assert.match(card.textContent ?? "", /check-mdns-health\.ps1/);
  } finally {
    await m.unmount();
  }
});

test("mdns badge: 'starting' renders the slate STARTING badge (no false alarm during boot)", async () => {
  setFetch(async () =>
    jsonResponse({ ok: true, report: aliveReport("starting") }),
  );
  const m = await mountCard();
  try {
    const card = findCard();
    assert.equal(card.getAttribute("data-mdns-state"), "starting");
    assert.match(card.textContent ?? "", /start/i);
  } finally {
    await m.unmount();
  }
});

test("mdns badge: 'disabled' (404 mdns_disabled) renders a quiet DISABLED card", async () => {
  setFetch(async (input) => {
    // The fetcher tries the hub path first then aggregator; a 404
    // with `error: "mdns_disabled"` on the first hit short-circuits
    // to the disabled branch.
    return jsonResponse({ error: "mdns_disabled" }, 404);
  });
  const m = await mountCard();
  try {
    const card = findCard();
    assert.equal(card.getAttribute("data-mdns-state"), "disabled");
    assert.match(card.textContent ?? "", /disabled/i);
  } finally {
    await m.unmount();
  }
});

test("mdns badge: server error renders the red UNREADABLE error card", async () => {
  setFetch(async () =>
    jsonResponse({ ok: false, error: "internal" }, 500),
  );
  const m = await mountCard();
  try {
    const card = findCard();
    // The error branch does not set `data-mdns-state` (no report
    // available) but the badge text must still scream UNREADABLE so
    // the operator sees something is wrong.
    assert.match(card.textContent ?? "", /unreadable/i);
    assert.match(card.textContent ?? "", /http_500/);
  } finally {
    await m.unmount();
  }
});

test("mdns badge: hides the card entirely when the internal API is disabled (cloud-only)", async () => {
  // Wipe the env for this single test so `getInternalApiPath` returns
  // null and the very first fetch result is `internal_api_disabled`.
  // The card must not mount AT ALL — System Health stays clean for
  // operators on a cloud-only build.
  const env = (globalThis as unknown as {
    __HAWK_TEST_VITE_ENV: Record<string, unknown>;
  }).__HAWK_TEST_VITE_ENV;
  const saved = env.VITE_INTERNAL_API_URL;
  env.VITE_INTERNAL_API_URL = "";
  try {
    setFetch(async () =>
      jsonResponse({ ok: false, error: "internal_api_disabled" }, 200),
    );
    const m = await mountCard();
    try {
      const card = w.document.querySelector(
        "[data-testid=mdns-health-card]",
      );
      assert.equal(
        card,
        null,
        "card must not render when the internal API is unreachable",
      );
    } finally {
      await m.unmount();
    }
  } finally {
    env.VITE_INTERNAL_API_URL = saved;
  }
});
