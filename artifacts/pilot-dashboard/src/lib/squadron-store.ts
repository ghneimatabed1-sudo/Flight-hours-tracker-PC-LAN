// Squadron registry — persistent, editable list of squadrons known to this PC.
//
// HISTORY (v1.0.42): Before this file existed, `mockData.squadrons` was an
// empty array hard-coded into the bundle, and there was NO UI to add a
// squadron. On a fresh install, the Super Admin would open License Keys,
// click Generate Key, see an empty squadron dropdown, and be permanently
// stuck — no key could be issued, so no other PC could ever be activated.
// Existing PCs only "worked" because they carried leftover squadron data
// from older builds that had seed entries.
//
// The Super Admin PC owns the master squadron list. When the Super Admin
// generates a license key for an Ops PC, the squadron metadata is baked
// into the activation payload, so commander/wing/HQ PCs receive their
// squadron context indirectly through the keys they activate.
//
// Storage: localStorage cache on the Super Admin PC under "rjaf.squadrons".
// Source of truth is Supabase when configured; internal-LAN migration adds an
// optional first read from `api-server` (see `refreshSquadronsFromDb`). Writes
// still go to Supabase when configured. We mirror reads to localStorage for
// offline resilience and same-tab reactivity.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Squadron } from "./types";
import { fetchInternalSquadronsList, isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { supabase, supabaseConfigured } from "./supabase";

const STORAGE_KEY = "rjaf.squadrons";
const CHANGE_EVENT = "rjaf:squadrons-changed";
const DB_CHANGE_EVENT = "rjaf:squadrons-db-changed";

export function shouldUseCloudSquadronSync(
  lanMode: boolean,
  cloudConfigured: boolean,
): boolean {
  return !lanMode && cloudConfigured;
}

function toRow(s: Squadron): {
  id: string;
  number: string;
  name: string;
  base: string;
  wing: string;
} {
  return {
    id: s.id,
    number: s.code,
    name: s.name,
    base: s.base,
    wing: s.wing,
  };
}

/**
 * Maps REST / internal-API squadron rows to UI records. Exported for unit
 * tests and shared with the internal migration read path.
 */
export function squadronsFromRemoteRows(
  rows: ReadonlyArray<{
    id: string;
    number: string;
    name: string;
    base: string;
    wing?: string | null;
  }>,
): Squadron[] {
  return rows.map((r) => fromRow(r));
}

function fromRow(row: {
  id: string;
  number: string;
  name: string;
  base: string;
  wing?: string | null;
}): Squadron {
  const nm = String(row.name ?? "").trim();
  const base = String(row.base ?? "").trim();
  const wing = String(row.wing ?? "").trim();
  return {
    id: String(row.id),
    name: nm,
    nameAr: nm,
    code: String(row.number ?? "").trim().toUpperCase(),
    base,
    baseAr: base,
    wing: wing || "—",
    wingAr: wing || "—",
    enabled: true,
    keyHolder: null,
  };
}

function read(): Squadron[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is Squadron =>
      x && typeof x === "object" && typeof x.id === "string" && typeof x.name === "string"
    );
  } catch {
    return [];
  }
}

function write(list: Squadron[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* quota / private mode — silently ignore so UI doesn't crash */
  }
}

export function listSquadrons(): Squadron[] {
  return read();
}

export async function refreshSquadronsFromDb(): Promise<Squadron[]> {
  const lanMode = isLanSessionLoginEnabled();
  const sb = supabase;
  const internalRows = await fetchInternalSquadronsList();
  // Hybrid migration: only trust the internal list when it is non-empty so a
  // mis-provisioned empty LAN Postgres cannot wipe a populated Supabase org.
  if (internalRows !== null && internalRows.length > 0) {
    const mapped = squadronsFromRemoteRows(internalRows);
    write(mapped);
    window.dispatchEvent(new Event(DB_CHANGE_EVENT));
    return mapped;
  }
  if (!shouldUseCloudSquadronSync(lanMode, !!(supabaseConfigured && sb)) || !sb) return read();
  const { data, error } = await sb
    .from("squadrons")
    .select("id, number, name, base, wing")
    .order("name", { ascending: true });
  if (error) throw error;
  const mapped = squadronsFromRemoteRows(
    (data ?? []) as Array<{
      id: string;
      number: string;
      name: string;
      base: string;
      wing?: string | null;
    }>,
  );
  write(mapped);
  window.dispatchEvent(new Event(DB_CHANGE_EVENT));
  return mapped;
}

export function getSquadron(id: string): Squadron | undefined {
  return read().find(s => s.id === id);
}

export interface CreateSquadronInput {
  name: string;
  nameAr?: string;
  code: string;
  base: string;
  baseAr?: string;
  wing: string;
  wingAr?: string;
}

export async function addSquadron(input: CreateSquadronInput): Promise<{ ok: boolean; error?: string; squadron?: Squadron }> {
  const sb = supabase;
  const name = input.name.trim();
  const code = input.code.trim().toUpperCase();
  const base = input.base.trim();
  const wing = input.wing.trim();
  if (!name) return { ok: false, error: "name_required" };
  if (!code) return { ok: false, error: "code_required" };
  if (!base) return { ok: false, error: "base_required" };
  if (!wing) return { ok: false, error: "wing_required" };
  const sqn: Squadron = {
    id: crypto.randomUUID(),
    name,
    nameAr: (input.nameAr ?? "").trim() || name,
    code,
    base,
    baseAr: (input.baseAr ?? "").trim() || base,
    wing,
    wingAr: (input.wingAr ?? "").trim() || wing,
    enabled: true,
    keyHolder: null,
  };
  if (shouldUseCloudSquadronSync(isLanSessionLoginEnabled(), !!(supabaseConfigured && sb)) && sb) {
    const { error } = await sb
      .from("squadrons")
      .insert(toRow(sqn));
    if (error) {
      const msg = (error.message || "").toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return { ok: false, error: "duplicate_code" };
      }
      return { ok: false, error: "db_write_failed" };
    }
    await refreshSquadronsFromDb();
    return { ok: true, squadron: sqn };
  }
  const list = read();
  if (list.some(s => s.code.toUpperCase() === code)) {
    return { ok: false, error: "duplicate_code" };
  }
  write([...list, sqn]);
  return { ok: true, squadron: sqn };
}

export async function updateSquadron(id: string, patch: Partial<Squadron>): Promise<boolean> {
  const sb = supabase;
  if (shouldUseCloudSquadronSync(isLanSessionLoginEnabled(), !!(supabaseConfigured && sb)) && sb) {
    const base = read().find((s) => s.id === id);
    if (!base) return false;
    const next = { ...base, ...patch, id: base.id };
    const { error } = await sb
      .from("squadrons")
      .update(toRow(next))
      .eq("id", id);
    if (error) return false;
    await refreshSquadronsFromDb();
    return true;
  }
  const list = read();
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) return false;
  list[idx] = { ...list[idx], ...patch, id: list[idx].id };
  write(list);
  return true;
}

export async function deleteSquadron(id: string): Promise<boolean> {
  const sb = supabase;
  if (shouldUseCloudSquadronSync(isLanSessionLoginEnabled(), !!(supabaseConfigured && sb)) && sb) {
    const { error } = await sb
      .from("squadrons")
      .delete()
      .eq("id", id);
    if (error) return false;
    await refreshSquadronsFromDb();
    return true;
  }
  const list = read();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  write(next);
  return true;
}

export async function setSquadronEnabled(id: string, enabled: boolean): Promise<boolean> {
  return updateSquadron(id, { enabled });
}

// React hook with cross-tab and same-tab live updates. Same-tab updates
// rely on the custom CHANGE_EVENT we dispatch in write(); cross-tab updates
// piggy-back on the standard `storage` event.
function subscribe(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener(DB_CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener(DB_CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

// useSyncExternalStore needs a stable snapshot reference between unchanged
// reads or React 18 will warn "getSnapshot should be cached". We memoize
// based on the JSON string of the underlying storage.
let cachedRaw: string | null = null;
let cachedList: Squadron[] = [];
function getSnapshot(): Squadron[] {
  const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  cachedList = read();
  return cachedList;
}
function getServerSnapshot(): Squadron[] {
  return [];
}

export function useSquadrons(): Squadron[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Convenience hook for pages that only want enabled squadrons (the typical
// dropdown filter when issuing licenses or routing pilots).
export function useEnabledSquadrons(): Squadron[] {
  const all = useSquadrons();
  // Recompute only when `all` reference changes (useSyncExternalStore caches it).
  const [filtered, setFiltered] = useState<Squadron[]>(() => all.filter(s => s.enabled));
  useEffect(() => {
    setFiltered(all.filter(s => s.enabled));
  }, [all]);
  return filtered;
}
