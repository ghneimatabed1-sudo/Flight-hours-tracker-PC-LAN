// E2E (jsdom) test for the "LAN drops mid-sortie" recovery flow
// (Task #371, gap closed under #406).
//
// Operator-visible scenario the test pins, end-to-end:
//
//   1. Operator types into a sortie form. The `useFormDraft` hook
//      debounces the entry into `localStorage` after 500 ms.
//   2. The LAN drops — `navigator.onLine` flips to false, the
//      browser fires the `offline` event, the operator clicks Save.
//   3. The save POST fails (network error). The form remains intact
//      because the draft is still in `localStorage`.
//   4. The page is reloaded (we re-mount the component). The
//      FormDraftBanner appears with restorable content.
//   5. Operator clicks RESTORE — the form re-populates.
//   6. The LAN comes back — `navigator.onLine` flips true, `online`
//      event fires. Operator retries Save and it succeeds. The
//      draft blob in `localStorage` is wiped.
//
// We deliberately avoid mounting the full AddSortie page because it
// drags in the entire wouter router, the squadron-data store and a
// dozen unrelated providers. The contract being tested is the
// integration of `useFormDraft` + `FormDraftBanner` + an
// offline/online-aware save, which a focused harness exercises with
// far fewer moving parts (pattern matches `use-form-draft.test.ts`).
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:lan-drop-mid-sortie

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

// ── lazy imports (after globals) ───────────────────────────────────
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { useFormDraft } = await import("../src/lib/use-form-draft");
const FormDraftBanner = (await import(
  "../src/components/FormDraftBanner"
)).default;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function flushDebounce() {
  await act(async () => { await sleep(600); });
}
async function flush() {
  await act(async () => { await sleep(0); });
}

// The shape of the "sortie" we're drafting. Kept intentionally
// minimal — the LAN-drop flow doesn't care about pilot rosters or
// hour buckets, only that the operator's typed bytes survive a
// network error and a remount.
interface SortieDraft {
  acNumber: string;
  remarks: string;
  time: string;
}

function emptyDraft(): SortieDraft {
  return { acNumber: "", remarks: "", time: "" };
}

const DRAFT_KEY = "draft.add-sortie.lan-drop-test";

// ── harness ─────────────────────────────────────────────────────────
// Mirrors what AddSortie.tsx does: a controlled form, the
// `useFormDraft` hook on top of its state, and a Save button that
// POSTs to a fake `/api/sorties` endpoint via `globalThis.fetch`.
// The save handler honours `navigator.onLine` exactly like the real
// sortie save path: when offline it short-circuits to `network_error`
// without even attempting the fetch.

interface SaveResult {
  ok: boolean;
  error?: string;
}

interface HarnessAPI {
  draft: SortieDraft;
  setField(field: keyof SortieDraft, value: string): void;
  save(): Promise<SaveResult>;
  hasDraft: boolean;
}

let mostRecentSave: SaveResult | null = null;

async function mountHarness(initial: SortieDraft) {
  const el = w.document.getElementById("root")!;
  while (el.firstChild) el.removeChild(el.firstChild);
  const root = createRoot(el);

  let api: HarnessAPI | null = null;

  function Harness({ initialState }: { initialState: SortieDraft }) {
    const [draft, setDraft] = React.useState<SortieDraft>(initialState);
    const formDraft = useFormDraft<SortieDraft>(DRAFT_KEY, draft, setDraft);

    const setField = React.useCallback(
      (field: keyof SortieDraft, value: string) => {
        setDraft((prev) => ({ ...prev, [field]: value }));
      },
      [],
    );

    const save = React.useCallback(async (): Promise<SaveResult> => {
      // Mirrors the LAN-drop guard rail in `offlineQueue.ts` and the
      // sortie save path: refuse to attempt a write while the
      // navigator reports offline. The draft stays in storage so the
      // operator can retry once the LAN is back.
      if (!w.navigator.onLine) {
        const r: SaveResult = { ok: false, error: "offline" };
        mostRecentSave = r;
        return r;
      }
      try {
        const res = await w.fetch("/api/sorties", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        if (!res.ok) {
          const r: SaveResult = { ok: false, error: `http_${res.status}` };
          mostRecentSave = r;
          return r;
        }
        // Success: clear the persisted draft so the banner doesn't
        // re-appear after the next reload.
        formDraft.discardDraft();
        const r: SaveResult = { ok: true };
        mostRecentSave = r;
        return r;
      } catch (e) {
        const r: SaveResult = {
          ok: false,
          error: e instanceof Error ? e.message : "network_error",
        };
        mostRecentSave = r;
        return r;
      }
    }, [draft, formDraft]);

    api = {
      draft,
      setField,
      save,
      hasDraft: formDraft.hasDraft,
    };

    return React.createElement(
      "div",
      null,
      React.createElement(FormDraftBanner, {
        hasDraft: formDraft.hasDraft,
        onRestore: formDraft.restoreDraft,
        onDiscard: formDraft.discardDraft,
        testIdSuffix: "add-sortie",
      }),
      React.createElement("input", {
        "data-testid": "input-ac-number",
        value: draft.acNumber,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          setField("acNumber", e.target.value),
      }),
      React.createElement("input", {
        "data-testid": "input-remarks",
        value: draft.remarks,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          setField("remarks", e.target.value),
      }),
      React.createElement("input", {
        "data-testid": "input-time",
        value: draft.time,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          setField("time", e.target.value),
      }),
      React.createElement(
        "button",
        {
          "data-testid": "button-save-sortie",
          type: "button",
          onClick: () => { void save(); },
        },
        "Save",
      ),
    );
  }

  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(Harness, { initialState: initial }),
      ),
    );
  });

  return {
    get api() {
      if (!api) throw new Error("harness API not mounted yet");
      return api;
    },
    async unmount() {
      await act(async () => { root.unmount(); });
    },
  };
}

// ── network controls ────────────────────────────────────────────────
type StubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let fetchHandler: StubFetch = async () =>
  new Response("not stubbed", { status: 500 });

function setFetch(handler: StubFetch) {
  fetchHandler = handler;
}

const wrappedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  fetchHandler(input, init)) as typeof w.fetch;
w.fetch = wrappedFetch;
setG("fetch", wrappedFetch);

function setOnline(online: boolean) {
  // jsdom's navigator.onLine is a getter; redefine as a writable
  // property so the harness can flip it from the test.
  Object.defineProperty(w.navigator, "onLine", {
    value: online,
    configurable: true,
    writable: true,
  });
  w.dispatchEvent(new w.Event(online ? "online" : "offline"));
}

// React's controlled-input synthetic events need the value mutated
// through the native setter so React picks up the change.
function typeInto(testId: string, value: string) {
  const el = w.document.querySelector(
    `[data-testid=${testId}]`,
  ) as HTMLInputElement | null;
  assert.ok(el, `input ${testId} must be mounted`);
  const desc = Object.getOwnPropertyDescriptor(
    w.HTMLInputElement.prototype,
    "value",
  )!;
  desc.set!.call(el, value);
  el!.dispatchEvent(new w.Event("input", { bubbles: true }));
}

// ── tests ───────────────────────────────────────────────────────────

test("LAN drop mid-sortie: typed entries persist; save while offline fails; remount surfaces the restore banner; restoring + retrying online succeeds and clears the draft", async () => {
  // Clean slate.
  w.localStorage.removeItem(DRAFT_KEY);
  setOnline(true);
  mostRecentSave = null;

  // ── Phase 1: operator types half a sortie ─────────────────────
  const session1 = await mountHarness(emptyDraft());
  await act(async () => { typeInto("input-ac-number", "JY-852"); });
  await act(async () => { typeInto("input-remarks", "training, partial entry"); });
  await flushDebounce();

  const blob = w.localStorage.getItem(DRAFT_KEY);
  assert.ok(blob, "useFormDraft must persist the partial entry to localStorage");
  const persisted = JSON.parse(blob!) as SortieDraft;
  assert.equal(persisted.acNumber, "JY-852");
  assert.equal(persisted.remarks, "training, partial entry");

  // ── Phase 2: LAN drops → save attempt fails ───────────────────
  setOnline(false);
  const failedSave = await session1.api.save();
  assert.equal(
    failedSave.ok,
    false,
    "save must fail while navigator.onLine is false",
  );
  assert.equal(
    failedSave.error,
    "offline",
    "save must short-circuit with the offline error code",
  );
  // Draft is still on disk because the save did not succeed.
  assert.ok(
    w.localStorage.getItem(DRAFT_KEY),
    "the persisted draft must survive a failed offline save",
  );

  await session1.unmount();

  // ── Phase 3: page reload → empty form, banner surfaces ────────
  // The "reload" is a fresh mount with an empty initial state,
  // exactly what would happen if the operator hit F5 after the LAN
  // drop. The restore banner must appear because the draft blob is
  // still in localStorage.
  const session2 = await mountHarness(emptyDraft());
  // Empty form, but draft flagged.
  assert.equal(
    session2.api.draft.acNumber,
    "",
    "fresh mount starts empty until the operator clicks Restore",
  );
  assert.equal(session2.api.hasDraft, true,
    "useFormDraft must advertise the saved blob to the banner");
  const banner = w.document.querySelector(
    "[data-testid=form-draft-banner-add-sortie]",
  );
  assert.ok(banner, "FormDraftBanner must render after the reload");

  // ── Phase 4: operator clicks RESTORE → form re-populates ──────
  const restoreBtn = w.document.querySelector(
    "[data-testid=form-draft-banner-add-sortie-restore]",
  ) as HTMLButtonElement;
  assert.ok(restoreBtn, "restore button must be inside the banner");
  await act(async () => { restoreBtn.click(); });
  await flush();

  assert.equal(session2.api.draft.acNumber, "JY-852",
    "restore must hand the saved A/C number back to the form");
  assert.equal(session2.api.draft.remarks, "training, partial entry",
    "restore must hand the saved remarks back to the form");
  // Banner must hide once restore completes — the draft has been
  // accepted into the form.
  assert.equal(
    w.document.querySelector(
      "[data-testid=form-draft-banner-add-sortie]",
    ),
    null,
    "FormDraftBanner must hide once the operator has restored",
  );

  // ── Phase 5: LAN returns → retry succeeds → draft clears ──────
  setOnline(true);
  let postCalls = 0;
  setFetch(async (input, init) => {
    postCalls++;
    assert.equal(String(input), "/api/sorties");
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ ok: true, id: "sortie-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  });

  // Operator types the missing time and resubmits.
  await act(async () => { typeInto("input-time", "1.5"); });
  await flush();

  const okSave = await session2.api.save();
  assert.equal(okSave.ok, true, "save must succeed once the LAN is back");
  assert.equal(postCalls, 1, "exactly one POST must be issued on the retry");
  // Draft blob is wiped after a successful save so the banner
  // doesn't re-appear next time the operator visits the form.
  assert.equal(
    w.localStorage.getItem(DRAFT_KEY),
    null,
    "successful save must clear the persisted draft",
  );

  await session2.unmount();
});

test("LAN drop mid-sortie: discarding the banner wipes the draft and prevents future restore", async () => {
  w.localStorage.removeItem(DRAFT_KEY);
  setOnline(true);

  // Seed a saved draft as if a previous session left one behind.
  const seed = { acNumber: "JY-001", remarks: "old", time: "0.5" };
  w.localStorage.setItem(DRAFT_KEY, JSON.stringify(seed));

  const m = await mountHarness(emptyDraft());
  assert.ok(
    w.document.querySelector(
      "[data-testid=form-draft-banner-add-sortie]",
    ),
    "banner must surface the seeded draft",
  );

  const discardBtn = w.document.querySelector(
    "[data-testid=form-draft-banner-add-sortie-discard]",
  ) as HTMLButtonElement;
  assert.ok(discardBtn);
  await act(async () => { discardBtn.click(); });
  await flush();

  assert.equal(
    w.localStorage.getItem(DRAFT_KEY),
    null,
    "discard must wipe the persisted draft",
  );
  assert.equal(
    w.document.querySelector(
      "[data-testid=form-draft-banner-add-sortie]",
    ),
    null,
    "banner must hide after discard",
  );

  await m.unmount();
});
