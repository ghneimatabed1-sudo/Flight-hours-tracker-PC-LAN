// End-to-end UI test for the Super Admin “Peer Tokens” page
// (`/admin/peer-tokens`). The server-side CRUD is already covered by
// `peer-tokens-routes.test.ts`; this test mounts the React page in
// jsdom, intercepts every `/api/internal/peer-tokens` GET/POST/DELETE
// request the helpers in `lib/internal-migration.ts` would emit, and
// walks the full operator flow:
//
//   1. boot AuthProvider as `super_admin` via the mocked
//      `/api/internal/auth/lan/me` endpoint
//   2. wait for the empty-state to render
//   3. open the “Issue token” dialog, fill in a label, submit
//   4. verify the one-time plain-token banner appears with the exact
//      token returned by the mocked POST, and that clicking “Copy
//      token” forwards the plain bearer to `navigator.clipboard.writeText`
//   5. verify the new row shows up in the table with the “Active”
//      status badge
//   6. open the Revoke confirm dialog for that row, confirm the action
//      and verify the row’s status flips to “Revoked”
//
// The cache-invalidation contract is exercised implicitly: after the
// POST and DELETE the page calls `reload()`, which goes back through
// our mocked `GET /api/internal/peer-tokens`. If the server-side row
// were not in the snapshot the next render would not show it.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:peer-tokens-page

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
// The test-only loader rewrites `import.meta.env` in
// `lib/internal-migration.ts` to read this object instead. By setting
// VITE_INTERNAL_API_URL the helpers resolve a real URL and dispatch
// fetch — which we capture with a global mock below. VITE_LAN_SESSION
// _LOGIN flips AuthProvider into LAN-session mode so it boots a user
// from `/api/internal/auth/lan/me` (also mocked).
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
// Radix focus-scope and dismissable-layer construct events with the
// global `Event` / `CustomEvent` constructors and dispatch them via
// jsdom's `dispatchEvent`. Web IDL conversion fails unless those
// globals are jsdom's own constructors, otherwise the dialog blows up
// during mount with "parameter 1 is not of type 'Event'".
setG("Event", w.Event);
setG("CustomEvent", w.CustomEvent);
setG("KeyboardEvent", w.KeyboardEvent);
setG("MouseEvent", w.MouseEvent);
setG("FocusEvent", w.FocusEvent);
setG("InputEvent", w.InputEvent);
setG("PointerEvent", w.PointerEvent ?? w.MouseEvent);
setG("EventTarget", w.EventTarget);
setG("DocumentFragment", w.DocumentFragment);
setG("DOMRect", w.DOMRect);
setG("NodeFilter", (w as unknown as { NodeFilter: unknown }).NodeFilter);
setG("Range", w.Range);
setG("DOMParser", w.DOMParser);
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

// ── clipboard mock ────────────────────────────────────────────────
let lastCopied: string | null = null;
Object.defineProperty(w.navigator, "clipboard", {
  value: { writeText: async (t: string) => { lastCopied = String(t); } },
  writable: true,
  configurable: true,
});

// ── mocked LAN api-server (fetch interceptor) ──────────────────────
type PeerTokenRow = {
  id: string;
  label: string | null;
  scope: string;
  issued_at: string;
  issued_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
};

const peerTokens: PeerTokenRow[] = [];
let nextIdSeq = 1;
const PLAIN_TOKEN = "phk_test_one_time_plain_bearer_value";

interface FetchCall {
  method: string;
  url: string;
  body?: unknown;
}
const fetchCalls: FetchCall[] = [];

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
  const url = typeof input === "string" ? input : (input as { url?: string }).url ?? String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  let parsedBody: unknown = undefined;
  if (init?.body != null) {
    try { parsedBody = JSON.parse(String(init.body)); } catch { parsedBody = init.body; }
  }
  fetchCalls.push({ method, url, body: parsedBody });

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

  if (url.endsWith("/api/internal/peer-tokens") && method === "GET") {
    return jsonResponse({ items: peerTokens });
  }

  if (url.endsWith("/api/internal/peer-tokens") && method === "POST") {
    const body = (parsedBody ?? {}) as { label?: string; scope?: string; expires_at?: string | null };
    const id = `tok-${nextIdSeq++}`;
    const row: PeerTokenRow = {
      id,
      label: body.label ?? null,
      scope: body.scope ?? "squadron-read",
      issued_at: new Date().toISOString(),
      issued_by: "alice",
      expires_at: body.expires_at ?? null,
      revoked_at: null,
      revoked_by: null,
      last_used_at: null,
    };
    peerTokens.unshift(row);
    return jsonResponse({ token: PLAIN_TOKEN, row });
  }

  const del = /\/api\/internal\/peer-tokens\/([^/?#]+)$/.exec(url);
  if (del && method === "DELETE") {
    const id = decodeURIComponent(del[1]!);
    const idx = peerTokens.findIndex((r) => r.id === id);
    if (idx === -1) return jsonResponse({ error: "not_found" }, 404);
    const updated: PeerTokenRow = {
      ...peerTokens[idx]!,
      revoked_at: new Date().toISOString(),
      revoked_by: "alice",
    };
    peerTokens[idx] = updated;
    return jsonResponse({ ok: true, row: updated });
  }

  return jsonResponse({ error: "not_handled", method, url }, 404);
};
setG("fetch", fetchImpl);

// AuthProvider's `fetchLanSessionUser` short-circuits with `no_token`
// unless this is set. Pre-seed so the boot effect actually hits our
// mocked `/api/internal/auth/lan/me`.
w.localStorage.setItem("rjaf.lanSessionToken", "test-session-token");

// ── helpers used inside the test ───────────────────────────────────
function setInputValue(el: HTMLInputElement, value: string): void {
  const proto = w.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc?.set) throw new Error("no input value setter");
  desc.set.call(el, value);
  const ev = el.ownerDocument.createEvent("HTMLEvents");
  ev.initEvent("input", true, false);
  el.dispatchEvent(ev);
}

test("PeerTokens · super_admin issue → copy → revoke flow", async () => {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { Router } = await import("wouter");
  const { memoryLocation } = await import("wouter/memory-location");
  const { I18nProvider } = await import("../src/lib/i18n.tsx");
  const { AuthProvider } = await import("../src/lib/auth.tsx");
  const { default: PeerTokens } = await import("../src/pages/admin/PeerTokens.tsx");

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: "/admin/peer-tokens", static: true });
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);

  const tree = React.createElement(
    QueryClientProvider, { client: qc },
    React.createElement(I18nProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(
          Router as unknown as React.ComponentType<{
            hook: unknown;
            children?: React.ReactNode;
          }>,
          { hook, children: React.createElement(PeerTokens) },
        ),
      ),
    ),
  );

  await act(async () => { root.render(tree); });

  const flush = async (ms = 60) => {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, ms));
    });
  };

  async function waitFor<T>(probe: () => T | null | undefined, label: string, timeoutMs = 4000): Promise<T> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = probe();
      if (hit) return hit;
      await flush(40);
    }
    const snippet = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    throw new Error(`timeout waiting for ${label}. body snippet: ${snippet}`);
  }

  // ── 1. AuthProvider boots from the mocked lan/me endpoint and the
  //       page renders the super_admin shell (not the forbidden card).
  await waitFor(
    () => el.querySelector('[data-testid="page-peer-tokens"]'),
    "page-peer-tokens (super_admin shell)",
  );
  assert.equal(
    el.querySelector('[data-testid="page-peer-tokens-forbidden"]'),
    null,
    "forbidden state must NOT render once super_admin user is loaded",
  );

  // ── 2. Initial GET resolves to an empty list → empty-state banner.
  await waitFor(
    () => el.querySelector('[data-testid="peer-tokens-empty"]'),
    "peer-tokens-empty",
  );

  // ── 3. Open the Issue dialog.
  const issueBtn = el.querySelector('[data-testid="button-issue-peer-token"]') as HTMLButtonElement | null;
  assert.ok(issueBtn, "Issue token button should be present");
  await act(async () => { issueBtn!.click(); });
  await flush();

  // Dialog content portals out to document.body — query from the doc.
  const labelInput = await waitFor(
    () => w.document.querySelector('[data-testid="input-peer-token-label"]') as HTMLInputElement | null,
    "input-peer-token-label",
  );
  await act(async () => { setInputValue(labelInput, "tigers-hub-pc"); });
  await flush();

  const submitBtn = w.document.querySelector('[data-testid="button-submit-issue-peer-token"]') as HTMLButtonElement | null;
  assert.ok(submitBtn, "submit button in issue dialog");
  await act(async () => { submitBtn!.click(); });
  await flush(150);

  // ── 4. Issued banner with the one-time plain token + Copy.
  const banner = await waitFor(
    () => el.querySelector('[data-testid="peer-token-issued-banner"]'),
    "peer-token-issued-banner",
  );
  const tokenText = banner.querySelector('[data-testid="text-issued-peer-token"]');
  assert.ok(tokenText, "issued plain-token element");
  assert.equal(
    (tokenText.textContent ?? "").trim(),
    PLAIN_TOKEN,
    "banner should display the exact plain bearer the server returned",
  );

  const copyBtn = el.querySelector('[data-testid="button-copy-peer-token"]') as HTMLButtonElement | null;
  assert.ok(copyBtn, "Copy token button");
  await act(async () => { copyBtn!.click(); });
  await flush();
  assert.equal(
    lastCopied,
    PLAIN_TOKEN,
    "navigator.clipboard.writeText must receive the plain token",
  );
  await waitFor(
    () => el.querySelector('[data-testid="text-peer-token-copied"]'),
    "text-peer-token-copied (copy ack)",
  );

  // ── 5. New row should appear in the table after the cache reload.
  assert.equal(peerTokens.length, 1, "server-side mock recorded one issued row");
  const issuedId = peerTokens[0]!.id;
  const rowEl = await waitFor(
    () => el.querySelector(`[data-testid="row-peer-token-${issuedId}"]`),
    `row-peer-token-${issuedId}`,
  );
  assert.match(
    rowEl.textContent ?? "",
    /tigers-hub-pc/,
    "row should display the label submitted in the issue dialog",
  );
  assert.match(
    rowEl.textContent ?? "",
    /Active/,
    "freshly-issued row should show the Active status",
  );

  // GETs so far: one from the initial page mount, one from reload after POST.
  const getCalls = fetchCalls.filter(
    (c) => c.method === "GET" && c.url.endsWith("/api/internal/peer-tokens"),
  );
  assert.ok(getCalls.length >= 2, `expected ≥2 GETs after issue, got ${getCalls.length}`);
  const postCalls = fetchCalls.filter(
    (c) => c.method === "POST" && c.url.endsWith("/api/internal/peer-tokens"),
  );
  assert.equal(postCalls.length, 1, "exactly one POST emitted by the issue submission");
  assert.deepEqual(
    (postCalls[0]!.body as { label?: string; expires_at?: unknown }).label,
    "tigers-hub-pc",
    "POST body must carry the label from the dialog",
  );

  // ── 6. Revoke the row.
  const revokeBtn = el.querySelector(
    `[data-testid="button-revoke-peer-token-${issuedId}"]`,
  ) as HTMLButtonElement | null;
  assert.ok(revokeBtn && !revokeBtn.disabled, "Revoke button enabled for active row");
  await act(async () => { revokeBtn!.click(); });
  await flush();

  const confirmBtn = await waitFor(
    () => w.document.querySelector(
      '[data-testid="button-confirm-revoke-peer-token"]',
    ) as HTMLButtonElement | null,
    "button-confirm-revoke-peer-token",
  );
  await act(async () => { confirmBtn.click(); });
  await flush(200);

  // Server state should reflect revocation.
  assert.ok(peerTokens[0]!.revoked_at, "mock server marked the row revoked");

  // Row should now display the Revoked status badge.
  const revokedRow = await waitFor(
    () => {
      const r = el.querySelector(`[data-testid="row-peer-token-${issuedId}"]`);
      if (r && /Revoked/.test(r.textContent ?? "")) return r;
      return null;
    },
    "row to flip to Revoked",
  );
  assert.match(
    revokedRow.textContent ?? "",
    /Revoked/,
    "row should show the Revoked status after confirm",
  );

  const deleteCalls = fetchCalls.filter((c) => c.method === "DELETE");
  assert.equal(
    deleteCalls.length,
    1,
    "exactly one DELETE call emitted by the revoke confirm",
  );
  assert.ok(
    deleteCalls[0]!.url.endsWith(`/api/internal/peer-tokens/${issuedId}`),
    "DELETE URL must target the issued row's id",
  );

  await act(async () => { root.unmount(); });
});

// ── Subtests added for Task #375 ──────────────────────────────────
//
// All three subtests share the helpers defined above and re-use the
// same fetch interceptor / clipboard mock. Each one resets the
// peerTokens store + fetchCalls counter at the top so the assertions
// run on a clean slate, then mounts a fresh PeerTokens tree against a
// fresh QueryClient to avoid cross-test cache leakage.

async function mountPeerTokens(): Promise<{
  el: HTMLElement;
  unmount: () => Promise<void>;
  flush: (ms?: number) => Promise<void>;
  waitFor: <T>(probe: () => T | null | undefined, label: string, timeoutMs?: number) => Promise<T>;
}> {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { Router } = await import("wouter");
  const { memoryLocation } = await import("wouter/memory-location");
  const { I18nProvider } = await import("../src/lib/i18n.tsx");
  const { AuthProvider } = await import("../src/lib/auth.tsx");
  const { default: PeerTokens } = await import("../src/pages/admin/PeerTokens.tsx");

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: "/admin/peer-tokens", static: true });
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);

  const tree = React.createElement(
    QueryClientProvider, { client: qc },
    React.createElement(I18nProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(
          Router as unknown as React.ComponentType<{
            hook: unknown;
            children?: React.ReactNode;
          }>,
          { hook, children: React.createElement(PeerTokens) },
        ),
      ),
    ),
  );

  await act(async () => { root.render(tree); });

  const flush = async (ms = 60) => {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, ms));
    });
  };

  async function waitFor<T>(probe: () => T | null | undefined, label: string, timeoutMs = 4000): Promise<T> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = probe();
      if (hit) return hit;
      await flush(40);
    }
    const snippet = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    throw new Error(`timeout waiting for ${label}. body snippet: ${snippet}`);
  }

  return {
    el: el as unknown as HTMLElement,
    unmount: async () => { await act(async () => { root.unmount(); }); el.remove(); },
    flush,
    waitFor,
  };
}

test("PeerTokens · expiry date submits a server-shaped expires_at", async () => {
  // Fresh state so we don't see the row issued by the prior test.
  peerTokens.length = 0;
  fetchCalls.length = 0;
  nextIdSeq = 100;

  const { el, unmount, waitFor, flush } = await mountPeerTokens();

  await waitFor(
    () => el.querySelector('[data-testid="page-peer-tokens"]'),
    "page-peer-tokens shell",
  );
  await waitFor(
    () => el.querySelector('[data-testid="peer-tokens-empty"]'),
    "peer-tokens-empty",
  );

  const issueBtn = el.querySelector('[data-testid="button-issue-peer-token"]') as HTMLButtonElement | null;
  assert.ok(issueBtn, "Issue token button");
  await act(async () => { issueBtn!.click(); });
  await flush();

  const labelInput = await waitFor(
    () => w.document.querySelector('[data-testid="input-peer-token-label"]') as HTMLInputElement | null,
    "input-peer-token-label",
  );
  await act(async () => { setInputValue(labelInput, "rotating-token"); });

  const expiryInput = w.document.querySelector(
    '[data-testid="input-peer-token-expires"]',
  ) as HTMLInputElement | null;
  assert.ok(expiryInput, "expiry date input");
  // Use a fixed YYYY-MM-DD so the toISOString() result is deterministic.
  await act(async () => { setInputValue(expiryInput, "2030-12-31"); });
  await flush();

  const submitBtn = w.document.querySelector('[data-testid="button-submit-issue-peer-token"]') as HTMLButtonElement | null;
  assert.ok(submitBtn, "submit button");
  await act(async () => { submitBtn!.click(); });
  await flush(150);

  const postCalls = fetchCalls.filter(
    (c) => c.method === "POST" && c.url.endsWith("/api/internal/peer-tokens"),
  );
  assert.equal(postCalls.length, 1, "one POST emitted");
  const body = postCalls[0]!.body as { label?: string; expires_at?: string | null };
  assert.equal(body.label, "rotating-token");
  assert.ok(typeof body.expires_at === "string" && body.expires_at.length > 0,
    "expires_at must be a non-empty ISO string when the date is filled");
  // The page sends midnight LOCAL time as ISO (so the date the user
  // sees comes back). Whichever timezone Node runs in, the YYYY-MM-DD
  // portion of the resulting ISO string must contain the picked date
  // OR the day before/after — we accept any of those three.
  const datePart = body.expires_at!.slice(0, 10);
  assert.ok(
    /^2030-12-3[01]$|^2031-01-01$/.test(datePart),
    `expires_at date part should be near 2030-12-31, got ${datePart}`,
  );

  await unmount();
});

test("PeerTokens · clipboard.writeText throws → execCommand fallback fires + Copied ack still shows", async () => {
  peerTokens.length = 0;
  fetchCalls.length = 0;
  nextIdSeq = 200;
  lastCopied = null;

  // Swap clipboard.writeText to throw, and instrument document.execCommand
  // so the fallback path is observable.
  let clipboardCalls = 0;
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      writeText: async (_t: string) => {
        clipboardCalls++;
        throw new Error("clipboard_blocked_by_test");
      },
    },
    writable: true,
    configurable: true,
  });
  let execCommandCalls = 0;
  let execCommandLastArg: string | null = null;
  let fallbackCapturedValue: string | null = null;
  const origExec = (w.document as unknown as { execCommand?: (cmd: string) => boolean }).execCommand;
  (w.document as unknown as { execCommand: (cmd: string) => boolean }).execCommand =
    (cmd: string) => {
      execCommandCalls++;
      execCommandLastArg = cmd;
      // PeerTokens.tsx mounts a fixed/opacity-0 textarea, selects it,
      // then calls execCommand("copy"). Capture the textarea's value so
      // we can assert the fallback truly carries the plain token.
      const ta = w.document.querySelector("textarea") as HTMLTextAreaElement | null;
      if (ta) fallbackCapturedValue = ta.value;
      return true;
    };

  const { el, unmount, waitFor, flush } = await mountPeerTokens();

  try {
    await waitFor(
      () => el.querySelector('[data-testid="page-peer-tokens"]'),
      "page-peer-tokens shell",
    );

    const issueBtn = el.querySelector('[data-testid="button-issue-peer-token"]') as HTMLButtonElement | null;
    assert.ok(issueBtn);
    await act(async () => { issueBtn!.click(); });
    await flush();

    const labelInput = await waitFor(
      () => w.document.querySelector('[data-testid="input-peer-token-label"]') as HTMLInputElement | null,
      "input-peer-token-label",
    );
    await act(async () => { setInputValue(labelInput, "fallback-pc"); });

    const submitBtn = w.document.querySelector('[data-testid="button-submit-issue-peer-token"]') as HTMLButtonElement | null;
    assert.ok(submitBtn);
    await act(async () => { submitBtn!.click(); });
    await flush(150);

    const copyBtn = await waitFor(
      () => el.querySelector('[data-testid="button-copy-peer-token"]') as HTMLButtonElement | null,
      "button-copy-peer-token",
    );
    await act(async () => { copyBtn.click(); });
    await flush();

    assert.equal(clipboardCalls, 1, "navigator.clipboard.writeText was called once");
    assert.equal(execCommandCalls, 1, "execCommand fallback was called exactly once");
    assert.equal(execCommandLastArg, "copy", "execCommand was invoked with 'copy'");
    assert.equal(
      fallbackCapturedValue,
      PLAIN_TOKEN,
      "fallback textarea must contain the plain token before execCommand runs",
    );
    await waitFor(
      () => el.querySelector('[data-testid="text-peer-token-copied"]'),
      "text-peer-token-copied (copy ack via fallback)",
    );
  } finally {
    // Restore both stubs so subsequent tests see the original mocks.
    if (typeof origExec === "function") {
      (w.document as unknown as { execCommand: (cmd: string) => boolean }).execCommand = origExec;
    } else {
      delete (w.document as unknown as { execCommand?: unknown }).execCommand;
    }
    Object.defineProperty(w.navigator, "clipboard", {
      value: { writeText: async (t: string) => { lastCopied = String(t); } },
      writable: true,
      configurable: true,
    });
    await unmount();
  }
});

test("PeerTokens · Issue dialog Cancel closes the dialog + emits no POST", async () => {
  peerTokens.length = 0;
  fetchCalls.length = 0;
  nextIdSeq = 300;

  const { el, unmount, waitFor, flush } = await mountPeerTokens();

  await waitFor(
    () => el.querySelector('[data-testid="page-peer-tokens"]'),
    "page-peer-tokens shell",
  );

  const issueBtn = el.querySelector('[data-testid="button-issue-peer-token"]') as HTMLButtonElement | null;
  assert.ok(issueBtn);
  await act(async () => { issueBtn!.click(); });
  await flush();

  const labelInput = await waitFor(
    () => w.document.querySelector('[data-testid="input-peer-token-label"]') as HTMLInputElement | null,
    "input-peer-token-label (dialog open)",
  );
  // Type something so we know cancel really does discard, not just no-op.
  await act(async () => { setInputValue(labelInput, "should-not-submit"); });
  await flush();

  // The dialog footer hosts a `Cancel` Button + the submit Button. The
  // submit one carries a testid; the Cancel one is the only OTHER button
  // in the dialog content. Find it by walking the dialog container.
  const dialog = w.document.querySelector(
    '[data-testid="dialog-issue-peer-token"]',
  ) as HTMLElement | null;
  assert.ok(dialog, "issue dialog rendered");
  const buttons = Array.from(dialog!.querySelectorAll("button")) as HTMLButtonElement[];
  const cancelBtn = buttons.find(b => !b.dataset.testid);
  assert.ok(cancelBtn, "Cancel button in issue dialog");
  await act(async () => { cancelBtn!.click(); });
  await flush(120);

  // Dialog closes → its content (and the label input) is removed.
  await waitFor(
    () => (w.document.querySelector('[data-testid="input-peer-token-label"]') === null
      ? true : null),
    "dialog to close (label input gone)",
  );

  const postCalls = fetchCalls.filter(
    (c) => c.method === "POST" && c.url.endsWith("/api/internal/peer-tokens"),
  );
  assert.equal(postCalls.length, 0, "Cancel must NOT emit a create POST");
  assert.equal(peerTokens.length, 0, "no row should have been issued");

  await unmount();
});

test("PeerTokens · teardown jsdom", () => {
  try { (dom.window as unknown as { close?: () => void }).close?.(); }
  catch { /* best-effort teardown */ }
});
