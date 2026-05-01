// End-to-end UI test for the four operator wizards (Task #375).
//
// Mounts each of AddSortieWizard, AddPilotWizard, DutyWeekWizard and
// SetupWizard in a jsdom React tree, walks the operator through every
// step, presses Finish, and asserts the *exact* shape of the POST body
// that the wizard's mutation hook emitted to the internal API (or, in
// SetupWizard's case, to the cloud bootstrap edge function).
//
// What this test guards against:
//   * a wizard accidentally dropping or renaming a payload field
//     (e.g. `pilot_id` → `pilotId`, `data.condition` → `condition`)
//   * a wizard hitting the *wrong* endpoint after a refactor
//     (e.g. /api/internal/sorties vs /api/internal/sorties/upsert)
//   * a step's validate() being skipped or its testId being renamed
//
// We don't try to assert on the rendered review-step DOM beyond what's
// needed to advance — the goal is to lock down the request the operator
// actually sends to the server. The server-side handlers are covered
// by their own dedicated route tests (sorties-writes-gate,
// peer-tokens-routes, etc.).
//
// Mode juggling:
//   The four wizards have *different* requirements for module-level
//   feature flags evaluated in `lib/unit-join.ts`:
//
//   * AddSortie / AddPilot / DutyWeek need the LAN data plane on so
//     `shouldUseInternalDataPlane()` is true and the mutation hits
//     `/api/internal/*` instead of the demo-mode in-memory mock.
//
//   * SetupWizard needs `unitJoinConfigured` (a const evaluated at
//     module load) to be true. That requires SUPABASE_URL +
//     ANON_KEY + JOIN_SECRET to be present *and*
//     `isLanSessionLoginEnabled()` to be false at the moment that
//     const is computed.
//
//   We resolve this by:
//     1. Setting env BEFORE any wizard import with LAN_SESSION_LOGIN
//        UNSET (so unitJoinConfigured = true at load) but with the
//        Supabase keys present.
//     2. Toggling `VITE_LAN_SESSION_LOGIN = "1"` on at runtime for
//        the AddSortie / AddPilot / DutyWeek tests (the loader
//        rewrites import.meta.env to a live `globalThis` ref so the
//        runtime helper `isLanSessionLoginEnabled()` picks up the
//        change immediately).
//     3. Deleting it again before mounting SetupWizard so its render
//        guard doesn't short-circuit into the LAN-mode panel.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:wizards-e2e

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
// SetupWizard's `unitJoinConfigured` is computed at module load time
// from these env values, so they must be present *before* tsx parses
// `lib/unit-join.ts`. The loader (`wizards-e2e-loader.mjs`) rewrites
// `import.meta.env` in both `internal-migration.ts` and `unit-join.ts`
// to read this same global object, so subsequent runtime helpers like
// `isLanSessionLoginEnabled()` always see the *current* value.
const SUPABASE_URL = "http://supabase.test.local";
const ANON_KEY = "anon-test-key";
const JOIN_SECRET = "join-test-secret";

type ViteEnvOverride = Record<string, string | boolean | undefined>;
const VITE_ENV: ViteEnvOverride = {
  VITE_INTERNAL_API_URL: "http://internal.test.local",
  VITE_INTERNAL_WRITES: "1",
  VITE_SUPABASE_URL: SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: ANON_KEY,
  VITE_UNIT_JOIN_SECRET: JOIN_SECRET,
  // VITE_LAN_SESSION_LOGIN intentionally unset at module-load time so
  // unit-join's `unitJoinConfigured = !LAN && Boolean(SB+ANON+SECRET)`
  // evaluates to TRUE. Tests flip it at runtime when needed.
};
(globalThis as unknown as { __HAWK_TEST_VITE_ENV?: ViteEnvOverride })
  .__HAWK_TEST_VITE_ENV = VITE_ENV;

function lanOn(): void { VITE_ENV.VITE_LAN_SESSION_LOGIN = "1"; }
function lanOff(): void { delete VITE_ENV.VITE_LAN_SESSION_LOGIN; }

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
// wouter's `useBrowserLocation` reads `location.pathname` directly, so
// the global `location` must be jsdom's `window.location` (not Node's
// undefined default). `history` is its companion — same story.
setG("location", w.location);
setG("history", w.history);
// wouter subscribes via bare `addEventListener("popstate", ...)` (i.e.
// against the global, not `window`), so the global must expose those
// methods bound to jsdom's window.
setG("addEventListener", w.addEventListener.bind(w));
setG("removeEventListener", w.removeEventListener.bind(w));
setG("dispatchEvent", w.dispatchEvent.bind(w));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
// React 19 emits a noisy "An update to Root inside a test was not wrapped
// in act(...)" warning whenever a query resolution lands AFTER the test
// body's last `await flush()` — which is unavoidable here because the
// wizards trigger background queries we don't control. Mute it so the
// run output stays scannable; pass everything else through unchanged.
const __origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  const first = args[0];
  if (typeof first === "string"
    && (first.includes("not wrapped in act") || first.includes("act(..."))) {
    return;
  }
  __origConsoleError(...args as [unknown, ...unknown[]]);
};
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("HTMLInputElement", w.HTMLInputElement);
setG("HTMLSelectElement", w.HTMLSelectElement);
setG("HTMLTextAreaElement", w.HTMLTextAreaElement);
setG("HTMLButtonElement", w.HTMLButtonElement);
setG("HTMLDivElement", w.HTMLDivElement);
setG("HTMLFormElement", w.HTMLFormElement);
setG("Element", w.Element);
setG("Node", w.Node);
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
setG("requestAnimationFrame",
  (cb: FrameRequestCallback) => Number(setTimeout(() => cb(performance.now()), 16)));
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

// `crypto.subtle` is only used by SetupWizard via sha256Hex; jsdom
// inherits the host's WebCrypto in current Node so this is just a
// safety net for older Node versions running the test.
if (!(w.crypto as unknown as { subtle?: unknown })?.subtle) {
  Object.defineProperty(w, "crypto", {
    value: globalThis.crypto, configurable: true,
  });
}
setG("crypto", globalThis.crypto);

// ── localStorage seed ─────────────────────────────────────────────
//
// `sessionSquadronIdForInternalWrite` reads `rjaf.user.squadronIds[0]`
// when LAN session mode is on. AuthProvider seeds an in-process user
// from `/api/internal/auth/lan/me`, but the squadron-id helper goes
// straight to localStorage so we need both.
const SQDN_ID = "11111111-1111-1111-1111-111111111111";
w.localStorage.setItem("rjaf.lanSessionToken", "test-lan-session-token");
w.localStorage.setItem("rjaf.user", JSON.stringify({
  id: "u-test", username: "alice", role: "super_admin",
  squadronIds: [SQDN_ID],
}));

// ── mocked LAN api-server + cloud edge function ───────────────────
type FetchCall = { method: string; url: string; body?: unknown };
const fetchCalls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const ROSTER_PILOTS = [
  { id: "P001", name: "Alpha Smith", arabic_name: "ألفا", rank: "نقيب طيار",
    rank_en: "Captain", phone: "555-0101", unit: "SQDN", available: true,
    data: { name: "Alpha Smith", arabicName: "ألفا", rank: "نقيب طيار",
      rankEn: "Captain", militaryNumber: "10001", flightName: "Alpha" } },
  { id: "P002", name: "Bravo Jones", arabic_name: "برافو", rank: "ملازم طيار",
    rank_en: "Lieutenant", phone: "555-0102", unit: "SQDN", available: true,
    data: { name: "Bravo Jones", arabicName: "برافو", rank: "ملازم طيار",
      rankEn: "Lieutenant", militaryNumber: "10002", flightName: "Bravo" } },
];

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
    try { parsedBody = JSON.parse(String(init.body)); }
    catch { parsedBody = init.body; }
  }
  fetchCalls.push({ method, url, body: parsedBody });

  // ── LAN: auth ────────────────────────────────────────────
  if (url.endsWith("/api/internal/auth/lan/me") && method === "GET") {
    return jsonResponse({
      ok: true,
      user: {
        id: "u-test", username: "alice", displayName: "Alice Admin",
        role: "super_admin", squadronId: SQDN_ID,
      },
    });
  }

  // ── LAN: pilots roster ───────────────────────────────────
  if (url.includes("/api/internal/pilots") && method === "GET") {
    return jsonResponse({ items: ROSTER_PILOTS });
  }
  if (url.endsWith("/api/internal/pilots/upsert") && method === "POST") {
    const body = (parsedBody ?? {}) as Record<string, unknown>;
    return jsonResponse({
      row: { ...body, created_at: new Date().toISOString() },
    });
  }

  // ── LAN: sorties ─────────────────────────────────────────
  if (url.endsWith("/api/internal/sorties") && method === "POST") {
    const body = (parsedBody ?? {}) as Record<string, unknown>;
    return jsonResponse({
      row: { ...body, id: "S-mock-1", created_at: new Date().toISOString() },
    });
  }

  // ── LAN: saved duty weeks ────────────────────────────────
  if (url.includes("/api/internal/saved-duty-weeks") && method === "GET") {
    return jsonResponse({ items: [] });
  }
  if (url.endsWith("/api/internal/saved-duty-weeks") && method === "POST") {
    return jsonResponse({ ok: true });
  }

  // ── LAN: misc reads (audit log etc.) — return empty so any
  //   page that opportunistically loads doesn't 404-spam. ──
  if (url.includes("/api/internal/") && method === "GET") {
    return jsonResponse({ items: [] });
  }

  // ── Cloud: Supabase RPC + edge function ──────────────────
  if (url.endsWith("/rest/v1/rpc/unit_super_admin_setup_allowed")
    && method === "POST") {
    return jsonResponse(true);
  }
  if (url.endsWith("/functions/v1/unit-super-admin-setup")
    && method === "POST") {
    const body = (parsedBody ?? {}) as { email?: string };
    return jsonResponse({ ok: true, email: body.email ?? "" });
  }

  return jsonResponse({ error: "not_handled", method, url }, 404);
};
setG("fetch", fetchImpl);

// ── pre-load `lib/unit-join.ts` while LAN is OFF ──────────────────
//
// `unitJoinConfigured` is a const evaluated at module-load time as
// `!isLanSessionLoginEnabled() && Boolean(SB+ANON+SECRET)`. Once the
// module is parsed, that value is locked in for the lifetime of the
// process. The SetupWizard test below toggles LAN ON for the first
// three sub-tests then back OFF — but if `unit-join.ts` is parsed
// for the first time DURING one of those LAN-on tests (transitively
// via SetupWizard's import graph) the const will be FALSE and the
// SetupWizard render guard will short-circuit into the LAN panel.
// Force the import here, before any test runs, to lock it in TRUE.
await import("../src/lib/unit-join");

// ── pilot roster shaped as `Pilot` for query-cache pre-seed ──────
//
// `usePilots()` only resolves to its async fetch result on the second
// render. The `AddPilotWizard` lazy-inits `form.id` from the derived
// `nextId` on the FIRST render (via `useState(() => blankForm(nextId))`)
// — so if the cache is empty at mount time the wizard locks in
// "P001" and never updates. Pre-seed the cache with the same roster
// the LAN handler returns so `nextId` correctly becomes "P003".
const SEED_PILOTS = [
  {
    id: "P001", name: "Alpha Smith", arabicName: "ألفا",
    rank: "نقيب طيار", rankEn: "Captain", phone: "555-0101",
    address: "", unit: "SQDN" as const, militaryNumber: "10001",
    flightName: "Alpha",
    openingDay: 0, openingNight: 0, openingNvg: 0,
    monthDay: 0, monthNight: 0, monthNvg: 0,
    available: true,
  },
  {
    id: "P002", name: "Bravo Jones", arabicName: "برافو",
    rank: "ملازم طيار", rankEn: "Lieutenant", phone: "555-0102",
    address: "", unit: "SQDN" as const, militaryNumber: "10002",
    flightName: "Bravo",
    openingDay: 0, openingNight: 0, openingNvg: 0,
    monthDay: 0, monthNight: 0, monthNvg: 0,
    available: true,
  },
] as unknown as import("../src/lib/mock").Pilot[];

// ── helpers ───────────────────────────────────────────────
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof w.HTMLTextAreaElement
    ? w.HTMLTextAreaElement.prototype
    : w.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc?.set) throw new Error("no input value setter");
  desc.set.call(el, value);
  const ev = el.ownerDocument.createEvent("HTMLEvents");
  ev.initEvent("input", true, false);
  el.dispatchEvent(ev);
}

async function flush(times = 6, ms = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, ms)); });
  }
}

function findByTestId<T extends Element = Element>(
  root: ParentNode, id: string,
): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`);
}

function requireByTestId<T extends Element = Element>(
  root: ParentNode, id: string,
): T {
  const el = findByTestId<T>(root, id);
  if (!el) throw new Error(`missing testId: ${id}`);
  return el;
}

// Click the wizard's "Next" or "Finish" button by prefix and assert no
// inline error appeared (validate() failures render an alert with the
// `${prefix}-error` testId — surfacing them here makes test failures
// easy to debug instead of silently advancing 0 steps).
async function clickNext(prefix: string): Promise<void> {
  const btn = requireByTestId<HTMLButtonElement>(
    document, `${prefix}-next`,
  );
  await act(async () => { btn.click(); });
  await flush(1);
  const err = findByTestId<HTMLElement>(document, `${prefix}-error`);
  if (err) throw new Error(`${prefix}-next: validation failed → ${err.textContent}`);
}
async function clickFinish(prefix: string): Promise<void> {
  const btn = requireByTestId<HTMLButtonElement>(
    document, `${prefix}-finish`,
  );
  await act(async () => { btn.click(); });
  await flush(4);
}

interface MountResult {
  unmount: () => void;
}
type QueryClientType = import("@tanstack/react-query").QueryClient;
async function mountWizard(
  WizardComp: React.ComponentType,
  // Pre-seed the React Query cache before the first render. This is
  // essential for `DutyWeekWizard` (and any future wizard) whose
  // module-scope `useEffect` depends on a query's `data` ref — without
  // a seeded cache the empty-fallback array re-creates on every
  // render and the effect's setState ping-pongs into a maximum-update
  // depth crash.
  seed?: (qc: QueryClientType) => void,
): Promise<MountResult> {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { I18nProvider } = await import("../src/lib/i18n");
  const { AuthProvider } = await import("../src/lib/auth");

  // Each sub-test mounts a fresh React tree on a brand-new container
  // node — re-using `#root` across createRoot calls trips React 19's
  // "container has already been passed to createRoot()" warning and
  // can leak state from the previous tree.
  const host = w.document.getElementById("root")!;
  while (host.firstChild) host.removeChild(host.firstChild);
  const container = w.document.createElement("div");
  host.appendChild(container);
  const root = createRoot(container);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (seed) seed(qc);

  const tree = React.createElement(
    QueryClientProvider, { client: qc },
    React.createElement(I18nProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(WizardComp),
      ),
    ),
  );
  await act(async () => { root.render(tree); });
  await flush(6);

  return { unmount: () => { try { root.unmount(); } catch { /* ignore */ } } };
}

// Reset only the *recorded* fetch calls between sub-tests; the mock
// implementation itself stays installed.
function resetCalls(): void { fetchCalls.length = 0; }

// ── AddSortieWizard ───────────────────────────────────────────────
test("AddSortieWizard · POST /api/internal/sorties body shape", async () => {
  lanOn();
  resetCalls();
  const { default: AddSortieWizard } = await import("../src/pages/wizards/AddSortieWizard");
  const m = await mountWizard(AddSortieWizard);
  try {
    // Step 0 (flight): defaults already set. Just advance.
    await clickNext("wiz-sortie");
    // Step 1 (crew): roster mode w/ pre-seeded P001/P002. Advance.
    await clickNext("wiz-sortie");
    // Step 2 (mission): no validate. Advance.
    await clickNext("wiz-sortie");
    // Step 3 (hours): need time>0.
    const timeInput = requireByTestId<HTMLInputElement>(document, "wizard-sortie-time");
    await act(async () => { setInputValue(timeInput, "1.5"); });
    await flush(1);
    await clickNext("wiz-sortie");
    // Step 4 (review): finish.
    await clickFinish("wiz-sortie");

    const post = fetchCalls.find(
      c => c.method === "POST" && c.url.endsWith("/api/internal/sorties"),
    );
    assert.ok(post, "expected POST /api/internal/sorties to be emitted");
    const body = post.body as Record<string, unknown>;
    assert.equal(body.squadron_id, SQDN_ID, "squadron_id must be the LAN session squadron");
    assert.equal(body.pilot_id, "P001", "pilot_id must come from the seeded roster slot 0");
    assert.equal(body.co_pilot_id, "P002", "co_pilot_id must come from roster slot 1");
    assert.ok(typeof body.date === "string" && (body.date as string).length >= 10,
      "date should be an ISO yyyy-mm-dd string");
    assert.ok(typeof body.ac_type === "string" && (body.ac_type as string).length > 0,
      "ac_type must default from squadron defaults / fallback");
    assert.ok(typeof body.sortie_type === "string" && (body.sortie_type as string).length > 0,
      "sortie_type must be one of the wizard's preset options");
    const data = body.data as Record<string, unknown>;
    assert.ok(data, "payload must include a `data` JSONB envelope");
    assert.equal(typeof data.actual, "number", "data.actual must mirror total flown hours");
    assert.equal(data.actual, 1.5, "data.actual = time + dual = 1.5 + 0");
    assert.equal(data.condition, "Day", "default condition is Day");
  } finally {
    m.unmount();
  }
});

// ── AddPilotWizard ────────────────────────────────────────────────
test("AddPilotWizard · POST /api/internal/pilots/upsert body shape", async () => {
  lanOn();
  resetCalls();
  const { default: AddPilotWizard } = await import("../src/pages/wizards/AddPilotWizard");
  const m = await mountWizard(AddPilotWizard, qc => {
    // See `SEED_PILOTS` comment above — without this the lazy form
    // init locks `id` to "P001" because the async query hasn't
    // resolved before the first render.
    qc.setQueryData(["pilots"], SEED_PILOTS);
  });
  try {
    // Step 0 (identity): name, arabicName, militaryNumber, rank required at submit time.
    const name = requireByTestId<HTMLInputElement>(document, "wizard-pilot-name");
    const arabic = requireByTestId<HTMLInputElement>(document, "wizard-pilot-arabic-name");
    const rank = requireByTestId<HTMLInputElement>(document, "wizard-pilot-rank");
    const mil = requireByTestId<HTMLInputElement>(document, "wizard-pilot-military");
    await act(async () => {
      setInputValue(name, "Charlie Wilson");
      setInputValue(arabic, "تشارلي");
      setInputValue(rank, "ملازم طيار");
      setInputValue(mil, "20003");
    });
    await flush(2);
    await clickNext("wiz-pilot");
    // Step 1 (contact): no validate. Advance.
    await clickNext("wiz-pilot");
    // Step 2 (currency): no validate. Advance.
    await clickNext("wiz-pilot");
    // Step 3 (review): finish.
    await clickFinish("wiz-pilot");

    const post = fetchCalls.find(
      c => c.method === "POST" && c.url.endsWith("/api/internal/pilots/upsert"),
    );
    assert.ok(post, "expected POST /api/internal/pilots/upsert to be emitted");
    const body = post.body as Record<string, unknown>;
    assert.equal(body.squadron_id, SQDN_ID, "squadron_id must be the LAN session squadron");
    // The wizard pre-fills `id` from PILOTS-derived nextId. Roster has
    // P001/P002 so the new id should be P003.
    assert.equal(body.id, "P003", "id should be the next free Pxxx after the roster");
    assert.equal(body.name, "Charlie Wilson");
    assert.equal(body.arabic_name, "تشارلي");
    assert.equal(body.rank, "ملازم طيار");
    const data = body.data as Record<string, unknown>;
    assert.ok(data, "payload must include a `data` JSONB envelope");
    assert.equal(data.militaryNumber, "20003",
      "militaryNumber must round-trip through the JSONB envelope");
  } finally {
    m.unmount();
  }
});

// ── DutyWeekWizard ────────────────────────────────────────────────
test("DutyWeekWizard · POST /api/internal/saved-duty-weeks body shape", async () => {
  lanOn();
  resetCalls();
  const { default: DutyWeekWizard } = await import("../src/pages/wizards/DutyWeekWizard");
  const m = await mountWizard(DutyWeekWizard, qc => {
    // Pre-seed the saved-duty-weeks query so its `data` ref is stable
    // from the first render — see comment in `mountWizard`.
    qc.setQueryData(["saved_duty_weeks", "8"], []);
  });
  try {
    // Step 0 (week): default start is next Sunday. Advance.
    await clickNext("wiz-duty");
    // Step 1 (fill): pencil one cell so the test asserts at least one
    //   non-empty row round-trips.
    const name1_0 = requireByTestId<HTMLInputElement>(document, "wizard-duty-name1-0");
    await act(async () => { setInputValue(name1_0, "نقيب طيار ألفا"); });
    await flush(1);
    await clickNext("wiz-duty");
    // Step 2 (review): finish.
    await clickFinish("wiz-duty");

    const post = fetchCalls.find(
      c => c.method === "POST" && c.url.endsWith("/api/internal/saved-duty-weeks"),
    );
    assert.ok(post, "expected POST /api/internal/saved-duty-weeks to be emitted");
    const body = post.body as Record<string, unknown>;
    assert.ok(typeof body.squadron === "string" && (body.squadron as string).length > 0,
      "squadron tag must be present on the upsert");
    // `useSaveDutyWeek` posts `start_date` (snake_case) — NOT `start`.
    // Locking the on-the-wire field name down here keeps a future
    // refactor that renames it from silently breaking the cross-PC
    // sync of duty rosters.
    assert.ok(typeof body.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.start_date as string),
      "start_date must be an ISO yyyy-mm-dd string");
    assert.ok(typeof body.saved_at === "string" && (body.saved_at as string).length > 0,
      "saved_at must be set so the server can dedupe by latest write");
    const rows = body.rows as Array<Record<string, string>>;
    assert.ok(Array.isArray(rows), "rows must be an array");
    assert.equal(rows.length, 7, "rows must always be 7 (one per day of the week)");
    assert.equal(rows[0]!.name1, "نقيب طيار ألفا",
      "row 0 name1 must round-trip exactly what the operator typed");
  } finally {
    m.unmount();
  }
});

// ── SetupWizard ───────────────────────────────────────────────────
test("SetupWizard · POST /functions/v1/unit-super-admin-setup body shape", async () => {
  // SetupWizard renders the LAN-mode panel (and never calls the cloud
  // bootstrap function) when isLanSessionLoginEnabled() is true at
  // render time. Flip LAN off for this sub-test.
  lanOff();
  resetCalls();
  const { default: SetupWizard } = await import("../src/pages/wizards/SetupWizard");
  const m = await mountWizard(SetupWizard);
  try {
    // Step 0 (welcome): no validate. Advance.
    await clickNext("wiz-setup");
    // Step 1 (account): email, username (≥3, lowercase),
    //   displayName, password (≥12), confirm.
    const email = requireByTestId<HTMLInputElement>(document, "wizard-setup-email");
    const username = requireByTestId<HTMLInputElement>(document, "wizard-setup-username");
    const display = requireByTestId<HTMLInputElement>(document, "wizard-setup-display");
    const pw = requireByTestId<HTMLInputElement>(document, "wizard-setup-password");
    const pw2 = requireByTestId<HTMLInputElement>(document, "wizard-setup-confirm");
    await act(async () => {
      setInputValue(email, "sa@unit.test");
      setInputValue(username, "superadmin");
      setInputValue(display, "Super Admin");
      setInputValue(pw, "correct horse battery staple"); // ≥ 12 chars
      setInputValue(pw2, "correct horse battery staple");
    });
    await flush(2);
    await clickNext("wiz-setup");
    // Step 2 (unit): optional. Advance.
    await clickNext("wiz-setup");
    // Step 3 (review): finish.
    await clickFinish("wiz-setup");

    const post = fetchCalls.find(
      c => c.method === "POST" && c.url.endsWith("/functions/v1/unit-super-admin-setup"),
    );
    assert.ok(post, "expected POST to the Supabase super-admin-setup edge function");
    const body = post.body as Record<string, unknown>;
    assert.equal(body.email, "sa@unit.test", "email must be lowercased + trimmed");
    assert.equal(body.username, "superadmin",
      "username must be lowercased + trimmed before submit");
    assert.equal(body.displayName, "Super Admin");
    assert.equal(body.password, "correct horse battery staple",
      "password is sent verbatim (the edge function performs hashing)");

    // Banner-of-success (`wizard-setup-success`) means setupSuperAdmin
    // returned ok=true — confirms our mocked edge function response
    // was actually consumed by the wizard's submit handler.
    await flush(2);
    const success = findByTestId<HTMLElement>(document, "wizard-setup-success");
    assert.ok(success, "success banner should render once the edge fn returns ok");
  } finally {
    m.unmount();
  }
});
