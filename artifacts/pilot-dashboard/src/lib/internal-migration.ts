import type { LanAuthUser } from "./lan-user-map";

export type { LanAuthUser };

/**
 * Internal LAN migration helpers — optional health check to the monorepo
 * `artifacts/api-server` while Supabase remains the live backend.
 *
 * - Dev: same-origin `fetch` via Vite proxy (see vite.config.ts) when
 *   `VITE_INTERNAL_API_URL` is unset.
 * - Staged / prod: set `VITE_INTERNAL_API_URL` to the internal base
 *   (e.g. `http://hawk-api.lan:3847`) and add that host to CSP
 *   `connect-src` in the built `index.html` (see docs/internal-migration).
 */

/** Must match the dev proxy path in `vite.config.ts`. */
export const INTERNAL_API_PROXY_PREFIX = "__hawk_eye_internal_api";

// Same pattern as Diagnostic.tsx / supabase.ts — must not throw when
// `import.meta.env` is undefined (Node sidebar-smoke without Vite).
const __viteEnv: Record<string, string | boolean | undefined> =
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env
    ? (import.meta as unknown as { env: Record<string, string | boolean | undefined> })
        .env
    : {};

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function getInternalApiPath(path: string): string | null {
  const fromEnv = String(__viteEnv.VITE_INTERNAL_API_URL ?? "").trim();
  if (fromEnv) return `${trimSlash(fromEnv)}/api/${path.replace(/^\/+/, "")}`;
  if (__viteEnv.DEV === true) {
    const base = String(__viteEnv.BASE_URL || "/");
    const p = `${INTERNAL_API_PROXY_PREFIX}/${path.replace(/^\/+/, "")}`;
    if (base === "/" || base === "") return `/${p}`;
    return `${trimSlash(base)}/${p}`;
  }
  return null;
}

const LAN_SESSION_KEY = "rjaf.lanSessionToken";

function getStoredLanSessionToken(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const t = String(localStorage.getItem(LAN_SESSION_KEY) ?? "").trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

export function setStoredLanSessionToken(token: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!token) localStorage.removeItem(LAN_SESSION_KEY);
    else localStorage.setItem(LAN_SESSION_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearLanSessionToken(): void {
  setStoredLanSessionToken(null);
}

/**
 * When set to `1`/`true` **and** an internal API base is resolved (dev proxy
 * or `VITE_INTERNAL_API_URL`), the dashboard uses `POST
 * /api/internal/auth/lan/login` instead of Supabase Auth for `login()`.
 */
export function isLanSessionLoginEnabled(): boolean {
  const v = String(__viteEnv.VITE_LAN_SESSION_LOGIN ?? "")
    .trim()
    .toLowerCase();
  if (v !== "true" && v !== "1") return false;
  return getInternalApiPath("healthz") !== null;
}

/** Explicitly disables login password checks in LAN mode (temporary migration flag). */
export function isLanNoAuthEnabled(): boolean {
  const v = String(__viteEnv.VITE_LAN_NO_AUTH ?? "")
    .trim()
    .toLowerCase();
  return v === "true" || v === "1";
}

/**
 * When the base `api-server` has `HAWK_INTERNAL_SESSION_AUTH=required`, all
 * `/api/internal/*` data calls must include this header. The token is
 * returned by `POST /api/internal/auth/lan/login` and may be stored by the
 * future LAN login UI (or manually for bring-up).
 */
function internalApiHeadersBase(): Record<string, string> {
  const h: Record<string, string> = {};
  const tok = getStoredLanSessionToken();
  if (tok) h["x-hawk-lan-session"] = tok;
  return h;
}

export async function postLanLogin(
  username: string,
  password: string,
): Promise<
  | { ok: true; token: string; user: LanAuthUser }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/auth/lan/login");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (body?.ok !== true) {
      return { ok: false, error: String(body?.error ?? "lan_login_failed") };
    }
    const token = String(body?.token ?? "").trim();
    const u = body?.user as Record<string, unknown> | undefined;
    if (!token || !u) {
      return { ok: false, error: "lan_login_bad_payload" };
    }
    return {
      ok: true,
      token,
      user: {
        id: String(u.id ?? "").trim(),
        username: String(u.username ?? "").trim(),
        displayName: String(u.displayName ?? u.display_name ?? "").trim(),
        role: String(u.role ?? "").trim(),
        squadronId:
          u.squadronId == null || u.squadronId === ""
            ? null
            : String(u.squadronId),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function postLanDevSession(
  username: string,
  opts?: { role?: string; displayName?: string; squadronId?: string | null },
): Promise<
  | { ok: true; token: string; user: LanAuthUser }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/auth/lan/dev-session");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        role: opts?.role,
        displayName: opts?.displayName,
        squadronId: opts?.squadronId,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (body?.ok !== true) {
      return { ok: false, error: String(body?.error ?? "lan_dev_session_failed") };
    }
    const token = String(body?.token ?? "").trim();
    const u = body?.user as Record<string, unknown> | undefined;
    if (!token || !u) return { ok: false, error: "lan_dev_session_bad_payload" };
    return {
      ok: true,
      token,
      user: {
        id: String(u.id ?? "").trim(),
        username: String(u.username ?? "").trim(),
        displayName: String(u.displayName ?? u.display_name ?? "").trim(),
        role: String(u.role ?? "").trim(),
        squadronId:
          u.squadronId == null || u.squadronId === ""
            ? null
            : String(u.squadronId),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function fetchLanSessionUser(): Promise<
  | { ok: true; user: LanAuthUser }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/auth/lan/me");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  const tok = getStoredLanSessionToken();
  if (!tok) return { ok: false, error: "no_token" };
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (body?.ok !== true) {
      return { ok: false, error: String(body?.error ?? "lan_me_failed") };
    }
    const u = body?.user as Record<string, unknown> | undefined;
    if (!u) return { ok: false, error: "lan_me_bad_payload" };
    return {
      ok: true,
      user: {
        id: String(u.id ?? "").trim(),
        username: String(u.username ?? "").trim(),
        displayName: String(u.displayName ?? u.display_name ?? "").trim(),
        role: String(u.role ?? "").trim(),
        squadronId:
          u.squadronId == null || u.squadronId === ""
            ? null
            : String(u.squadronId),
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Best-effort server-side session end + local token clear.
 */
export async function postLanLogout(): Promise<void> {
  const url = getInternalApiPath("internal/auth/lan/logout");
  const tok = getStoredLanSessionToken();
  if (url && tok) {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...internalApiHeadersBase(),
        },
        body: JSON.stringify({ token: tok }),
      });
    } catch {
      /* ignore */
    }
  }
  clearLanSessionToken();
}

/**
 * Resolves the URL for `GET /api/healthz` on the internal API, or `null` if
 * the check is disabled (no dev proxy and no `VITE_INTERNAL_API_URL`).
 */
export function getInternalApiHealthUrl(): string | null {
  const fromEnv = String(__viteEnv.VITE_INTERNAL_API_URL ?? "").trim();
  if (fromEnv) {
    return `${trimSlash(fromEnv)}/api/healthz`;
  }
  if (__viteEnv.DEV === true) {
    const base = String(__viteEnv.BASE_URL || "/");
    const path = `${INTERNAL_API_PROXY_PREFIX}/healthz`;
    if (base === "/" || base === "") return `/${path}`;
    return `${trimSlash(base)}/${path}`;
  }
  return null;
}

export type InternalApiHealthResult =
  | { ok: true; status: string; ms: number }
  | { ok: false; error: string; ms?: number };

/**
 * Fetches the internal API health endpoint. When disabled, returns a
 * structured error (not a throw).
 */
export async function fetchInternalApiHealth(): Promise<InternalApiHealthResult> {
  const url = getInternalApiHealthUrl();
  if (!url) {
    return {
      ok: false,
      error:
        "Not enabled — in dev, start the API on INTERNAL_API_PROXY_TARGET and use the Vite proxy; or set VITE_INTERNAL_API_URL for a direct URL.",
    };
  }
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, ms };
    }
    const data = (await res.json()) as { status?: string };
    if (data?.status !== "ok") {
      return {
        ok: false,
        error: `Unexpected body: ${JSON.stringify(data)}`,
        ms,
      };
    }
    return { ok: true, status: data.status, ms };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - t0),
    };
  }
}

export interface InternalPilotOption {
  id: string;
  scheduleName: string;
}

export async function fetchInternalPilotOptions(): Promise<InternalPilotOption[]> {
  const url = getInternalApiPath("internal/pilot-options");
  if (!url) return [];
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      items?: Array<{ id?: string; schedule_name?: string }>;
    };
    const rows = Array.isArray(body?.items) ? body.items : [];
    return rows
      .map((r) => ({
        id: String(r.id ?? "").trim(),
        scheduleName: String(r.schedule_name ?? "").trim(),
      }))
      .filter((r) => !!r.id && !!r.scheduleName);
  } catch {
    return [];
  }
}

/** Row shape aligned with `squadrons` defaults columns (0039). */
export type InternalSquadronDefaultsRow = {
  base: string | null;
  wing: string | null;
  default_aircraft: unknown;
  default_monthly_targets: unknown;
};

/**
 * Fetches squadron wizard defaults from the internal API when enabled.
 * Returns `null` when disabled, HTTP error, or squadron not found — caller
 * should fall back to Supabase.
 */
export async function fetchInternalSquadronDefaultsRow(
  squadronNumber: string,
): Promise<InternalSquadronDefaultsRow | null> {
  const n = squadronNumber.trim();
  if (!n) return null;
  const url = getInternalApiPath(
    `internal/squadron-airframes?number=${encodeURIComponent(n)}`,
  );
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      found?: boolean;
      base?: string | null;
      wing?: string | null;
      default_aircraft?: unknown;
      default_monthly_targets?: unknown;
    };
    if (!body || body.found !== true) return null;
    return {
      base: body.base ?? null,
      wing: body.wing ?? null,
      default_aircraft: body.default_aircraft,
      default_monthly_targets: body.default_monthly_targets,
    };
  } catch {
    return null;
  }
}

/** One row from `GET /api/internal/squadrons` (Super Admin registry). */
export type InternalSquadronListRow = {
  id: string;
  number: string;
  name: string;
  base: string;
  wing: string | null;
};

/**
 * Fetches the full squadron list from the internal API when enabled.
 * Returns `null` when the URL is not configured, the request fails, or the
 * body is invalid — caller should fall back to Supabase `squadrons` select.
 * On success the array may be empty (valid org with zero squadrons). Callers
 * that need hybrid Supabase fallback should treat `[]` as “no usable internal
 * snapshot yet” unless they intentionally own an empty registry.
 */
export async function fetchInternalSquadronsList(): Promise<
  InternalSquadronListRow[] | null
> {
  const url = getInternalApiPath("internal/squadrons");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      items?: Array<{
        id?: string;
        number?: string;
        name?: string;
        base?: string;
        wing?: string | null;
      }>;
    };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.map((r) => ({
      id: String(r.id ?? "").trim(),
      number: String(r.number ?? "").trim(),
      name: String(r.name ?? "").trim(),
      base: String(r.base ?? "").trim(),
      wing: r.wing == null || r.wing === "" ? null : String(r.wing).trim(),
    }));
  } catch {
    return null;
  }
}

/**
 * Full `pilots` table rows (same shape as Supabase `select *`), for roster
 * hydration on the internal LAN. Returns `null` if internal API is off or the
 * response is unusable.
 */
export async function fetchInternalPilotTableRows(): Promise<
  Record<string, unknown>[] | null
> {
  const url = getInternalApiPath("internal/pilots");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

// ── Internal writes (LAN database) — gated by `VITE_INTERNAL_WRITES` ───

/**
 * When `true`, pilot and sortie **saves** go to the internal `api-server`
 * Postgres instead of Supabase (still requires a normal sign-in session for
 * squadron id). Off by default so hybrid installs never surprise the ops PC.
 */
export function internalWritesEnabled(): boolean {
  const v = String(__viteEnv.VITE_INTERNAL_WRITES ?? "")
    .trim()
    .toLowerCase();
  if (v !== "true" && v !== "1") return false;
  return getInternalApiPath("healthz") !== null;
}

function internalWriteHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...internalApiHeadersBase(),
  };
  const secret = String(__viteEnv.VITE_INTERNAL_WRITE_SECRET ?? "").trim();
  if (secret) headers["x-hawk-internal-write"] = secret;
  return headers;
}

export async function internalPilotUpsertFetch(
  body: Record<string, unknown>,
): Promise<Response> {
  const url = getInternalApiPath("internal/pilots/upsert");
  if (!url) throw new Error("internal_api_disabled");
  return fetch(url, {
    method: "POST",
    headers: internalWriteHeaders(),
    body: JSON.stringify(body),
  });
}

export async function internalPilotDeleteFetch(id: string): Promise<Response> {
  const url = getInternalApiPath(`internal/pilots/${encodeURIComponent(id)}`);
  if (!url) throw new Error("internal_api_disabled");
  return fetch(url, { method: "DELETE", headers: internalWriteHeaders() });
}

export async function internalSortieInsertFetch(
  body: Record<string, unknown>,
): Promise<Response> {
  const url = getInternalApiPath("internal/sorties");
  if (!url) throw new Error("internal_api_disabled");
  return fetch(url, {
    method: "POST",
    headers: internalWriteHeaders(),
    body: JSON.stringify(body),
  });
}

export async function internalSortieUpdateFetch(
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = getInternalApiPath(`internal/sorties/${encodeURIComponent(id)}`);
  if (!url) throw new Error("internal_api_disabled");
  return fetch(url, {
    method: "PATCH",
    headers: internalWriteHeaders(),
    body: JSON.stringify(body),
  });
}

export async function internalSortieDeleteFetch(id: string): Promise<Response> {
  const url = getInternalApiPath(`internal/sorties/${encodeURIComponent(id)}`);
  if (!url) throw new Error("internal_api_disabled");
  return fetch(url, { method: "DELETE", headers: internalWriteHeaders() });
}

/**
 * Sortie rows for the log when `VITE_INTERNAL_WRITES` is on — same shape as
 * Supabase `select * from sorties … limit 500`.
 */
export async function fetchInternalSortieTableRows(
  limit = 500,
): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath(`internal/sorties?limit=${encodeURIComponent(String(limit))}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalAuditLogRows(
  limit = 2500,
): Promise<
  Array<{
    occurred_at?: string | null;
    actor?: string | null;
    type?: string | null;
    detail?: unknown;
  }> | null
> {
  const url = getInternalApiPath(`internal/audit-log?limit=${encodeURIComponent(String(limit))}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter(
      (x): x is { occurred_at?: string | null; actor?: string | null; type?: string | null; detail?: unknown } =>
        !!x && typeof x === "object",
    );
  } catch {
    return null;
  }
}

export type InternalReminderRun = {
  runid: number;
  start_time: string;
  end_time: string | null;
  status: string;
  return_message: string | null;
};

export type InternalReminderHttpResult = {
  id: number;
  status_code: number | null;
  error_msg: string | null;
  created: string;
  content_preview: string | null;
};

export type InternalReminderScheduleStatus = {
  enabled: boolean;
  extensionMissing?: boolean;
  jobid?: number;
  schedule?: string;
  runs: InternalReminderRun[];
  httpResults?: InternalReminderHttpResult[];
};

export async function fetchInternalReminderStatus(): Promise<InternalReminderScheduleStatus | null> {
  const url = getInternalApiPath("internal/reminders/status");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; status?: unknown };
    if (body?.ok !== true || !body.status || typeof body.status !== "object") return null;
    return body.status as InternalReminderScheduleStatus;
  } catch {
    return null;
  }
}

export async function postInternalReminderAction(
  action: "enable" | "disable" | "run-now",
  cron?: string,
): Promise<
  | { ok: true; result?: { sent?: number; failed?: number; candidates?: number } }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/reminders/action");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify({
        action,
        ...(action === "enable" ? { cron } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (body?.ok !== true) {
      return { ok: false, error: String(body?.error ?? "reminder_action_failed") };
    }
    const r = (body?.result ?? {}) as {
      sent?: number;
      failed?: number;
      candidates?: number;
    };
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type InternalReminderLogRow = {
  sent_at: string;
  pilot_id: string;
  pilot_name: string;
  pilot_name_ar: string | null;
  currency_key: string;
  expiry_date: string;
  threshold_days: number;
};

export async function fetchInternalReminderLogRows(): Promise<InternalReminderLogRow[] | null> {
  const url = getInternalApiPath("internal/reminders/log");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; log?: unknown };
    if (body?.ok !== true || !Array.isArray(body.log)) return null;
    return body.log
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((r) => ({
        sent_at: String(r.sent_at ?? ""),
        pilot_id: String(r.pilot_id ?? ""),
        pilot_name: String(r.pilot_name ?? ""),
        pilot_name_ar:
          r.pilot_name_ar == null || r.pilot_name_ar === ""
            ? null
            : String(r.pilot_name_ar),
        currency_key: String(r.currency_key ?? ""),
        expiry_date: String(r.expiry_date ?? ""),
        threshold_days: Number(r.threshold_days ?? 0),
      }));
  } catch {
    return null;
  }
}

export type InternalXpcRegistryRow = {
  id: string;
  squadron_name?: string | null;
  tier?: string | null;
  base?: string | null;
  wing?: string | null;
  device_name?: string | null;
  last_seen?: string | null;
  parent_pc_id?: string | null;
  squadron_pc_id?: string | null;
};

export async function fetchInternalXpcRegistryRows(
  opts?: { includeStale?: boolean; staleHours?: number; activeSeconds?: number },
): Promise<InternalXpcRegistryRow[] | null> {
  const params = new URLSearchParams();
  if (opts?.includeStale) params.set("include_stale", "1");
  if (opts?.staleHours != null) params.set("stale_hours", String(opts.staleHours));
  if (opts?.activeSeconds != null) params.set("active_seconds", String(opts.activeSeconds));
  const qs = params.toString();
  const url = getInternalApiPath(`internal/xpc/registry${qs ? `?${qs}` : ""}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((r) => ({
        id: String(r.id ?? ""),
        squadron_name:
          r.squadron_name == null || r.squadron_name === ""
            ? null
            : String(r.squadron_name),
        tier: r.tier == null || r.tier === "" ? null : String(r.tier),
        base: r.base == null || r.base === "" ? null : String(r.base),
        wing: r.wing == null || r.wing === "" ? null : String(r.wing),
        device_name:
          r.device_name == null || r.device_name === "" ? null : String(r.device_name),
        last_seen: r.last_seen == null || r.last_seen === "" ? null : String(r.last_seen),
        parent_pc_id:
          r.parent_pc_id == null || r.parent_pc_id === ""
            ? null
            : String(r.parent_pc_id),
        squadron_pc_id:
          r.squadron_pc_id == null || r.squadron_pc_id === ""
            ? null
            : String(r.squadron_pc_id),
      }));
  } catch {
    return null;
  }
}

export async function postInternalXpcRegistryHeartbeat(body: {
  id: string;
  squadron_name: string;
  tier: string;
  base?: string | null;
  wing?: string | null;
  device_name?: string | null;
  last_seen?: string | null;
  parent_pc_id?: string | null;
  squadron_pc_id?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/xpc/registry/heartbeat");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_heartbeat_failed") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteInternalXpcRegistryRows(
  opts: { includeSelf?: boolean; keepPcId?: string | null } = {},
): Promise<{ ok: true; removedRegistry: number; removedClaims: number } | { ok: false; error: string; status?: number }> {
  const params = new URLSearchParams();
  if (opts.includeSelf) params.set("include_self", "1");
  if (!opts.includeSelf && opts.keepPcId) params.set("keep_pc_id", String(opts.keepPcId));
  const qs = params.toString();
  const url = getInternalApiPath(`internal/xpc/registry${qs ? `?${qs}` : ""}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalApiHeadersBase(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_registry_delete_failed") };
    }
    return {
      ok: true,
      removedRegistry: Number(parsed?.removed_registry ?? 0),
      removedClaims: Number(parsed?.removed_claims ?? 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalXpcMessages(
  forPcId: string,
  retentionDays: number,
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams({
    for_pc_id: forPcId,
    retention_days: String(retentionDays),
  });
  const url = getInternalApiPath(`internal/xpc/messages?${params.toString()}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalXpcMessage(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/xpc/messages");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_message_send_failed") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalXpcMessageRead(
  id: string,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath("internal/xpc/messages/read");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { item?: unknown };
    if (!parsed || !parsed.item || typeof parsed.item !== "object") return null;
    return parsed.item as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchInternalXpcPending(
  opts?: { homeSquadronId?: string; statuses?: string[]; limit?: number },
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams();
  if (opts?.homeSquadronId) params.set("home_squadron_id", opts.homeSquadronId);
  if (opts?.statuses && opts.statuses.length > 0) params.set("status", opts.statuses.join(","));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const url = getInternalApiPath(`internal/xpc/pending${params.toString() ? `?${params.toString()}` : ""}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalXpcPending(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/xpc/pending");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_pending_submit_failed") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalXpcPendingUpdate(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath("internal/xpc/pending/update");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { item?: unknown };
    if (!body || !body.item || typeof body.item !== "object") return null;
    return body.item as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchInternalXpcScheduleShares(
  opts?: { status?: string; limit?: number },
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const url = getInternalApiPath(`internal/xpc/schedule-shares${qs ? `?${qs}` : ""}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalXpcScheduleShareById(
  id: string,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath(`internal/xpc/schedule-shares/${encodeURIComponent(id)}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { item?: unknown };
    if (!body || !body.item || typeof body.item !== "object") return null;
    return body.item as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function postInternalXpcScheduleShare(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/xpc/schedule-shares");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_schedule_submit_failed") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function patchInternalXpcScheduleShare(
  id: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath(`internal/xpc/schedule-shares/${encodeURIComponent(id)}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { item?: unknown };
    if (!body || !body.item || typeof body.item !== "object") return null;
    return body.item as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function deleteInternalXpcScheduleShare(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/xpc/schedule-shares/${encodeURIComponent(id)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalApiHeadersBase(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_schedule_delete_failed") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalXpcSnapshots(
  opts?: { squadronId?: string },
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams();
  if (opts?.squadronId) params.set("squadron_id", opts.squadronId);
  const qs = params.toString();
  const url = getInternalApiPath(`internal/xpc/snapshots${qs ? `?${qs}` : ""}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalXpcSnapshot(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/xpc/snapshots");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...internalApiHeadersBase(),
      },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    if (parsed?.ok !== true) {
      return { ok: false, error: String(parsed?.error ?? "xpc_snapshot_publish_failed") };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalXpcPairs(
  opts?: { mine?: string; since?: string; limit?: number },
): Promise<Record<string, unknown>[] | null> {
  const params = new URLSearchParams();
  if (opts?.mine) params.set("mine", opts.mine);
  if (opts?.since) params.set("since", opts.since);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const url = getInternalApiPath(`internal/xpc/pairs${qs ? `?${qs}` : ""}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalXpcPairAudit(
  limit: number,
): Promise<{ items: Record<string, unknown>[]; rlsDenied: boolean } | null> {
  const url = getInternalApiPath(`internal/xpc/pairs/audit?limit=${encodeURIComponent(String(limit))}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown; rlsDenied?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return {
      items: body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object"),
      rlsDenied: Boolean(body.rlsDenied ?? false),
    };
  } catch {
    return null;
  }
}

export async function postInternalXpcPairIssueCode(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath("internal/xpc/pairs/code/issue");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalApiHeadersBase() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { item?: unknown };
    if (!body || !body.item || typeof body.item !== "object") return null;
    return body.item as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchInternalXpcPairCode(
  code: string,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath(`internal/xpc/pairs/code/${encodeURIComponent(code)}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { item?: unknown };
    if (!body || body.item == null || typeof body.item !== "object") return null;
    return body.item as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function postInternalXpcPairRedeem(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = getInternalApiPath("internal/xpc/pairs/code/redeem");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalApiHeadersBase() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => ({}))) as { error?: unknown };
      const err = String(parsed.error ?? `http_${res.status}`);
      throw new Error(err);
    }
    const body = (await res.json()) as Record<string, unknown>;
    return body;
  } catch (e) {
    throw (e instanceof Error ? e : new Error(String(e)));
  }
}

async function postInternalXpcPairsSimple(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(path);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalApiHeadersBase() },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalXpcPairAdminCreate(payload: Record<string, unknown>) {
  return postInternalXpcPairsSimple("internal/xpc/pairs/admin/create", payload);
}
export async function postInternalXpcPairRevoke(payload: Record<string, unknown>) {
  return postInternalXpcPairsSimple("internal/xpc/pairs/revoke", payload);
}
export async function postInternalXpcPairAdminSetPermanent(payload: Record<string, unknown>) {
  return postInternalXpcPairsSimple("internal/xpc/pairs/admin/set-permanent", payload);
}
export async function postInternalXpcPairAdminResetPc(payload: Record<string, unknown>) {
  const url = getInternalApiPath("internal/xpc/pairs/admin/reset-pc");
  if (!url) return { ok: false as const, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalApiHeadersBase() },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false as const,
        error: String(parsed?.error ?? `http_${res.status}`),
        status: res.status,
      };
    }
    return {
      ok: true as const,
      revokedPairCount: Number(parsed?.revokedPairCount ?? 0),
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
export async function postInternalXpcPairAdminBulk() {
  const url = getInternalApiPath("internal/xpc/pairs/admin/bulk-in-squadron");
  if (!url) return { ok: false as const, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalApiHeadersBase() },
      body: JSON.stringify({}),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false as const, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true as const, created: Number(parsed?.created ?? 0) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}
export async function postInternalXpcPairAdminSweep(payload: Record<string, unknown>) {
  const url = getInternalApiPath("internal/xpc/pairs/admin/sweep");
  if (!url) return { ok: false as const, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalApiHeadersBase() },
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false as const, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return {
      ok: true as const,
      revoked: Number(parsed?.revoked_count ?? 0),
      expired: Number(parsed?.expired_count ?? 0),
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalUnavailableRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/unavailable");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalUnavailableUpsertDay(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/unavailable/upsert-day");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteInternalUnavailableDay(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/unavailable/day");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalUnavailableInsert(
  payload: Record<string, unknown>,
): Promise<{ ok: true; row?: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/unavailable");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    const row = parsed?.row;
    return {
      ok: true,
      row: row && typeof row === "object" ? (row as Record<string, unknown>) : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteInternalUnavailableById(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/unavailable/${encodeURIComponent(id)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalWriteHeaders(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalDutyWeekRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/duty-week");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalLeavesRows(
  year: number,
): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath(`internal/leaves?year=${encodeURIComponent(String(year))}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalAlertsRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/alerts");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalAlertInsert(
  payload: Record<string, unknown>,
): Promise<{ ok: true; row?: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/alerts");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    const row = parsed?.row;
    return { ok: true, row: row && typeof row === "object" ? (row as Record<string, unknown>) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function patchInternalAlert(
  id: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/alerts/${encodeURIComponent(id)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteInternalAlert(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/alerts/${encodeURIComponent(id)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalWriteHeaders(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalNotamsRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/notams");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalNotamInsert(
  payload: Record<string, unknown>,
): Promise<{ ok: true; row?: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/notams");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    const row = parsed?.row;
    return { ok: true, row: row && typeof row === "object" ? (row as Record<string, unknown>) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function patchInternalNotam(
  id: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/notams/${encodeURIComponent(id)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteInternalNotam(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/notams/${encodeURIComponent(id)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalWriteHeaders(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalScheduleRows(
  dateIso: string,
): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath(`internal/schedule?date=${encodeURIComponent(dateIso)}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalSavedDutyWeeksRows(
  squadron: string,
): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath(`internal/saved-duty-weeks?squadron=${encodeURIComponent(squadron)}`);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalSavedDutyWeekUpsert(
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/saved-duty-weeks");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteInternalOldSavedDutyWeeks(
  squadron: string,
  cutoffIso: string,
): Promise<{ ok: true; removed: number } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(
    `internal/saved-duty-weeks/old?squadron=${encodeURIComponent(squadron)}&cutoff=${encodeURIComponent(cutoffIso)}`,
  );
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: internalWriteHeaders(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true, removed: Number(parsed?.removed ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalActivePilotDevicesRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/pilot-links/active-devices");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function fetchInternalPilotLinkStatus(
  pilotId: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath(`internal/pilot-links/status?pilotId=${encodeURIComponent(pilotId)}`);
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true, body: parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalIssuePilotLinkCode(
  pilotId: string,
): Promise<{ ok: true; code: string; expiresAt: string } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/pilot-links/issue");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify({ pilot_id: pilotId }),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    const code = String(parsed?.code ?? "").trim();
    const expiresAt = String(parsed?.expiresAt ?? "").trim();
    if (!code || !expiresAt) return { ok: false, error: "pilot_link_issue_bad_payload" };
    return { ok: true, code, expiresAt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalRevokePilotDevices(
  pilotId: string,
): Promise<{ ok: true; revoked: number } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/pilot-links/revoke");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify({ pilot_id: pilotId }),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return { ok: true, revoked: Number(parsed?.revoked ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalSquadronUsersRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/users");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalSquadronUserCreate(
  payload: Record<string, unknown>,
): Promise<{ ok: true; row?: Record<string, unknown> } | { ok: false; error: string; status?: number }> {
  const url = getInternalApiPath("internal/users");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    const row = parsed?.row;
    return { ok: true, row: row && typeof row === "object" ? (row as Record<string, unknown>) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchInternalReminderOverviewRows(): Promise<Record<string, unknown>[] | null> {
  const url = getInternalApiPath("internal/reminders/overview");
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: internalApiHeadersBase(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  } catch {
    return null;
  }
}

export async function postInternalImportHistory(
  payload: Record<string, unknown>,
): Promise<
  | { ok: true; stamp: string; pilotsInserted: number; sortiesInserted: number }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/import/history");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify(payload),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return {
      ok: true,
      stamp: String(parsed?.stamp ?? ""),
      pilotsInserted: Number(parsed?.pilotsInserted ?? 0),
      sortiesInserted: Number(parsed?.sortiesInserted ?? 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalUndoImport(
  stamp: string,
): Promise<
  | { ok: true; pilotsRemoved: number; sortiesRemoved: number }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/import/undo");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify({ stamp }),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return {
      ok: true,
      pilotsRemoved: Number(parsed?.pilotsRemoved ?? 0),
      sortiesRemoved: Number(parsed?.sortiesRemoved ?? 0),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postInternalPilotTransfer(
  pilotId: string,
  toSquadronId: string,
): Promise<
  | { ok: true; pilotId: string; fromSquadron: string | null; toSquadron: string }
  | { ok: false; error: string; status?: number }
> {
  const url = getInternalApiPath("internal/pilots/transfer");
  if (!url) return { ok: false, error: "internal_api_disabled" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: internalWriteHeaders(),
      body: JSON.stringify({
        pilot_id: pilotId,
        to_squadron_id: toSquadronId,
      }),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(parsed?.error ?? `http_${res.status}`), status: res.status };
    }
    return {
      ok: true,
      pilotId: String(parsed?.pilotId ?? pilotId),
      fromSquadron:
        parsed?.fromSquadron == null || parsed.fromSquadron === ""
          ? null
          : String(parsed.fromSquadron),
      toSquadron: String(parsed?.toSquadron ?? toSquadronId),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
