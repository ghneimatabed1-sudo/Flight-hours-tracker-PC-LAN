// Generic form-draft hook. Persists the live form state to
// localStorage on every change (debounced) so a LAN drop, page reload
// or accidental browser close never costs the operator a half-typed
// sortie / pilot record / NOTAM. Mounted forms call `discardDraft()`
// after a successful save so the next session starts clean.
//
// Design notes
// ────────────
//   • The hook never auto-restores. It only reports `hasDraft` and
//     hands two callbacks (`restoreDraft`, `discardDraft`) back to the
//     caller. The caller renders <FormDraftBanner/> which gives the
//     operator a deliberate Restore / Discard choice  silently
//     replacing the form would be a worse UX (mid-edit rows would
//     get clobbered).
//   • The "is this draft different from the empty initial state?"
//     comparison uses JSON.stringify against a snapshot of `current`
//     captured on first render. That snapshot is treated as the
//     "empty" baseline; if the persisted blob deep-equals it, we
//     hide the banner. This lets every form pass its own `blankForm()`
//     output without needing a separate `initial` prop.
//   • Persistence is debounced at 500ms. Operators type fast; without
//     debounce we'd hammer localStorage on every keystroke.
//   • SSR-safe: the hook checks for `window` before touching
//     localStorage, so server-rendered tests don't blow up.
//   • Persisted shape (since #383): a JSON envelope
//     `{ _savedAt: <ISO>, value: <T> }`. The `_savedAt` timestamp lets
//     `cleanup-stale-drafts.ts` evict drafts that no operator has
//     touched in 30 days so localStorage doesn't grow unbounded.
//     Legacy raw-`T` blobs written before the envelope landed are
//     still accepted on read so an upgrade doesn't lose work.
//   • Since #382: while a draft is dirty (current state differs from
//     the empty baseline) we register a `beforeunload` listener so
//     the browser's native "Are you sure you want to leave?" prompt
//     fires on tab close / refresh / navigation. The listener is
//     removed as soon as state matches the baseline again, which is
//     what `discardDraft()` produces immediately after a successful
//     save (forms reset their state to `blankForm()` on save).
//
// Task T-D / #371 originally; #382 + #383 folded in by T-M.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

const DEBOUNCE_MS = 500;

interface UseFormDraftResult {
  /** True if a non-empty saved draft exists for this key. */
  hasDraft: boolean;
  /** Apply the saved draft to the form (calls setCurrent). */
  restoreDraft: () => void;
  /** Wipe the saved draft from localStorage and hide the banner. */
  discardDraft: () => void;
  /**
   * Tell the hook the current form contents have just been persisted
   * server-side. Suppresses the #382 beforeunload prompt until the
   * user makes another edit, even if the form does NOT reset back to
   * `blankForm()` after save (e.g. an "edit pilot" screen that stays
   * populated). Most call sites can ignore this and rely on the
   * baseline-comparison; it's an opt-in escape hatch.
   */
  markSaved: () => void;
}

/**
 * Persisted envelope. Wraps the form's value with the timestamp the
 * draft was last touched so the once-per-app-mount stale-draft
 * sweeper (`cleanup-stale-drafts.ts`) can age old drafts out of
 * localStorage without parsing every shape independently.
 */
export interface FormDraftEnvelope<T = unknown> {
  _savedAt: string;
  value: T;
}

/**
 * True iff `parsed` walks like a `FormDraftEnvelope`. Used by the
 * cleanup sweeper too — exported so we keep the shape contract in
 * exactly one place.
 */
export function isFormDraftEnvelope(parsed: unknown): parsed is FormDraftEnvelope {
  if (!parsed || typeof parsed !== "object") return false;
  const o = parsed as Record<string, unknown>;
  return typeof o["_savedAt"] === "string" && "value" in o;
}

function safeRead(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage may be full or blocked  silently drop */
  }
}

function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * Read the "value" portion of a persisted draft, supporting both the
 * envelope shape and the legacy raw-T blob. Returns the JSON-stringified
 * value (so it can be compared cheaply against the baseline) along
 * with the parsed value itself for `restoreDraft` to hand back.
 */
function readPersistedValue(blob: string | null): { valueJson: string; value: unknown } | null {
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (isFormDraftEnvelope(parsed)) {
      return { valueJson: JSON.stringify(parsed.value), value: parsed.value };
    }
    return { valueJson: blob, value: parsed };
  } catch {
    return null;
  }
}

export function useFormDraft<T>(
  formKey: string,
  current: T,
  setCurrent: (next: T) => void,
): UseFormDraftResult {
  // Snapshot the initial "empty" state on first render. We compare
  // persisted drafts against this baseline so the banner only fires
  // when there's actual user-entered content, not just the default
  // shape. The ref is intentionally NOT included as a dependency
  // anywhere  it must stay stable across re-renders.
  const emptyBaselineRef = useRef<string>("");
  const initialisedRef = useRef(false);
  if (!initialisedRef.current) {
    try {
      emptyBaselineRef.current = JSON.stringify(current);
    } catch {
      emptyBaselineRef.current = "";
    }
    initialisedRef.current = true;
  }

  // Read the persisted draft once on mount.
  const initialPersisted = useMemo(
    () => readPersistedValue(safeRead(formKey)),
    [formKey],
  );
  const [storedValueJson, setStoredValueJson] = useState<string | null>(
    initialPersisted ? initialPersisted.valueJson : null,
  );

  // hasDraft is true iff a persisted blob exists AND its value differs
  // from the empty baseline. We keep this as derived state so the
  // banner hides as soon as discardDraft() runs.
  const hasDraft = useMemo(() => {
    if (!storedValueJson) return false;
    if (storedValueJson === emptyBaselineRef.current) return false;
    return storedValueJson.length > 0;
  }, [storedValueJson]);

  // Debounced write: every change to `current` schedules a save 500ms
  // later. Subsequent changes within that window cancel the prior
  // timer so we end up with a single write per quiet period.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.setTimeout(() => {
      try {
        const blob = JSON.stringify(current);
        // Don't bother persisting the empty baseline  it's just
        // noise and would make hasDraft trip on every fresh visit.
        if (blob === emptyBaselineRef.current) {
          safeRemove(formKey);
        } else {
          const envelope: FormDraftEnvelope<T> = {
            _savedAt: new Date().toISOString(),
            value: current,
          };
          safeWrite(formKey, JSON.stringify(envelope));
        }
      } catch {
        /* unserialisable input  skip */
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [formKey, current]);

  // beforeunload guard (#382). While the form is dirty (current state
  // differs from the empty baseline AND the user has touched it since
  // the last save), register a `beforeunload` listener so the browser
  // shows its native "Leave site?" prompt on tab close, refresh and
  // back-navigation. Once the form is back at baseline — which
  // happens immediately after a successful save because most callers
  // reset state to `blankForm()` — we tear the listener down so a
  // clean form never produces a spurious prompt.
  //
  // `lastSavedSnapshot` is the opt-in escape hatch (`markSaved()`)
  // for callers whose forms stay populated after save (e.g. an edit
  // screen). It MUST be state, not a ref — the beforeunload effect
  // depends on it, so updating it via `setLastSavedSnapshot` triggers
  // the effect to re-evaluate and remove the listener immediately.
  // (A ref would silently fail to tear the listener down.)
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let snapshot: string;
    try {
      snapshot = JSON.stringify(current);
    } catch {
      return;
    }
    const matchesBaseline = snapshot === emptyBaselineRef.current;
    const matchesLastSaved = lastSavedSnapshot !== null
      && snapshot === lastSavedSnapshot;
    if (matchesBaseline || matchesLastSaved) return;
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      // Modern browsers ignore the message string but still display
      // the native prompt as long as we call preventDefault and
      // assign returnValue. Both are required across Chrome/Firefox.
      ev.preventDefault();
      ev.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [current, lastSavedSnapshot]);

  const restoreDraft = useCallback(() => {
    const persisted = readPersistedValue(safeRead(formKey));
    if (!persisted) {
      // Nothing to restore — or the stored blob was unparseable.
      // Drop it defensively so we never get stuck prompting forever.
      safeRemove(formKey);
      setStoredValueJson(null);
      return;
    }
    setCurrent(persisted.value as T);
    setStoredValueJson(null);
  }, [formKey, setCurrent]);

  const discardDraft = useCallback(() => {
    safeRemove(formKey);
    setStoredValueJson(null);
  }, [formKey]);

  const markSaved = useCallback(() => {
    try {
      setLastSavedSnapshot(JSON.stringify(current));
    } catch {
      setLastSavedSnapshot(null);
    }
  }, [current]);

  return { hasDraft, restoreDraft, discardDraft, markSaved };
}
