// Runtime error reporter — Task #265 Part F.
//
// Best-effort POST of caught runtime errors to `public.runtime_errors`
// via the `runtime_error_capture` RPC. This is fire-and-forget: a
// failure to report MUST NEVER bubble back into the UI. Without that
// guarantee the reporter would amplify the very crash it's meant to
// observe.
//
// Rate limiting:
//   • A given (name + first 80 chars of message) is reported at most
//     once per 60 seconds. Storms of identical errors (e.g. a render
//     loop) collapse into one row per minute.
//   • A hard cap of 30 reports per session prevents pathological
//     loops from filling up the table from a single PC.
//
// The reporter is safe to call before any user has signed in — the
// SQL RPC is granted to `anon` precisely so pre-mount failures land
// in the table.

import { supabase, supabaseConfigured } from "./supabase";
import { isLanSessionLoginEnabled } from "./internal-migration";

const APP_NAME = "dashboard";
const APP_VERSION = (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null) || "unknown";
const DEDUP_WINDOW_MS = 60_000;
const MAX_REPORTS_PER_SESSION = 30;

const recentlyReported = new Map<string, number>();
let reportCount = 0;

function dedupKey(name: string, message: string): string {
  return `${name}::${message.slice(0, 80)}`;
}

function shouldReport(name: string, message: string): boolean {
  if (reportCount >= MAX_REPORTS_PER_SESSION) return false;
  const key = dedupKey(name, message);
  const lastSeen = recentlyReported.get(key);
  const now = Date.now();
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) return false;
  recentlyReported.set(key, now);
  return true;
}

function currentPage(): string {
  if (typeof window === "undefined") return "(no-window)";
  // The dashboard uses hash routing (e.g. #/sorties); include both
  // the pathname (path-based prefix) and the hash so we know which
  // page within the SPA crashed.
  return `${window.location.pathname}${window.location.hash || ""}`.slice(0, 256);
}

function userAgent(): string | null {
  return typeof navigator !== "undefined" ? navigator.userAgent : null;
}

export interface RuntimeErrorContext {
  source?: string;          // 'window.error' | 'unhandledrejection' | 'errorBoundary'
  componentStack?: string;
}

export function reportRuntimeError(err: unknown, ctx: RuntimeErrorContext = {}): void {
  try {
    if (isLanSessionLoginEnabled()) return;
    if (!supabaseConfigured || !supabase) return;
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
    const name = (e.name || "Error").slice(0, 64);
    const message = (e.message || "(no message)").slice(0, 1000);
    if (!shouldReport(name, message)) return;
    reportCount += 1;
    const stack = (e.stack || "").slice(0, 4000);
    const detail = ctx.componentStack
      ? { source: ctx.source ?? "unknown", componentStack: ctx.componentStack.slice(0, 2000) }
      : { source: ctx.source ?? "unknown" };
    // Fire-and-forget. Never await; never re-raise.
    Promise.resolve(
      supabase.rpc("runtime_error_capture", {
        p_app: APP_NAME,
        p_app_version: APP_VERSION,
        p_page: currentPage(),
        p_message: message,
        p_name: name,
        p_stack: stack,
        p_user_agent: userAgent(),
        p_detail: detail,
      }),
    ).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Reporter must never throw.
  }
}

// Vite-injected at build time via `define`; falls back to "unknown"
// if the constant isn't defined.
declare const __APP_VERSION__: string | undefined;
