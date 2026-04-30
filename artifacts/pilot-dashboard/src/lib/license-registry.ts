// License-key registry — localStorage-backed mirror of every key the Super
// Admin has ever generated in this browser. The desktop app reads this to
// validate (key, username, expiry) when an operator activates an installation.
//
// In production these checks happen server-side via validate-license; this
// registry exists so the demo mode is faithful: a key issued for "Muhammad"
// must NOT unlock when "Ali" types the same string.
//
// v1.1.53: every write is also mirrored to the central `license_registry`
// table on Supabase, fire-and-forget, so the registry survives a super-admin
// browser cache wipe / OS reinstall / laptop swap. On startup we
// opportunistically pull the central ledger back down so a fresh super-admin
// install gets the full history without manual export/import.

import type { LicenseKey } from "./types";
import { licenseKeys as SEED_KEYS } from "./mockData";
import { supabase, supabaseConfigured } from "./supabase";
import { isLanSessionLoginEnabled } from "./internal-migration";

const isLive = () => !isLanSessionLoginEnabled() && supabaseConfigured && supabase !== null;

const STORAGE_KEY = "rjaf.licenseRegistry";

function loadRegistry(): LicenseKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LicenseKey[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRegistry(keys: LicenseKey[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* quota / private mode — silently degrade */
  }
}

// Seed once: copy the static mockData fixtures into localStorage so demo
// activation has something to validate against on a fresh install.
function ensureSeeded() {
  const existing = loadRegistry();
  if (existing.length > 0) return;
  saveRegistry(SEED_KEYS);
}

export interface IssuedKeyRecord {
  // The full plaintext key string the operator must paste in. Keys are stored
  // in plaintext intentionally — this is a local demo registry, not a
  // production credential store.
  fullKey: string;
  meta: LicenseKey;
}

// ─── Supabase mirror ────────────────────────────────────────────────────
// All three writers (register/update/remove) push their change to the
// central table fire-and-forget. Failures (offline, RLS, schema drift) are
// swallowed silently — the localStorage write is the source of truth, the
// central mirror is a survivability layer.

function mirrorUpsert(rec: IssuedKeyRecord): void {
  if (!isLive() || !supabase) return;
  void (async () => {
    try {
      await supabase!.from("license_registry").upsert(
        {
          id: rec.meta.id,
          full_key: rec.fullKey,
          meta: rec.meta as unknown as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
    } catch { /* mirror is best-effort */ }
  })();
}

function mirrorPatch(id: string, patch: Partial<LicenseKey>): void {
  if (!isLive() || !supabase) return;
  void (async () => {
    try {
      // Read current meta, apply patch, write back. Two roundtrips but only
      // on revoke/release flows which are rare admin actions.
      const { data } = await supabase!
        .from("license_registry")
        .select("meta")
        .eq("id", id)
        .maybeSingle();
      const current = (data?.meta ?? {}) as Record<string, unknown>;
      const next = { ...current, ...patch };
      await supabase!
        .from("license_registry")
        .update({ meta: next, updated_at: new Date().toISOString() })
        .eq("id", id);
    } catch { /* mirror is best-effort */ }
  })();
}

function mirrorDelete(id: string): void {
  if (!isLive() || !supabase) return;
  void (async () => {
    try {
      await supabase!.from("license_registry").delete().eq("id", id);
    } catch { /* mirror is best-effort */ }
  })();
}

// One-shot pull on first super-admin login per browser: read the central
// ledger and merge into local storage, so a fresh install instantly
// recovers the full key history. Safe to call repeatedly — local rows
// take precedence on `id` conflict (the local copy may have edits that
// haven't been mirrored yet because the writer was offline).
export async function syncLicenseRegistryFromSupabase(): Promise<void> {
  if (!isLive() || !supabase) return;
  try {
    const { data, error } = await supabase
      .from("license_registry")
      .select("id, full_key, meta")
      .order("updated_at", { ascending: false })
      .limit(5000);
    if (error || !data) return;
    ensureSeeded();
    const local = loadRegistry() as Array<LicenseKey & { _fullKey?: string }>;
    const localById = new Map(local.map(k => [k.id, k]));
    const merged: Array<LicenseKey & { _fullKey?: string }> = [...local];
    for (const row of data) {
      if (localById.has(row.id)) continue;
      const meta = (row.meta ?? {}) as LicenseKey;
      merged.push({ ...meta, id: row.id, _fullKey: row.full_key });
    }
    saveRegistry(merged);
  } catch { /* sync is best-effort */ }
}

// Persist a freshly minted key. The registry stores the full key string so we
// can match exactly on activation; the LicenseKey row stored alongside is the
// same one shown in the admin table (it carries `keyPreview` etc).
export function registerLicenseKey(rec: IssuedKeyRecord): void {
  ensureSeeded();
  const list = loadRegistry();
  // Stash the full key in a private field on the meta — TypeScript widens this
  // through cast since LicenseKey doesn't expose it (and shouldn't, the table
  // only ever shows the preview).
  const stored = { ...rec.meta, _fullKey: rec.fullKey } as LicenseKey & { _fullKey: string };
  saveRegistry([stored, ...list]);
  mirrorUpsert(rec);
}

// Update an existing key's status/lock fields. Used by revoke/release flows so
// activation can immediately reflect the new state.
export function updateLicenseKey(id: string, patch: Partial<LicenseKey>): void {
  ensureSeeded();
  const list = loadRegistry();
  const next = list.map(k => k.id === id ? { ...k, ...patch } : k);
  saveRegistry(next);
  mirrorPatch(id, patch);
}

// Hard-delete a license key from the registry. Super-admin only — used when
// an operator has uninstalled their PC copy and the row should disappear
// entirely (not just be marked revoked). Once removed, the key string can
// never be re-activated; a fresh key must be issued.
export function removeLicenseKey(id: string): void {
  ensureSeeded();
  const list = loadRegistry();
  const next = list.filter(k => k.id !== id);
  saveRegistry(next);
  mirrorDelete(id);
}

export interface LookupResult {
  ok: boolean;
  reason?:
    | "unknown_key"
    | "wrong_username"
    | "revoked"
    | "expired";
  record?: LicenseKey;
}

// Try to validate (key, username) against the registry. Both inputs are
// trimmed and matched case-insensitively to be forgiving — the operator might
// type "muhammad" when the admin issued "Muhammad".
export function lookupLicenseKey(rawKey: string, rawUsername: string): LookupResult {
  ensureSeeded();
  const key = rawKey.trim().toUpperCase();
  const username = rawUsername.trim().toLowerCase();
  const list = loadRegistry() as Array<LicenseKey & { _fullKey?: string }>;

  // Two ways to match: either the full key was stored (post-#26 keys) or only
  // the preview is known (legacy seed rows). For seed rows we accept any key
  // whose tail matches the preview's last-4, since the demo seed has no full
  // string to compare against. This keeps the existing DEMO-RJAF-1234-5678
  // path working until a real key is generated.
  let record: (LicenseKey & { _fullKey?: string }) | undefined;
  for (const k of list) {
    if (k._fullKey && k._fullKey.toUpperCase() === key) { record = k; break; }
  }

  if (!record) return { ok: false, reason: "unknown_key" };
  if (record.status === "revoked") return { ok: false, reason: "revoked", record };
  if (record.expiresAt && +new Date(record.expiresAt) < Date.now()) {
    return { ok: false, reason: "expired", record };
  }
  if (record.assignedUsername && record.assignedUsername.trim().toLowerCase() !== username) {
    return { ok: false, reason: "wrong_username", record };
  }
  return { ok: true, record };
}

// Read-only enumerator used by the admin table so it can show keys persisted
// across reloads in addition to the in-memory mockData seed.
export function listLicenseKeys(): LicenseKey[] {
  ensureSeeded();
  return loadRegistry();
}
