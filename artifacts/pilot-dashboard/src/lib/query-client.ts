import { QueryClient, MutationCache, QueryCache } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { isMissingSchemaError } from "./schema-errors";

// Lightweight global "last error" tracker so the sidebar live-data indicator
// can flip to red after a Supabase failure without each page wiring its own
// error handling. The same hook also drives the toast that every mutation
// failure should produce.
let lastErrorAt: number | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function recordDataError(message: string) {
  lastErrorAt = Date.now();
  notify();
  toast({
    title: "Server error",
    description: message,
    variant: "destructive",
  });
}

export function clearDataError() {
  if (lastErrorAt === null) return;
  lastErrorAt = null;
  notify();
}

export function subscribeDataErrors(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLastDataErrorAt(): number | null {
  return lastErrorAt;
}

function describe(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Stale-while-revalidate keeps the UI responsive even when Supabase is
      // slow; the live-data indicator surfaces the in-flight state.
      staleTime: 30_000,
    },
  },
  // Surface every failed mutation through the global toast + indicator so
  // ops officers always see why a save did not persist. Successful mutations
  // can still emit their own page-specific toasts.
  // Per spec: the red "last mutation failed" indicator is driven only by
  // mutation failures. Query failures still surface a non-destructive toast
  // so the operator sees them, but they do not flip the live-data pill red
  // (the amber syncing state already covers in-flight reads).
  mutationCache: new MutationCache({
    onError: (err) => {
      // Missing-schema errors are environmental (pending migration) and
      // should not flip the global red indicator — they fall back to the
      // local mirror automatically.
      if (isMissingSchemaError(err)) return;
      recordDataError(describe(err));
    },
    onSuccess: () => clearDataError(),
  }),
  queryCache: new QueryCache({
    onError: (err) => {
      if (isMissingSchemaError(err)) return;
      toast({
        title: "Couldn't reach the server",
        description: describe(err),
      });
    },
  }),
});
