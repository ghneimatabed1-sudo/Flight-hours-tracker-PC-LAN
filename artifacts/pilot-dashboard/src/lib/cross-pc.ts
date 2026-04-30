// Cross-PC workflow layer.
//
// This module backs the four ecosystem features that span more than one
// squadron PC: the squadron-PC registry, cross-squadron pending sortie
// approvals, the flight-schedule sharing chain (Squadron ↔ Wing ↔ Base),
// and Sqn/Wing/Base private messages.
//
// When VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are configured we talk
// to four shared tables on the central Supabase project (xpc_registry,
// xpc_pending, xpc_schedule_shares, xpc_messages). Unlike the per-squadron
// operational tables these are intentionally cross-tenant — every PC in
// the ecosystem can see every other PC, and a wing/base PC must read rows
// originated by squadrons it oversees. RLS on those tables is permissive
// (any authenticated user); per-PC filtering happens in the queryFn below.
//
// When Supabase is NOT configured (demo mode / standalone Electron preview
// before the central server is online) we fall back to a single
// localStorage namespace per channel ("rjaf.xpc.*"). The fallback keeps
// the in-browser preview working and lets a single PC see its own slice;
// other PCs render as "registered but offline" until the link comes back.

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Sortie } from "./mock";
import { supabase, supabaseConfigured, recordAuditEvent, withFreshSession } from "./supabase";
import { recordDataError } from "./query-client";
import {
  deleteInternalXpcRegistryRows,
  deleteInternalXpcScheduleShare,
  fetchInternalXpcMessages,
  fetchInternalXpcPending,
  fetchInternalXpcRegistryRows,
  fetchInternalXpcSnapshots,
  fetchInternalXpcScheduleShareById,
  fetchInternalXpcScheduleShares,
  isLanSessionLoginEnabled,
  patchInternalXpcScheduleShare,
  postInternalXpcMessage,
  postInternalXpcMessageRead,
  postInternalXpcPending,
  postInternalXpcPendingUpdate,
  postInternalXpcSnapshot,
  postInternalXpcScheduleShare,
  postInternalXpcRegistryHeartbeat,
} from "./internal-migration";

const isLive = () => supabaseConfigured && supabase !== null;

// ---------------------------------------------------------------------
// Heartbeat status — surfaces silent xpc_registry/xpc_user_pcs upsert
// failures to the operator. Before this existed, a Flight or Squadron
// PC could show the green "Live" indicator (auth session OK, reads
// working) while every 30s heartbeat write was being rejected by RLS,
// so the PC never appeared in any other operator's picker. Now any
// failed heartbeat tick flips the existing red data-error indicator
// AND emits a toast (deduped by message so a stable failure does not
// spam every 30s).
// ---------------------------------------------------------------------
let lastHeartbeatErrorMsg: string | null = null;
let lastHeartbeatErrorAt: number | null = null;
let lastHeartbeatOkAt: number | null = null;
// Loud-banner state. Task #134: a stable RLS / 401 / 403 rejection
// used to toast once and then go silent — the operator's PC would
// silently drop out of every other PC's picker with no on-screen
// signal. We now flip a `bannerVisible` flag immediately on any RLS
// / 401 / 403 rejection (codes 42501 / 401 / 403 / PGRST301), or
// after THREE consecutive non-OK heartbeats of any kind (covers
// transient network errors that would otherwise spam every 30s
// without telling the operator the PC is invisible upstream). The
// banner is dismissible only by a successful heartbeat — clicking
// "Diagnose" navigates to /diagnostic, but the banner stays until
// the next successful upsert clears it.
let consecutiveHbFailures = 0;
let bannerVisible = false;
function isLoudFailureCode(code: string | undefined | null, msg: string | undefined | null): boolean {
  if (!code && !msg) return false;
  const c = String(code ?? "").toLowerCase();
  if (c === "42501" || c === "401" || c === "403" || c === "pgrst301") return true;
  const m = String(msg ?? "");
  if (/row[- ]level security|rls|401|403|forbidden|unauthor/i.test(m)) return true;
  return false;
}

// Module-scope flag set by `setResetInProgress` (called from auth.tsx
// `resetThisPC` right before the cloud DELETEs). Suppresses any
// concurrent / subsequent heartbeat tick from re-upserting the
// xpc_registry / xpc_user_pcs rows we are about to delete. Without
// this flag, the 30-second heartbeat interval can fire between
// DELETE and window.location.reload() and silently re-create the
// exact rows the user just asked us to wipe.
let resetInProgress = false;
export function setResetInProgress(v: boolean) { resetInProgress = v; }
export function isResetInProgress(): boolean { return resetInProgress; }
const heartbeatListeners = new Set<() => void>();

function notifyHeartbeat() { for (const fn of heartbeatListeners) fn(); }

function reportHeartbeatError(msg: string, code?: string | null) {
  lastHeartbeatErrorAt = Date.now();
  consecutiveHbFailures += 1;
  // Always log to the console so a developer pulling logs from a remote
  // PC can see every tick's failure, not just the first one.
  console.warn("[xpc heartbeat]", msg);
  // Only flip the global red pill / fire a toast when the message
  // CHANGES — otherwise a stable failure (e.g. "RLS denied") would
  // produce a destructive toast every 30s and make the UI unusable.
  if (msg !== lastHeartbeatErrorMsg) {
    lastHeartbeatErrorMsg = msg;
    recordDataError(`Cross-PC heartbeat failed: ${msg}`);
  }
  // Loud-banner trigger: any RLS/401/403 fires immediately, otherwise
  // require 3 consecutive failures so a single network blip does not
  // alarm the operator.
  if (isLoudFailureCode(code, msg) || consecutiveHbFailures >= 3) {
    bannerVisible = true;
  }
  notifyHeartbeat();
}

function clearHeartbeatError() {
  lastHeartbeatOkAt = Date.now();
  consecutiveHbFailures = 0;
  const wasBanner = bannerVisible;
  bannerVisible = false;
  if (lastHeartbeatErrorMsg !== null || wasBanner) {
    lastHeartbeatErrorMsg = null;
    lastHeartbeatErrorAt = null;
    notifyHeartbeat();
  }
}

export function getHeartbeatStatus(): {
  errorMsg: string | null;
  errorAt: number | null;
  okAt: number | null;
  bannerVisible: boolean;
  consecutiveFailures: number;
} {
  return {
    errorMsg: lastHeartbeatErrorMsg,
    errorAt: lastHeartbeatErrorAt,
    okAt: lastHeartbeatOkAt,
    bannerVisible,
    consecutiveFailures: consecutiveHbFailures,
  };
}

// "Heartbeat fresh" = a successful upsert within the last 90 s.
// Used by the topbar Online badge to flip to amber when the network
// is up but our PC has dropped off the registry. Falls back to false
// if we have never had a successful heartbeat in this session.
export function isHeartbeatFresh(): boolean {
  if (!lastHeartbeatOkAt) return false;
  return Date.now() - lastHeartbeatOkAt <= ACTIVE_WINDOW_MS;
}

export function subscribeHeartbeatStatus(fn: () => void): () => void {
  heartbeatListeners.add(fn);
  return () => heartbeatListeners.delete(fn);
}

// PostgREST returns PGRST205 when a table referenced in code does not yet
// exist in the central Supabase schema (i.e. migrations 0011/0012/0013
// have not been applied). When that happens the cross-PC layer should
// degrade gracefully — fall back to the local mirror and stay quiet —
// instead of spamming a "Couldn't reach the server" toast every poll
// interval. Detect both the structured Supabase error and a plain Error
// whose .message embeds the PostgREST JSON.
function isMissingTableError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === "PGRST205" || code === "42P01") return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /PGRST205|Could not find the table|does not exist/i.test(msg);
}

// Wrap a Supabase query so PGRST205 (missing table) is swallowed and a
// caller-supplied local fallback runs instead. Other errors still throw.
//
// Task #234 — also routes the call through `withFreshSession` so a
// stale-JWT 401 on first paint (the cached access token expired but
// supabase-js has not yet auto-refreshed) triggers exactly ONE silent
// `auth.refreshSession()` + retry. If the retry still 401s — or there
// is no session at all to refresh — we fall back to the local mirror
// silently (debug log) instead of letting a noisy red 401 bubble up
// through React Query's onError handler. Without this guard, every
// admin page that issues a background read on mount (Overview,
// Squadrons, Commanders, License Keys, Messages, Schedule chain, …)
// would emit a "Couldn't reach the server" toast in the narrow window
// between an expired cached token and the next auto-refresh tick.
async function liveOrLocal<T>(remote: () => Promise<T>, local: () => T | Promise<T>): Promise<T> {
  const result = await withFreshSession(remote);
  if (result.ok) return result.value;
  if (result.reason === "auth") {
    // Stale token + refresh failed (or no session to refresh). The
    // network 401 is unavoidable but we keep the JS console clean —
    // the caller's local mirror keeps the UI responsive while
    // supabase-js sorts itself out on the next auth-state event.
    console.debug("[xpc] silenced stale-JWT 401 — using local fallback");
    return await local();
  }
  if (isMissingTableError(result.error)) return await local();
  throw result.error;
}

// ── shared helpers ──────────────────────────────────────────────────────
function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
function writeJSON<T>(key: string, v: T) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota / private mode */ }
}
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso(): string { return new Date().toISOString(); }

// ── 1. Squadron PC registry ─────────────────────────────────────────────
//
// Every squadron PC that has ever signed in is registered. A PC may be
// offline at any moment — registration is by ecosystem, not live link, so
// other PCs still see the entry in pickers and the registry catches up
// silently when the offline PC reconnects.
const REGISTRY_KEY = "rjaf.xpc.registry";
// Heartbeat written by the local PC on every signed-in render. PCs whose
// heartbeat is older than this window are considered INACTIVE — every
// picker, dropdown, forward target and message recipient list across
// the app must hide PCs whose last_seen is older than this. Threshold
// kept deliberately tight (90 s) so an operator on PC A never sees a
// "ghost" entry for PC B that was actually shut down two minutes ago,
// which used to confuse forwarding and message addressing in real
// production drills. The single source of truth for "is this PC live
// right now" — do NOT introduce a different threshold per page; route
// everything through getActivePCs / isPcActive below.
const ONLINE_WINDOW_MS = 90_000;
// Re-exported under a clearer name for new call sites. Same value —
// "online" and "active" mean the same thing in this codebase: heartbeat
// within the last 90 seconds. Existing call sites that read the
// `online` boolean on RegisteredPC continue to work; new call sites
// should prefer isPcActive() / getActivePCs().
export const ACTIVE_WINDOW_MS = ONLINE_WINDOW_MS;
// Long-stale prune window — a registry row whose last_seen is older than
// this is considered abandoned. Tightened in v1.1.73 from 90 days to
// 24 hours: with the active window now at 90 s, any row older than a
// day is unambiguously stale (PC reimaged, decommissioned, USB lost,
// operator off-shift) and would otherwise inflate every registry
// query in 100+ deployments. Operators can re-register a PC at any
// time — the prune is opportunistic and never blocks signup. Pruned
// rows are deleted from the central xpc_registry + xpc_user_pcs
// tables; an operator signing in on the same PC after a long absence
// re-registers it automatically on the next heartbeat.
const STALE_REGISTRY_MS = 24 * 60 * 60_000;
// Schedule-shares + revoked-devices prune window — 6 months. The flight
// already happened months ago and the local sortie log retains its own
// permanent record, so the share itself doesn't need to live in the
// central xpc_schedule_shares table forever. Same for pilot_devices
// rows whose `revoked_at` is older than this — the unlink already
// happened, the row is just dead weight after half a year.
const STALE_SHARE_MS = 180 * 24 * 60 * 60_000;

// Tier of the PC in the Squadron → Wing → Base → HQ chain. The tier is
// what the schedule-sharing chain enforces when picking forward targets:
// a squadron PC can only forward up to a `wing` PC, a wing PC can only
// forward up to a `base` PC, and a base PC terminates the chain.
export type PcTier = "flight" | "squadron" | "wing" | "base" | "hq";

// ── Flight Commander binding ────────────────────────────────────────────
//
// A Flight Commander PC reports up to ONE specific Squadron Commander PC
// chosen at first-run setup. Once bound, every cross-PC surface on the
// flight PC (schedule sharing recipient picker, messages composer) is
// reshaped to address only that single squadron commander. The binding
// is stored only in localStorage on the flight PC itself — the squadron
// commander doesn't need to know the relationship in advance, the
// inbound schedule share carries the originator id and routes the
// approval back automatically.
const FLIGHT_BIND_ID_KEY   = "rjaf.pc.flight.boundPcId";
const FLIGHT_BIND_NAME_KEY = "rjaf.pc.flight.boundPcName";

export interface FlightBinding {
  pcId: string;
  pcName: string;
}

export function getFlightBinding(): FlightBinding | null {
  const id = localStorage.getItem(FLIGHT_BIND_ID_KEY) ?? "";
  if (!id) return null;
  return { pcId: id, pcName: localStorage.getItem(FLIGHT_BIND_NAME_KEY) ?? id };
}

export function setFlightBinding(b: FlightBinding | null) {
  if (!b || !b.pcId) {
    localStorage.removeItem(FLIGHT_BIND_ID_KEY);
    localStorage.removeItem(FLIGHT_BIND_NAME_KEY);
    return;
  }
  localStorage.setItem(FLIGHT_BIND_ID_KEY, b.pcId);
  localStorage.setItem(FLIGHT_BIND_NAME_KEY, b.pcName || b.pcId);
}

// Admin-driven Flight↔Squadron commander binding overrides. April 2026:
// per CO request the binding selection is moved out of the flight PC's
// first-run gate and into Super Admin → Commanders, so HQ controls who
// reports to whom. The override is keyed by the flight commander's
// username; when that commander signs in on any PC, the gate auto-applies
// the override and skips the manual picker. Stored in a single
// localStorage map per PC so admin presets are restorable from any
// machine that's been synced.
const ADMIN_FLIGHT_BIND_KEY = "rjaf.pc.flight.adminOverrides";
type AdminBindingMap = Record<string, FlightBinding>;
function readAdminMap(): AdminBindingMap {
  try {
    const raw = localStorage.getItem(ADMIN_FLIGHT_BIND_KEY);
    return raw ? (JSON.parse(raw) as AdminBindingMap) : {};
  } catch { return {}; }
}
export function getAdminFlightBindingFor(username: string | null | undefined): FlightBinding | null {
  if (!username) return null;
  const m = readAdminMap();
  return m[username.toLowerCase()] ?? null;
}
export function setAdminFlightBindingFor(username: string, b: FlightBinding | null) {
  const m = readAdminMap();
  const key = username.toLowerCase();
  if (!b || !b.pcId) delete m[key];
  else m[key] = { pcId: b.pcId, pcName: b.pcName || b.pcId };
  try { localStorage.setItem(ADMIN_FLIGHT_BIND_KEY, JSON.stringify(m)); } catch { /* ignore */ }
  // Broadcast to every other PC via the shared audit_log channel. The
  // event carries the full binding map so a flight PC that boots later
  // gets the latest view in a single fetch (see syncAdminFlightBindingsFromRemote).
  void recordAuditEvent({
    type: "admin.flight.binding.set",
    actor: "super-admin",
    detail: { username: key, binding: b ?? null, map: m },
  });
}
export function listAdminFlightBindings(): AdminBindingMap {
  return readAdminMap();
}

// Pull the latest admin-published flight bindings from Supabase and cache
// them locally. The Super Admin writes the binding by calling
// setAdminFlightBindingFor above, which both updates their localStorage
// AND inserts an audit_log row containing the full map. Any other PC can
// recover the latest state by selecting the most recent
// admin.flight.binding.set event. This is the cross-PC channel that
// distinguishes the April 2026 implementation from the previous
// localStorage-only approach.
export async function syncAdminFlightBindingsFromRemote(): Promise<void> {
  if (!isLive() || !supabase) return;
  const { data, error } = await supabase
    .from("audit_log")
    .select("detail")
    .eq("type", "admin.flight.binding.set")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return;
  const detail = (data as { detail?: Record<string, unknown> }).detail ?? {};
  const map = (detail.map ?? {}) as AdminBindingMap;
  if (map && typeof map === "object") {
    try {
      localStorage.setItem(ADMIN_FLIGHT_BIND_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Squadron-commander → flight-commander group. Published by a Squadron
// Commander PC when it finishes Setup with a non-empty
// `rjaf.linkedFlightPcIds`. Any flight commander PC whose id is in
// `flightPcIds` picks this up on sign-in and auto-sets its local
// flight binding to the squadron commander PC — so the whole squadron
// group (ops PC + squadron commander + linked flight commanders) can
// message and coordinate without an additional admin step.
// ──────────────────────────────────────────────────────────────────────
export interface SquadronFlightGroup {
  squadronPcId: string;
  squadronPcName: string;
  flightPcIds: string[];
  publishedAt: string;
}

export async function publishSquadronFlightGroup(
  squadronPcId: string,
  squadronPcName: string,
  flightPcIds: string[],
): Promise<void> {
  if (!squadronPcId) return;
  const payload: SquadronFlightGroup = {
    squadronPcId,
    squadronPcName: squadronPcName || squadronPcId,
    flightPcIds: Array.from(new Set(flightPcIds.filter(Boolean))),
    publishedAt: nowIso(),
  };
  try {
    await recordAuditEvent({
      type: "xpc.squadron.flight.group.set",
      actor: squadronPcId,
      detail: payload as unknown as Record<string, unknown>,
    });
  } catch {
    // Silent — the registry heartbeat re-runs every 30s and will retry.
  }
}

// Called on every flight commander PC sign-in. Finds the most recent
// squadron group that lists THIS flight PC, and returns the squadron
// binding to apply. Returns null when no group claims this PC or when
// offline (the caller falls back to the admin-override path).
// Super Admin entry point: fetch the most recent group published for a
// given squadron PC id. Used by the Squadrons admin page so the edit
// dialog can pre-populate the flight-commander checkbox list and the
// admin can add/remove members post-setup without visiting the
// squadron commander PC.
export async function getLatestSquadronFlightGroup(
  squadronPcId: string,
): Promise<SquadronFlightGroup | null> {
  if (!isLive() || !supabase || !squadronPcId) return null;
  const { data, error } = await supabase
    .from("audit_log")
    .select("detail, occurred_at")
    .eq("type", "xpc.squadron.flight.group.set")
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (error || !data) return null;
  for (const row of data as { detail?: Record<string, unknown> }[]) {
    const d = row.detail ?? {};
    const sid = typeof (d as { squadronPcId?: unknown }).squadronPcId === "string"
      ? (d as { squadronPcId: string }).squadronPcId
      : "";
    if (sid !== squadronPcId) continue;
    const ids = Array.isArray((d as { flightPcIds?: unknown }).flightPcIds)
      ? ((d as { flightPcIds: unknown[] }).flightPcIds.filter(
          (x): x is string => typeof x === "string",
        ))
      : [];
    const name = typeof (d as { squadronPcName?: unknown }).squadronPcName === "string"
      ? (d as { squadronPcName: string }).squadronPcName
      : sid;
    const at = typeof (d as { publishedAt?: unknown }).publishedAt === "string"
      ? (d as { publishedAt: string }).publishedAt
      : nowIso();
    return { squadronPcId: sid, squadronPcName: name, flightPcIds: ids, publishedAt: at };
  }
  return null;
}

export async function syncSquadronFlightGroupForFlightPc(
  flightPcId: string,
): Promise<FlightBinding | null> {
  if (!isLive() || !supabase || !flightPcId) return null;
  const { data, error } = await supabase
    .from("audit_log")
    .select("detail, occurred_at")
    .eq("type", "xpc.squadron.flight.group.set")
    .order("occurred_at", { ascending: false })
    .limit(50);
  if (error || !data) return null;
  // Latest group (per squadron) wins — walk newest → oldest and return
  // the first one whose flightPcIds includes us.
  for (const row of data as { detail?: Record<string, unknown> }[]) {
    const d = row.detail ?? {};
    const ids = Array.isArray((d as { flightPcIds?: unknown }).flightPcIds)
      ? ((d as { flightPcIds: unknown[] }).flightPcIds.filter(
          (x): x is string => typeof x === "string",
        ))
      : [];
    if (!ids.includes(flightPcId)) continue;
    const sqId = typeof (d as { squadronPcId?: unknown }).squadronPcId === "string"
      ? (d as { squadronPcId: string }).squadronPcId
      : "";
    const sqName = typeof (d as { squadronPcName?: unknown }).squadronPcName === "string"
      ? (d as { squadronPcName: string }).squadronPcName
      : sqId;
    if (!sqId) continue;
    return { pcId: sqId, pcName: sqName };
  }
  return null;
}

export interface SquadronPC {
  id: string;             // canonical ecosystem id (squadron name, or
                          // commander-scope id e.g. "WING:NWAC")
  squadronName: string;   // human-readable label, e.g. "8 SQN"
  tier: PcTier;
  base?: string;          // e.g. "Marka"
  wing?: string;          // e.g. "RWAC"
  // Optional friendly device label the owner of this PC set in Setup /
  // Security (rjaf.pcDeviceName). When present, commander pickers prefer
  // this over the base suffix because operators asked to identify PCs by
  // "the name I gave the device", not by the airbase it happens to be at.
  deviceName?: string;
  lastSeen: string;       // ISO
  // v1.1.98 multi-squadron org chart pointer (xpc_registry.parent_pc_id).
  // Squadron PC → its Wing PC id; Wing PC → its Base PC id; Flight PC →
  // undefined (use squadronPcId instead).
  parentPcId?: string;
  // Flight PCs only: the Sqn-tier PC this flight belongs to. Lets a Sqn
  // Cmdr's "down-chain to flight" picker show only its own children.
  squadronPcId?: string;
}

export interface RegisteredPC extends SquadronPC {
  online: boolean;
  isSelf: boolean;
}

function readRegistry(): SquadronPC[] {
  return readJSON<SquadronPC[]>(REGISTRY_KEY, []);
}
function writeRegistry(rows: SquadronPC[]) {
  writeJSON(REGISTRY_KEY, rows);
}

// The local PC's own canonical id. Set by `registerLocalPC` — every page
// that filters by "is this for me?" (pending queue, schedule chain, the
// messages inbox) reads this value, so the same id flows from the writer
// (host PC submitting a pending entry) to the reader (home PC reviewing
// it). The id is the squadron name for squadron PCs, or a tier-prefixed
// id for commander tiers (e.g. "WING:NWAC", "BASE:Marka").
function localPcId(): string {
  return localStorage.getItem("rjaf.xpc.localId") ?? "";
}
// v1.1.65 — squadronColor returns a stable, deterministic Tailwind
// palette per squadron id so 15-20+ squadrons stay visually distinct
// at a glance on the Wing / Base / HQ commander surfaces. The hash is
// intentionally simple (sum of char codes) — same id → same colour
// every render, every PC, no server round-trip required.
export interface SquadronPalette {
  /** Subtle pill background, e.g. for inline badges. */
  badge: string;
  /** Solid coloured stripe / left border for cards. */
  stripe: string;
  /** Plain hex for inline styles when Tailwind classes can't reach. */
  hex: string;
}
const SQUADRON_PALETTES: SquadronPalette[] = [
  { badge: "bg-sky-500/15 text-sky-200 border-sky-400/40",         stripe: "bg-sky-400",     hex: "#38bdf8" },
  { badge: "bg-emerald-500/15 text-emerald-200 border-emerald-400/40", stripe: "bg-emerald-400", hex: "#34d399" },
  { badge: "bg-amber-500/15 text-amber-200 border-amber-400/40",   stripe: "bg-amber-400",   hex: "#fbbf24" },
  { badge: "bg-violet-500/15 text-violet-200 border-violet-400/40", stripe: "bg-violet-400",  hex: "#a78bfa" },
  { badge: "bg-rose-500/15 text-rose-200 border-rose-400/40",      stripe: "bg-rose-400",    hex: "#fb7185" },
  { badge: "bg-cyan-500/15 text-cyan-200 border-cyan-400/40",      stripe: "bg-cyan-400",    hex: "#22d3ee" },
  { badge: "bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-400/40", stripe: "bg-fuchsia-400", hex: "#e879f9" },
  { badge: "bg-lime-500/15 text-lime-200 border-lime-400/40",      stripe: "bg-lime-400",    hex: "#a3e635" },
  { badge: "bg-orange-500/15 text-orange-200 border-orange-400/40", stripe: "bg-orange-400", hex: "#fb923c" },
  { badge: "bg-teal-500/15 text-teal-200 border-teal-400/40",      stripe: "bg-teal-400",    hex: "#2dd4bf" },
  { badge: "bg-indigo-500/15 text-indigo-200 border-indigo-400/40", stripe: "bg-indigo-400", hex: "#818cf8" },
  { badge: "bg-pink-500/15 text-pink-200 border-pink-400/40",      stripe: "bg-pink-400",    hex: "#f472b6" },
];
export function squadronColor(squadronId: string): SquadronPalette {
  if (!squadronId) return SQUADRON_PALETTES[0];
  let h = 0;
  for (let i = 0; i < squadronId.length; i++) h = (h * 31 + squadronId.charCodeAt(i)) >>> 0;
  return SQUADRON_PALETTES[h % SQUADRON_PALETTES.length];
}

export function getLocalPcId(): string {
  return localPcId();
}
export function setLocalPcId(id: string): void {
  try {
    if (id) localStorage.setItem("rjaf.xpc.localId", id);
  } catch { /* localStorage may be blocked in tests */ }
}

// Stable per-machine random suffix. Generated once on first request and
// cached in localStorage so the same physical PC always derives the same
// suffix across restarts. Used to disambiguate two PCs that happen to be
// signed in with the same account (e.g. two flight commander offices
// sharing one set of credentials) — without a suffix they would heartbeat
// to the same registry id and overwrite each other every 30 seconds. The
// canonical ops PC intentionally does NOT use this suffix because its id
// IS the squadron's address that other PCs route to.
export function getDeviceSuffix(): string {
  try {
    const existing = localStorage.getItem("rjaf.deviceSuffix");
    if (existing && /^[0-9a-f]{6}$/.test(existing)) return existing;
    let fresh = "";
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      fresh = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
    } else {
      fresh = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
    }
    localStorage.setItem("rjaf.deviceSuffix", fresh);
    return fresh;
  } catch {
    // localStorage blocked — return an in-process random so the session
    // still has a unique-ish suffix even if it can't be persisted.
    return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  }
}

export interface RegisterPcOpts {
  id: string;
  displayName: string;
  tier: PcTier;
  base?: string;
  wing?: string;
  // v1.1.98 multi-squadron: this PC's parent in the org chart.
  //   Squadron PC → Wing PC id     ("WING:NORTH#abc123")
  //   Wing PC     → Base PC id     ("BASE:KAB#def456")
  //   Flight PC   → leave undefined; use squadronPcId instead.
  parentPcId?: string;
  // For Flight PCs only: which Squadron PC do we belong under? Lets a
  // Sqn Cmdr's down-chain composer show only their own flights.
  squadronPcId?: string;
}

function rowToPc(r: Record<string, unknown>): SquadronPC {
  const id = String(r.id);
  // The xpc_registry table's tier CHECK constraint pre-dates the Flight
  // Commander tier and only accepts squadron/wing/base/hq. To keep the
  // schema unchanged we encode flight PCs in the id prefix ("FLIGHT:")
  // and write tier='squadron' to the DB; on read we recover the true
  // tier from the prefix here so the rest of the app sees "flight".
  let tier = (r.tier as PcTier) ?? "squadron";
  if (id.startsWith("FLIGHT:")) tier = "flight";
  return {
    id,
    squadronName: String(r.squadron_name ?? ""),
    tier,
    base: r.base ? String(r.base) : undefined,
    wing: r.wing ? String(r.wing) : undefined,
    deviceName: r.device_name ? String(r.device_name) : undefined,
    lastSeen: String(r.last_seen ?? nowIso()),
    parentPcId: r.parent_pc_id ? String(r.parent_pc_id) : undefined,
    squadronPcId: r.squadron_pc_id ? String(r.squadron_pc_id) : undefined,
  };
}

export function registerLocalPC(opts: RegisterPcOpts | string, base?: string, wing?: string) {
  // Backwards-compat: an early form was `registerLocalPC(squadronName, base, wing)`
  // — that path is preserved by promoting the squadron name to both the
  // canonical id and the display name with tier="squadron".
  const o: RegisterPcOpts = typeof opts === "string"
    ? { id: opts, displayName: opts, tier: "squadron", base, wing }
    : opts;
  if (!o.id) return;
  localStorage.setItem("rjaf.xpc.localId", o.id);
  // Pick up the friendly device label the operator saved in Setup /
  // Security (localStorage `rjaf.pcDeviceName`) so commander pickers can
  // show "8SQN — Ops Cockpit-3" instead of repeating the base name.
  const deviceName = (() => {
    try { return localStorage.getItem("rjaf.pcDeviceName") || undefined; } catch { return undefined; }
  })();
  const entry: SquadronPC = {
    id: o.id,
    squadronName: o.displayName,
    tier: o.tier,
    base: o.base,
    wing: o.wing,
    deviceName,
    lastSeen: nowIso(),
    parentPcId: o.parentPcId,
    squadronPcId: o.squadronPcId,
  };
  // Mirror into localStorage so the offline fallback path (and a quick
  // first paint before the Supabase round-trip resolves) has data to show.
  const rows = readRegistry();
  const idx = rows.findIndex(r => r.id === o.id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...entry }; else rows.push(entry);
  writeRegistry(rows);
  // Heartbeat write path. We MUST do these two upserts in sequence and
  // both must succeed, or this PC will be invisible to every other
  // operator in the ecosystem:
  //   1. xpc_user_pcs  — claims `o.id` for the current auth.uid so RLS
  //                      lets the PC publish on cross-PC tables.
  //   2. xpc_registry  — publishes "this PC is alive at <last_seen>"
  //                      so other operators' pickers can see it.
  //
  // Historically these were both fire-and-forget with empty catch
  // blocks. A Flight or Squadron Commander PC would sign in, the
  // registry SELECT would succeed (so the green "Live" pill lit up),
  // but the registry UPSERT would silently fail under RLS — leaving
  // the PC invisible to everyone else. The new path captures the
  // error and surfaces it through the existing data-error indicator.
  if (isLanSessionLoginEnabled() && !resetInProgress) {
    void (async () => {
      if (resetInProgress) return;
      try {
        const dbTier = o.tier === "flight" ? "squadron" : o.tier;
        const hb = await postInternalXpcRegistryHeartbeat({
          id: o.id,
          squadron_name: o.displayName,
          tier: dbTier,
          base: o.base ?? null,
          wing: o.wing ?? null,
          device_name: deviceName ?? null,
          last_seen: entry.lastSeen,
          parent_pc_id: o.parentPcId ?? null,
          squadron_pc_id: o.squadronPcId ?? null,
        });
        if (!hb.ok) {
          reportHeartbeatError(
            `LAN registry heartbeat rejected for "${o.id}" (${hb.status ?? "?"}): ${hb.error}`,
            hb.status ? String(hb.status) : undefined,
          );
          return;
        }
        clearHeartbeatError();
      } catch (e) {
        reportHeartbeatError(
          `LAN registry heartbeat threw for "${o.id}": ${(e as Error)?.message ?? String(e)}`,
        );
      }
    })();
  } else if (isLive() && !resetInProgress) {
    void (async () => {
      // Recheck the flag inside the async closure — the user may have
      // started a "Reset this PC" between the outer check and the
      // microtask actually running.
      if (resetInProgress) return;
      const claimOk = await ensureMyPcClaim(o.id);
      if (!claimOk) {
        reportHeartbeatError(
          `Could not claim PC "${o.id}" — cloud sign-in may not have completed yet. ` +
          `If this persists, sign out and sign back in.`,
        );
        return;
      }
      try {
        const dbTier = o.tier === "flight" ? "squadron" : o.tier;
        const { error } = await supabase!.from("xpc_registry").upsert({
          id: o.id,
          squadron_name: o.displayName,
          tier: dbTier,
          base: o.base ?? null,
          wing: o.wing ?? null,
          device_name: deviceName ?? null,
          last_seen: entry.lastSeen,
          // v1.1.98 multi-squadron org-chart pointer. Older Supabase
          // schemas (pre-0037) don't have these columns yet — PostgREST
          // will surface a "column does not exist" error in that case.
          // We catch + retry-without below so the upsert still wins.
          parent_pc_id: o.parentPcId ?? null,
          squadron_pc_id: o.squadronPcId ?? null,
        }, { onConflict: "id" });
        // Detect "column does not exist" across the multiple shapes
        // PostgREST/Supabase emit it in:
        //   - raw Postgres: 'column "parent_pc_id" does not exist' (SQLSTATE 42703)
        //   - PostgREST schema cache miss: "Could not find the 'parent_pc_id' column of 'xpc_registry' in the schema cache" (PGRST204)
        //   - Some proxies prefix with the column name only.
        // Any of those means migration 0037 has not been applied yet —
        // retry with the legacy 5-column upsert so heartbeat survives.
        const errMsg = (error?.message ?? "") + " " + (error?.details ?? "") + " " + (error?.hint ?? "");
        const errCode = error?.code ?? "";
        const isMissingNewColumn =
          /parent_pc_id|squadron_pc_id/i.test(errMsg) &&
          (errCode === "42703" || errCode === "PGRST204" ||
            /does not exist|schema cache|could not find/i.test(errMsg));
        if (error && isMissingNewColumn) {
          // Migration 0037 not applied yet on this project — retry with
          // the legacy column set so heartbeat keeps working. Operator
          // gets the routing benefits as soon as they paste 0037 in.
          const legacy = await supabase!.from("xpc_registry").upsert({
            id: o.id,
            squadron_name: o.displayName,
            tier: dbTier,
            base: o.base ?? null,
            wing: o.wing ?? null,
            device_name: deviceName ?? null,
            last_seen: entry.lastSeen,
          }, { onConflict: "id" });
          if (!legacy.error) { clearHeartbeatError(); return; }
        }
        if (error) {
          reportHeartbeatError(
            `Registry upsert rejected for "${o.id}" (${error.code ?? "?"}): ${error.message}`,
            error.code,
          );
          return;
        }
        clearHeartbeatError();
        // Tick last_activity_at on every pair this PC participates in.
        // This is what powers the 90-day inactivity sweep — without it
        // the timer would always read "creation time" and the sweep
        // would either never expire anything or expire everything in
        // bulk on day 90. Best-effort: failures here do NOT touch the
        // heartbeat error indicator (a missing 0038 migration must not
        // break the registry tick).
        try { await supabase!.rpc("xpc_pair_touch", { p_pc_id: o.id }); } catch { /* ignore */ }
      } catch (e) {
        reportHeartbeatError(
          `Registry upsert threw for "${o.id}": ${(e as Error)?.message ?? String(e)}`,
        );
      }
    })();
  }
}

// ---------------------------------------------------------------------
// PC-claim management.
//
// Every write to xpc_messages / xpc_schedule_shares / xpc_pending is
// gated by the RLS policy `from_pc_id = ANY (xpc_my_pc_ids())`, where
// `xpc_my_pc_ids()` returns the array of pc_ids claimed by the current
// auth.uid in `xpc_user_pcs`. If the claim was never persisted (e.g.
// the heartbeat fired BEFORE supabase finished restoring the session,
// or the user signed in via signInWithPassword AFTER the first
// registerLocalPC tick), every cross-PC operation fails with the
// 42501 error users see as "Server error: row violates row-level
// security policy for table xpc_messages".
//
// `ensureMyPcClaim` is called from registerLocalPC (every 30s
// heartbeat), from useSendMessage / submit / decide / forward
// mutationFns (defensive, just before the write), and once from the
// auth flow right after signInWithPassword resolves. Each call retries
// the auth.getUser lookup for up to ~5s with backoff, then upserts the
// claim. A successful upsert is cached in-memory so subsequent calls
// for the same (uid,pcId) pair are no-ops.
// ---------------------------------------------------------------------

const claimedKeys = new Set<string>();

export async function ensureMyPcClaim(pcId: string | null | undefined): Promise<boolean> {
  if (!pcId || !isLive() || !supabase) return false;
  // Try up to 6 times spaced ~750ms apart (≈4.5s) for the supabase
  // session to settle after a fresh sign-in. Once we have a uid, the
  // upsert itself is idempotent and synchronous from the client's
  // point of view.
  let uid: string | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { data } = await supabase.auth.getUser();
      uid = data?.user?.id;
      if (uid) break;
    } catch { /* network blip — retry */ }
    await new Promise(r => setTimeout(r, 750));
  }
  if (!uid) return false;
  const cacheKey = `${uid}::${pcId}`;
  if (claimedKeys.has(cacheKey)) return true;
  try {
    const { error } = await supabase.from("xpc_user_pcs").upsert(
      { user_id: uid, pc_id: pcId },
      { onConflict: "user_id,pc_id" },
    );
    if (error) {
      // Surface the failure to the console — silent failure here is
      // what kept the bug invisible in production for so long.
      console.warn("[xpc] PC claim upsert failed:", error.message, { pcId });
      return false;
    }
    claimedKeys.add(cacheKey);
    return true;
  } catch (e) {
    console.warn("[xpc] PC claim threw:", (e as Error)?.message);
    return false;
  }
}

export function useRegisteredPCs(
  opts: { enabled?: boolean } = {},
): UseQueryResult<RegisteredPC[]> & { data: RegisteredPC[] } {
  const enabled = opts.enabled ?? true;
  const q = useQuery<RegisteredPC[]>({
    queryKey: ["xpc", "registry"],
    enabled,
    queryFn: async () => {
      const me = localPcId();
      const cutoff = Date.now() - ONLINE_WINDOW_MS;
      let rows: SquadronPC[] = [];
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcRegistryRows({
          includeStale: false,
          activeSeconds: Math.floor(ACTIVE_WINDOW_MS / 1000),
        });
        rows = (data ?? []).map((r) =>
          rowToPc({
            id: r.id,
            squadron_name: r.squadron_name ?? "",
            tier: r.tier ?? "squadron",
            base: r.base ?? null,
            wing: r.wing ?? null,
            device_name: r.device_name ?? null,
            last_seen: r.last_seen ?? nowIso(),
            parent_pc_id: r.parent_pc_id ?? null,
            squadron_pc_id: r.squadron_pc_id ?? null,
          }),
        );
      } else if (isLive()) {
        rows = await liveOrLocal(
          async () => {
            // Defensive cap so the registry query stays fast even if the
            // table grows to 1000+ PCs (active or retired) over the life
            // of the deployment. Ordered by last_seen DESC so the most
            // recently active PCs always make the cut. The schema has a
            // matching index (xpc_registry_last_seen_idx) so this is a
            // cheap index scan, not a sequential scan.
            // v1.1.73: server-side enforce the 90 s active window. Every
            // consumer of useRegisteredPCs() (Messages, ScheduleChain,
            // FlightProgram, FinalSchedules, AddSortie, Overview,
            // LicenseKeys, Commanders, Squadrons, ...) automatically
            // sees only PCs whose heartbeat lands in the window — the
            // single source of truth lives in ACTIVE_WINDOW_MS. Stale
            // rows never cross the wire, so they cannot leak into any
            // picker through a forgotten client filter. The
            // isPcActive() / getActivePCs() helpers stay in place as
            // defence-in-depth for any new call site.
            const activeFloor = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
            const { data, error } = await supabase!
              .from("xpc_registry")
              .select("*")
              .gte("last_seen", activeFloor)
              .order("last_seen", { ascending: false })
              .limit(5000);
            if (error) throw error;
            // Opportunistic prune of long-stale rows so the registry stays
            // bounded over years of personnel turnover. Runs ~1 in 20
            // fetches and is fully fire-and-forget — never blocks the UI
            // and never throws into the query. Deletes from BOTH the
            // registry and the per-user PC claims table so a reimaged or
            // decommissioned PC vanishes completely from every other
            // operator's pickers within a single refresh cycle.
            if (Math.random() < 0.05) {
              void (async () => {
                try {
                  const staleBefore = new Date(Date.now() - STALE_REGISTRY_MS).toISOString();
                  const { data: deadIds } = await supabase!
                    .from("xpc_registry")
                    .select("id")
                    .lt("last_seen", staleBefore)
                    .limit(500);
                  const ids = (deadIds ?? []).map((r: { id: string }) => r.id).filter(Boolean);
                  if (ids.length > 0) {
                    await supabase!.from("xpc_registry").delete().in("id", ids);
                    await supabase!.from("xpc_user_pcs").delete().in("pc_id", ids);
                  }
                } catch { /* prune is best-effort */ }
                // Also prune long-stale schedule shares — flights that
                // already happened more than 6 months ago. Local sortie
                // logs keep the permanent record; the central share row
                // exists only so the chain (squadron→wing→base→HQ) can
                // review and approve in near-real-time. After 6 months
                // it has served its purpose.
                try {
                  const sharesBefore = new Date(Date.now() - STALE_SHARE_MS).toISOString().slice(0, 10);
                  await supabase!
                    .from("xpc_schedule_shares")
                    .delete()
                    .lt("flight_date", sharesBefore);
                } catch { /* prune is best-effort */ }
                // And prune long-revoked mobile devices — once a phone
                // has been "Unlinked" for 6+ months, the row is dead
                // weight (it can never be reactivated, only re-paired
                // fresh). Keeps the pilot_devices table from bloating
                // over years of personnel turnover at 15+ squadrons.
                try {
                  const revokedBefore = new Date(Date.now() - STALE_SHARE_MS).toISOString();
                  await supabase!
                    .from("pilot_devices")
                    .delete()
                    .lt("revoked_at", revokedBefore);
                } catch { /* prune is best-effort */ }
              })();
            }
            return (data ?? []).map(rowToPc);
          },
          () => readRegistry(),
        );
      } else {
        rows = readRegistry();
      }
      // v1.1.59: hard-filter any TEST_DEMO:-prefixed rows from every UI
      // surface. The headless e2e test suite (.local/tests/cross-pc-e2e.mjs)
      // creates synthetic registry rows during runs and cleans them at the
      // end, but if a run is killed mid-execution the rows can briefly
      // linger and confuse operators ("what is NO.99? I didn't register
      // that"). The TEST_DEMO: prefix is reserved for that test harness;
      // no production PC may use it. Filter at the source so downstream
      // pickers, inboxes and counts can never see them.
      return rows
        .filter(r => !r.id.startsWith("TEST_DEMO:"))
        .map(r => ({
          ...r,
          online: new Date(r.lastSeen).getTime() >= cutoff,
          isSelf: r.id === me,
        }));
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<RegisteredPC[]> & { data: RegisteredPC[] };
}

// ── Tolerant squadron-name comparison ──────────────────────────────────
//
// Squadron labels drift in practice — operators type "NO.8", "NO. 8",
// "8 SQN", "8 SQDN", "no 8", "Squadron 8". The Messages and Schedule
// pickers used to do their own ad-hoc lowercase+stripping, which
// missed near-matches and silently dropped flight-cmdr PCs from a
// squadron commander's recipient list. This is the single source of
// truth: keep squadron-name comparisons routed through here so a fix
// here propagates everywhere.
export function normalizeSquadronKey(s: string | undefined | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
export function squadronNameMatches(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const ka = normalizeSquadronKey(a);
  const kb = normalizeSquadronKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.includes(kb) || kb.includes(ka)) return true;
  // Bare-number fallback — "no8" ↔ "8" ↔ "sqn8" ↔ "sqdn8". Pull the
  // first run of digits from each side and compare; same number wins.
  const da = ka.match(/\d+/)?.[0] ?? "";
  const db = kb.match(/\d+/)?.[0] ?? "";
  if (da && db && da === db) return true;
  return false;
}

// Stale-aware registry hook — same shape as useRegisteredPCs but the
// server-side last_seen floor is widened to 24 hours so the Messages
// picker can render PCs that have gone briefly offline as "stale"
// rather than dropping them silently. The `online` flag still reflects
// the 90 s ACTIVE_WINDOW_MS so callers can distinguish active from
// stale rows. Used by Messages.tsx to comply with task #134's
// "stale PCs are visible, not hidden" rule.
const STALE_PICKER_WINDOW_MS = 24 * 60 * 60_000;
export function useRegisteredPCsIncludingStale(): UseQueryResult<RegisteredPC[]> & { data: RegisteredPC[] } {
  const q = useQuery<RegisteredPC[]>({
    queryKey: ["xpc", "registry", "includingStale"],
    queryFn: async () => {
      const me = localPcId();
      const cutoff = Date.now() - ONLINE_WINDOW_MS;
      let rows: SquadronPC[] = [];
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcRegistryRows({
          includeStale: true,
          staleHours: Math.floor(STALE_PICKER_WINDOW_MS / (60 * 60_000)),
        });
        rows = (data ?? []).map((r) =>
          rowToPc({
            id: r.id,
            squadron_name: r.squadron_name ?? "",
            tier: r.tier ?? "squadron",
            base: r.base ?? null,
            wing: r.wing ?? null,
            device_name: r.device_name ?? null,
            last_seen: r.last_seen ?? nowIso(),
            parent_pc_id: r.parent_pc_id ?? null,
            squadron_pc_id: r.squadron_pc_id ?? null,
          }),
        );
      } else if (isLive()) {
        rows = await liveOrLocal(
          async () => {
            const floor = new Date(Date.now() - STALE_PICKER_WINDOW_MS).toISOString();
            const { data, error } = await supabase!
              .from("xpc_registry")
              .select("*")
              .gte("last_seen", floor)
              .order("last_seen", { ascending: false })
              .limit(5000);
            if (error) throw error;
            return (data ?? []).map(rowToPc);
          },
          () => readRegistry(),
        );
      } else {
        rows = readRegistry();
      }
      return rows
        .filter(r => !r.id.startsWith("TEST_DEMO:"))
        .map(r => ({
          ...r,
          online: new Date(r.lastSeen).getTime() >= cutoff,
          isSelf: r.id === me,
        }));
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<RegisteredPC[]> & { data: RegisteredPC[] };
}

// Active-PC helpers — single source of truth for "is this PC live right
// now". A PC is active iff its last heartbeat was within
// ACTIVE_WINDOW_MS (90 s). Every cross-PC list, picker, dropdown,
// forward-target and message-recipient surface MUST run through these
// helpers so an operator can never select / forward to / message a PC
// that has actually gone offline. Existing message threads with a now-
// inactive PC keep rendering — only the composer / picker side is
// gated. See `isPcActive(pc)` for ad-hoc checks and `getActivePCs(pcs)`
// for filtering a list.
export function isPcActive(pc: { lastSeen?: string; online?: boolean } | null | undefined): boolean {
  if (!pc) return false;
  if (typeof pc.online === "boolean") return pc.online;
  if (!pc.lastSeen) return false;
  return Date.now() - new Date(pc.lastSeen).getTime() <= ACTIVE_WINDOW_MS;
}
export function getActivePCs<T extends { lastSeen?: string; online?: boolean }>(rows: readonly T[]): T[] {
  return rows.filter(isPcActive);
}
// Convenience: look up a single PC by id and return whether it's active.
// Used by the Messages composer and the schedule forwarder to gate the
// "Send" button when the selected counterpart's heartbeat has lapsed.
export function isPcIdActive(rows: readonly { id: string; lastSeen?: string; online?: boolean }[], pcId: string | null | undefined): boolean {
  if (!pcId) return false;
  const row = rows.find(r => r.id === pcId);
  return isPcActive(row);
}

// ── 2. Cross-squadron pending sortie approvals ──────────────────────────
//
// When ops at the hosting squadron logs a sortie for a guest pilot whose
// home squadron is registered, the entry is queued here. The guest's
// squadron sees it in their Pending Approvals page. Accepting cascades
// into the calc engine on that PC; reject/edit/delete propagate the
// status back to the hosting squadron with an optional reason.
const PENDING_KEY = "rjaf.xpc.pending";

export type PendingStatus = "pending" | "accepted" | "rejected" | "edited" | "deleted";

export interface PendingSortie {
  id: string;
  // Squadron PC that hosted the flight (entered the sortie locally).
  hostingSquadronId: string;
  hostingSquadronName: string;
  // Squadron PC that owns the guest pilot — where the entry should be
  // approved and credited toward hours/currencies.
  homeSquadronId: string;
  homeSquadronName: string;
  // Snapshot of the guest pilot as the hosting ops officer typed them.
  guestPilotName: string;
  guestPilotMilitaryNumber?: string;
  // Which seat the guest occupied on the host's record. The home ops
  // officer fills `sortie[seat]Id` when accepting so the local calc
  // engine credits the right local pilot's totals/currencies/captain.
  guestSeat: "pilot" | "coPilot";
  // Snapshot of the sortie at submission time — enough for the home ops
  // officer to review without needing to round-trip back to the host.
  sortie: Omit<Sortie, "id">;
  submittedAt: string;
  submittedBy: string;
  // Task #137 — rich identity for the submitting ops officer.
  // Optional for back-compat with rows written before migration 0039.
  submittedByDisplayName?: string;
  submittedByRank?: string;
  submittedBySeatLabel?: string;
  status: PendingStatus;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  // When status === "edited", the home ops officer's revised payload.
  editedSortie?: Omit<Sortie, "id">;
}

function readPending(): PendingSortie[] {
  return readJSON<PendingSortie[]>(PENDING_KEY, []);
}
function writePending(rows: PendingSortie[]) {
  writeJSON(PENDING_KEY, rows);
}

function rowToPending(r: Record<string, unknown>): PendingSortie {
  return {
    id: String(r.id),
    hostingSquadronId: String(r.hosting_squadron_id),
    hostingSquadronName: String(r.hosting_squadron_name),
    homeSquadronId: String(r.home_squadron_id),
    homeSquadronName: String(r.home_squadron_name),
    guestPilotName: String(r.guest_pilot_name),
    guestPilotMilitaryNumber: r.guest_pilot_military_number ? String(r.guest_pilot_military_number) : undefined,
    guestSeat: r.guest_seat as "pilot" | "coPilot",
    sortie: (r.sortie ?? {}) as Omit<Sortie, "id">,
    submittedAt: String(r.submitted_at),
    submittedBy: String(r.submitted_by),
    submittedByDisplayName: r.submitter_display_name ? String(r.submitter_display_name) : undefined,
    submittedByRank:        r.submitter_rank         ? String(r.submitter_rank)         : undefined,
    submittedBySeatLabel:   r.submitter_seat_label   ? String(r.submitter_seat_label)   : undefined,
    status: r.status as PendingStatus,
    decidedAt: r.decided_at ? String(r.decided_at) : undefined,
    decidedBy: r.decided_by ? String(r.decided_by) : undefined,
    decisionReason: r.decision_reason ? String(r.decision_reason) : undefined,
    editedSortie: r.edited_sortie ? (r.edited_sortie as Omit<Sortie, "id">) : undefined,
  };
}

function pendingToRow(p: PendingSortie): Record<string, unknown> {
  return {
    id: p.id,
    hosting_squadron_id: p.hostingSquadronId,
    hosting_squadron_name: p.hostingSquadronName,
    home_squadron_id: p.homeSquadronId,
    home_squadron_name: p.homeSquadronName,
    guest_pilot_name: p.guestPilotName,
    guest_pilot_military_number: p.guestPilotMilitaryNumber ?? null,
    guest_seat: p.guestSeat,
    sortie: p.sortie,
    submitted_at: p.submittedAt,
    submitted_by: p.submittedBy,
    submitter_display_name: p.submittedByDisplayName ?? null,
    submitter_rank:         p.submittedByRank        ?? null,
    submitter_seat_label:   p.submittedBySeatLabel   ?? null,
    status: p.status,
    decided_at: p.decidedAt ?? null,
    decided_by: p.decidedBy ?? null,
    decision_reason: p.decisionReason ?? null,
    edited_sortie: p.editedSortie ?? null,
  };
}

export function usePendingApprovals(homeSquadronId: string | null | undefined): UseQueryResult<PendingSortie[]> & { data: PendingSortie[] } {
  const q = useQuery<PendingSortie[]>({
    queryKey: ["xpc", "pending", homeSquadronId ?? ""],
    queryFn: async () => {
      if (!homeSquadronId) return [];
      const localFallback = () => readPending()
        .filter(p => p.homeSquadronId === homeSquadronId && p.status === "pending")
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcPending({
          homeSquadronId,
          statuses: ["pending"],
        });
        if (rows) return rows.map(rowToPending);
        return localFallback();
      }
      if (isLive()) {
        return await liveOrLocal(
          async () => {
            const { data, error } = await supabase!
              .from("xpc_pending")
              .select("*")
              .eq("home_squadron_id", homeSquadronId)
              .eq("status", "pending")
              .order("submitted_at", { ascending: false });
            if (error) throw error;
            return (data ?? []).map(rowToPending);
          },
          localFallback,
        );
      }
      return localFallback();
    },
    refetchInterval: 15_000,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<PendingSortie[]> & { data: PendingSortie[] };
}

// All pending entries across all squadrons — used by the mobile pilot
// view to surface "your ops officer must approve this" notifications.
export function useAllPending(): UseQueryResult<PendingSortie[]> & { data: PendingSortie[] } {
  const q = useQuery<PendingSortie[]>({
    queryKey: ["xpc", "pending", "all"],
    queryFn: async () => {
      const localFallback = () => readPending().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcPending();
        if (rows) return rows.map(rowToPending);
        return localFallback();
      }
      if (isLive()) {
        return await liveOrLocal(
          async () => {
            const { data, error } = await supabase!
              .from("xpc_pending")
              .select("*")
              .order("submitted_at", { ascending: false });
            if (error) throw error;
            return (data ?? []).map(rowToPending);
          },
          localFallback,
        );
      }
      return localFallback();
    },
    refetchInterval: 15_000,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<PendingSortie[]> & { data: PendingSortie[] };
}

export function useSubmitPending() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PendingSortie, "id" | "submittedAt" | "status">) => {
      const row: PendingSortie = {
        ...input,
        id: genId("PND"),
        submittedAt: nowIso(),
        status: "pending",
      };
      if (isLanSessionLoginEnabled()) {
        const resp = await postInternalXpcPending(pendingToRow(row));
        if (!resp.ok) throw new Error(resp.error);
      } else if (isLive()) {
        // RLS gate on xpc_pending.insert is
        // (hosting_squadron_id = ANY (xpc_my_pc_ids())). The hosting
        // PC is the local PC submitting the cross-squadron sortie.
        await ensureMyPcClaim(row.hostingSquadronId);
        const { error } = await supabase!.from("xpc_pending").insert(pendingToRow(row));
        if (error) throw error;
      } else {
        const rows = readPending();
        rows.push(row);
        writePending(rows);
      }
      await recordAuditEvent({
        type: "xpc.pending.submitted",
        actor: input.submittedBy,
        detail: { id: row.id, host: input.hostingSquadronName, home: input.homeSquadronName, guest: input.guestPilotName },
      });
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["xpc", "pending"] });
    },
  });
}

// Sentinel stored in `guestPilotMilitaryNumber` when the home-squadron
// ops officer has actively reviewed a legacy entry and confirmed the
// hosting squadron cannot supply the visiting pilot's number. Treated as
// "explicitly unknown" so the entry stops appearing in the backfill
// queue but matchGuestPilot still refuses to do a name-only credit.
export const GUEST_MIL_UNKNOWN = "UNKNOWN";
export function isGuestMilUnknown(n: string | undefined | null): boolean {
  return (n ?? "").trim().toUpperCase() === GUEST_MIL_UNKNOWN;
}

// All guest entries (pending + accepted) for the home squadron whose
// guestPilotMilitaryNumber is genuinely missing — i.e. neither a real
// number nor the explicit-unknown sentinel. Drives the legacy backfill
// queue.
export function useGuestEntriesNeedingBackfill(homeSquadronId: string | null | undefined): UseQueryResult<PendingSortie[]> & { data: PendingSortie[] } {
  const q = useQuery<PendingSortie[]>({
    queryKey: ["xpc", "pending", "backfill", homeSquadronId ?? ""],
    queryFn: async () => {
      if (!homeSquadronId) return [];
      let rows: PendingSortie[] = [];
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcPending({
          homeSquadronId,
          statuses: ["pending", "accepted"],
        });
        rows = (data ?? []).map(rowToPending);
      } else if (isLive()) {
        const { data, error } = await supabase!
          .from("xpc_pending")
          .select("*")
          .eq("home_squadron_id", homeSquadronId)
          .in("status", ["pending", "accepted"])
          .order("submitted_at", { ascending: false });
        if (error) throw error;
        rows = (data ?? []).map(rowToPending);
      } else {
        rows = readPending()
          .filter(p => p.homeSquadronId === homeSquadronId && (p.status === "pending" || p.status === "accepted"))
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      }
      return rows.filter(r => !(r.guestPilotMilitaryNumber ?? "").trim());
    },
    refetchInterval: 30_000,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<PendingSortie[]> & { data: PendingSortie[] };
}

// Stamp a military number (or the explicit-unknown sentinel) onto a
// historical guest entry. Records an audit event so the backfill is
// traceable alongside the original submission/decision events.
export function useBackfillGuestMilNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      militaryNumber: string; // pass GUEST_MIL_UNKNOWN to mark unknown
      by: string;
    }) => {
      const value = input.militaryNumber.trim();
      if (!value) throw new Error("Military number required");
      let updated: PendingSortie | null = null;
      if (isLanSessionLoginEnabled()) {
        const data = await postInternalXpcPendingUpdate({
          id: input.id,
          guest_pilot_military_number: value,
          by: input.by,
        });
        if (!data) throw new Error("Pending entry not found");
        updated = rowToPending(data);
      } else if (isLive()) {
        const { data, error } = await supabase!
          .from("xpc_pending")
          .update({ guest_pilot_military_number: value })
          .eq("id", input.id)
          .select()
          .single();
        if (error) throw error;
        updated = rowToPending(data);
      } else {
        const rows = readPending();
        const idx = rows.findIndex(r => r.id === input.id);
        if (idx < 0) throw new Error("Pending entry not found");
        rows[idx] = { ...rows[idx], guestPilotMilitaryNumber: value };
        writePending(rows);
        updated = rows[idx];
      }
      await recordAuditEvent({
        type: "xpc.pending.backfilled",
        actor: input.by,
        detail: {
          id: input.id,
          militaryNumber: value,
          markedUnknown: isGuestMilUnknown(value),
        },
      });
      return updated;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["xpc", "pending"] });
    },
  });
}

export function useDecidePending() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      decision: "accepted" | "rejected" | "edited" | "deleted";
      decidedBy: string;
      reason?: string;
      editedSortie?: Omit<Sortie, "id">;
    }) => {
      const decidedAt = nowIso();
      let updated: PendingSortie | null = null;
      if (isLanSessionLoginEnabled()) {
        const data = await postInternalXpcPendingUpdate({
          id: input.id,
          status: input.decision,
          decided_at: decidedAt,
          decided_by: input.decidedBy,
          decision_reason: input.reason ?? null,
          edited_sortie: input.editedSortie ?? null,
        });
        if (!data) throw new Error("Pending entry not found");
        updated = rowToPending(data);
      } else if (isLive()) {
        const { data, error } = await supabase!.from("xpc_pending").update({
          status: input.decision,
          decided_at: decidedAt,
          decided_by: input.decidedBy,
          decision_reason: input.reason ?? null,
          edited_sortie: input.editedSortie ?? null,
        }).eq("id", input.id).select().single();
        if (error) throw error;
        updated = rowToPending(data);
      } else {
        const rows = readPending();
        const idx = rows.findIndex(r => r.id === input.id);
        if (idx < 0) throw new Error("Pending entry not found");
        rows[idx] = {
          ...rows[idx],
          status: input.decision,
          decidedAt,
          decidedBy: input.decidedBy,
          decisionReason: input.reason,
          editedSortie: input.editedSortie,
        };
        writePending(rows);
        updated = rows[idx];
      }
      await recordAuditEvent({
        type: `xpc.pending.${input.decision}`,
        actor: input.decidedBy,
        detail: { id: input.id, reason: input.reason },
      });
      return updated;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["xpc", "pending"] });
    },
  });
}

// ── 3. Flight schedule sharing chain ────────────────────────────────────
//
// The chain is strictly Squadron → Wing → Base. A squadron PC cannot skip
// directly to base — the wing PC must approve / forward / hold first. Each
// PC's name is shown explicitly in the share dialog so the originator
// always knows where the sheet currently sits.
const SCHEDULE_SHARE_KEY = "rjaf.xpc.schedule";

// The tier stored on a schedule share row as it travels up (squadron →
// wing → base) or laterally (squadron ↔ flight). "flight" was added in
// v1.0.45 so a Flight Commander can compose and forward a sortie
// schedule to their parent Squadron Commander, and a Squadron Commander
// can publish a daily programme DOWN to one of their Flight Commanders
// for visibility / return-for-edit. The DB check constraint on
// xpc_schedule_shares.current_tier is widened to match.
export type ScheduleTier = "flight" | "squadron" | "wing" | "base";
export type ScheduleStatus = "draft" | "submitted" | "reviewed" | "approved" | "rejected" | "held" | "edited";

export interface ScheduleRow {
  id: string;
  ac: string;
  config: string;
  /** Free-form mission route, e.g. "OJAM-OJAQ-OJAM" or "Local". */
  route?: string;
  crew: string[];
  mission: string;
  takeoff: string;
  land: string;
  fuel: string;
  // v1.1.47: optional fields added so the Schedule Chain compose/read
  // table can mirror the printed Flight Schedule sheet's column layout.
  // All optional → existing rows in xpc_schedule_shares stay valid.
  /** D = day, N = night (or NVG / N&D). */
  dn?: string;
  /** Sortie duration, free-form (e.g. "1+30"). */
  dur?: string;
  /** Free-form remarks. */
  remarks?: string;
  /** ATC USE — take-off slot. */
  atcTakeoff?: string;
  /** ATC USE — landing slot. */
  atcLanding?: string;
}

// Full Flight Program snapshot — when an ops officer submits the daily
// flight schedule from the FlightProgram page, we ship the entire sheet
// (helo header + airbase/squadron + bands + briefing strip + A/C-needed
// strip + signatures) so the recipient sees the SAME paper, not a
// stripped-down summary table. Mirrors the Program interface in
// pages/FlightProgram.tsx; kept as a plain JSON shape so it travels in
// xpc_schedule_shares.program (jsonb).
export interface ScheduleProgramRow {
  dn: string;
  acType: string;
  toTime: string;
  pilot: string;
  coPilot: string;
  /** Legacy field — no longer rendered. Kept so old saved sheets parse. */
  crewMen?: string;
  msnDuty: string;
  duration: string;
  fuel: string;
  configuration: string;
  /** Free-form mission route. Optional so older saved sheets parse. */
  route?: string;
  remarks: string;
  atcTakeoff: string;
  atcLanding: string;
}
export interface ScheduleProgram {
  date: string;
  mode: "DAY" | "NIGHT" | "NVG" | "DAY_AND_NVG" | "DAY_AND_NIGHT";
  airbase: string;
  squadron: string;
  dayRows: ScheduleProgramRow[];
  nightRows: ScheduleProgramRow[];
  mainBriefer: string;
  briefTime: string;
  dayOps: string;
  nightOps: string;
  lecture: string;
  capte: string;
  nightBrief: string;
  reportingTime: string;
  acNeededDay: { main: string; stby: string };
  acNeededNight: { main: string; stby: string };
  fltCmdr: string;
  sqdnCmdr: string;
}

export interface ScheduleShare {
  id: string;
  date: string;
  originSquadronId: string;
  originSquadronName: string;
  // Where the sheet currently sits in the chain.
  currentTier: ScheduleTier;
  currentPcId: string | null;
  currentPcName: string | null;
  status: ScheduleStatus;
  rows: ScheduleRow[];
  // Snapshot of the rows as last seen by each tier — used to render diff
  // highlights when a downstream PC sends edits back upstream.
  baselineRows: ScheduleRow[];
  history: Array<{
    at: string;
    by: string;
    tier: ScheduleTier;
    action: ScheduleStatus;
    note?: string;
    // Task #137 — rich actor identity stamped at the time of the
    // decision so Schedule History / Schedule Chain can render
    // "Maj. Ahmad · Flight Cmdr" instead of the bare auth username.
    // Optional for back-compat with rows written before migration 0039.
    byDisplayName?: string;
    byRank?: string;
    bySeatLabel?: string;
  }>;
  // Once edits round-trip, the originator sees them as a diff before
  // accepting. `editedRows` holds the proposed changes; once the
  // originator accepts they replace `rows` and `editedRows` clears.
  editedRows?: ScheduleRow[];
  editedBy?: string;
  // Full RJAF flight schedule sheet snapshot. Optional for backwards
  // compatibility with older shares that only carried the row list.
  program?: ScheduleProgram;
  editedProgram?: ScheduleProgram;
  // PCs (besides origin + current holder) that are allowed to view this
  // share once it has been approved — operator chose "visible to whole
  // chain so far". Populated as the sheet moves through tiers.
  chainPcIds?: string[];
  approvedAt?: string;
  approvedBy?: string;
  // PCs that have ever rejected this share. Captured at the moment of
  // rejection (the rejecter's currentPcId, before the share is bounced
  // back to the originator). Once a PC is in this list the share never
  // re-appears on that PC's screen — even if the originator later edits,
  // resends or self-approves it. Keeps rejecter inboxes clean without
  // any manual cleanup.
  rejectedByPcIds?: string[];
  // Set when the originating PC clicks "Delete from my view". Hides the
  // share from the originator's own screen only — every other PC that
  // received, reviewed, edited or approved it keeps its copy intact.
  originatorDismissedAt?: string;
}

function readShares(): ScheduleShare[] {
  return readJSON<ScheduleShare[]>(SCHEDULE_SHARE_KEY, []);
}
function writeShares(rows: ScheduleShare[]) {
  writeJSON(SCHEDULE_SHARE_KEY, rows);
}

function rowToShare(r: Record<string, unknown>): ScheduleShare {
  // Recover the flight tier from the current_pc_id prefix the same way
  // rowToMessage does. Migration 0028 widens the DB constraint so new
  // writes carry the canonical 'flight' tier directly, but rows written
  // by older builds (which downgraded to 'squadron' to satisfy the old
  // constraint) still need the prefix decode so flight commanders see
  // their inbox correctly across mixed-version deployments.
  const currentPcIdRaw = r.current_pc_id ? String(r.current_pc_id) : null;
  const currentTier: ScheduleTier =
    currentPcIdRaw && currentPcIdRaw.startsWith("FLIGHT:")
      ? "flight"
      : (r.current_tier as ScheduleTier);
  return {
    id: String(r.id),
    date: String(r.flight_date),
    originSquadronId: String(r.origin_squadron_id),
    originSquadronName: String(r.origin_squadron_name),
    currentTier,
    currentPcId: currentPcIdRaw,
    currentPcName: r.current_pc_name ? String(r.current_pc_name) : null,
    status: r.status as ScheduleStatus,
    rows: (r.rows ?? []) as ScheduleRow[],
    baselineRows: (r.baseline_rows ?? []) as ScheduleRow[],
    history: (r.history ?? []) as ScheduleShare["history"],
    editedRows: r.edited_rows ? (r.edited_rows as ScheduleRow[]) : undefined,
    editedBy: r.edited_by ? String(r.edited_by) : undefined,
    program: r.program ? (r.program as ScheduleProgram) : undefined,
    editedProgram: r.edited_program ? (r.edited_program as ScheduleProgram) : undefined,
    chainPcIds: Array.isArray(r.chain_pc_ids) ? (r.chain_pc_ids as string[]) : undefined,
    approvedAt: r.approved_at ? String(r.approved_at) : undefined,
    approvedBy: r.approved_by ? String(r.approved_by) : undefined,
    rejectedByPcIds: Array.isArray(r.rejected_by_pc_ids) ? (r.rejected_by_pc_ids as string[]) : undefined,
    originatorDismissedAt: r.originator_dismissed_at ? String(r.originator_dismissed_at) : undefined,
  };
}

function shareToRow(s: ScheduleShare): Record<string, unknown> {
  // Defense-in-depth: migration 0028 widens the current_tier CHECK to
  // accept 'flight', but if a PC ever talks to a Supabase project that
  // hasn't applied 0028 yet (a stale dev DB, a future fork) the write
  // would still fail with a constraint violation and the share would
  // silently never reach the flight commander's inbox. Downgrade
  // 'flight' to 'squadron' on the wire — the flight tier is fully
  // recovered on read from the FLIGHT: id prefix in rowToShare, so the
  // round-trip is lossless either way.
  const currentTierDb = s.currentTier === "flight" ? "squadron" : s.currentTier;
  return {
    id: s.id,
    flight_date: s.date,
    origin_squadron_id: s.originSquadronId,
    origin_squadron_name: s.originSquadronName,
    current_tier: currentTierDb,
    current_pc_id: s.currentPcId,
    current_pc_name: s.currentPcName,
    status: s.status,
    rows: s.rows,
    baseline_rows: s.baselineRows,
    history: s.history,
    edited_rows: s.editedRows ?? null,
    edited_by: s.editedBy ?? null,
    program: s.program ?? null,
    edited_program: s.editedProgram ?? null,
    chain_pc_ids: s.chainPcIds ?? [],
    approved_at: s.approvedAt ?? null,
    approved_by: s.approvedBy ?? null,
    rejected_by_pc_ids: s.rejectedByPcIds ?? [],
    originator_dismissed_at: s.originatorDismissedAt ?? null,
    updated_at: nowIso(),
  };
}

// v1.1.64 — `viewAllApproved` opens a read-only firehose: every share
// whose status is "approved" AND whose latest "approved" history entry
// was logged by a Wing-tier approver becomes visible regardless of
// chainPcIds. This is exactly how the Base Cmdr / HQ Cmdr final-
// schedules page populates its sorted-per-squadron rollup. It is
// strictly a viewer flag — viewers still cannot mutate any share.
// v1.1.101 — decode the ScheduleTier from a PC id prefix. Used on
// edit / reject return so the tier badge and sidebar badge count
// match the originator's actual tier instead of a hard-coded
// "squadron". Stays in lock-step with localPcId() formats:
//   "FLIGHT:<...>"   → flight
//   "WING:<...>"     → wing
//   "BASE:<...>"     → base
//   "SQDNCMD:<...>"  → squadron  (Sqn Cmdr PC)
//   "HQ:<...>"       → base      (HQ PC has no own ScheduleTier; treat
//                                  as base for archive/view semantics)
//   anything else    → squadron  (Ops PC uses the bare squadron code)
export function tierFromPcId(pcId: string | null | undefined): ScheduleTier {
  if (!pcId) return "squadron";
  if (pcId.startsWith("FLIGHT:")) return "flight";
  if (pcId.startsWith("WING:")) return "wing";
  if (pcId.startsWith("BASE:")) return "base";
  if (pcId.startsWith("HQ:")) return "base";
  return "squadron";
}

export function isWingApprovedFinal(s: ScheduleShare): boolean {
  if (s.status !== "approved") return false;
  // Find the latest "approved" entry; the tier on that entry tells us
  // who signed off. Wing approval is the release point to Base + HQ.
  const approvals = s.history.filter(h => h.action === "approved");
  if (approvals.length === 0) return false;
  return approvals[approvals.length - 1].tier === "wing";
}

// v1.1.108 — single source of truth for "this share is terminally
// approved" used by both Schedule History (Final tag) and any other
// surface that needs it. Wing approval auto-forwards to Base and the
// auto-forward stamps a base-tier approval event, so the latest
// approval tier can legitimately be "wing" OR "base" for a fully
// finalized chain. This helper covers both so a base-stamped chain
// doesn't get mis-tagged as in-flight.
export function isFinalSchedule(s: ScheduleShare): boolean {
  if (s.status !== "approved") return false;
  const approvals = s.history.filter(h => h.action === "approved");
  if (approvals.length === 0) return false;
  const lastTier = approvals[approvals.length - 1].tier;
  return lastTier === "wing" || lastTier === "base";
}

export function useScheduleShares(
  forPcId: string | null,
  opts?: { viewAllApproved?: boolean; includeHistoryParticipant?: boolean },
): UseQueryResult<ScheduleShare[]> & { data: ScheduleShare[] } {
  const viewAllApproved = !!opts?.viewAllApproved;
  // v1.1.108 — for the Schedule History page we need every share this
  // PC ever touched: rows we forwarded (no longer current), rows we
  // rejected (status=rejected), rows we approved that later got
  // forwarded onward, and rows still in flight further up the chain.
  // The default `visible()` filter is too narrow because it only
  // surfaces approved+chain rows. This option widens it to include
  // any share where the PC appears in chain_pc_ids OR in history[],
  // regardless of status.
  const includeHistoryParticipant = !!opts?.includeHistoryParticipant;
  const q = useQuery<ScheduleShare[]>({
    queryKey: [
      "xpc", "schedule", forPcId ?? "",
      viewAllApproved ? "all-approved" : (includeHistoryParticipant ? "history" : "mine"),
    ],
    queryFn: async () => {
      // Visibility rules (applied client-side so the same logic is used
      // for both Supabase and local-fallback paths):
      //   - Originator sees the share UNLESS they have dismissed it from
      //     their own view (originatorDismissedAt set).
      //   - Current holder always sees it (the ball is in their court).
      //   - Approved-chain visibility shows the share to every PC that
      //     touched the chain — but a PC that has rejected it in the past
      //     is excluded (we don't re-surface a stale rejected row when
      //     the originator later edits/resends/approves it).
      //   - viewAllApproved (Base / HQ): see every Wing-approved final
      //     regardless of chain membership. They never see drafts,
      //     rejected cycles, or in-flight forwards.
      const matcher = makePcMatcher(forPcId);
      const visible = (s: ScheduleShare): boolean => {
        if (viewAllApproved) {
          return isWingApprovedFinal(s);
        }
        if (!forPcId) return true;
        const isOrigin = s.originSquadronId === forPcId;
        const isCurrent = s.currentPcId === forPcId;
        const wasRejecter = (s.rejectedByPcIds ?? []).includes(forPcId);
        // v1.1.108 — Schedule History broadens visibility to every
        // share this PC participated in (chain member or history
        // actor) across all statuses, so the audit page can show
        // forwarded / rejected / in-flight rows that the default
        // "ball-in-my-court" filter would hide.
        if (includeHistoryParticipant) {
          if (isOrigin) return !s.originatorDismissedAt;
          if (isCurrent) return true;
          if ((s.chainPcIds ?? []).some(id => matcher(id))) return true;
          if ((s.history ?? []).some(h => matcher(h.by))) return true;
          if ((s.rejectedByPcIds ?? []).some(id => matcher(id))) return true;
          return false;
        }
        if (isOrigin) {
          if (s.originatorDismissedAt) return false;
          return true;
        }
        if (isCurrent) return true;
        if (s.status === "approved" && (s.chainPcIds ?? []).includes(forPcId) && !wasRejecter) {
          return true;
        }
        return false;
      };
      const localFallback = () => {
        return readShares()
          .filter(visible)
          .sort((a, b) => b.date.localeCompare(a.date));
      };
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcScheduleShares(
          viewAllApproved ? { status: "approved" } : undefined,
        );
        if (rows) return rows.map(rowToShare).filter(visible);
        return localFallback();
      }
      if (isLive()) {
        return await liveOrLocal(
          async () => {
            let qry = supabase!.from("xpc_schedule_shares").select("*").order("flight_date", { ascending: false });
            if (viewAllApproved) {
              // Base / HQ firehose: server-side narrow to status=approved.
              // The client-side `visible()` filter then keeps only the
              // Wing-signed finals (drops Sqn-only approvals).
              qry = qry.eq("status", "approved");
            } else if (forPcId) {
              // Server-side narrowing keeps payload small; the client-side
              // `visible()` filter then enforces the dismissal / rejecter
              // rules so the logic stays in one place.
              //
              // v1.1.101 — widen the OR clause with logical-seat LIKE
              // patterns + peer-squadron mirror (mirrors useMessages at
              // cross-pc.ts:2154-2160). Without this, a commander who
              // reinstalled Windows / cleared localStorage / moved to a
              // replacement PC got a NEW device suffix (#xyz → #abc) and
              // the strict eq filter silently dropped every share that
              // had been routed to the OLD suffix. At 15-20 squadrons
              // with 4-5 PCs per squadron, suffix drift becomes routine
              // (new AV install, clean reimage, SSD swap, etc) — the
              // logical-seat pattern keeps the inbox wired to the tier
              // role regardless of which physical PC is currently on
              // that desk. Stays in lock-step with the client-side
              // makePcMatcher so visible() agrees with what the server
              // returns on both paths (live + local fallback).
              const hashIdx = forPcId.indexOf("#");
              const logicalSeat = hashIdx < 0 ? null : forPcId.slice(0, hashIdx);
              const peerSquadronId = forPcId.startsWith("SQDNCMD:")
                ? forPcId.slice("SQDNCMD:".length)
                : (!forPcId.includes(":") ? `SQDNCMD:${forPcId}` : null);
              const orParts: string[] = [
                `current_pc_id.eq.${forPcId}`,
                `origin_squadron_id.eq.${forPcId}`,
                // For the Schedule History audit page, drop the
                // status=approved gate so chain participants see
                // rejected + in-flight + forwarded rows too.
                includeHistoryParticipant
                  ? `chain_pc_ids.cs.{${forPcId}}`
                  : `and(status.eq.approved,chain_pc_ids.cs.{${forPcId}})`,
              ];
              if (peerSquadronId !== null) {
                orParts.push(
                  `current_pc_id.eq.${peerSquadronId}`,
                  `origin_squadron_id.eq.${peerSquadronId}`,
                );
                if (includeHistoryParticipant) {
                  orParts.push(`chain_pc_ids.cs.{${peerSquadronId}}`);
                }
              }
              if (includeHistoryParticipant && logicalSeat !== null) {
                orParts.push(
                  `chain_pc_ids.cs.{${logicalSeat}}`,
                );
              }
              if (logicalSeat !== null) {
                orParts.push(
                  `current_pc_id.like.${logicalSeat}#*`,
                  `origin_squadron_id.like.${logicalSeat}#*`,
                  `current_pc_id.eq.${logicalSeat}`,
                  `origin_squadron_id.eq.${logicalSeat}`,
                );
              }
              qry = qry.or(orParts.join(","));
            }
            const { data, error } = await qry;
            if (error) throw error;
            return (data ?? []).map(rowToShare).filter(visible);
          },
          localFallback,
        );
      }
      return localFallback();
    },
    refetchInterval: 15_000,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<ScheduleShare[]> & { data: ScheduleShare[] };
}

export function useSubmitSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      date: string;
      originSquadronId: string;
      originSquadronName: string;
      rows: ScheduleRow[];
      // Wing PC that should review next.
      targetPcId: string;
      targetPcName: string;
      // Tier of the recipient. v1.1.63: schedule sharing is squadron-
      // internal only — the FlightProgram Submit dialog passes
      // "flight" or "squadron". Default falls back to "squadron"
      // (Ops PC tier) for any legacy caller that forgets to set it.
      targetTier?: ScheduleTier;
      submittedBy: string;
      // Task #137 — optional rich identity for the submitter so the
      // first history entry renders "Maj. Ahmad · Flight Cmdr" instead
      // of the bare auth username.
      submittedByDisplayName?: string;
      submittedByRank?: string;
      submittedBySeatLabel?: string;
      // Optional full sheet snapshot — when present the recipient
      // renders the same RJAF flight schedule paper, not a stripped
      // table. The legacy `rows` payload is still derived for the
      // existing diff machinery.
      program?: ScheduleProgram;
    }) => {
      const share: ScheduleShare = {
        id: genId("SCH"),
        date: input.date,
        originSquadronId: input.originSquadronId,
        originSquadronName: input.originSquadronName,
        currentTier: input.targetTier ?? "squadron",
        currentPcId: input.targetPcId,
        currentPcName: input.targetPcName,
        status: "submitted",
        rows: input.rows,
        baselineRows: input.rows,
        history: [{
          at: nowIso(),
          by: input.submittedBy,
          tier: "squadron",
          action: "submitted",
          note: `→ ${input.targetPcName}`,
          byDisplayName: input.submittedByDisplayName,
          byRank: input.submittedByRank,
          bySeatLabel: input.submittedBySeatLabel,
        }],
        program: input.program,
        chainPcIds: [input.originSquadronId, input.targetPcId],
      };
      if (isLanSessionLoginEnabled()) {
        const resp = await postInternalXpcScheduleShare(shareToRow(share));
        if (!resp.ok) throw new Error(resp.error);
      } else if (isLive()) {
        // RLS gate on xpc_schedule_shares.insert is
        // (origin_squadron_id = ANY (xpc_my_pc_ids())). Defensive
        // claim, same reasoning as useSendMessage.
        // v1.1.92: Previously the return value of ensureMyPcClaim was
        // ignored, so when auth.uid() wasn't ready (or the claim upsert
        // failed) the INSERT proceeded anyway and crashed with 42501
        // "new row violates row-level security policy". Treat a failed
        // claim as a hard precondition error with a user-actionable
        // message, BEFORE we let PostgREST hand back an unreadable
        // RLS code.
        if (!share.originSquadronId || share.originSquadronId === "self") {
          throw new Error(
            "Cannot submit: this PC has no registered squadron seat. " +
            "Sign out and sign back in, then try again."
          );
        }
        const claimed = await ensureMyPcClaim(share.originSquadronId);
        if (!claimed) {
          throw new Error(
            `Cannot submit: failed to claim PC seat "${share.originSquadronId}" ` +
            "for the current Supabase session. Check that you're signed in " +
            "(Settings → Account) and try again."
          );
        }
        const { error } = await supabase!.from("xpc_schedule_shares").insert(shareToRow(share));
        if (error) {
          // v1.1.92: same diagnostic envelope as useDecideSchedule —
          // dump auth state + intended row + full PostgREST error so
          // the next 42501 in the field is one console line away from
          // root cause instead of another guessing round.
          try {
            const { data: { session } } = await supabase!.auth.getSession();
            const uid = session?.user?.id ?? null;
            const { data: pcs } = await supabase!.from("xpc_user_pcs").select("pc_id").eq("user_id", uid ?? "");
            console.error("[xpc.schedule.submit] RLS/INSERT failure", {
              auth_uid: uid,
              session_email: session?.user?.email ?? null,
              owned_pc_ids: (pcs ?? []).map(p => p.pc_id),
              attempted_origin_pc: share.originSquadronId,
              attempted_target_pc: share.currentPcId,
              attempted_target_tier: share.currentTier,
              submitted_by: input.submittedBy,
              error_code: (error as { code?: string }).code,
              error_message: error.message,
              error_details: (error as { details?: string }).details,
              error_hint: (error as { hint?: string }).hint,
            });
          } catch (diagErr) {
            console.error("[xpc.schedule.submit] diagnostic itself failed", diagErr);
          }
          throw error;
        }
      } else {
        const all = readShares();
        all.push(share);
        writeShares(all);
      }
      await recordAuditEvent({
        type: "xpc.schedule.submitted",
        actor: input.submittedBy,
        detail: { id: share.id, target: input.targetPcName },
      });
      return share;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "schedule"] }),
  });
}

export function useDecideSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      action: "approve" | "reject" | "hold" | "edit" | "forward";
      by: string;
      // Task #137 — optional rich identity for the actor.
      byDisplayName?: string;
      byRank?: string;
      bySeatLabel?: string;
      tier: ScheduleTier;
      note?: string;
      // For action=forward: the next PC up the chain (wing → base).
      forwardPcId?: string;
      forwardPcName?: string;
      // For action=edit: revised rows; defaults to sending back to the originator.
      editedRows?: ScheduleRow[];
      // For action=edit on a full-sheet share: the revised RJAF program
      // snapshot. Mirrors editedRows but carries the whole paper so the
      // originator's diff dialog can show what changed in context.
      editedProgram?: ScheduleProgram;
    }) => {
      // Load current state (Supabase or local).
      let cur: ScheduleShare;
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcScheduleShareById(input.id);
        if (!data) throw new Error("Schedule not found");
        cur = rowToShare(data);
      } else if (isLive()) {
        const { data, error } = await supabase!.from("xpc_schedule_shares").select("*").eq("id", input.id).single();
        if (error) throw error;
        cur = rowToShare(data);
      } else {
        const all = readShares();
        const found = all.find(s => s.id === input.id);
        if (!found) throw new Error("Schedule not found");
        cur = { ...found };
      }

      const push = (action: ScheduleStatus, note?: string) =>
        cur.history.push({
          at: nowIso(),
          by: input.by,
          tier: input.tier,
          action,
          note,
          byDisplayName: input.byDisplayName,
          byRank: input.byRank,
          bySeatLabel: input.bySeatLabel,
        });

      if (input.action === "approve") {
        cur.status = "approved";
        cur.approvedAt = nowIso();
        cur.approvedBy = input.by;
        // Operator chose: once approved, the sheet becomes visible to
        // every PC that has touched the chain so far. The chainPcIds
        // already accumulates everyone (origin + each forward target);
        // we just guarantee both endpoints are present.
        const ids = new Set<string>(cur.chainPcIds ?? []);
        ids.add(cur.originSquadronId);
        if (cur.currentPcId) ids.add(cur.currentPcId);
        cur.chainPcIds = Array.from(ids);
        push("approved", input.note);
      } else if (input.action === "reject") {
        // Capture the rejecter's PC id BEFORE we bounce the share back to
        // the originator. Anyone in this list will never see this share
        // again — even if the originator later edits/resends/approves it.
        // Keeps rejecter inboxes from filling up with stale rows the
        // originator already actioned.
        if (cur.currentPcId) {
          const set = new Set<string>(cur.rejectedByPcIds ?? []);
          set.add(cur.currentPcId);
          cur.rejectedByPcIds = Array.from(set);
        }
        cur.status = "rejected";
        cur.currentPcId = cur.originSquadronId;
        cur.currentPcName = cur.originSquadronName;
        // v1.1.101 — derive tier from the originator's PC id prefix
        // instead of hard-coding "squadron". Otherwise a Flight Cmdr
        // (FLIGHT:...), Wing Cmdr (WING:...), or Base Cmdr (BASE:...)
        // origin sees the bounced sheet labelled with the wrong tier
        // badge, which cascades into the sidebar badge counts and the
        // Now-at indicator lying about who holds the ball.
        cur.currentTier = tierFromPcId(cur.originSquadronId);
        push("rejected", input.note);
      } else if (input.action === "hold") {
        cur.status = "held";
        push("held", input.note);
      } else if (input.action === "edit") {
        cur.status = "edited";
        cur.editedRows = input.editedRows ?? cur.rows;
        cur.editedProgram = input.editedProgram ?? cur.program;
        cur.editedBy = input.by;
        // Edits ALWAYS go back to the originator — the operator wants
        // to re-approve the change before it propagates further.
        // v1.1.101 — derive the returned-to tier from the origin PC id
        // prefix, NOT a hard-coded "squadron". When a Flight Cmdr,
        // Wing Cmdr, or Base Cmdr originated the share, returning edits
        // while mislabelling the tier made the bounce-back card render
        // with the wrong badge and (on some tiers) slip out of the
        // Incoming bucket entirely. The fix is tier-agnostic so the
        // same path works once we scale to 15-20 squadrons.
        cur.currentPcId = cur.originSquadronId;
        cur.currentPcName = cur.originSquadronName;
        cur.currentTier = tierFromPcId(cur.originSquadronId);
        push("edited", input.note ?? "edits returned to originator");
      } else if (input.action === "forward") {
        // v1.1.64 chain transitions:
        //   flight    → squadron   (Flight Cmdr returns to Sqn for review)
        //   squadron  → wing       (Sqn Cmdr submits up for Wing approval)
        //   squadron  ↔ flight     (Sqn Cmdr peer-shares back to Flight)
        // Wing-tier shares are never forwarded — Wing approves them
        // and the approval makes them visible to Base + HQ via the
        // canViewFinalSchedules / useScheduleShares viewAllApproved
        // path. Base / HQ are read-only viewers, never recipients of
        // an active forward.
        // v1.1.96 chain transitions per operator-stated contract (DOMAIN §7.1):
        //   flight    → squadron   (Flight Cmdr returns to Sqn for review)
        //   squadron  → wing       (Sqn Cmdr submits up for Wing approval)
        //   wing      → base       (Wing Cmdr forwards for final archive — NEW)
        // Wing approve WITHOUT a base forward also remains valid: it stores
        // for that day for that squadron (operator: "if the wing commander
        // didn't want to send it to the base commander, it's OK").
        // Base is the terminal tier — final archive is on Base.approve.
        // v1.1.98: when the forward target is a Flight PC (id starts
        // with "FLIGHT:"), this is a peer-share / ping-pong return —
        // NOT a chain advance. Used by:
        //   • Ops re-sending revised rows back to a specific Flight Cmdr
        //     after Flight bounced edits ("send it back to that specific
        //     flight commander", per operator).
        //   • Sqn Cmdr peer-sharing back down to Flight (squadron ↔ flight).
        // In all other cases the target is upchain and we advance the tier.
        const targetIsFlight = (input.forwardPcId ?? "").startsWith("FLIGHT:");
        if (targetIsFlight) {
          cur.currentTier = "flight";
        } else if (cur.currentTier === "flight") {
          cur.currentTier = "squadron";
        } else if (cur.currentTier === "squadron") {
          cur.currentTier = "wing";
        } else if (cur.currentTier === "wing") {
          cur.currentTier = "base";
        } else {
          throw new Error("Base tier is the final archive — there is no further forward step.");
        }
        cur.currentPcId = input.forwardPcId ?? null;
        cur.currentPcName = input.forwardPcName ?? null;
        // Peer-share back to Flight stays in "submitted" so the Flight
        // Cmdr's inbox treats it as a fresh action item (not as a
        // already-reviewed sheet just passing through).
        cur.status = targetIsFlight ? "submitted" : "reviewed";
        // Track every PC that has handled the share so the approve-time
        // visibility rule can include them.
        if (input.forwardPcId) {
          const ids = new Set<string>(cur.chainPcIds ?? []);
          ids.add(input.forwardPcId);
          cur.chainPcIds = Array.from(ids);
        }
        push("reviewed", `→ ${input.forwardPcName ?? ""}`);
      }

      if (isLanSessionLoginEnabled()) {
        const data = await patchInternalXpcScheduleShare(cur.id, shareToRow(cur));
        if (!data) throw new Error("Schedule update failed");
      } else if (isLive()) {
        const { error } = await supabase!.from("xpc_schedule_shares")
          .update(shareToRow(cur)).eq("id", cur.id);
        if (error) {
          // v1.1.91: hard-diagnose RLS 42501 in the wild. When the
          // Commander/Wing action throws, we want a single console
          // payload that tells us:
          //   - which user the browser thinks is logged in (auth.uid)
          //   - what pc_ids that user owns server-side
          //   - which row + which action was being attempted
          //   - the full Supabase error envelope
          // Without this, "new row violates RLS" is a black box and we
          // ship blind fixes that miss the real cause.
          try {
            const { data: { session } } = await supabase!.auth.getSession();
            const uid = session?.user?.id ?? null;
            const { data: pcs } = await supabase!.from("xpc_user_pcs").select("pc_id").eq("user_id", uid ?? "");
            console.error("[xpc.schedule.decide] RLS/UPDATE failure", {
              auth_uid: uid,
              session_email: session?.user?.email ?? null,
              owned_pc_ids: (pcs ?? []).map(p => p.pc_id),
              row_id: cur.id,
              row_origin_pc: cur.originSquadronId,
              row_current_pc: cur.currentPcId,
              row_current_tier: cur.currentTier,
              attempted_action: input.action,
              attempted_by: input.by,
              error_code: (error as { code?: string }).code,
              error_message: error.message,
              error_details: (error as { details?: string }).details,
              error_hint: (error as { hint?: string }).hint,
            });
          } catch (diagErr) {
            console.error("[xpc.schedule.decide] diagnostic itself failed", diagErr);
          }
          throw error;
        }
      } else {
        const all = readShares();
        const idx = all.findIndex(s => s.id === cur.id);
        if (idx >= 0) all[idx] = cur;
        writeShares(all);
      }
      await recordAuditEvent({
        type: `xpc.schedule.${input.action}`,
        actor: input.by,
        detail: { id: cur.id, tier: input.tier },
      });
      return cur;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "schedule"] }),
  });
}

// Originator-side "Delete from my view" — flips the originator-dismissed
// flag on the share so it disappears from the originating PC's screen
// only. Every other PC that received, reviewed, edited or approved the
// share keeps its copy untouched and the central audit trail is fully
// preserved. Strictly a per-creator hide, never a system-wide delete.
// v1.1.60: hard-delete a schedule share. Removes the row from
// xpc_schedule_shares so it disappears from EVERY PC (originator,
// chain holders, downstream reviewers). RLS (migration 0029) permits
// any participating PC to delete — same authority model as
// reject/edit/forward elsewhere in the chain. Strong confirm in the
// UI gates accidental clicks.
export function useDeleteScheduleShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      if (isLanSessionLoginEnabled()) {
        const resp = await deleteInternalXpcScheduleShare(input.id);
        if (!resp.ok) throw new Error(resp.error);
      } else if (isLive()) {
        const { error } = await supabase!
          .from("xpc_schedule_shares")
          .delete()
          .eq("id", input.id);
        if (error) throw error;
      } else {
        const all = readShares().filter(s => s.id !== input.id);
        writeShares(all);
      }
      return { id: input.id };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "schedule"] }),
  });
}

export function useDismissScheduleShareForOriginator() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      let cur: ScheduleShare;
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcScheduleShareById(input.id);
        if (!data) throw new Error("Schedule not found");
        cur = rowToShare(data);
      } else if (isLive()) {
        const { data, error } = await supabase!.from("xpc_schedule_shares").select("*").eq("id", input.id).single();
        if (error) throw error;
        cur = rowToShare(data);
      } else {
        const all = readShares();
        const found = all.find(s => s.id === input.id);
        if (!found) throw new Error("Schedule not found");
        cur = { ...found };
      }
      cur.originatorDismissedAt = nowIso();
      if (isLanSessionLoginEnabled()) {
        const data = await patchInternalXpcScheduleShare(cur.id, shareToRow(cur));
        if (!data) throw new Error("Schedule update failed");
      } else if (isLive()) {
        const { error } = await supabase!.from("xpc_schedule_shares")
          .update(shareToRow(cur)).eq("id", cur.id);
        if (error) throw error;
      } else {
        const all = readShares();
        const idx = all.findIndex(s => s.id === cur.id);
        if (idx >= 0) all[idx] = cur;
        writeShares(all);
      }
      return cur;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "schedule"] }),
  });
}

// Originator-side accept of the diff: replaces `rows` with `editedRows`.
export function useAcceptScheduleEdit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      by: string;
      byDisplayName?: string;
      byRank?: string;
      bySeatLabel?: string;
    }) => {
      let cur: ScheduleShare;
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcScheduleShareById(input.id);
        if (!data) throw new Error("Schedule not found");
        cur = rowToShare(data);
      } else if (isLive()) {
        const { data, error } = await supabase!.from("xpc_schedule_shares").select("*").eq("id", input.id).single();
        if (error) throw error;
        cur = rowToShare(data);
      } else {
        const all = readShares();
        const found = all.find(s => s.id === input.id);
        if (!found) throw new Error("Schedule not found");
        cur = { ...found };
      }
      if (!cur.editedRows && !cur.editedProgram) return cur;
      if (cur.editedRows) {
        cur.rows = cur.editedRows;
        cur.baselineRows = cur.editedRows;
      }
      if (cur.editedProgram) {
        cur.program = cur.editedProgram;
      }
      cur.editedProgram = undefined;
      cur.editedRows = undefined;
      cur.status = "approved";
      cur.history.push({
        at: nowIso(),
        by: input.by,
        tier: "squadron",
        action: "approved",
        note: "originator accepted edits",
        byDisplayName: input.byDisplayName,
        byRank: input.byRank,
        bySeatLabel: input.bySeatLabel,
      });
      if (isLanSessionLoginEnabled()) {
        const data = await patchInternalXpcScheduleShare(cur.id, shareToRow(cur));
        if (!data) throw new Error("Schedule update failed");
      } else if (isLive()) {
        const { error } = await supabase!.from("xpc_schedule_shares")
          .update(shareToRow(cur)).eq("id", cur.id);
        if (error) throw error;
      } else {
        const all = readShares();
        const idx = all.findIndex(s => s.id === cur.id);
        if (idx >= 0) all[idx] = cur;
        writeShares(all);
      }
      await recordAuditEvent({ type: "xpc.schedule.edits.accepted", actor: input.by, detail: { id: cur.id } });
      return cur;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "schedule"] }),
  });
}

// Diff helper used by the schedule review UI. Returns per-row classification
// against a baseline so the on-screen view can highlight added / changed /
// removed rows. The print stylesheet strips these classes so paper output
// is always clean.
export type DiffKind = "added" | "removed" | "changed" | "same";
export interface RowDiff {
  kind: DiffKind;
  next?: ScheduleRow;
  prev?: ScheduleRow;
  changedFields?: Array<keyof ScheduleRow>;
}
export function diffSchedule(prev: ScheduleRow[], next: ScheduleRow[]): RowDiff[] {
  const out: RowDiff[] = [];
  const prevById = new Map(prev.map(r => [r.id, r]));
  const nextById = new Map(next.map(r => [r.id, r]));
  for (const n of next) {
    const p = prevById.get(n.id);
    if (!p) { out.push({ kind: "added", next: n }); continue; }
    const changed: Array<keyof ScheduleRow> = [];
    (Object.keys(n) as Array<keyof ScheduleRow>).forEach(k => {
      const a = JSON.stringify(p[k]); const b = JSON.stringify(n[k]);
      if (a !== b) changed.push(k);
    });
    out.push({ kind: changed.length ? "changed" : "same", next: n, prev: p, changedFields: changed });
  }
  for (const p of prev) {
    if (!nextById.has(p.id)) out.push({ kind: "removed", prev: p });
  }
  return out;
}

// ── 4. Private messages (Sqn / Wing / Base only) ────────────────────────
//
// Bidirectional thread model. Flight Cmdr is excluded; Ops Pilot is
// excluded entirely (no UI on those PCs at all). Reply or mark-read moves
// the message into the recipient's history. Auto-delete is configurable
// with a hard ceiling of 50 days. Text only — no attachments.
const MESSAGES_KEY = "rjaf.xpc.messages";
const MESSAGE_RETENTION_KEY = "rjaf.xpc.messages.retention";
export const MESSAGE_RETENTION_MAX_DAYS = 50;

export type MessagePriority = "normal" | "medium" | "urgent";
export type MessageTier = "flight" | "squadron" | "wing" | "base";

export interface PrivateMessage {
  id: string;
  threadId: string;            // groups replies into a thread
  fromPcId: string;
  fromPcName: string;
  fromTier: MessageTier;
  fromUser: string;
  // Task #137 — rich sender identity. All optional so legacy rows
  // (written before migration 0039) still parse; the renderer falls
  // back to fromUser/fromPcName when these are absent.
  fromDisplayName?: string;
  fromRank?: string;
  fromSeatLabel?: string;
  toPcId: string;
  toPcName: string;
  toTier: MessageTier;
  subject: string;
  body: string;
  priority: MessagePriority;
  sentAt: string;
  readAt?: string;
  // Once replied-to or explicitly marked read, the message moves to the
  // recipient's history view instead of their unread inbox.
  inHistory: boolean;
}

function readMessages(): PrivateMessage[] {
  return readJSON<PrivateMessage[]>(MESSAGES_KEY, []);
}
function writeMessages(rows: PrivateMessage[]) {
  writeJSON(MESSAGES_KEY, rows);
}

function rowToMessage(r: Record<string, unknown>): PrivateMessage {
  // Recover the flight tier from the id prefix — the DB CHECK constraint
  // doesn't allow 'flight' as a tier value yet, so flight PCs persist
  // their messages with tier='squadron' and we fix that up here.
  const fromPcId = String(r.from_pc_id);
  const toPcId   = String(r.to_pc_id);
  const fromTier: MessageTier = fromPcId.startsWith("FLIGHT:") ? "flight" : (r.from_tier as MessageTier);
  const toTier:   MessageTier = toPcId.startsWith("FLIGHT:")   ? "flight" : (r.to_tier as MessageTier);
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    fromPcId,
    fromPcName: String(r.from_pc_name),
    fromTier,
    fromUser: String(r.from_user),
    fromDisplayName: r.from_display_name ? String(r.from_display_name) : undefined,
    fromRank:        r.from_rank         ? String(r.from_rank)         : undefined,
    fromSeatLabel:   r.from_seat_label   ? String(r.from_seat_label)   : undefined,
    toPcId,
    toPcName: String(r.to_pc_name),
    toTier,
    subject: String(r.subject),
    body: String(r.body),
    priority: r.priority as MessagePriority,
    sentAt: String(r.sent_at),
    readAt: r.read_at ? String(r.read_at) : undefined,
    inHistory: Boolean(r.in_history),
  };
}

function messageToRow(m: PrivateMessage): Record<string, unknown> {
  // The xpc_messages tier CHECK constraint pre-dates the flight tier;
  // downgrade to 'squadron' on the wire and let rowToMessage recover
  // the true tier from the FLIGHT: id prefix on read.
  const fromTierDb = m.fromTier === "flight" ? "squadron" : m.fromTier;
  const toTierDb   = m.toTier   === "flight" ? "squadron" : m.toTier;
  return {
    id: m.id,
    thread_id: m.threadId,
    from_pc_id: m.fromPcId,
    from_pc_name: m.fromPcName,
    from_tier: fromTierDb,
    from_user: m.fromUser,
    from_display_name: m.fromDisplayName ?? null,
    from_rank:         m.fromRank         ?? null,
    from_seat_label:   m.fromSeatLabel    ?? null,
    to_pc_id: m.toPcId,
    to_pc_name: m.toPcName,
    to_tier: toTierDb,
    subject: m.subject,
    body: m.body,
    priority: m.priority,
    sent_at: m.sentAt,
    read_at: m.readAt ?? null,
    in_history: m.inHistory,
  };
}

export function getMessageRetentionDays(): number {
  const raw = localStorage.getItem(MESSAGE_RETENTION_KEY);
  const n = raw ? Number(raw) : 30;
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(MESSAGE_RETENTION_MAX_DAYS, Math.floor(n));
}
export function setMessageRetentionDays(days: number) {
  const clamped = Math.min(MESSAGE_RETENTION_MAX_DAYS, Math.max(1, Math.floor(days)));
  localStorage.setItem(MESSAGE_RETENTION_KEY, String(clamped));
}

// Auto-purge messages older than the configured retention window. Called
// implicitly on every read; safe to call repeatedly.
//
// At 100+ PCs polling messages every ~10s, an unconditional remote DELETE
// on every fetch fires ~10 deletes/sec against `xpc_messages` even when
// nothing has expired. We throttle the remote delete to once per hour per
// browser session so the purge stays effectively maintenance-only at
// scale; the local localStorage purge still runs on every call so the
// PC's own UI doesn't keep stale entries around.
let lastRemotePurgeAt = 0;
const REMOTE_PURGE_INTERVAL_MS = 60 * 60 * 1000;
export function purgeExpiredMessages(): void {
  try {
    const rows = readMessages();
    const kept = purgeExpiredLocal(rows);
    if (kept.length !== rows.length) writeMessages(kept);
  } catch { /* localStorage may be unavailable in SSR/tests */ }
  if (isLive()) {
    const now = Date.now();
    if (now - lastRemotePurgeAt < REMOTE_PURGE_INTERVAL_MS) return;
    lastRemotePurgeAt = now;
    const days = getMessageRetentionDays();
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    void supabase!.from("xpc_messages").delete().lt("sent_at", cutoff);
  }
}

function purgeExpiredLocal(rows: PrivateMessage[]): PrivateMessage[] {
  const days = getMessageRetentionDays();
  const cutoff = Date.now() - days * 86_400_000;
  return rows.filter(m => new Date(m.sentAt).getTime() >= cutoff);
}

// v1.1.56: extracted from useMessages so ScheduleChain.tsx can share the
// exact same matcher. Two copies of this logic existed (here and in
// ScheduleChain.tsx) and any future tweak to one would silently diverge
// from the other — so a flight commander's message inbox and schedule
// inbox could disagree about which incoming items belong to them.
//
// The matcher is a pure function of `forPcId` and accepts the candidate
// id; it folds three identity rules into one predicate:
//
//   1. Exact match on the registry id.
//   2. Ops PC <-> Squadron Cmdr peer match — "<sqn>" and "SQDNCMD:<sqn>"
//      address the same logical seat for inbound mail/shares.
//   3. Logical-seat match — any tier-prefixed id (FLIGHT:, SQDNCMD:,
//      WING:, BASE:, HQ:) carries a "#<deviceSuffix>" tail that
//      regenerates if localStorage is wiped (reimage, browser cache
//      flush, fresh install). Compare on the prefix so the same seat
//      keeps catching its own mail across suffix changes.
export function makePcMatcher(
  forPcId: string | null | undefined,
): (id: string | null | undefined) => boolean {
  if (!forPcId) return () => false;
  const hashIdx = forPcId.indexOf("#");
  const logicalSeat = hashIdx < 0 ? null : forPcId.slice(0, hashIdx);
  const peerSquadronId = forPcId.startsWith("SQDNCMD:")
    ? forPcId.slice("SQDNCMD:".length)
    : (!forPcId.includes(":") ? `SQDNCMD:${forPcId}` : null);
  return (id: string | null | undefined): boolean => {
    if (!id) return false;
    if (id === forPcId) return true;
    if (peerSquadronId !== null && id === peerSquadronId) return true;
    if (logicalSeat !== null) {
      const i = id.indexOf("#");
      const otherSeat = i < 0 ? id : id.slice(0, i);
      if (otherSeat === logicalSeat) return true;
    }
    return false;
  };
}

export function useMessages(forPcId: string | null): {
  inbox: PrivateMessage[]; sent: PrivateMessage[]; history: PrivateMessage[];
} & UseQueryResult<PrivateMessage[]> {
  const matchesMe = makePcMatcher(forPcId);
  // Server-side OR-clause inputs — derived the same way makePcMatcher
  // does so the live PostgREST query and the client-side matcher stay
  // in lock-step (any drift would surface as messages visible in the
  // local fallback path but missing from the live path or vice versa).
  const logicalSeat = (() => {
    if (!forPcId) return null;
    const i = forPcId.indexOf("#");
    return i < 0 ? null : forPcId.slice(0, i);
  })();
  const peerSquadronId = (() => {
    if (!forPcId) return null;
    if (forPcId.startsWith("SQDNCMD:")) return forPcId.slice("SQDNCMD:".length);
    if (!forPcId.includes(":")) return `SQDNCMD:${forPcId}`;
    return null;
  })();
  const q = useQuery<PrivateMessage[]>({
    queryKey: ["xpc", "messages", forPcId ?? ""],
    queryFn: async () => {
      if (!forPcId) return [];
      const localFallback = () => {
        const purged = purgeExpiredLocal(readMessages());
        writeMessages(purged);
        return purged
          .filter(m => matchesMe(m.fromPcId) || matchesMe(m.toPcId))
          .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
      };
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcMessages(forPcId, getMessageRetentionDays());
        if (rows) {
          return rows.map(rowToMessage);
        }
        return localFallback();
      }
      if (isLive()) {
        return await liveOrLocal(
          async () => {
            const days = getMessageRetentionDays();
            const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
            // Build an OR clause that covers strict id, peer-squadron
            // mirror, and tier-prefix LIKE patterns. Supabase's PostgREST
            // OR syntax requires comma-separated filters with no spaces.
            const orParts: string[] = [
              `from_pc_id.eq.${forPcId}`,
              `to_pc_id.eq.${forPcId}`,
            ];
            if (peerSquadronId !== null) {
              orParts.push(`from_pc_id.eq.${peerSquadronId}`, `to_pc_id.eq.${peerSquadronId}`);
            }
            if (logicalSeat !== null) {
              orParts.push(
                `from_pc_id.like.${logicalSeat}#*`,
                `to_pc_id.like.${logicalSeat}#*`,
                `from_pc_id.eq.${logicalSeat}`,
                `to_pc_id.eq.${logicalSeat}`,
              );
            }
            const { data, error } = await supabase!
              .from("xpc_messages")
              .select("*")
              .or(orParts.join(","))
              .gte("sent_at", cutoff)
              .order("sent_at", { ascending: false });
            if (error) throw error;
            return (data ?? []).map(rowToMessage);
          },
          localFallback,
        );
      }
      return localFallback();
    },
    refetchInterval: 15_000,
    retry: isLive() ? 1 : false,
  });
  const all = q.data ?? [];
  return {
    ...q,
    inbox: all.filter(m => matchesMe(m.toPcId) && !m.inHistory),
    sent: all.filter(m => matchesMe(m.fromPcId)),
    history: all.filter(m => matchesMe(m.toPcId) && m.inHistory),
  } as ReturnType<typeof useMessages>;
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PrivateMessage, "id" | "sentAt" | "inHistory" | "threadId"> & { threadId?: string }) => {
      const msg: PrivateMessage = {
        ...input,
        id: genId("MSG"),
        threadId: input.threadId ?? genId("THR"),
        sentAt: nowIso(),
        inHistory: false,
      };
      if (isLanSessionLoginEnabled()) {
        const resp = await postInternalXpcMessage(messageToRow(msg));
        if (!resp.ok) throw new Error(resp.error);
      } else if (isLive()) {
        // RLS gate: every xpc_messages.insert requires from_pc_id to
        // appear in xpc_my_pc_ids() for the signed-in user. Without
        // this defensive claim, a heartbeat that hasn't yet completed
        // its first upsert will yield code 42501 ("row violates
        // row-level security policy for table xpc_messages") on the
        // very first send.
        await ensureMyPcClaim(msg.fromPcId);
        const { error } = await supabase!.from("xpc_messages").insert(messageToRow(msg));
        if (error) throw error;
      } else {
        const all = readMessages();
        all.push(msg);
        writeMessages(all);
      }
      await recordAuditEvent({
        type: "xpc.message.sent",
        actor: input.fromUser,
        detail: { id: msg.id, to: input.toPcName, priority: input.priority },
      });
      return msg;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "messages"] }),
  });
}

export function useMarkMessageRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string }) => {
      const readAt = nowIso();
      if (isLanSessionLoginEnabled()) {
        const data = await postInternalXpcMessageRead(input.id);
        return data ? rowToMessage(data) : null;
      }
      if (isLive()) {
        const { data, error } = await supabase!.from("xpc_messages")
          .update({ read_at: readAt, in_history: true })
          .eq("id", input.id).select().single();
        if (error) throw error;
        return data ? rowToMessage(data) : null;
      }
      const all = readMessages();
      const idx = all.findIndex(m => m.id === input.id);
      if (idx < 0) return null;
      all[idx] = { ...all[idx], readAt, inHistory: true };
      writeMessages(all);
      return all[idx];
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["xpc", "messages"] }),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Squadron daily snapshot (xpc_squadron_snapshot) — v1.1.26
// ──────────────────────────────────────────────────────────────────────
// Each squadron's canonical Ops PC publishes a tiny daily picture of
// its roster + unavailable list to xpc_squadron_snapshot. Wing / Base /
// HQ commanders subscribe per-squadron and render that picture inside
// the squadron drill-down so they can see who's grounded today, who's
// on leave, and the headline roster — without phoning the squadron.
//
// RLS: only the canonical Ops PC for a squadron may UPSERT its own row
// (ops_pc_id = squadron_id AND ops_pc_id ∈ xpc_my_pc_ids()). Any
// authenticated user may SELECT.
export interface SquadronSnapshotPilot {
  id: string;
  callSign: string;
  name: string;
  flightName?: string | null;
  rank?: string | null;
  expDay?: string | null;
  expNight?: string | null;
  expNvg?: string | null;
  expIrt?: string | null;
  expMedical?: string | null;
  // Round 4 AA3 / #268 — lifetime hour totals carried in the payload so
  // wing/base/HQ commander rollups can show real hours instead of "0h".
  // Optional so legacy snapshots (published by pre-AA3 dashboards)
  // still parse — `adaptSnapshotPilot` defaults missing fields to 0.
  dayHours?: number | null;
  nightHours?: number | null;
  nvgHours?: number | null;
  simHours?: number | null;
  captainHours?: number | null;
}
export interface SquadronSnapshotUnavail {
  id: string;
  pilotId: string;
  pilotName: string;
  from: string;
  to: string;
  reason: string;
}
export interface SquadronSnapshotPayload {
  roster: SquadronSnapshotPilot[];
  unavailable: SquadronSnapshotUnavail[];
  counts: { pilots: number; unavailToday: number; expired: number; expiringSoon: number };
}
export interface SquadronSnapshotRow {
  squadronId: string;
  opsPcId: string;
  snapshotAt: string;
  payload: SquadronSnapshotPayload;
}

export async function publishSquadronSnapshot(
  squadronId: string,
  payload: SquadronSnapshotPayload,
): Promise<void> {
  if (!squadronId) return;
  // Only the canonical Ops PC for this squadron is allowed to publish.
  const myId = getLocalPcId();
  if (myId !== squadronId) return;
  const row = {
    squadron_id: squadronId,
    ops_pc_id: squadronId,
    snapshot_at: nowIso(),
    payload: payload as unknown as Record<string, unknown>,
  };
  if (isLanSessionLoginEnabled()) {
    const resp = await postInternalXpcSnapshot(row);
    if (!resp.ok) {
      void recordAuditEvent({
        type: "xpc.squadron.snapshot.publish.error",
        actor: squadronId,
        detail: { message: resp.error },
      });
    }
    return;
  }
  if (!isLive() || !supabase) return;
  const { error } = await supabase
    .from("xpc_squadron_snapshot")
    .upsert(row, { onConflict: "squadron_id" });
  if (error) {
    // Silent — re-runs on the next tick.
    void recordAuditEvent({
      type: "xpc.squadron.snapshot.publish.error",
      actor: squadronId,
      detail: { message: error.message },
    });
  }
}

export function useSquadronSnapshot(
  squadronId: string | null | undefined,
): UseQueryResult<SquadronSnapshotRow | null> & { data: SquadronSnapshotRow | null } {
  const enabled = (isLive() || isLanSessionLoginEnabled()) && !!squadronId;
  const q = useQuery<SquadronSnapshotRow | null>({
    queryKey: ["xpc", "squadron-snapshot", squadronId ?? "_"],
    queryFn: async () => {
      if (!squadronId) return null;
      if (isLanSessionLoginEnabled()) {
        const items = await fetchInternalXpcSnapshots({ squadronId });
        if (!items || items.length === 0) return null;
        const data = items[0];
        return {
          squadronId: String(data.squadron_id ?? ""),
          opsPcId: String(data.ops_pc_id ?? ""),
          snapshotAt: String(data.snapshot_at ?? ""),
          payload: (data.payload ?? { roster: [], unavailable: [], counts: { pilots: 0, unavailToday: 0, expired: 0, expiringSoon: 0 } }) as SquadronSnapshotPayload,
        };
      }
      if (!isLive() || !supabase) return null;
      const { data, error } = await supabase
        .from("xpc_squadron_snapshot")
        .select("squadron_id, ops_pc_id, snapshot_at, payload")
        .eq("squadron_id", squadronId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        squadronId: String(data.squadron_id),
        opsPcId: String(data.ops_pc_id),
        snapshotAt: String(data.snapshot_at),
        payload: (data.payload ?? { roster: [], unavailable: [], counts: { pilots: 0, unavailToday: 0, expired: 0, expiringSoon: 0 } }) as SquadronSnapshotPayload,
      };
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? null } as UseQueryResult<SquadronSnapshotRow | null> & { data: SquadronSnapshotRow | null };
}

// ──────────────────────────────────────────────────────────────────────
// Multi-squadron commander empty-state probe (audit finding F-B-01).
// ──────────────────────────────────────────────────────────────────────
// Wing / Base / HQ commanders have `squadron_id = NULL` in their JWT,
// so RLS on `pilots` / `sorties` returns zero rows for them by design.
// Their dashboard is meant to consume aggregated reads from
// xpc_squadron_snapshot. Without this hook the UI cannot tell a
// freshly provisioned commander whether their dashboard is empty
// because (a) no squadron PC has registered yet, (b) one has
// registered but never published, (c) the latest snapshot is stale,
// or (d) the snapshot rosters are genuinely empty — they all look
// identical to the operator (a blank page).
//
// This hook returns the inputs the pure `computeCommanderEmptyState`
// reasoner needs to classify the cause. The UI side then renders the
// matching explainer copy via `<CommanderEmptyState>`.
//
// Reads two cross-tenant tables (both broadly readable per
// migration 0024 / the snapshot RLS comment):
//   • xpc_registry            — count squadron-tier rows
//   • xpc_squadron_snapshot   — pull (squadron_id, snapshot_at,
//                               payload.counts.pilots) for every row
//
// In demo mode (no Supabase) we surface the local registry mirror but
// no snapshots — the empty-state classifier will say "no_snapshots"
// or "no_registry", which is honest for that mode.
export interface CommanderSnapshotProbe {
  registeredSquadronCount: number;
  snapshots: Array<{
    squadronId: string;
    snapshotAt: string;
    pilotCount: number;
  }>;
  isLoading: boolean;
}

export function useCommanderSnapshotProbe(opts: {
  enabled: boolean;
}): CommanderSnapshotProbe {
  const enabled = !!opts.enabled;

  // Squadron-tier registry rows, used to distinguish "no PC online"
  // from "PC online but never published". We re-use the same registry
  // poll cadence (30s staleTime) the rest of the app uses.
  const regQ = useQuery<number>({
    queryKey: ["xpc", "commander-empty", "registry-count"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const rows = await fetchInternalXpcRegistryRows({ includeStale: true, staleHours: 24 });
        if (!rows) return 0;
        return rows.filter((r) => String(r.tier ?? "") === "squadron").length;
      }
      if (!isLive() || !supabase) {
        // Fall back to the localStorage mirror so the demo / offline
        // preview shows a sensible answer rather than always
        // "no_registry".
        try {
          const rows = readRegistry();
          return rows.filter(r => r.tier === "squadron").length;
        } catch {
          return 0;
        }
      }
      const { count, error } = await supabase
        .from("xpc_registry")
        .select("id", { count: "exact", head: true })
        .eq("tier", "squadron");
      if (error) return 0;
      return count ?? 0;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: isLive() ? 1 : false,
  });

  const snapQ = useQuery<CommanderSnapshotProbe["snapshots"]>({
    queryKey: ["xpc", "commander-empty", "snapshots"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcSnapshots();
        if (!Array.isArray(data)) return [];
        return data.map((row) => {
          const r = row as {
            squadron_id: unknown;
            snapshot_at: unknown;
            payload?: { counts?: { pilots?: unknown } } | null;
          };
          const pilots = Number(r.payload?.counts?.pilots ?? 0);
          return {
            squadronId: String(r.squadron_id ?? ""),
            snapshotAt: String(r.snapshot_at ?? ""),
            pilotCount: Number.isFinite(pilots) ? pilots : 0,
          };
        });
      }
      if (!isLive() || !supabase) return [];
      const { data, error } = await supabase
        .from("xpc_squadron_snapshot")
        .select("squadron_id, snapshot_at, payload");
      if (error || !Array.isArray(data)) return [];
      return data.map(row => {
        const r = row as {
          squadron_id: unknown;
          snapshot_at: unknown;
          payload?: { counts?: { pilots?: unknown } } | null;
        };
        const pilots = Number(r.payload?.counts?.pilots ?? 0);
        return {
          squadronId: String(r.squadron_id ?? ""),
          snapshotAt: String(r.snapshot_at ?? ""),
          pilotCount: Number.isFinite(pilots) ? pilots : 0,
        };
      });
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: isLive() ? 1 : false,
  });

  return {
    registeredSquadronCount: regQ.data ?? 0,
    snapshots: snapQ.data ?? [],
    isLoading: regQ.isLoading || snapQ.isLoading,
  };
}

// ──────────────────────────────────────────────────────────────────────
// All-snapshots fetch — Round 3 O Part B (audit J F-J-03/04).
// ──────────────────────────────────────────────────────────────────────
// `useSquadronSnapshot` reads ONE squadron's snapshot at a time (used by
// the squadron drill-down). Wing / Base / HQ commanders need the rollup
// view: every snapshot row their JWT is allowed to read, which is what
// 0056_snapshot_rls_lockdown.sql restricts SELECT to.
//
// Returns the full row including payload so the dashboard can render
// rollup pilot lists (PilotsTable, Currencies, Alerts) directly from
// snapshots without any local DB rows. The query is enabled only when
// requested by the caller — squadron-tier ops PCs don't need this and
// would just churn quota.
export function useAllSquadronSnapshots(opts: {
  enabled: boolean;
}): UseQueryResult<SquadronSnapshotRow[]> & { data: SquadronSnapshotRow[] } {
  const enabled = !!opts.enabled && (isLive() || isLanSessionLoginEnabled());
  const q = useQuery<SquadronSnapshotRow[]>({
    queryKey: ["xpc", "squadron-snapshot", "all"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const data = await fetchInternalXpcSnapshots();
        if (!Array.isArray(data)) return [];
        return data.map(row => {
          const r = row as {
            squadron_id: unknown;
            ops_pc_id: unknown;
            snapshot_at: unknown;
            payload?: Record<string, unknown> | null;
          };
          const payload = (r.payload ?? {
            roster: [],
            unavailable: [],
            counts: { pilots: 0, unavailToday: 0, expired: 0, expiringSoon: 0 },
          }) as unknown as SquadronSnapshotPayload;
          return {
            squadronId: String(r.squadron_id ?? ""),
            opsPcId: String(r.ops_pc_id ?? ""),
            snapshotAt: String(r.snapshot_at ?? ""),
            payload,
          } as SquadronSnapshotRow;
        });
      }
      if (!isLive() || !supabase) return [];
      const { data, error } = await supabase
        .from("xpc_squadron_snapshot")
        .select("squadron_id, ops_pc_id, snapshot_at, payload");
      if (error || !Array.isArray(data)) return [];
      return data.map(row => {
        const r = row as {
          squadron_id: unknown;
          ops_pc_id: unknown;
          snapshot_at: unknown;
          payload?: Record<string, unknown> | null;
        };
        const payload = (r.payload ?? {
          roster: [],
          unavailable: [],
          counts: { pilots: 0, unavailToday: 0, expired: 0, expiringSoon: 0 },
        }) as unknown as SquadronSnapshotPayload;
        return {
          squadronId: String(r.squadron_id ?? ""),
          opsPcId: String(r.ops_pc_id ?? ""),
          snapshotAt: String(r.snapshot_at ?? ""),
          payload,
        } as SquadronSnapshotRow;
      });
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: isLive() ? 1 : false,
  });
  return { ...q, data: q.data ?? [] } as UseQueryResult<SquadronSnapshotRow[]> & { data: SquadronSnapshotRow[] };
}

// Role helper: which roles are allowed to use the messages UI at all.
// Commanders (Flight / Squadron / Wing / Base) AND the squadron Ops
// Pilot. v1.1.58: Ops is included because in the live deployment the
// Ops PC is the squadron's always-on desk and routinely receives
// messages addressed to the squadron — without the inbox UI the
// operator could see notifications arriving but had no way to open or
// reply to them. Deputies remain excluded.
export function canUseMessages(role: string | undefined, scope: string | undefined): boolean {
  if (role === "super_admin") return true;
  if (role === "ops") return true;
  if (role === "commander") {
    return scope === "flight" || scope === "squadron" || scope === "wing" || scope === "base";
  }
  return false;
}

// Role helper: which roles see the schedule chain / flight program UI.
//
// v1.1.64 — final scope per design owner:
//
// AUTHORING (compose, edit, peer-share within the squadron):
//   Flight Cmdr  ⇄ Squadron Cmdr   (peer + approve/reject)
//   Flight Cmdr  ⇄ Ops Pilot
//   Squadron Cmdr ⇄ Ops Pilot
//
// APPROVAL UP THE CHAIN:
//   Squadron Cmdr → Wing Cmdr      (Wing reviews + Approve/Reject)
//
// DOWNSTREAM DISTRIBUTION (read-only, sorted per squadron):
//   Wing-approved final → Base Cmdr + HQ Cmdr
//   Base + HQ get a separate clean read-only page (FinalSchedules);
//   they never see in-flight drafts, never see rejected/edited cycles,
//   and never act on a schedule. They see only what Wing has signed
//   off as the final flying programme for that day.
//
// canUseScheduleChain controls who sees the active /schedule-chain
// review page. Base + HQ are NOT here — they have their own
// /final-schedules page (see canViewFinalSchedules below).
export function canUseScheduleChain(role: string | undefined, scope: string | undefined): boolean {
  if (role === "super_admin") return true;
  if (role === "ops") return true; // Ops Pilot's PC — squadron-tier peer
  if (role === "commander") {
    return scope === "flight" || scope === "squadron" || scope === "wing";
  }
  return false;
}

/**
 * Wipe every registered PC from the central registry + the local mirror.
 *
 * Used when redeploying the same APK install to a different squadron
 * (e.g. NO.8 → NO.5): the prior squadron's PCs survive in the
 * central xpc_registry table and in this PC's localStorage mirror,
 * leaking into every picker (Schedule Chain, Messages, License Keys
 * commander targets, ...) for up to 24h until the auto-prune runs.
 *
 * Behaviour
 * ─────────
 *  • Wipes the local `rjaf.xpc.registry` mirror outright.
 *  • DELETEs every row from the central `xpc_registry` table, except
 *    the row belonging to THIS PC (so the operator clicking the button
 *    is not silently signed out of the chain). Pass
 *    `{ includeSelf: true }` to wipe self too.
 *  • DELETEs the matching `xpc_user_pcs` claim rows so a re-register
 *    on the same auth.uid does not collide with an orphan claim.
 *  • Best-effort: a failure on either delete is reported but does NOT
 *    throw, so the local mirror is always cleared.
 *
 * Returns a summary `{ removedLocal, removedCentral, errors }`.
 */
export async function wipeAllRegisteredPCs(
  opts: { includeSelf?: boolean } = {},
): Promise<{ removedLocal: number; removedCentral: number; errors: string[] }> {
  const errors: string[] = [];
  const myPcId = localPcId();
  const localBefore = readRegistry();
  const removedLocal = opts.includeSelf
    ? localBefore.length
    : localBefore.filter(r => r.id !== myPcId).length;
  // Local mirror — keep self only if includeSelf is false.
  writeRegistry(opts.includeSelf ? [] : localBefore.filter(r => r.id === myPcId));

  let removedCentral = 0;
  if (isLanSessionLoginEnabled()) {
    const resp = await deleteInternalXpcRegistryRows({
      includeSelf: !!opts.includeSelf,
      keepPcId: !opts.includeSelf ? myPcId : null,
    });
    if (!resp.ok) {
      errors.push(`xpc_registry: ${resp.error}`);
    } else {
      removedCentral = Number(resp.removedRegistry ?? 0);
    }
    return { removedLocal, removedCentral, errors };
  }
  if (isLive() && supabase) {
    try {
      let q = supabase.from("xpc_registry").delete().select("id");
      if (!opts.includeSelf && myPcId) q = q.neq("id", myPcId);
      const { data, error } = await q;
      if (error) errors.push(`xpc_registry: ${error.message}`);
      else removedCentral = (data as Array<{ id: string }> | null)?.length ?? 0;
    } catch (e) {
      errors.push(`xpc_registry threw: ${(e as Error)?.message ?? String(e)}`);
    }
    try {
      let q = supabase.from("xpc_user_pcs").delete().select("pc_id");
      if (!opts.includeSelf && myPcId) q = q.neq("pc_id", myPcId);
      const { error } = await q;
      if (error) errors.push(`xpc_user_pcs: ${error.message}`);
    } catch (e) {
      errors.push(`xpc_user_pcs threw: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  return { removedLocal, removedCentral, errors };
}

// v1.1.64 — read-only final-schedule viewers. Base Cmdr and HQ Cmdr
// PCs see every Wing-approved flight schedule from every registered
// squadron, sorted by squadron with the latest update on top. They
// have no action buttons.
// v1.1.104 — Flight Cmdr and Sqn Cmdr also granted access. Per the
// operator's chain spec they need to "come back for it" on a specific
// date after the schedule flows up to Base and finalises. The page's
// squadron-scoped filter + chain_pc_ids visibility ensures each of
// them only sees the schedules their own PC participated in — no
// cross-squadron leakage.
export function canViewFinalSchedules(role: string | undefined, scope: string | undefined): boolean {
  if (role === "super_admin") return true;
  if (role === "commander" && (scope === "base" || scope === "hq" || scope === "flight" || scope === "squadron")) return true;
  return false;
}
