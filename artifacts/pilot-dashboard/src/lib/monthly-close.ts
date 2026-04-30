// Annual close — sorties whose date falls more than 12 months before the
// current calendar month are frozen and become read-only on every PC. Only
// the super admin can authorize a specific operations PC to edit / delete /
// create sorties inside that frozen window. The grant is bound to the PC
// (stable per-browser id stored in localStorage) and lives until the super
// admin revokes it. Every grant, revoke, and frozen-record change made
// under a grant is captured in the audit log.
//
// Model summary
// -------------
//   isFrozenMonth(date)            — true when date is older than 12 months
//   getThisPc() / setThisPcName()  — local browser identity (id + name)
//   listAuthorizedPcs()            — currently authorized PCs (super-admin
//                                    set via the Settings panel)
//   isThisPcAuthorized()           — convenience wrapper
//   authorizePc / revokePc         — super-admin operations
//   useFrozenAccess()              — React hook for live updates
//   canManageFrozenAccess(role)    — true only for "super_admin"

import { useSyncExternalStore } from "react";

const FROZEN_MONTHS_AGO = 12;            // anything older than 12 months freezes
const PC_ID_KEY        = "pilot-pc-id";
const PC_NAME_KEY      = "pilot-pc-name";
const AUTH_LIST_KEY    = "pilot-frozen-access.v1";
const STORAGE_TICK_KEY = "pilot-frozen-access.tick";

const listeners = new Set<() => void>();

function emit(): void { for (const fn of listeners) fn(); }
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
// Cross-tab sync: another tab on the same PC may grant/revoke access; pick
// up the change so the open dashboard re-renders without a reload.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === AUTH_LIST_KEY || e.key === STORAGE_TICK_KEY || e.key === PC_NAME_KEY) emit();
  });
}

// ── month math ───────────────────────────────────────────────────────────
export function monthOf(date: string): string {
  if (!date || date.length < 7) return "";
  return date.slice(0, 7);
}
export function currentMonth(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// True when the given sortie date sits more than 12 months before the
// current calendar month — i.e. last year's hours are read-only once the
// current month rolls in. Today's month and the prior 11 months stay
// editable for normal day-to-day corrections.
export function isFrozenMonth(date: string, now: Date = new Date()): boolean {
  const m = monthOf(date);
  if (!m) return false;
  const [sy, sm] = m.split("-").map(Number);
  const cy = now.getFullYear();
  const cm = now.getMonth() + 1;
  const diff = (cy * 12 + cm) - (sy * 12 + sm);
  return diff > FROZEN_MONTHS_AGO;
}

// ── PC identity ──────────────────────────────────────────────────────────
export interface PcIdentity { id: string; name: string; }

function safeStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}

function uuid(): string {
  // crypto.randomUUID isn't available on every old browser/desktop shell —
  // fall back to a Math.random-based 16-byte hex string.
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return `${out.slice(0,8)}-${out.slice(8,12)}-${out.slice(12,16)}-${out.slice(16,20)}-${out.slice(20)}`;
}

export function getThisPc(): PcIdentity {
  const ls = safeStorage();
  if (!ls) return { id: "unknown-pc", name: "This PC" };
  let id = ls.getItem(PC_ID_KEY);
  if (!id) { id = uuid(); ls.setItem(PC_ID_KEY, id); }
  const name = ls.getItem(PC_NAME_KEY) ?? defaultPcName(id);
  return { id, name };
}

function defaultPcName(id: string): string {
  return `PC-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export function setThisPcName(name: string): void {
  const ls = safeStorage();
  if (!ls) return;
  const trimmed = name.trim();
  if (trimmed) ls.setItem(PC_NAME_KEY, trimmed);
  else ls.removeItem(PC_NAME_KEY);
  emit();
}

// ── authorized PC list ───────────────────────────────────────────────────
export interface FrozenAccessGrant {
  id: string;            // PC id this grant applies to
  name: string;          // human-readable PC name at grant time
  grantedAt: string;     // ISO timestamp
  grantedBy: string;     // username of super admin who issued the grant
  note?: string;         // optional reason / context
}

function readList(): FrozenAccessGrant[] {
  const ls = safeStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(AUTH_LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is FrozenAccessGrant =>
      !!g && typeof (g as FrozenAccessGrant).id === "string"
        && typeof (g as FrozenAccessGrant).name === "string"
        && typeof (g as FrozenAccessGrant).grantedAt === "string"
        && typeof (g as FrozenAccessGrant).grantedBy === "string");
  } catch { return []; }
}
function writeList(list: FrozenAccessGrant[]): void {
  const ls = safeStorage();
  if (!ls) return;
  ls.setItem(AUTH_LIST_KEY, JSON.stringify(list));
  // Bump tick so other tabs that miss the AUTH_LIST_KEY event still notice.
  ls.setItem(STORAGE_TICK_KEY, String(Date.now()));
  emit();
}

export function listAuthorizedPcs(): FrozenAccessGrant[] {
  return readList();
}
export function isPcAuthorized(pcId: string): boolean {
  return readList().some(g => g.id === pcId);
}
export function isThisPcAuthorized(): boolean {
  return isPcAuthorized(getThisPc().id);
}
export function getGrantForPc(pcId: string): FrozenAccessGrant | null {
  return readList().find(g => g.id === pcId) ?? null;
}

export function authorizePc(input: {
  id: string;
  name: string;
  grantedBy: string;
  note?: string;
}): FrozenAccessGrant {
  const grant: FrozenAccessGrant = {
    id: input.id.trim(),
    name: input.name.trim() || defaultPcName(input.id),
    grantedAt: new Date().toISOString(),
    grantedBy: input.grantedBy,
    note: input.note?.trim() || undefined,
  };
  const next = readList().filter(g => g.id !== grant.id).concat(grant);
  writeList(next);
  return grant;
}

export function revokePc(pcId: string): FrozenAccessGrant | null {
  const list = readList();
  const idx = list.findIndex(g => g.id === pcId);
  if (idx < 0) return null;
  const removed = list[idx];
  list.splice(idx, 1);
  writeList(list);
  return removed;
}

// ── React hook ───────────────────────────────────────────────────────────
let snapshot: {
  pc: PcIdentity;
  authorized: boolean;
  list: FrozenAccessGrant[];
} = computeSnapshot();

function computeSnapshot() {
  const pc = getThisPc();
  const list = readList();
  return { pc, list, authorized: list.some(g => g.id === pc.id) };
}
listeners.add(() => { snapshot = computeSnapshot(); });

export interface FrozenAccessState {
  pc: PcIdentity;
  /** True when this browser/PC is on the authorized list. */
  thisPcAuthorized: boolean;
  /** All authorized PCs — super admin uses this to revoke. */
  authorizedPcs: FrozenAccessGrant[];
  /** Returns true when the date sits in the frozen window. */
  isFrozen: (date: string) => boolean;
  /** True when this PC is allowed to edit the given date. */
  canEdit: (date: string) => boolean;
}

export function useFrozenAccess(): FrozenAccessState {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return {
    pc: snap.pc,
    thisPcAuthorized: snap.authorized,
    authorizedPcs: snap.list,
    isFrozen: (date: string) => isFrozenMonth(date),
    canEdit: (date: string) => !isFrozenMonth(date) || snap.authorized,
  };
}

// Only the super admin can grant/revoke frozen-record edit access.
export function canManageFrozenAccess(role: string | undefined | null): boolean {
  return role === "super_admin";
}

// Test-only escape hatch — clears all per-PC authorizations.
export function __resetFrozenAccessForTests(): void {
  const ls = safeStorage();
  if (ls) { ls.removeItem(AUTH_LIST_KEY); ls.removeItem(PC_ID_KEY); ls.removeItem(PC_NAME_KEY); }
  snapshot = computeSnapshot();
  emit();
}
