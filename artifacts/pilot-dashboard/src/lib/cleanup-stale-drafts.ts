// Once-per-app-mount sweeper that evicts old form drafts from
// `localStorage`. Without it, every wizard / Add-Sortie / NOTAM
// session leaves a `draft.*` key behind that operators don't notice
// and never clear by hand — six months in, ops PCs accumulate
// hundreds of stale envelopes that never become useful again.
//
// Contract:
//   * Scans every `localStorage` key starting with `draft.`.
//   * Treats each value as a `FormDraftEnvelope` ({ _savedAt, value }).
//   * Deletes the entry when `_savedAt` is older than `maxAgeMs`
//     (default = 30 days).
//   * Legacy raw-T blobs (no `_savedAt`) are left alone — we don't
//     know how old they are. A new save will rewrite them in the
//     envelope shape and they'll age out on the next sweep.
//   * Unparseable entries are also left alone; the per-form hook
//     drops them defensively on the next `restoreDraft` call.
//
// Task #383 (folded into T-M).

import { isFormDraftEnvelope } from "./use-form-draft";

const DRAFT_PREFIX = "draft.";
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  scanned: number;
  removed: number;
  /** Keys that were dropped — exposed for tests and audit logging. */
  removedKeys: string[];
}

/**
 * Sweep `draft.*` localStorage keys, evicting envelopes older than
 * `maxAgeMs`. Safe to call without `window` (returns a zeroed
 * result so SSR / node tests don't throw). Always best-effort:
 * any per-key error is swallowed so a single corrupt entry can't
 * stop the rest of the sweep.
 */
export function cleanupStaleDrafts(maxAgeMs = DEFAULT_MAX_AGE_MS): CleanupResult {
  const result: CleanupResult = { scanned: 0, removed: 0, removedKeys: [] };
  if (typeof window === "undefined") return result;

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return result;
  }

  // Snapshot the keys before mutating — `removeItem` shifts indices
  // under the iteration cursor and can skip entries on some browsers.
  const candidates: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(DRAFT_PREFIX)) candidates.push(k);
    }
  } catch {
    return result;
  }

  const now = Date.now();
  for (const key of candidates) {
    result.scanned++;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable — leave it; a future restore call will drop it.
      continue;
    }
    if (!isFormDraftEnvelope(parsed)) {
      // Legacy raw-T blob — no `_savedAt`, so we can't age it out.
      // Will be rewritten with a timestamp on the next save.
      continue;
    }

    const savedAt = Date.parse(parsed._savedAt);
    if (!Number.isFinite(savedAt)) continue;
    if (now - savedAt < maxAgeMs) continue;

    try {
      storage.removeItem(key);
      result.removed++;
      result.removedKeys.push(key);
    } catch {
      /* ignore — best-effort */
    }
  }

  return result;
}
