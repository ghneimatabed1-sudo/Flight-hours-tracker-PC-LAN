// Mobile runtime error reporter — Task #265 Part F.
//
// Best-effort POST of caught runtime errors to public.runtime_errors
// via the runtime_error_capture RPC. Fire-and-forget; reporter failure
// MUST NEVER bubble back into the UI.
import Constants from "expo-constants";
import { Platform } from "react-native";

import { supabase, supabaseConfigured } from "./supabase";

const APP_NAME = "mobile";
const APP_VERSION =
  (Constants.expoConfig?.version as string | undefined) ??
  (Constants.manifest?.version as string | undefined) ??
  "unknown";

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
  const last = recentlyReported.get(key);
  const now = Date.now();
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  recentlyReported.set(key, now);
  return true;
}
function deviceUserAgent(): string {
  return `Hawk Eye Mobile / Expo ${Platform.OS} ${Platform.Version}`;
}

export interface RuntimeErrorContext {
  source?: string;       // 'errorBoundary' | 'unhandledpromise' | 'global'
  componentStack?: string;
  page?: string;
}

export function reportRuntimeError(
  err: unknown,
  ctx: RuntimeErrorContext = {},
): void {
  try {
    if (!supabaseConfigured || !supabase) return;
    const e =
      err instanceof Error
        ? err
        : new Error(typeof err === "string" ? err : JSON.stringify(err));
    const name = (e.name || "Error").slice(0, 64);
    const message = (e.message || "(no message)").slice(0, 1000);
    if (!shouldReport(name, message)) return;
    reportCount += 1;
    const stack = (e.stack || "").slice(0, 4000);
    const detail: Record<string, unknown> = { source: ctx.source ?? "unknown" };
    if (ctx.componentStack) {
      detail.componentStack = ctx.componentStack.slice(0, 2000);
    }
    Promise.resolve(
      supabase.rpc("runtime_error_capture", {
        p_app: APP_NAME,
        p_app_version: APP_VERSION,
        p_page: ctx.page ?? "(unknown)",
        p_message: message,
        p_name: name,
        p_stack: stack,
        p_user_agent: deviceUserAgent(),
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
