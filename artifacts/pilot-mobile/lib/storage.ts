import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import type { PilotSnapshot } from "./types";

const LINK_KEY = "rjaf.link.v1";
const SNAPSHOT_KEY = "rjaf.snapshot.v1";
const PREFS_KEY = "rjaf.prefs.v1";
const LOCK_KEY = "rjaf.lock.v1";

export interface LinkRecord {
  militaryNumber: string;
  pilotId: string;
  linkedAt: string;
  squadronId?: string;
  // Legacy: opaque device token from the pre-RLS-per-pilot link path. The
  // current flow uses a real Supabase auth session (persisted by the
  // supabase client into SecureStore under `rjaf.auth.v1`) instead, so new
  // links no longer set this. Kept optional for backward-compat reads of
  // already-linked devices.
  token?: string;
}

// 0 means "keep forever" (no auto-delete). Any positive integer is a
// number of days — alerts older than that on the phone are filtered out
// of the Alerts tab. The server copy is untouched, so other pilots and
// the issuing commander keep seeing it.
export type AlertsTtlDays = 0 | 1 | 3 | 7 | 30;

// Auto-sync interval the mobile app uses to ping the server so the Ops
// PC Roster sync-indicator dot stays green. 3h is the default; pilots
// can pick 1 / 3 / 6 / 12 from Settings. The ping is also triggered on
// cold launch and whenever the app returns to the foreground, so this
// timer is really only useful for pilots who leave the app open.
export type AutoSyncHours = 1 | 3 | 6 | 12;

export interface UserPrefs {
  language: "en" | "ar";
  alertsTtlDays?: AlertsTtlDays;
  autoSyncHours?: AutoSyncHours;
}

// SecureStore is unavailable on web; fall back to AsyncStorage so the demo
// preview still works in the browser.
async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return AsyncStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function secureDelete(key: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export async function loadLink(): Promise<LinkRecord | null> {
  try {
    const raw = await secureGet(LINK_KEY);
    return raw ? (JSON.parse(raw) as LinkRecord) : null;
  } catch {
    return null;
  }
}

export async function saveLink(link: LinkRecord): Promise<void> {
  await secureSet(LINK_KEY, JSON.stringify(link));
}

export async function clearLink(): Promise<void> {
  await secureDelete(LINK_KEY);
  await secureDelete(SNAPSHOT_KEY);
}

export async function loadSnapshot(): Promise<PilotSnapshot | null> {
  try {
    const raw = await secureGet(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as PilotSnapshot) : null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(snap: PilotSnapshot): Promise<void> {
  await secureSet(SNAPSHOT_KEY, JSON.stringify(snap));
}

// Local device-lock password. Stored as { salt, hash } — we never keep
// the plaintext. Absent when the pilot has not created a password yet.
//
// `trusted` flips to true once the pilot has successfully entered (or just
// created) their password on this device. It's persisted so the app does
// NOT re-prompt for the password on every cold launch — the intended UX
// is "set it once, then the device is trusted until you sign out". An
// explicit sign-out (Settings → Sign out) or change-password flow flips
// it back to false so the lock screen shows again on next open.
// Older records written before this flag existed are treated as trusted
// so an app upgrade doesn't lock the user out of their own device.
export interface LockRecord {
  salt: string;
  hash: string;
  trusted?: boolean;
}

export async function loadLock(): Promise<LockRecord | null> {
  try {
    const raw = await secureGet(LOCK_KEY);
    return raw ? (JSON.parse(raw) as LockRecord) : null;
  } catch {
    return null;
  }
}

export async function saveLock(rec: LockRecord): Promise<void> {
  await secureSet(LOCK_KEY, JSON.stringify(rec));
}

export async function clearLock(): Promise<void> {
  await secureDelete(LOCK_KEY);
}

export async function loadPrefs(): Promise<UserPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (!raw) return { language: "en", alertsTtlDays: 7 };
    return {
      language: "en",
      alertsTtlDays: 7,
      ...(JSON.parse(raw) as Partial<UserPrefs>),
    };
  } catch {
    return { language: "en", alertsTtlDays: 7 };
  }
}

export async function savePrefs(prefs: UserPrefs): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  prefsListeners.forEach(fn => { try { fn(prefs); } catch { /* ignore */ } });
}

// In-process pub/sub so callers that cached a pref value (e.g. the
// sync-heartbeat timer in data.tsx, which arms an interval from
// autoSyncHours) can re-read it when Settings writes a new value,
// instead of only picking up the change after an app restart.
const prefsListeners = new Set<(p: UserPrefs) => void>();
export function subscribePrefsChange(fn: (p: UserPrefs) => void): () => void {
  prefsListeners.add(fn);
  return () => { prefsListeners.delete(fn); };
}
