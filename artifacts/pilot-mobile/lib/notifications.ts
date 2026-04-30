import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { supabase, supabaseConfigured } from "./supabase";

const LOCAL_PREFS_KEY = "@hawkeye/reminder_prefs";

// Resolve the EAS project id used to scope Expo push tokens. Reads from the
// EAS config first (set automatically in EAS builds) then falls back to a
// public env var so dev clients can still register a token without a build.
export function resolveProjectId(): string | undefined {
  const fromEas =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId ??
    (
      Constants.easConfig as { projectId?: string } | undefined
    )?.projectId;
  if (fromEas) return fromEas;
  return process.env.EXPO_PUBLIC_EAS_PROJECT_ID || undefined;
}

export type CurrencyKey = "day" | "night" | "nvg" | "irt" | "medical" | "sim";

export type ReminderThresholds = Partial<Record<CurrencyKey, number[]>>;

export interface ReminderPrefs {
  thresholds: ReminderThresholds;
  pushEnabled: boolean;
  expoPushToken: string | null;
  platform: string | null;
}

export const DEFAULT_PREFS: ReminderPrefs = {
  thresholds: {},
  pushEnabled: false,
  expoPushToken: null,
  platform: null,
};

// Suggested chip values shown in the reminders UI. Pilot taps to toggle each
// in/out of their per-currency list. Order matches what looks natural on a
// row (most-imminent on the left).
export const THRESHOLD_PRESETS: number[] = [1, 3, 7, 10, 14, 21, 30];

// Set up the foreground handler once per app launch. Without this, taps on
// notifications received while the app is open do not surface to the user.
let handlerConfigured = false;
export function configureNotificationHandler(): void {
  if (handlerConfigured) return;
  handlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

interface RegisterResult {
  ok: boolean;
  token?: string;
  error?:
    | "unsupported_platform"
    | "permission_denied"
    | "no_project_id"
    | "expo_error";
}

// Acquires (or refreshes) the Expo push token for this device, after
// requesting OS-level notification permission. Returns the token string the
// caller can persist to Supabase. Web is a no-op since the mobile app does
// not run real push there.
export async function registerForPushNotifications(
  projectId?: string
): Promise<RegisterResult> {
  if (Platform.OS === "web") return { ok: false, error: "unsupported_platform" };
  if (!Device.isDevice) {
    // Simulator / emulator cannot receive real Expo pushes; treat as an
    // unsupported environment so the UI can show a friendly notice instead
    // of looping the permission dialog.
    return { ok: false, error: "unsupported_platform" };
  }

  if (Platform.OS === "android") {
    try {
      await Notifications.setNotificationChannelAsync("currency-expiry", {
        name: "Currency expiry reminders",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 250, 250],
      });
    } catch {
      // Channel creation failures should not block token retrieval.
    }
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== "granted") return { ok: false, error: "permission_denied" };

  // Prefer an Expo push token (requires the EAS projectId). When the EAS
  // projectId is not configured for this build (e.g. Codemagic builds that
  // bypass EAS), gracefully fall back to a raw native device token (FCM
  // on Android, APNs on iOS) so push setup still completes. The server can
  // route to either format.
  if (projectId) {
    try {
      const tokenResp = await Notifications.getExpoPushTokenAsync({ projectId });
      return { ok: true, token: tokenResp.data };
    } catch {
      // fall through to raw device token
    }
  }

  try {
    const dev = await Notifications.getDevicePushTokenAsync();
    const raw = typeof dev.data === "string" ? dev.data : JSON.stringify(dev.data);
    return { ok: true, token: raw };
  } catch {
    return { ok: false, error: "expo_error" };
  }
}

// ── local helpers ──────────────────────────────────────────────────────────
async function loadLocalPrefs(): Promise<ReminderPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_PREFS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<ReminderPrefs>;
    return {
      thresholds:    obj.thresholds    ?? {},
      pushEnabled:   Boolean(obj.pushEnabled),
      expoPushToken: obj.expoPushToken ?? null,
      platform:      obj.platform      ?? null,
    };
  } catch {
    return null;
  }
}

async function saveLocalPrefs(prefs: ReminderPrefs): Promise<boolean> {
  try {
    await AsyncStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

// ── public API ─────────────────────────────────────────────────────────────

export async function loadReminderPrefs(): Promise<ReminderPrefs> {
  // Try Supabase first (requires migration 0011+). If the RPC doesn't exist
  // yet or Supabase isn't configured, fall back to the local AsyncStorage
  // copy so pilots can still manage their reminders before the DB migration
  // is applied.
  if (supabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc("get_pilot_reminder_prefs");
    if (!error && data) {
      const obj = data as {
        thresholds?: ReminderThresholds;
        pushEnabled?: boolean;
        expoPushToken?: string | null;
        platform?: string | null;
      };
      const prefs: ReminderPrefs = {
        thresholds:    obj.thresholds    ?? {},
        pushEnabled:   Boolean(obj.pushEnabled),
        expoPushToken: obj.expoPushToken ?? null,
        platform:      obj.platform      ?? null,
      };
      // Keep local copy in sync.
      void saveLocalPrefs(prefs);
      return prefs;
    }
  }
  // Supabase unavailable or RPC missing — use local copy.
  return (await loadLocalPrefs()) ?? DEFAULT_PREFS;
}

export async function saveReminderPrefs(prefs: ReminderPrefs): Promise<boolean> {
  // Always persist locally so reminders survive offline / pre-migration.
  const localOk = await saveLocalPrefs(prefs);

  // Supabase sync. We AWAIT this so a failed save (e.g. RPC raising
  // 'unauthorized' because the pilot's auth_user_id binding was never
  // set during pairing) propagates back to the UI and the toggle does
  // NOT appear to be saved when it isn't. Without this await, the
  // toggle in Reminders silently reverts to OFF on the next visit
  // because the local copy is overwritten by the stale Supabase row.
  if (supabaseConfigured && supabase) {
    try {
      const { error } = await supabase.rpc("save_pilot_reminder_prefs", {
        p_thresholds:       prefs.thresholds,
        p_push_enabled:     prefs.pushEnabled,
        p_expo_push_token:  prefs.expoPushToken,
        p_platform:         prefs.platform,
      });
      if (error) {
        console.warn("[reminders] save_pilot_reminder_prefs error:", error.message);
        return false;
      }
    } catch (err) {
      console.warn("[reminders] save_pilot_reminder_prefs threw:", err);
      return false;
    }
  }

  return localOk;
}

// Auto-register push on cold launch.  Called right after the mobile app
// has verified its Supabase session.  If the device already has a valid
// token on the server we do nothing; otherwise we silently request OS
// permission, grab the Expo push token and persist it with
// push_enabled=true so alerts and NOTAMs land on this phone without the
// pilot ever having to open the Reminders screen.  A silent failure
// (permission denied, EAS id missing, etc.) is swallowed — the pilot can
// still enable it manually from the Reminders tab.
export async function autoRegisterPushOnLaunch(): Promise<void> {
  if (Platform.OS === "web") return;
  if (!supabaseConfigured || !supabase) return;
  try {
    const current = await loadReminderPrefs();
    // Already registered: refresh the token in case it rotated, but only
    // if we can do so without prompting (permission already granted).
    if (current.pushEnabled && current.expoPushToken) {
      const perm = await Notifications.getPermissionsAsync();
      if (perm.status !== "granted") return;
      const r = await registerForPushNotifications(resolveProjectId());
      if (r.ok && r.token && r.token !== current.expoPushToken) {
        await saveReminderPrefs({
          ...current,
          expoPushToken: r.token,
          platform: Platform.OS,
        });
      }
      return;
    }
    // Not yet registered.  Request permission (OS remembers the answer —
    // a denied user is NOT re-prompted on every launch).
    const r = await registerForPushNotifications(resolveProjectId());
    if (!r.ok || !r.token) return;
    await saveReminderPrefs({
      thresholds:    current.thresholds,
      pushEnabled:   true,
      expoPushToken: r.token,
      platform:      Platform.OS,
    });
  } catch {
    // Best-effort — never block app launch because of push registration.
  }
}

// ── Sync indicator ────────────────────────────────────────────────────────
// Ping the Supabase `ping_pilot_sync` RPC so the Ops PC Roster can show
// this pilot as "recently seen" (green dot within 24 h). Called:
//   * on cold launch (right after autoRegisterPushOnLaunch),
//   * whenever the app returns to the foreground (AppState 'active'),
//   * every N hours on an interval timer while the app is open (N = the
//     pilot's autoSyncHours pref, 3 h by default).
// Any failure is swallowed — this is a best-effort heartbeat, never a
// blocker for the user. Returns true on success so the caller can tell
// the user "Synced just now" after a manual tap of "Sync now".
export async function pingSync(): Promise<boolean> {
  if (!supabaseConfigured || !supabase) return false;
  try {
    const { error } = await supabase.rpc("ping_pilot_sync");
    return !error;
  } catch {
    return false;
  }
}

// Normalise a per-currency threshold list: dedupe, drop nonsense, sort
// descending so the most-distant reminder shows first.
export function normaliseThresholds(values: number[]): number[] {
  const seen = new Set<number>();
  for (const v of values) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n) && n >= 0 && n <= 365) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => b - a);
}
