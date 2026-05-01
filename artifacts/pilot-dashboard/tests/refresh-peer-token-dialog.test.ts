// Focused end-to-end test for `RefreshPeerTokenDialog` — the modal
// the aggregator dashboard pops when a peer squadron's token rotates
// out from under it (the next health probe comes back 401 with body
// `invalid_token` or `revoked_token`).
//
// The smoke + button-state contract is already covered by the
// `aggregator-ui.test.ts` suite; this file walks the full operator
// flow end-to-end against a mocked LAN api-server:
//
//   1. paste a token, click Test → mocked probe returns
//      `{ok:false, error_kind:"auth_revoked"}` → dialog renders the
//      localized "still revoked" reason
//   2. paste a different token, click Test → mocked probe returns
//      `{ok:true}` → dialog renders the green "✓ probe ok" line
//   3. click Save → mocked PATCH returns `{ok:true}` → dialog calls
//      onSaved exactly once and never calls onCancel
//
// We mount only the dialog (not the whole panel) so the test is
// hermetic and doesn't drag in HQLayout / install-profile state. The
// dialog's contract with internal-migration.ts is exercised through
// real `fetch` calls intercepted by `fetchImpl` below.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:refresh-peer-token-dialog

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.TSX_TSCONFIG_PATH = resolve(__dirname, "tsconfig.json");

// ── env injection (must run before any dashboard module import) ────
//
// Setting VITE_INTERNAL_API_URL makes `aggregateApiPath()` resolve a
// real URL, so probeAggregatePeer / patchAggregatePeer dispatch fetch
// against `http://test.local/api/aggregate/...` — captured by the
// fetch mock below.
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
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
setG("window", w);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
setG("MouseEvent", w.MouseEvent);
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
const matchMedia = (q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
setG("matchMedia", matchMedia);
(w as unknown as Record<string, unknown>).matchMedia = matchMedia;

// ── mocked aggregator API (fetch interceptor) ─────────────────────
//
// The dialog only ever hits two endpoints:
//   POST /api/aggregate/peers/:id/probe — Test button
//   PATCH /api/aggregate/peers/:id      — Save button
// Anything else returns 404 so a misrouted call surfaces loudly.

interface FetchCall {
  method: string;
  url: string;
  body?: unknown;
}
const fetchCalls: FetchCall[] = [];

type ProbeOutcome =
  | { ok: true }
  | { ok: false; error: string; error_kind?: string };

let nextProbeOutcome: ProbeOutcome = { ok: true };
let nextPatchOutcome: { ok: true } | { status: number; body: unknown } = {
  ok: true,
};

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
  const url =
    typeof input === "string"
      ? input
      : (input as { url?: string }).url ?? String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  let parsedBody: unknown = undefined;
  if (init?.body != null) {
    try {
      parsedBody = JSON.parse(String(init.body));
    } catch {
      parsedBody = init.body;
    }
  }
  fetchCalls.push({ method, url, body: parsedBody });

  const probeMatch = /\/api\/aggregate\/peers\/([^/?#]+)\/probe$/.exec(url);
  if (probeMatch && method === "POST") {
    if (nextProbeOutcome.ok) return jsonResponse({ ok: true });
    return jsonResponse({
      ok: false,
      error: nextProbeOutcome.error,
      error_kind: nextProbeOutcome.error_kind,
    });
  }

  const patchMatch = /\/api\/aggregate\/peers\/([^/?#]+)$/.exec(url);
  if (patchMatch && method === "PATCH") {
    if ("ok" in nextPatchOutcome) return jsonResponse({ ok: true });
    return jsonResponse(nextPatchOutcome.body, nextPatchOutcome.status);
  }

  return jsonResponse({ error: "not_handled", method, url }, 404);
};
setG("fetch", fetchImpl);

// ── helpers ────────────────────────────────────────────────────────
function setInputValue(el: HTMLInputElement, value: string): void {
  const proto = w.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc?.set) throw new Error("no input value setter");
  desc.set.call(el, value);
  const ev = el.ownerDocument.createEvent("HTMLEvents");
  ev.initEvent("input", true, false);
  el.dispatchEvent(ev);
}

async function flush(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, ms));
  });
}

async function waitFor<T>(
  probe: () => T | null | undefined,
  label: string,
  timeoutMs = 2000,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = probe();
    if (hit) return hit;
    await flush(20);
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
}

// ── the test ───────────────────────────────────────────────────────
test("RefreshPeerTokenDialog · probe-fail → probe-ok → save → onSaved", async () => {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../src/lib/i18n.tsx");
  const { default: RefreshPeerTokenDialog } = await import(
    "../src/components/RefreshPeerTokenDialog.tsx"
  );

  const PEER_ID = "11111111-1111-1111-1111-111111111111";
  let savedCalls = 0;
  let cancelCalls = 0;

  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);

  const tree = React.createElement(
    I18nProvider,
    null,
    React.createElement(RefreshPeerTokenDialog, {
      peerId: PEER_ID,
      squadronName: "No. 5 Squadron",
      onSaved: () => {
        savedCalls += 1;
      },
      onCancel: () => {
        cancelCalls += 1;
      },
    }),
  );

  await act(async () => {
    root.render(tree);
  });

  const input = el.querySelector<HTMLInputElement>(
    '[data-testid="input-refresh-peer-token"]',
  );
  const testBtn = el.querySelector<HTMLButtonElement>(
    '[data-testid="button-refresh-peer-token-test"]',
  );
  const saveBtn = el.querySelector<HTMLButtonElement>(
    '[data-testid="button-refresh-peer-token-save"]',
  );
  assert.ok(input, "token input should render");
  assert.ok(testBtn, "Test button should render");
  assert.ok(saveBtn, "Save button should render");

  // ── 1. probe failure path: peer rejects the pasted token as still revoked
  nextProbeOutcome = {
    ok: false,
    error: "revoked_token",
    error_kind: "auth_revoked",
  };
  await act(async () => {
    setInputValue(input!, "phk_first_attempt");
  });
  await act(async () => {
    testBtn!.dispatchEvent(
      new w.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  const errBlock = await waitFor(
    () =>
      el.querySelector('[data-testid="text-refresh-peer-token-error"]'),
    "probe error block",
  );
  // Localized auth_revoked reason: i18n key `refreshPeerTokenStillRevoked`.
  // The exact copy is "Peer still rejects this token as revoked." (EN).
  assert.match(
    errBlock.textContent ?? "",
    /revoked/i,
    "auth_revoked probe failure should surface the localized 'still revoked' message",
  );
  assert.equal(
    el.querySelector('[data-testid="text-refresh-peer-token-ok"]'),
    null,
    "probe-ok block must NOT render after a failed probe",
  );

  // The probe call must have hit the right URL and forwarded the
  // pasted bearer in the body — pin the wiring contract.
  const probeCall = fetchCalls.find((c) =>
    c.url.includes(`/peers/${PEER_ID}/probe`),
  );
  assert.ok(probeCall, "Test should POST to the probe endpoint");
  assert.equal(probeCall!.method, "POST");
  assert.deepEqual(probeCall!.body, { auth_token: "phk_first_attempt" });

  // ── 2. probe success path: new token works
  nextProbeOutcome = { ok: true };
  await act(async () => {
    setInputValue(input!, "phk_correct_token");
  });
  // Editing the input clears the error block (probe -> idle).
  assert.equal(
    el.querySelector('[data-testid="text-refresh-peer-token-error"]'),
    null,
    "editing the token must clear the previous probe error",
  );
  await act(async () => {
    testBtn!.dispatchEvent(
      new w.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  const okBlock = await waitFor(
    () => el.querySelector('[data-testid="text-refresh-peer-token-ok"]'),
    "probe ok block",
  );
  assert.ok(
    (okBlock.textContent ?? "").length > 0,
    "probe-ok block should render localized success copy",
  );

  // ── 3. save path: PATCH succeeds → onSaved fires
  nextPatchOutcome = { ok: true };
  await act(async () => {
    saveBtn!.dispatchEvent(
      new w.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await waitFor(
    () => (savedCalls > 0 ? true : null),
    "onSaved callback fired",
  );
  assert.equal(savedCalls, 1, "onSaved should fire exactly once on success");
  assert.equal(cancelCalls, 0, "onCancel must NOT fire on Save success");

  // The PATCH must carry the trimmed token in `{token}` and target
  // the same peer id — ensures the operator's verified token is what
  // gets persisted, not some stale state.
  const patchCall = fetchCalls
    .filter(
      (c) => c.method === "PATCH" && c.url.endsWith(`/peers/${PEER_ID}`),
    )
    .pop();
  assert.ok(patchCall, "Save should PATCH the peer row");
  assert.deepEqual(patchCall!.body, { token: "phk_correct_token" });

  await act(async () => {
    root.unmount();
  });
  el.remove();
});

test("RefreshPeerTokenDialog · save failure surfaces error and does not fire onSaved", async () => {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { I18nProvider } = await import("../src/lib/i18n.tsx");
  const { default: RefreshPeerTokenDialog } = await import(
    "../src/components/RefreshPeerTokenDialog.tsx"
  );

  const PEER_ID = "22222222-2222-2222-2222-222222222222";
  let savedCalls = 0;
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);

  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(RefreshPeerTokenDialog, {
          peerId: PEER_ID,
          squadronName: "No. 8 Squadron",
          onSaved: () => {
            savedCalls += 1;
          },
          onCancel: () => {},
        }),
      ),
    );
  });

  const input = el.querySelector<HTMLInputElement>(
    '[data-testid="input-refresh-peer-token"]',
  );
  const saveBtn = el.querySelector<HTMLButtonElement>(
    '[data-testid="button-refresh-peer-token-save"]',
  );
  assert.ok(input);
  assert.ok(saveBtn);

  // Server says the row no longer exists (operator deleted it from
  // another tab while this dialog was open). The dialog must surface
  // the structured error and keep itself open.
  nextPatchOutcome = { status: 404, body: { error: "not_found" } };
  await act(async () => {
    setInputValue(input!, "phk_some_token");
  });
  await act(async () => {
    saveBtn!.dispatchEvent(
      new w.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  const saveErr = await waitFor(
    () =>
      el.querySelector('[data-testid="text-refresh-peer-token-save-error"]'),
    "save error block",
  );
  assert.match(
    saveErr.textContent ?? "",
    /not_found|http_404/i,
    "save failure should surface the server's structured error",
  );
  assert.equal(savedCalls, 0, "onSaved must NOT fire when PATCH fails");

  await act(async () => {
    root.unmount();
  });
  el.remove();
});

test("refresh-peer-token-dialog · teardown jsdom", () => {
  try {
    (dom.window as unknown as { close?: () => void }).close?.();
  } catch {
    /* best-effort */
  }
});
