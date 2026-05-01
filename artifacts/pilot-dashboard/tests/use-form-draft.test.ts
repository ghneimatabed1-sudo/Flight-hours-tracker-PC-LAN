// Tests for the useFormDraft hook (artifacts/pilot-dashboard/src/lib/use-form-draft.ts).
//
// We mount a tiny harness component that uses the hook, then drive
// the same operator flow a real form would: type → wait for the
// 500 ms debounce → reload (re-mount with the same key) → assert
// hasDraft → click Restore → assert state matches → click Discard →
// assert blob removed.
//
// All persistence goes through `window.localStorage` provided by the
// shared JSDOM bootstrap. We deliberately drive the debounce by
// awaiting real `setTimeout` instead of fake timers — keeps the test
// honest about the 500 ms contract advertised in the hook's doc.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:use-form-draft

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
    value, writable: true, configurable: true, enumerable: true,
  });
}
setG("window", w);
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("HTMLElement", w.HTMLElement);
setG("Element", w.Element);
setG("Node", w.Node);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wait long enough for the 500 ms hook debounce to flush.
async function flushDebounce() {
  await act(async () => { await sleep(600); });
}

interface DraftShape {
  name: string;
  count: number;
}

function emptyDraft(): DraftShape {
  return { name: "", count: 0 };
}

// ── harness ─────────────────────────────────────────────────────────
// Renders a button row that exposes the hook's full surface so the
// test can drive it without any DOM querying — every action is wired
// to a stable test id.
async function mountHarness(key: string, initial: DraftShape) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useFormDraft } = await import("../src/lib/use-form-draft.ts");

  let latestState: DraftShape = initial;
  let latestHook: ReturnType<typeof useFormDraft<DraftShape>> | null = null;
  let setStateExternal: ((next: DraftShape) => void) | null = null;

  function Harness({ initialState }: { initialState: DraftShape }) {
    const [state, setState] = React.useState<DraftShape>(initialState);
    const hook = useFormDraft<DraftShape>(key, state, setState);
    latestState = state;
    latestHook = hook;
    setStateExternal = setState;
    return null;
  }

  const el = w.document.getElementById("root")!;
  // Wipe between tests by clearing the host node.
  while (el.firstChild) el.removeChild(el.firstChild);
  const root = createRoot(el);

  await act(async () => {
    root.render(React.createElement(Harness, { initialState: initial }));
  });

  return {
    get state() { return latestState; },
    get hook() {
      if (!latestHook) throw new Error("hook not yet mounted");
      return latestHook;
    },
    setState(next: DraftShape) {
      if (!setStateExternal) throw new Error("setState not yet exposed");
      setStateExternal(next);
    },
    async unmount() { await act(async () => { root.unmount(); }); },
  };
}

// ── tests ───────────────────────────────────────────────────────────

test("useFormDraft: initial empty form does not flag a draft", async () => {
  const KEY = "draft.test.empty";
  w.localStorage.removeItem(KEY);

  const h = await mountHarness(KEY, emptyDraft());
  await flushDebounce();
  assert.equal(h.hook.hasDraft, false, "empty baseline must not be flagged");
  assert.equal(w.localStorage.getItem(KEY), null,
    "writing the empty baseline back to storage would be noise");
  await h.unmount();
});

test("useFormDraft: typing persists after the 500ms debounce", async () => {
  const KEY = "draft.test.persist";
  w.localStorage.removeItem(KEY);

  const h = await mountHarness(KEY, emptyDraft());
  await act(async () => { h.setState({ name: "Alice", count: 3 }); });

  // Before debounce flushes, nothing should be persisted yet.
  assert.equal(w.localStorage.getItem(KEY), null,
    "write must wait for the debounce window");

  await flushDebounce();
  const blob = w.localStorage.getItem(KEY);
  assert.ok(blob, "blob must exist after debounce");
  // The hook persists `{ _savedAt, value }` envelopes since #383 so
  // the once-per-mount cleanup sweep can age stale drafts out of
  // localStorage. The user's data lives under `value`.
  const parsed = JSON.parse(blob!) as { _savedAt: string; value: DraftShape };
  assert.deepEqual(parsed.value, { name: "Alice", count: 3 });
  assert.equal(typeof parsed._savedAt, "string");
  assert.ok(
    !Number.isNaN(Date.parse(parsed._savedAt)),
    "_savedAt must be a parseable ISO timestamp",
  );
  await h.unmount();
});

test("useFormDraft: rapid edits collapse into a single write", async () => {
  const KEY = "draft.test.debounce-coalesce";
  w.localStorage.removeItem(KEY);

  const h = await mountHarness(KEY, emptyDraft());
  // Three edits inside the same 500 ms window — only the last one
  // should ever land in storage.
  await act(async () => { h.setState({ name: "A", count: 1 }); });
  await act(async () => { await sleep(50); });
  await act(async () => { h.setState({ name: "AB", count: 2 }); });
  await act(async () => { await sleep(50); });
  await act(async () => { h.setState({ name: "ABC", count: 3 }); });

  await flushDebounce();
  const blob = w.localStorage.getItem(KEY);
  const parsed = JSON.parse(blob!) as { _savedAt: string; value: DraftShape };
  assert.deepEqual(parsed.value, { name: "ABC", count: 3 });
  await h.unmount();
});

test("useFormDraft: hasDraft is true on remount when a saved blob exists", async () => {
  const KEY = "draft.test.has-draft";
  w.localStorage.removeItem(KEY);

  // Session 1 — type something and let it persist.
  const h1 = await mountHarness(KEY, emptyDraft());
  await act(async () => { h1.setState({ name: "Bravo", count: 7 }); });
  await flushDebounce();
  await h1.unmount();

  // Session 2 — fresh mount with the EMPTY initial state simulates a
  // page reload. The hook must see the persisted blob and flag it.
  const h2 = await mountHarness(KEY, emptyDraft());
  assert.equal(h2.hook.hasDraft, true, "saved draft must be advertised");
  await h2.unmount();
});

test("useFormDraft: restoreDraft applies the persisted blob to state", async () => {
  const KEY = "draft.test.restore";
  w.localStorage.removeItem(KEY);

  const h1 = await mountHarness(KEY, emptyDraft());
  await act(async () => { h1.setState({ name: "Charlie", count: 12 }); });
  await flushDebounce();
  await h1.unmount();

  const h2 = await mountHarness(KEY, emptyDraft());
  assert.equal(h2.state.name, "");
  assert.equal(h2.state.count, 0);

  await act(async () => { h2.hook.restoreDraft(); });
  assert.equal(h2.state.name, "Charlie",
    "restoreDraft must hand the saved name back to the form");
  assert.equal(h2.state.count, 12,
    "restoreDraft must hand the saved count back to the form");
  assert.equal(h2.hook.hasDraft, false,
    "banner must hide once the draft has been restored");
  await h2.unmount();
});

test("useFormDraft: discardDraft wipes the persisted blob", async () => {
  const KEY = "draft.test.discard";
  w.localStorage.removeItem(KEY);

  const h1 = await mountHarness(KEY, emptyDraft());
  await act(async () => { h1.setState({ name: "Delta", count: 99 }); });
  await flushDebounce();
  await h1.unmount();

  const h2 = await mountHarness(KEY, emptyDraft());
  assert.equal(h2.hook.hasDraft, true);

  await act(async () => { h2.hook.discardDraft(); });
  assert.equal(w.localStorage.getItem(KEY), null,
    "discard must remove the storage key");
  assert.equal(h2.hook.hasDraft, false,
    "banner must hide once the draft has been discarded");
  await h2.unmount();
});

test("useFormDraft: corrupt persisted blob is dropped on restore", async () => {
  const KEY = "draft.test.corrupt";
  w.localStorage.setItem(KEY, "{not valid json");

  const h = await mountHarness(KEY, emptyDraft());
  // hasDraft is allowed to be true here — the hook can't tell the
  // blob is corrupt without parsing. Restore must defensively drop it.
  await act(async () => { h.hook.restoreDraft(); });
  assert.equal(w.localStorage.getItem(KEY), null,
    "corrupt blobs must not stick around prompting the operator forever");
  assert.equal(h.hook.hasDraft, false,
    "banner must hide after the failed restore");
  await h.unmount();
});

test("useFormDraft: legacy raw-T blobs are still accepted on restore (#383)", async () => {
  // Pre-#383 builds wrote raw `T` JSON without the `_savedAt`
  // envelope. Operators upgrading to the new bundle must not lose
  // their in-progress drafts on first launch.
  const KEY = "draft.test.legacy-raw";
  const legacy = { name: "Foxtrot", count: 42 };
  w.localStorage.setItem(KEY, JSON.stringify(legacy));

  const h = await mountHarness(KEY, emptyDraft());
  assert.equal(h.hook.hasDraft, true, "legacy blob must still trip hasDraft");

  await act(async () => { h.hook.restoreDraft(); });
  assert.equal(h.state.name, "Foxtrot");
  assert.equal(h.state.count, 42);
  await h.unmount();
});

test("useFormDraft: dirty state installs a beforeunload listener (#382)", async () => {
  const KEY = "draft.test.beforeunload";
  w.localStorage.removeItem(KEY);

  // Spy on add/remove to verify the listener lifecycle.
  const installs: string[] = [];
  const removes: string[] = [];
  const origAdd = w.addEventListener.bind(w);
  const origRemove = w.removeEventListener.bind(w);
  w.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
    if (type === "beforeunload") installs.push(type);
    return origAdd(type as never, listener as never, opts as never);
  }) as typeof w.addEventListener;
  w.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
    if (type === "beforeunload") removes.push(type);
    return origRemove(type as never, listener as never, opts as never);
  }) as typeof w.removeEventListener;

  try {
    const h = await mountHarness(KEY, emptyDraft());
    // Empty baseline — no listener yet.
    assert.equal(installs.length, 0,
      "no beforeunload listener while the form matches the baseline");

    await act(async () => { h.setState({ name: "Golf", count: 1 }); });
    assert.equal(installs.length, 1,
      "dirty state must install exactly one beforeunload listener");

    // Simulate a tab-close attempt and confirm we cancel it.
    const ev = new w.Event("beforeunload", { cancelable: true }) as unknown as BeforeUnloadEvent;
    Object.defineProperty(ev, "returnValue", { value: "", writable: true });
    w.dispatchEvent(ev as unknown as Event);
    assert.equal(ev.defaultPrevented, true,
      "beforeunload must be cancelled while the draft is dirty");

    // Reset to baseline — listener must come back off.
    await act(async () => { h.setState(emptyDraft()); });
    assert.ok(removes.length >= 1,
      "clean form must remove the beforeunload listener");

    await h.unmount();
  } finally {
    w.addEventListener = origAdd;
    w.removeEventListener = origRemove;
  }
});

test("useFormDraft: markSaved() suppresses beforeunload until next edit (#382)", async () => {
  const KEY = "draft.test.markSaved";
  w.localStorage.removeItem(KEY);

  const installs: string[] = [];
  const removes: string[] = [];
  const origAdd = w.addEventListener.bind(w);
  const origRemove = w.removeEventListener.bind(w);
  w.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
    if (type === "beforeunload") installs.push(type);
    return origAdd(type as never, listener as never, opts as never);
  }) as typeof w.addEventListener;
  w.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
    if (type === "beforeunload") removes.push(type);
    return origRemove(type as never, listener as never, opts as never);
  }) as typeof w.removeEventListener;

  try {
    const h = await mountHarness(KEY, emptyDraft());

    // Type → listener is installed.
    await act(async () => { h.setState({ name: "Alpha", count: 2 }); });
    assert.equal(installs.length, 1,
      "dirty edit must install the beforeunload listener");

    // Operator hits Save in the host form. The form does NOT reset
    // to baseline (e.g. an Edit screen). markSaved() should remove
    // the listener for this populated state.
    const installsBefore = installs.length;
    const removesBefore = removes.length;
    await act(async () => { h.hook.markSaved(); h.setState({ name: "Alpha", count: 2 }); });
    assert.ok(removes.length > removesBefore,
      "markSaved() must remove the listener while state is unchanged");
    assert.equal(installs.length, installsBefore,
      "no fresh install while state still equals the saved snapshot");

    // The next user edit must re-arm the listener.
    await act(async () => { h.setState({ name: "Alpha2", count: 2 }); });
    assert.ok(installs.length > installsBefore,
      "subsequent edit must reinstall the beforeunload listener");

    await h.unmount();
  } finally {
    w.addEventListener = origAdd;
    w.removeEventListener = origRemove;
  }
});

test("cleanupStaleDrafts: evicts envelopes older than the cutoff (#383)", async () => {
  const { cleanupStaleDrafts } = await import(
    "../src/lib/cleanup-stale-drafts.ts"
  );

  // Wipe any leftover keys so we count cleanly.
  for (let i = w.localStorage.length - 1; i >= 0; i--) {
    const k = w.localStorage.key(i);
    if (k && k.startsWith("draft.")) w.localStorage.removeItem(k);
  }

  const now = Date.now();
  const oldStamp = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
  const freshStamp = new Date(now - 60_000).toISOString();
  w.localStorage.setItem(
    "draft.stale.one",
    JSON.stringify({ _savedAt: oldStamp, value: { foo: 1 } }),
  );
  w.localStorage.setItem(
    "draft.fresh.two",
    JSON.stringify({ _savedAt: freshStamp, value: { foo: 2 } }),
  );
  w.localStorage.setItem(
    "draft.legacy.three",
    JSON.stringify({ foo: 3 }), // pre-envelope blob — must be left alone
  );
  w.localStorage.setItem(
    "draft.corrupt.four",
    "{not valid json",
  );
  // Non-draft keys must never be touched.
  w.localStorage.setItem("rjaf.lang", "en");

  const r = cleanupStaleDrafts();
  assert.equal(r.removed, 1, "exactly the stale envelope is dropped");
  assert.deepEqual(r.removedKeys, ["draft.stale.one"]);

  assert.equal(w.localStorage.getItem("draft.stale.one"), null);
  assert.ok(w.localStorage.getItem("draft.fresh.two"),
    "fresh envelope survives");
  assert.ok(w.localStorage.getItem("draft.legacy.three"),
    "legacy raw blob is left alone (no _savedAt to age out)");
  assert.equal(w.localStorage.getItem("draft.corrupt.four"), "{not valid json",
    "corrupt blob is left alone — per-form hook drops it on restore");
  assert.equal(w.localStorage.getItem("rjaf.lang"), "en",
    "non-draft keys are never touched");
});

test("useFormDraft: clearing back to the baseline removes the stored blob", async () => {
  const KEY = "draft.test.clear-to-baseline";
  w.localStorage.removeItem(KEY);

  const h = await mountHarness(KEY, emptyDraft());
  await act(async () => { h.setState({ name: "Echo", count: 5 }); });
  await flushDebounce();
  assert.ok(w.localStorage.getItem(KEY), "blob exists after a real edit");

  // Operator deletes everything they typed — state matches the empty
  // baseline again. The hook treats this as "nothing to preserve" and
  // clears the storage so a future mount doesn't show a stale banner.
  await act(async () => { h.setState(emptyDraft()); });
  await flushDebounce();
  assert.equal(w.localStorage.getItem(KEY), null,
    "matching the baseline must wipe the persisted draft");
  await h.unmount();
});
