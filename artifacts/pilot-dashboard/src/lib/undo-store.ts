// Single-slot undo store. The edit/delete flows in AddSortie + SortieLog
// register an undo handler here after a successful mutation; the global
// UndoToast component subscribes and renders a 30-second countdown with a
// single Undo button. Registering a new undo while one is still pending
// auto-finalizes the previous one (the prior action becomes permanent).
//
// State lives outside React (module-level) so it survives unrelated
// re-renders and so any page can register an undo without prop-drilling.

export interface UndoEntry {
  id: string;
  message: string;
  startedAt: number;
  expiresAt: number;
  undo: () => Promise<void> | void;
  finalize?: () => void;
}

type Listener = (entry: UndoEntry | null) => void;

let listeners: Listener[] = [];
let current: UndoEntry | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const l of listeners) l(current);
}

function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function finalizeCurrent() {
  const entry = current;
  current = null;
  clearTimer();
  if (entry?.finalize) {
    try {
      entry.finalize();
    } catch {
      /* noop — finalize is best-effort */
    }
  }
  notify();
}

export interface ShowUndoOpts {
  message: string;
  durationMs?: number;
  undo: () => Promise<void> | void;
  finalize?: () => void;
}

export function showUndo(opts: ShowUndoOpts): string {
  // Replacing a still-pending undo finalizes the prior action permanently
  // before the new one shows up. This is intentional: the toast is single
  // slot so the user always sees the most recent reversible action.
  if (current?.finalize) {
    try {
      current.finalize();
    } catch {
      /* noop */
    }
  }
  clearTimer();
  const duration = opts.durationMs ?? 30_000;
  const now = Date.now();
  const entry: UndoEntry = {
    id: `${now}-${Math.random().toString(36).slice(2, 6)}`,
    message: opts.message,
    startedAt: now,
    expiresAt: now + duration,
    undo: opts.undo,
    finalize: opts.finalize,
  };
  current = entry;
  timer = setTimeout(() => {
    if (current?.id === entry.id) finalizeCurrent();
  }, duration);
  notify();
  return entry.id;
}

export async function triggerUndo(): Promise<void> {
  const entry = current;
  if (!entry) return;
  current = null;
  clearTimer();
  notify();
  try {
    await entry.undo();
  } catch {
    /* error toasts surfaced by callers */
  }
}

export function dismissUndo(): void {
  if (!current) return;
  finalizeCurrent();
}

export function subscribeUndo(fn: Listener): () => void {
  listeners.push(fn);
  fn(current);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function getCurrentUndo(): UndoEntry | null {
  return current;
}
