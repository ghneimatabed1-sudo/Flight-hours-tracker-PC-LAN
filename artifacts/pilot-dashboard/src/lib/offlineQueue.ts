import { supabase } from "./supabase";
import { isLanSessionLoginEnabled } from "./internal-migration";

export interface QueuedMutation {
  id: string;
  table: string;
  op: "insert" | "update" | "delete";
  payload: Record<string, unknown>;
  match?: Record<string, unknown>;
  createdAt: number;
}

const KEY = "rjaf.outbox";

function read(): QueuedMutation[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as QueuedMutation[]; }
  catch { return []; }
}
function write(items: QueuedMutation[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
}

export function enqueue(m: Omit<QueuedMutation, "id" | "createdAt">) {
  const items = read();
  items.push({ ...m, id: crypto.randomUUID(), createdAt: Date.now() });
  write(items);
}

export function pending(): QueuedMutation[] {
  return read();
}

export async function flushOutbox(): Promise<{ flushed: number; failed: number }> {
  if (isLanSessionLoginEnabled()) return { flushed: 0, failed: 0 };
  if (!supabase || !navigator.onLine) return { flushed: 0, failed: 0 };
  const items = read();
  if (!items.length) return { flushed: 0, failed: 0 };
  const remaining: QueuedMutation[] = [];
  let flushed = 0;
  let failed = 0;
  for (const m of items) {
    let error: { message: string } | null = null;
    if (m.op === "insert") {
      ({ error } = await supabase.from(m.table).insert(m.payload));
    } else if (m.op === "update") {
      ({ error } = await supabase.from(m.table).update(m.payload).match(m.match ?? {}));
    } else {
      ({ error } = await supabase.from(m.table).delete().match(m.match ?? {}));
    }
    if (error) { failed++; remaining.push(m); } else { flushed++; }
  }
  write(remaining);
  return { flushed, failed };
}

let started = false;
export function startOutboxWorker() {
  if (started) return;
  started = true;
  const tick = () => { void flushOutbox(); };
  window.addEventListener("online", tick);
  setInterval(tick, 30_000);
  tick();
}
