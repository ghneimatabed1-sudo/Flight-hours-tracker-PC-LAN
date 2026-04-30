// Task #299 — Join → Approve → Bind client-side wrapper.
//
// Talks to the new `unit_*` RPCs in migration 0069 (+ 0070-0076 patch
// stack) and the three Edge Functions: `unit-approve-device`,
// `unit-claim-device`, `unit-super-admin-setup`.
//
// Critical: the joining laptop owns its password from JoinSetup all
// the way through the claim step. The server only ever sees the
// SHA-256 of the password (stored on the device_request) plus the
// random claim_token (also stored on the request and used by the
// claim edge function to verify the laptop's identity at exchange
// time). The plaintext password lives only in this laptop's
// localStorage between submit and claim — never on the server.
//
// The shared anti-spam secret (`VITE_UNIT_JOIN_SECRET`) gates the
// anonymous bootstrap RPCs. The DB-side value lives in
// `public.unit_config` (see migration 0070; rotation procedure
// documented in 0076). Both must agree byte-for-byte.

import { supabase } from "./supabase";
import { isLanSessionLoginEnabled } from "./internal-migration";

const env: Record<string, string | undefined> =
  typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string | undefined> }).env
    ? ((import.meta as { env: Record<string, string | undefined> }).env)
    : {};

const SUPABASE_URL = env.VITE_SUPABASE_URL ?? "";
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY ?? "";
const JOIN_SECRET = env.VITE_UNIT_JOIN_SECRET ?? "";

/** Squadron entry returned by `unit_squadrons_for_join`. */
export interface UnitSquadron {
  id: string;
  name: string;
  number: string | null;
  base: string | null;
}

export type UnitRole = "ops" | "flight" | "squadron" | "wing" | "base" | "hq";

export interface UnitMemberSelf {
  member_id: string;
  device_id: string | null;
  status: "active" | "removed";
  role: "ops" | "commander" | "super_admin";
  tier: UnitRole;
  squadron_allow_list: string[];
  display_name: string;
  username: string;
}

export interface UnitPendingRequest {
  id: string;
  requested_role: UnitRole;
  requested_squadron_names: string[];
  username: string;
  display_name: string;
  fingerprint: string;
  originating_ip: string | null;
  originating_city: string | null;
  submitted_at: string;
  status: "pending";
}

export interface UnitDeviceListRow {
  member_id: string;
  username: string;
  display_name: string;
  role: string;
  tier: string;
  squadron_allow_list: string[];
  device_id: string | null;
  fingerprint_short: string | null;
  status: string;
  approved_at: string | null;
  last_seen_at: string | null;
}

export interface UnitRequestStatus {
  status: "pending" | "approved" | "rejected" | "ignored" | "unknown";
  decision_reason: string | null;
  supabase_email: string | null;
  member_id: string | null;
  device_id: string | null;
  claim_consumed: boolean;
}

export type UnitJoinError =
  | "server_misconfigured"
  | "unauthorized"
  | "invalid_role"
  | "username_too_short"
  | "display_name_required"
  | "password_too_short"
  | "password_hash_invalid"
  | "claim_token_invalid"
  | "claim_token_mismatch"
  | "claim_already_consumed"
  | "password_mismatch"
  | "fingerprint_required"
  | "squadrons_required"
  | "single_squadron_only_for_role"
  | "username_taken"
  | "request_not_found"
  | "request_not_pending"
  | "request_not_bound"
  | "super_admin_required"
  | "super_admin_already_exists"
  | "complete_approval_failed"
  | "network"
  | "unknown";

function classifyPostgrestError(body: unknown): UnitJoinError {
  if (body && typeof body === "object") {
    const e = body as { code?: string; message?: string };
    if (e.code === "42501") return "unauthorized";
    if (e.code === "23505") return "super_admin_already_exists";
    if (e.message) {
      const m = e.message.toLowerCase();
      if (m.includes("invalid_role")) return "invalid_role";
      if (m.includes("username_too_short")) return "username_too_short";
      if (m.includes("display_name_required")) return "display_name_required";
      if (m.includes("password_hash_invalid")) return "password_hash_invalid";
      if (m.includes("claim_token_invalid")) return "claim_token_invalid";
      if (m.includes("fingerprint_required")) return "fingerprint_required";
      if (m.includes("squadrons_required")) return "squadrons_required";
      if (m.includes("single_squadron_only_for_role")) return "single_squadron_only_for_role";
      if (m.includes("super_admin_required")) return "super_admin_required";
      if (m.includes("super_admin_already_exists")) return "super_admin_already_exists";
      if (m.includes("request_not_pending")) return "request_not_pending";
      if (m.includes("request_not_found")) return "request_not_found";
      if (m.includes("request_not_bound")) return "request_not_bound";
    }
  }
  return "unknown";
}

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rpcAnon(name: string, body: Record<string, unknown>, withSecret: boolean): Promise<{
  ok: true; data: unknown;
} | { ok: false; error: UnitJoinError; detail?: unknown }> {
  if (isLanSessionLoginEnabled()) {
    return { ok: false, error: "server_misconfigured", detail: "unit-join cloud RPC disabled in LAN session mode" };
  }
  if (!SUPABASE_URL || !ANON_KEY) return { ok: false, error: "server_misconfigured" };
  const headers = buildHeaders(withSecret ? { "x-unit-join-secret": JOIN_SECRET } : {});
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: "network", detail: String(err) };
  }
  let parsed: unknown;
  try { parsed = await res.json(); } catch { parsed = await res.text().catch(() => null); }
  if (!res.ok) return { ok: false, error: classifyPostgrestError(parsed), detail: parsed };
  return { ok: true, data: parsed };
}

async function rpcAuth(name: string, body: Record<string, unknown>): Promise<{
  ok: true; data: unknown;
} | { ok: false; error: UnitJoinError; detail?: unknown }> {
  if (isLanSessionLoginEnabled()) {
    return { ok: false, error: "server_misconfigured", detail: "unit-join cloud RPC disabled in LAN session mode" };
  }
  if (!supabase) return { ok: false, error: "server_misconfigured" };
  const { data: sessRes } = await supabase.auth.getSession();
  const jwt = sessRes?.session?.access_token;
  if (!jwt) return { ok: false, error: "unauthorized" };
  if (!SUPABASE_URL || !ANON_KEY) return { ok: false, error: "server_misconfigured" };
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: "network", detail: String(err) };
  }
  let parsed: unknown = null;
  if (res.status !== 204) {
    try { parsed = await res.json(); } catch { parsed = await res.text().catch(() => null); }
  }
  if (!res.ok) return { ok: false, error: classifyPostgrestError(parsed), detail: parsed };
  return { ok: true, data: parsed };
}

// SHA-256 hex of an arbitrary string. Used to hash the joining
// laptop's chosen password before submission so the server NEVER
// sees plaintext.
export async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(byteLen = 16): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Anonymous bootstrap RPCs ───────────────────────────────────────────
export async function checkSuperAdminExists(): Promise<boolean> {
  const r = await rpcAnon("unit_super_admin_exists", {}, false);
  return r.ok && r.data === true;
}

export async function checkSuperAdminSetupAllowed(): Promise<boolean> {
  const r = await rpcAnon("unit_super_admin_setup_allowed", {}, false);
  return r.ok && r.data === true;
}

export async function listSquadronsForJoin(): Promise<UnitSquadron[]> {
  const r = await rpcAnon("unit_squadrons_for_join", {}, false);
  return r.ok && Array.isArray(r.data) ? (r.data as UnitSquadron[]) : [];
}

export interface RequestJoinInput {
  role: UnitRole;
  squadronNames: string[];
  username: string;
  displayName: string;
  password: string;
  fingerprint: string;
}

export interface RequestJoinResult {
  requestId: string;
  claimToken: string;
}

export async function requestJoin(input: RequestJoinInput): Promise<
  { ok: true; result: RequestJoinResult } | { ok: false; error: UnitJoinError; detail?: unknown }
> {
  if (input.password.length < 8) return { ok: false, error: "password_too_short" };
  const claimToken = randomToken(16);
  const passwordHash = await sha256Hex(input.password);
  // Coarse "where in the world is this PC" hint so the super admin
  // can sanity-check the join request before approving. We send the
  // browser's IANA timezone (e.g. "Asia/Amman") because we have no
  // GeoIP integration and asking the joining user to type a city is
  // friction nobody asked for.
  let originatingCity: string | null = null;
  try { originatingCity = Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
  catch { originatingCity = null; }
  const r = await rpcAnon("unit_request_join", {
    p_role: input.role,
    p_requested_squadron_names: input.squadronNames,
    p_username: input.username,
    p_display_name: input.displayName,
    p_password_sha256: passwordHash,
    p_claim_token: claimToken,
    p_fingerprint: input.fingerprint,
    p_originating_city: originatingCity,
  }, true);
  if (!r.ok) return r;
  if (typeof r.data !== "string") return { ok: false, error: "unknown", detail: r.data };
  return { ok: true, result: { requestId: r.data, claimToken } };
}

export async function getRequestStatus(requestId: string): Promise<UnitRequestStatus> {
  const r = await rpcAnon("unit_request_status", { p_request_id: requestId }, true);
  const empty: UnitRequestStatus = {
    status: "unknown",
    decision_reason: null,
    supabase_email: null,
    member_id: null,
    device_id: null,
    claim_consumed: false,
  };
  if (!r.ok) return empty;
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!row || typeof row !== "object") return empty;
  return row as UnitRequestStatus;
}

// ── Authenticated (super-admin) RPCs ──────────────────────────────────
export async function listPendingRequests(): Promise<UnitPendingRequest[]> {
  const r = await rpcAuth("unit_pending_requests", {});
  return r.ok && Array.isArray(r.data) ? (r.data as UnitPendingRequest[]) : [];
}

export async function listAllDevices(): Promise<UnitDeviceListRow[]> {
  const r = await rpcAuth("unit_list_devices", {});
  return r.ok && Array.isArray(r.data) ? (r.data as UnitDeviceListRow[]) : [];
}

export async function rejectRequest(requestId: string, reason: string): Promise<boolean> {
  const r = await rpcAuth("unit_reject_request", { p_request_id: requestId, p_reason: reason });
  return r.ok;
}

export async function ignoreRequest(requestId: string): Promise<boolean> {
  const r = await rpcAuth("unit_ignore_request", { p_request_id: requestId });
  return r.ok;
}

export async function updateMemberSquadrons(memberId: string, squadronNames: string[]): Promise<boolean> {
  const r = await rpcAuth("unit_update_squadrons", { p_member_id: memberId, p_squadron_names: squadronNames });
  return r.ok;
}

export interface RemoveMemberResult {
  ok: boolean;
  error?: UnitJoinError;
  detail?: unknown;
}
export async function removeMember(memberId: string, reason: string): Promise<RemoveMemberResult> {
  // Calls the hardened unit_remove_member from migration 0075 — flips
  // status to 'removed', revokes devices, rotates the bcrypt hash,
  // sets banned_until='infinity', and deletes auth.sessions +
  // auth.refresh_tokens for the user. After this call any open access
  // token is dead within ≤1h (its TTL) and password sign-in is blocked
  // immediately.
  const r = await rpcAuth("unit_remove_member", { p_member_id: memberId, p_reason: reason });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
  return { ok: true };
}

export async function fetchMemberSelf(): Promise<UnitMemberSelf | null> {
  const r = await rpcAuth("unit_member_self", {});
  if (!r.ok) return null;
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!row || typeof row !== "object") return null;
  return row as UnitMemberSelf;
}

// ── Approve via Edge Function ──────────────────────────────────────────
export interface ApprovalResult {
  ok: boolean;
  supabaseEmail?: string;
  memberId?: string;
  deviceId?: string;
  error?: UnitJoinError;
  detail?: unknown;
}
export async function approveRequest(requestId: string, squadronNamesOverride: string[] | null): Promise<ApprovalResult> {
  if (!supabase) return { ok: false, error: "server_misconfigured" };
  const reserve = await rpcAuth("unit_reserve_approval", {
    p_request_id: requestId,
    p_squadron_names_override: squadronNamesOverride,
  });
  if (!reserve.ok) return { ok: false, error: reserve.error, detail: reserve.detail };
  const { data: sessRes } = await supabase.auth.getSession();
  const jwt = sessRes?.session?.access_token;
  if (!jwt) return { ok: false, error: "unauthorized" };
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/unit-approve-device`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    });
  } catch (err) {
    return { ok: false, error: "network", detail: String(err) };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  if (!res.ok) {
    const err = (body as { error?: string })?.error as UnitJoinError | undefined;
    return { ok: false, error: err ?? "complete_approval_failed", detail: body };
  }
  const ok = (body as { ok?: boolean })?.ok === true;
  if (!ok) return { ok: false, error: "complete_approval_failed", detail: body };
  return {
    ok: true,
    supabaseEmail: (body as { supabaseEmail?: string }).supabaseEmail,
    memberId: (body as { memberId?: string }).memberId,
    deviceId: (body as { deviceId?: string }).deviceId,
  };
}

// ── Claim Device (joining laptop swaps placeholder password for its own) ──
export interface ClaimResult {
  ok: boolean;
  supabaseEmail?: string;
  error?: UnitJoinError;
  detail?: unknown;
}

export async function claimDevice(requestId: string, claimToken: string, password: string): Promise<ClaimResult> {
  if (isLanSessionLoginEnabled()) return { ok: false, error: "server_misconfigured" };
  if (!SUPABASE_URL || !ANON_KEY) return { ok: false, error: "server_misconfigured" };
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/unit-claim-device`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, claimToken, password }),
    });
  } catch (err) {
    return { ok: false, error: "network", detail: String(err) };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  if (!res.ok) {
    const err = (body as { error?: string })?.error as UnitJoinError | undefined;
    return { ok: false, error: err ?? "unknown", detail: body };
  }
  return { ok: true, supabaseEmail: (body as { supabaseEmail?: string }).supabaseEmail };
}

// ── Super-Admin Setup (one-shot bootstrap) ────────────────────────────
export interface SetupSuperAdminInput {
  email: string;
  password: string;
  displayName: string;
  username: string;
}
export interface SetupSuperAdminResult {
  ok: boolean;
  email?: string;
  error?: UnitJoinError;
  detail?: unknown;
}
export async function setupSuperAdmin(input: SetupSuperAdminInput): Promise<SetupSuperAdminResult> {
  if (isLanSessionLoginEnabled()) return { ok: false, error: "server_misconfigured" };
  if (!SUPABASE_URL || !ANON_KEY) return { ok: false, error: "server_misconfigured" };
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/unit-super-admin-setup`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: "network", detail: String(err) };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
  if (!res.ok) {
    const err = (body as { error?: string })?.error as UnitJoinError | undefined;
    return { ok: false, error: err ?? "unknown", detail: body };
  }
  return { ok: true, email: (body as { email?: string }).email };
}

// ── Local persistence for the joining laptop ──────────────────────────
const KEY_REQUEST_ID = "rjaf.joinPendingRequestId";
const KEY_USERNAME = "rjaf.joinPendingUsername";
const KEY_FINGERPRINT_AT_JOIN = "rjaf.joinPendingFingerprint";
const KEY_CLAIM_TOKEN = "rjaf.joinPendingClaimToken";
const KEY_PASSWORD = "rjaf.joinPendingPassword";

export interface PendingRequest {
  requestId: string;
  username: string;
  fingerprint: string;
  claimToken: string;
  password: string;
  // Identity context the operator typed at JoinSetup time. Persisted
  // so WaitingForApproval can render a confirmation strip ("you filed
  // as Capt. Foo, role=squadron, squadrons=NO.8") — review round 4
  // wanted this visible while polling so the user can confirm they
  // didn't typo themselves into the wrong slot.
  displayName: string;
  role: UnitRole;
  squadronNames: string[];
}

const KEY_DISPLAY_NAME = "rjaf.joinPendingDisplayName";
const KEY_ROLE = "rjaf.joinPendingRole";
const KEY_SQUADRONS = "rjaf.joinPendingSquadrons";

export function persistPendingRequest(p: PendingRequest): void {
  try {
    localStorage.setItem(KEY_REQUEST_ID, p.requestId);
    localStorage.setItem(KEY_USERNAME, p.username);
    localStorage.setItem(KEY_FINGERPRINT_AT_JOIN, p.fingerprint);
    localStorage.setItem(KEY_CLAIM_TOKEN, p.claimToken);
    localStorage.setItem(KEY_PASSWORD, p.password);
    localStorage.setItem(KEY_DISPLAY_NAME, p.displayName);
    localStorage.setItem(KEY_ROLE, p.role);
    localStorage.setItem(KEY_SQUADRONS, JSON.stringify(p.squadronNames));
  } catch { /* localStorage unavailable */ }
}

export function getPendingRequest(): PendingRequest | null {
  try {
    const requestId = localStorage.getItem(KEY_REQUEST_ID);
    const username = localStorage.getItem(KEY_USERNAME);
    const fingerprint = localStorage.getItem(KEY_FINGERPRINT_AT_JOIN);
    const claimToken = localStorage.getItem(KEY_CLAIM_TOKEN);
    const password = localStorage.getItem(KEY_PASSWORD);
    if (!requestId || !username || !fingerprint || !claimToken || !password) return null;
    const displayName = localStorage.getItem(KEY_DISPLAY_NAME) ?? username;
    const role = (localStorage.getItem(KEY_ROLE) as UnitRole | null) ?? "ops";
    let squadronNames: string[] = [];
    try {
      const raw = localStorage.getItem(KEY_SQUADRONS);
      if (raw) squadronNames = JSON.parse(raw) as string[];
    } catch { squadronNames = []; }
    return { requestId, username, fingerprint, claimToken, password, displayName, role, squadronNames };
  } catch { return null; }
}

export function clearPendingRequest(): void {
  try {
    localStorage.removeItem(KEY_REQUEST_ID);
    localStorage.removeItem(KEY_USERNAME);
    localStorage.removeItem(KEY_FINGERPRINT_AT_JOIN);
    localStorage.removeItem(KEY_CLAIM_TOKEN);
    localStorage.removeItem(KEY_PASSWORD);
    localStorage.removeItem(KEY_DISPLAY_NAME);
    localStorage.removeItem(KEY_ROLE);
    localStorage.removeItem(KEY_SQUADRONS);
  } catch { /* localStorage unavailable */ }
}

export const unitJoinConfigured = !isLanSessionLoginEnabled() && Boolean(SUPABASE_URL && ANON_KEY && JOIN_SECRET);
