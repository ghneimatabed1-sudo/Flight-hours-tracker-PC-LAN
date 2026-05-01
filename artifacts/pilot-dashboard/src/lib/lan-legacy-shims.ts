// LAN legacy shims (formerly src/lib/supabase.ts).
//
// In the cloud-era build this file was a thin Supabase client + a small
// pile of remote-RPC helpers (license validation, commander provisioning,
// per-user credential cache, etc). The Hawk Eye / RJAF LAN production
// build has no Supabase and no internet at all, so the bulk of those
// helpers were dead code with `false`/no-op stubs.
//
// What survives, and *why*:
//
//  - `supabaseConfigured` (literal `false`) — call sites still gate
//    Supabase-only UI on this flag. Keeping it as a stable `false`
//    avoids a sweeping UI refactor on every page that just wants to
//    say "the cloud path is unavailable, fall through to LAN".
//
//  - `withFreshSession` / `isAuthError` / `refreshSessionOnce` — LAN
//    builds never refresh a Supabase session, so these are no-op
//    pass-through wrappers that always run the closure once and
//    surface its error verbatim. They exist so legacy retry-on-401
//    code paths compile without a behaviour change.
//
//  - `recordAuditEvent` — historical no-op kept so any remaining
//    legacy caller (Roster, FrozenAccessPanel) compiles. Real audit
//    rows are written via `appendInternalAudit` on the api-server.
//
//  - `AUDIT_RETENTION_ROWS` — display cap for the legacy audit log
//    page; still referenced by `pages/admin/AuditLog.tsx` to size
//    its pagination.
//
// Everything else from the old file (`validateLicenseRemote`,
// `registerLicenseRemote`, `provisionCommanderRemote`,
// `storeSupabaseCreds` / `getSupabaseCreds` / `clearSupabaseCreds`,
// `resyncSupabaseCreds`, plus their `*Args` / `*Result` types) was
// confirmed unused outside this file (round-7 review) and has been
// deleted to scrub the residual cloud surface from the LAN build.

export const supabaseConfigured: false = false;

/**
 * Always returns `false` on LAN builds — there is no Supabase auth
 * error surface to recognise, only HTTP 401/403 from the LAN
 * api-server which the call sites handle directly.
 */
export function isAuthError(_err: unknown): boolean {
  return false;
}

/**
 * No-op refresh — there is no Supabase session to refresh on a
 * closed-LAN install. Returning `false` tells callers "no fresh
 * session was obtained" so they fall through to their normal error
 * path instead of looping.
 */
export async function refreshSessionOnce(): Promise<boolean> {
  return false;
}

export type FreshSessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * LAN-mode pass-through: runs `op` exactly once and returns its
 * result; never tries to recover by refreshing a Supabase session.
 * Kept so the half-dozen legacy retry-on-401 call sites compile
 * unchanged while the migration finishes.
 */
export async function withFreshSession<T>(
  op: () => Promise<T>,
): Promise<FreshSessionResult<T>> {
  try {
    const value = await op();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

// Legacy audit-log display cap. The real audit log on the LAN host
// PC is written via `appendInternalAudit` and read via the
// `/api/internal/audit-log` route; this constant only sizes the
// historical UI page that paginates client-side.
export const AUDIT_RETENTION_ROWS = 2500;

/**
 * No-op audit-event recorder kept for legacy callers. The LAN build
 * writes audit rows through `appendInternalAudit` on the api-server
 * (called from the route handlers themselves), so there is no
 * client-side audit write path. We swallow the call rather than
 * logging it, because the data has already been recorded server-side
 * by the route the caller just hit.
 */
export async function recordAuditEvent(_event: {
  actor?: string;
  type?: string;
  detail?: unknown;
}): Promise<void> {
  // intentional no-op
}
