import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { isLanSessionLoginEnabled } from "./internal-migration";

// `import.meta.env` is a Vite-only construct; guard it so the module can
// also be imported from a plain Node test runner (see
// supabase-auth-wrap.test.ts) without crashing on first read.
const env: Record<string, string | undefined> =
  typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string | undefined> }).env
    ? ((import.meta as { env: Record<string, string | undefined> }).env)
    : {};
const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url as string, anonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "rjaf.sb" },
    })
  : null;

// ── Stale-token 401 handling ────────────────────────────────────────────
// supabase-js auto-refreshes JWTs every ~hour, but on the FIRST paint after
// returning to a tab that has been idle long enough for the cached token to
// expire, the very first .from(...).select() can race the refresh and come
// back with a 401 / PGRST301 / "JWT expired". Without a centralised guard,
// every page that issues a background read on mount (Overview, Squadrons,
// Commanders, License Keys, …) emits a noisy red error in the console even
// though supabase-js will quietly recover within a second.
//
// The contract:
//   • `isAuthError(err)` — best-effort predicate for the family of stale-
//     JWT errors that supabase-js / PostgREST return.
//   • `refreshSessionOnce()` — coalesces concurrent refresh attempts so a
//     burst of background reads on first paint only triggers a single
//     `auth.refreshSession()` round-trip, not one per query.
//   • `withFreshSession(fn)` — runs `fn()`; on auth error, refreshes
//     exactly once and retries `fn()` exactly once. Returns a tagged
//     result so callers can decide whether to fall back silently
//     (auth still bad → no session) or surface the error normally.
export function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { code?: string | number; status?: number; statusCode?: number; message?: string };
  const code = typeof e.code === "string" ? e.code.toUpperCase() : e.code;
  if (code === 401 || code === "401" || code === "PGRST301" || code === "PGRST302") return true;
  if (e.status === 401 || e.statusCode === 401) return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : (e.message ?? "");
  if (!msg) return false;
  return /jwt (expired|is expired|missing|malformed)|invalid jwt|token.*expired|unauthorized|not authenticated|auth session missing/i.test(msg);
}

let refreshInflight: Promise<boolean> | null = null;
export async function refreshSessionOnce(): Promise<boolean> {
  if (!supabase) return false;
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      // No session at all (signed out, or never signed in). Refresh would
      // 400 with "Auth session missing" and surface another red console
      // error — treat it as "not refreshable" so the caller silently
      // falls back to local data instead of retrying.
      if (!data?.session?.refresh_token) return false;
      const { error } = await supabase.auth.refreshSession();
      return !error;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInflight;
  } finally {
    // Clear shortly after so a stable failure can be re-attempted on the
    // next 401 burst (e.g. user re-authenticated in another tab).
    setTimeout(() => { refreshInflight = null; }, 500);
  }
}

export type FreshSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "auth"; error: unknown }
  | { ok: false; reason: "other"; error: unknown };

export async function withFreshSession<T>(fn: () => Promise<T>): Promise<FreshSessionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (!isAuthError(err)) return { ok: false, reason: "other", error: err };
    const refreshed = await refreshSessionOnce();
    if (!refreshed) return { ok: false, reason: "auth", error: err };
    try {
      return { ok: true, value: await fn() };
    } catch (err2) {
      if (isAuthError(err2)) return { ok: false, reason: "auth", error: err2 };
      return { ok: false, reason: "other", error: err2 };
    }
  }
}

export interface LicenseValidationResult {
  ok: boolean;
  error?: string;
  squadronId?: string;
  expiresAt?: string;
}

export async function validateLicenseRemote(
  key: string,
  fingerprint: string,
  username: string
): Promise<LicenseValidationResult> {
  if (isLanSessionLoginEnabled()) return { ok: false, error: "lan_mode_cloud_disabled" };
  if (!supabase) return { ok: false, error: "supabase_not_configured" };
  const { data, error } = await supabase.functions.invoke("validate-license", {
    body: { key, fingerprint, username },
  });
  if (error) return { ok: false, error: error.message };
  const payload = data as Partial<LicenseValidationResult> | null;
  if (!payload || !payload.ok) {
    return { ok: false, error: payload?.error ?? "rejected" };
  }
  return {
    ok: true,
    squadronId: payload.squadronId,
    expiresAt: payload.expiresAt,
  };
}

export interface RegisterLicenseArgs {
  key: string;
  username: string;
  displayName?: string;
  squadronNumber: string;
  squadronName?: string;
  squadronBase?: string;
  expiresAt?: string | null;
}

export interface RegisterLicenseResult {
  ok: boolean;
  error?: string;
  squadronId?: string;
  supabaseEmail?: string;
  supabasePassword?: string;
}

// Registers a freshly-minted license key with the central server AND
// provisions a Supabase auth user for the ops account so the browser can
// sign into Supabase and obtain a JWT carrying app_metadata.squadron_id.
// Without that JWT every operational-table read/write is silently filtered
// by RLS and PCs cannot share data.
//
// This call is routed through the api-server proxy (/api/license/register)
// rather than directly to the Supabase edge function. The provisioning
// secret lives only in the api-server's environment — it is never bundled
// into client code. VITE_API_SERVER_URL is just a base URL (not a secret)
// and defaults to the same-origin /api path for web builds.
export async function registerLicenseRemote(
  args: RegisterLicenseArgs
): Promise<RegisterLicenseResult> {
  if (isLanSessionLoginEnabled()) return { ok: false, error: "lan_mode_cloud_disabled" };
  // Build the registration endpoint robustly:
  //  - When VITE_API_SERVER_URL is unset (web build, same-origin) we fall back
  //    to the relative `/api` path.
  //  - When it IS set (Electron installer, points at the published api-server)
  //    we strip any trailing slash and any trailing `/api` segment the operator
  //    may have included, then re-append `/api`. This way the secret can be
  //    set to `https://pc-builder.replit.app` OR `https://pc-builder.replit.app/api`
  //    and both produce the same correct URL — instead of silently dropping
  //    the `/api` prefix and getting served the SPA's index.html (which is
  //    exactly the "Failed to fetch" we kept seeing in the field).
  const rawBase = (import.meta.env.VITE_API_SERVER_URL as string | undefined) ?? "";
  const trimmed = rawBase.replace(/\/+$/, "").replace(/\/api$/, "");
  const apiBase = trimmed ? `${trimmed}/api` : "/api";
  let resp: Response;
  try {
    resp = await fetch(`${apiBase}/license/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network_error" };
  }
  let payload: RegisterLicenseResult | null = null;
  try { payload = await resp.json(); } catch { /* ignore */ }
  if (!payload?.ok) return { ok: false, error: payload?.error ?? "register_failed" };
  return {
    ok: true,
    squadronId: payload.squadronId,
    supabaseEmail: payload.supabaseEmail,
    supabasePassword: payload.supabasePassword,
  };
}

export interface ProvisionCommanderArgs {
  username: string;
  displayName?: string;
  role?: "ops" | "commander" | "deputy";
  tier?: "hq" | "base" | "wing" | "squadron" | "flight" | "ops" | "deputy";
  squadronNumber?: string;
  squadronName?: string;
  squadronBase?: string;
  // Multi-squadron allow-list of squadron NAMES (matches
  // public.squadrons.name and xpc_squadron_snapshot.squadron_id). Required
  // for wing/base/HQ commanders so the snapshot SELECT policy admits the
  // squadrons they monitor; optional for squadron/flight tiers (the
  // edge function falls back to [squadronName]).
  squadronNames?: string[];
}

export interface ProvisionCommanderResult {
  ok: boolean;
  error?: string;
  userId?: string;
  supabaseEmail?: string;
  supabasePassword?: string;
}

// Provision (or refresh) a Supabase auth user for a non-ops account
// (Squadron / Flight / HQ commander, or a deputy). Returns the synthesized
// email + random password the client must persist locally so subsequent
// logins can call supabase.auth.signInWithPassword and obtain a JWT.
export async function provisionCommanderRemote(
  args: ProvisionCommanderArgs
): Promise<ProvisionCommanderResult> {
  if (isLanSessionLoginEnabled()) return { ok: false, error: "lan_mode_cloud_disabled" };
  if (!supabase) return { ok: false, error: "supabase_not_configured" };
  const { data, error } = await supabase.functions.invoke("provision-commander", {
    body: args,
  });
  if (error) return { ok: false, error: error.message };
  const payload = data as ProvisionCommanderResult | null;
  if (!payload?.ok) return { ok: false, error: payload?.error ?? "provision_failed" };
  return {
    ok: true,
    userId: payload.userId,
    supabaseEmail: payload.supabaseEmail,
    supabasePassword: payload.supabasePassword,
  };
}

// ── Local cache of Supabase credentials per local username ──────────────
// The local password (what the operator types) is intentionally separate
// from the random Supabase password we mint server-side; we cache the
// Supabase creds here keyed by local username so the auth flow can sign
// into Supabase right after the local hash check passes.
const SB_CREDS_KEY = "rjaf.supabaseCreds";

export interface SupabaseCreds { email: string; password: string }

function readCredsMap(): Record<string, SupabaseCreds> {
  try {
    const raw = localStorage.getItem(SB_CREDS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

export function storeSupabaseCreds(username: string, email: string, password: string): void {
  const map = readCredsMap();
  map[username.trim().toLowerCase()] = { email, password };
  try { localStorage.setItem(SB_CREDS_KEY, JSON.stringify(map)); } catch { /* swallow */ }
}

export function getSupabaseCreds(username: string): SupabaseCreds | null {
  const map = readCredsMap();
  return map[username.trim().toLowerCase()] ?? null;
}

// Re-provision Supabase credentials for a user whose locally-cached
// password has gone out of sync with the server (e.g. password rotated
// server-side, or local cache cleared and never restored). Calls the
// provision-commander edge function which is idempotent: it either
// creates the auth user or rotates its password, and returns the new
// password the client must persist. After a successful re-sync this
// helper also signs the browser into Supabase so the very next write
// carries a valid JWT — no extra round-trip from the caller.
//
// IMPORTANT: provision-commander now enforces JWT authentication —
// the caller must already be signed into Supabase (via a valid session)
// before calling this helper. The Supabase client automatically forwards
// the current session token in the Authorization header.
export async function resyncSupabaseCreds(
  username: string,
  role: "ops" | "commander" = "ops",
  squadron?: { number?: string; name?: string; base?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (isLanSessionLoginEnabled()) return { ok: false, error: "lan_mode_cloud_disabled" };
  if (!supabase) return { ok: false, error: "supabase_not_configured" };
  try {
    const prov = await provisionCommanderRemote({
      username,
      displayName: username,
      role,
      tier: role === "ops" ? "ops" : "squadron",
      squadronNumber: squadron?.number ?? "",
      squadronName: squadron?.name ?? "",
      squadronBase: squadron?.base ?? "",
    });
    if (!prov.ok || !prov.supabaseEmail || !prov.supabasePassword) {
      return { ok: false, error: prov.error ?? "no_creds_returned" };
    }
    storeSupabaseCreds(username, prov.supabaseEmail, prov.supabasePassword);
    const { error: sbErr } = await supabase.auth.signInWithPassword({
      email: prov.supabaseEmail,
      password: prov.supabasePassword,
    });
    if (sbErr) return { ok: false, error: sbErr.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function clearSupabaseCreds(username: string): void {
  const map = readCredsMap();
  delete map[username.trim().toLowerCase()];
  try { localStorage.setItem(SB_CREDS_KEY, JSON.stringify(map)); } catch { /* swallow */ }
}

// Hard retention cap for the audit_log table. Pages × page-size in the UI
// (50 × 50 = 2,500 rows) — keeping the table itself bounded means an old
// deployment can't accumulate millions of rows that slow every page load.
// Eviction runs opportunistically on insert: count rows, and if we're over
// the cap, delete the oldest row(s) so the new one fits.
export const AUDIT_RETENTION_ROWS = 2500;

export async function recordAuditEvent(event: {
  type: string;
  actor?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  if (isLanSessionLoginEnabled()) return;
  if (!supabase) return;
  // v1.1.95 — Audit writes MUST NEVER throw. Migration 0036 already
  // relaxes the audit_log INSERT policy to bare auth, but if anything
  // ever fails again (network blip, future policy regression, retention
  // race), an audit failure must not make the user's real action look
  // like it failed. Log to console for forensics and move on.
  //
  // Task #234 — wrap the insert in `withFreshSession` so a stale-JWT
  // 401 on the first audit write after a tab has been idle silently
  // refreshes the token and retries once. If the session is genuinely
  // gone (user signed out) the write is dropped at debug level rather
  // than a red console error — same final behaviour as before, just
  // without the noise.
  const result = await withFreshSession(async () => {
    const { error } = await supabase!.from("audit_log").insert({
      type: event.type,
      actor: event.actor ?? null,
      detail: event.detail ?? {},
      occurred_at: new Date().toISOString(),
    });
    if (error) throw error;
  });
  if (!result.ok) {
    if (result.reason === "auth") {
      console.debug("[audit] insert skipped (no valid session)", { type: event.type });
    } else {
      console.warn("[audit] insert failed (non-fatal)", { type: event.type, error: result.error });
    }
    return;
  }
  // Opportunistic retention eviction — runs fire-and-forget so it NEVER
  // blocks the caller. The cleanup adds 1-2 sequential network roundtrips
  // (count + delete) which used to compound on hot paths like login,
  // making the sign-in button stay disabled for an extra 1-2 seconds while
  // the cap was being trimmed. Also: only check the cap on ~1 in 25
  // writes so we're not paying for a count() roundtrip on every event.
  if (Math.random() < 0.04) {
    void (async () => {
      try {
        const { count } = await supabase!
          .from("audit_log")
          .select("*", { count: "exact", head: true });
        if (typeof count === "number" && count > AUDIT_RETENTION_ROWS) {
          const overflow = count - AUDIT_RETENTION_ROWS;
          const { data: oldest } = await supabase!
            .from("audit_log")
            .select("id")
            .order("occurred_at", { ascending: true })
            .limit(overflow);
          const ids = (oldest ?? []).map((r: { id: number | string }) => r.id);
          if (ids.length > 0) {
            await supabase!.from("audit_log").delete().in("id", ids);
          }
        }
      } catch { /* retention is best-effort */ }
    })();
  }
}
