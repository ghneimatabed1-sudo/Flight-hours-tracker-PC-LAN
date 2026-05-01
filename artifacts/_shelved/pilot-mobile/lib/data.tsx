import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { demoSnapshot, DEMO_LINK_CODE, DEMO_MILITARY_NUMBER } from "./mockData";
import { autoRegisterPushOnLaunch, pingSync } from "./notifications";
import { AppState, type AppStateStatus } from "react-native";
import { loadPrefs, subscribePrefsChange } from "./storage";
import { generateSalt, hashPassword } from "./password";
import {
  clearLink,
  clearLock,
  loadLink,
  loadLock,
  loadSnapshot,
  saveLink,
  saveLock,
  saveSnapshot,
  type LinkRecord,
  type LockRecord,
} from "./storage";
import {
  fetchPilotSnapshotRemote,
  linkPilotRemote,
  supabase,
  supabaseConfigured,
} from "./supabase";
import type { PilotSnapshot } from "./types";

type LinkErrorCode =
  | "not_found"
  | "bad_code"
  | "revoked"
  | "supabase_not_configured"
  | "generic";

interface AppDataValue {
  ready: boolean;
  link: LinkRecord | null;
  snapshot: PilotSnapshot | null;
  refreshing: boolean;
  lastError: string | null;
  remoteEnabled: boolean;
  // Local device-lock state.
  // `hasPassword` is true when the pilot has already created a password.
  // `unlocked` becomes true after the pilot creates their password or
  // types it in once on a fresh install. It's then persisted in the
  // lock record (`trusted: true`) so subsequent cold launches auto-
  // unlock — the password only returns as a gate after an explicit
  // sign-out or password change.
  hasPassword: boolean;
  unlocked: boolean;
  linkAccount: (
    militaryNumber: string,
    code: string
  ) => Promise<{ ok: boolean; error?: LinkErrorCode }>;
  refresh: () => Promise<void>;
  unlink: () => Promise<void>;
  createPassword: (pw: string) => Promise<{ ok: boolean }>;
  verifyPassword: (pw: string) => Promise<{ ok: boolean }>;
  changePassword: (
    currentPw: string,
    newPw: string
  ) => Promise<{ ok: boolean; error?: "wrong_current" }>;
  signOut: () => Promise<void>;
  // Forgot-password recovery. Clears the local password so the pilot can
  // re-pair with a fresh 6-digit code issued by their ops officer (same
  // flow as first install). The cached snapshot is kept as a read-only
  // fallback until the new pairing succeeds and overwrites it.
  forgotPassword: () => Promise<void>;
}

const Ctx = createContext<AppDataValue | null>(null);

// Background sync interval. The mobile client polls direct table reads under
// its per-pilot Supabase auth session (RLS scopes them to the signed-in
// pilot). Polling keeps the dependency surface small; pull-to-refresh
// remains for on-demand updates.
const POLL_MS = 15_000;

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [link, setLink] = useState<LinkRecord | null>(null);
  const [snapshot, setSnapshot] = useState<PilotSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lock, setLock] = useState<LockRecord | null>(null);
  // Cold launch starts unlocked iff the stored lock record is marked as
  // `trusted` (i.e. the pilot has previously typed or created the password
  // on this device). Otherwise the lock screen is shown. The useEffect
  // below hydrates this from SecureStore once storage has loaded.
  const [unlocked, setUnlocked] = useState(false);
  // Latest link kept in a ref so the polling/realtime closures always see the
  // current token without resubscribing on every state change.
  const linkRef = useRef<LinkRecord | null>(null);
  linkRef.current = link;

  const applyRefresh = useCallback(async (rec: LinkRecord) => {
    if (!rec.pilotId) return;
    const r = await fetchPilotSnapshotRemote(rec.pilotId);
    if (r.ok && r.snapshot) {
      setSnapshot(r.snapshot);
      await saveSnapshot(r.snapshot);
      setLastError(null);
    } else if (r.error === "revoked") {
      setLastError("revoked");
      await clearLink();
      setLink(null);
      setSnapshot(null);
    } else if (r.error) {
      setLastError(r.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [storedLink, storedSnap, storedLock] = await Promise.all([
        loadLink(),
        loadSnapshot(),
        loadLock(),
      ]);
      if (cancelled) return;
      setLink(storedLink);
      setSnapshot(storedSnap);
      setLock(storedLock);
      // Honor the `trusted` flag on the lock record. After the pilot has
      // set up the password the first time — or after any successful
      // unlock — the lock record is saved with `trusted: true`, which
      // means subsequent cold launches skip the password screen and go
      // straight to the app. The lock screen only re-appears after an
      // explicit Sign Out from Settings (which flips `trusted: false`)
      // or after the pilot changes their password.
      //
      // Older lock records written before this flag existed have no
      // `trusted` field and are treated as trusted (same as they
      // behaved historically), so this change does not force an
      // existing pilot base to re-type a password on the next update.
      if (storedLock) {
        const isTrusted = storedLock.trusted !== false;
        setUnlocked(isTrusted);
      }
      setReady(true);

      if (storedLink && supabaseConfigured && storedLink.pilotId) {
        // The Supabase client restores the persisted auth session from
        // SecureStore on its own; just verify it is still valid before
        // attempting a read so we surface revoked sessions cleanly.
        const { data } = (await supabase?.auth.getSession()) ?? { data: null };
        if (data?.session) {
          await applyRefresh(storedLink);
          // Silently (re-)register the Expo push token on every cold
          // launch while signed in.  Without this, a pilot who never
          // opens the Reminders screen would have no row in
          // pilot_reminder_prefs and the notify-alert / notify-notam
          // edge functions would skip their device entirely.
          void autoRegisterPushOnLaunch();
          // Heartbeat: stamp last_seen_at so the Ops PC Roster shows
          // this pilot as freshly synced. Also runs on foreground and
          // on a timer below.
          void pingSync();
        } else {
          setLastError("revoked");
          await clearLink();
          setLink(null);
          setSnapshot(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyRefresh]);

  // Background sync: only active while linked against a real Supabase
  // project. Demo mode skips this since the cached snapshot never changes.
  useEffect(() => {
    if (!link || !supabaseConfigured || !link.pilotId) return;

    let stopped = false;
    const interval = setInterval(() => {
      const current = linkRef.current;
      if (!stopped && current) void applyRefresh(current);
    }, POLL_MS);

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [link, applyRefresh]);

  // Sync-indicator heartbeat. Keeps pilot_reminder_prefs.last_seen_at
  // fresh so the Ops PC Roster shows a green dot for this pilot. Three
  // triggers:
  //   1. App returns to the foreground (AppState → 'active')
  //   2. Periodic timer while the app is open, interval taken from the
  //      pilot's `autoSyncHours` preference (default 3 h).
  //   3. The cold-launch call is above in the initial-mount effect.
  useEffect(() => {
    if (!link || !supabaseConfigured || !link.pilotId) return;

    let hours = 3;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const armTimer = (h: number) => {
      if (timer) clearInterval(timer);
      const ms = Math.max(1, h) * 60 * 60 * 1000;
      timer = setInterval(() => {
        if (!cancelled) void pingSync();
      }, ms);
    };

    void (async () => {
      try {
        const prefs = await loadPrefs();
        hours = prefs.autoSyncHours ?? 3;
      } catch { /* keep default */ }
      if (!cancelled) armTimer(hours);
    })();

    // Re-arm the heartbeat interval if the pilot picks a new
    // autoSyncHours value in Settings — otherwise the running timer
    // would stay on the value we read at mount until the next relink
    // or app restart.
    const prefsUnsub = subscribePrefsChange(p => {
      const next = p.autoSyncHours ?? 3;
      if (!cancelled && next !== hours) {
        hours = next;
        armTimer(hours);
      }
    });

    // Phones aren't workstations: the pilot opens and closes the app
    // dozens of times a day, and an idle-lock on the handset would just
    // annoy them. So on every foreground we only ping sync — no
    // auto-logout / auto-lock is enforced on mobile. The device-level
    // password (configured at link time) and the PC's revoke-device
    // action remain the two access-control gates.
    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "active") void pingSync();
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      sub.remove();
      prefsUnsub();
    };
  }, [link]);

  const linkAccount = useCallback(
    async (militaryNumber: string, code: string) => {
      setLastError(null);
      const mn = militaryNumber.trim();
      const cd = code.trim();

      if (!mn || !cd) return { ok: false, error: "generic" as const };

      if (supabaseConfigured) {
        const r = await linkPilotRemote(mn, cd);
        if (!r.ok || !r.snapshot) {
          const err = (r.error as LinkErrorCode) ?? "generic";
          setLastError(err);
          return { ok: false, error: err };
        }
        const linkRec: LinkRecord = {
          militaryNumber: mn,
          pilotId: r.snapshot.profile.id,
          linkedAt: new Date().toISOString(),
          squadronId: r.squadronId,
        };
        // Always wipe any previously stored password on a successful new
        // pairing so the pilot goes through the clean "create a password"
        // flow on the next screen (/setup-lock mode=initial). Without this
        // a pilot re-linking (after a key revoke, reinstall, or device
        // hand-off) would see the "change password" form and be stuck
        // because they don't know the old password.
        await clearLock();
        await saveLink(linkRec);
        await saveSnapshot(r.snapshot);
        setLock(null);
        setUnlocked(false);
        setLink(linkRec);
        setSnapshot(r.snapshot);
        return { ok: true };
      }

      // Demo mode (no Supabase configured).
      if (mn !== DEMO_MILITARY_NUMBER) {
        setLastError("not_found");
        return { ok: false, error: "not_found" as const };
      }
      if (cd !== DEMO_LINK_CODE) {
        setLastError("bad_code");
        return { ok: false, error: "bad_code" as const };
      }
      const linkRec: LinkRecord = {
        militaryNumber: mn,
        pilotId: demoSnapshot.profile.id,
        linkedAt: new Date().toISOString(),
      };
      await clearLock();
      await saveLink(linkRec);
      await saveSnapshot(demoSnapshot);
      setLock(null);
      setUnlocked(false);
      setLink(linkRec);
      setSnapshot(demoSnapshot);
      return { ok: true };
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!link) return;
    setRefreshing(true);
    try {
      if (supabaseConfigured && link.pilotId) {
        await applyRefresh(link);
      } else {
        const next: PilotSnapshot = {
          ...demoSnapshot,
          fetchedAt: new Date().toISOString(),
        };
        setSnapshot(next);
        await saveSnapshot(next);
      }
    } finally {
      setRefreshing(false);
    }
  }, [link, applyRefresh]);

  const unlink = useCallback(async () => {
    if (supabaseConfigured) {
      try {
        await supabase?.auth.signOut();
      } catch {
        // Best-effort: even if the network sign-out fails we still want to
        // wipe local state below.
      }
    }
    await clearLink();
    await clearLock();
    setLink(null);
    setSnapshot(null);
    setLock(null);
    setUnlocked(false);
    setLastError(null);
  }, []);

  const createPassword = useCallback(async (pw: string) => {
    const clean = pw.trim();
    if (clean.length < 4) return { ok: false };
    const salt = await generateSalt();
    const hash = await hashPassword(clean, salt);
    // Mark the device as trusted at creation — the pilot has just proven
    // ownership, so we don't want to prompt again on the next launch.
    const rec: LockRecord = { salt, hash, trusted: true };
    await saveLock(rec);
    setLock(rec);
    setUnlocked(true);
    return { ok: true };
  }, []);

  const verifyPassword = useCallback(
    async (pw: string) => {
      if (!lock) return { ok: false };
      const h = await hashPassword(pw.trim(), lock.salt);
      if (h === lock.hash) {
        // Persist the trusted bit so subsequent cold launches bypass the
        // lock screen until an explicit sign-out.
        const rec: LockRecord = { ...lock, trusted: true };
        await saveLock(rec);
        setLock(rec);
        setUnlocked(true);
        return { ok: true };
      }
      return { ok: false };
    },
    [lock]
  );

  const changePassword = useCallback(
    async (currentPw: string, newPw: string) => {
      const clean = newPw.trim();
      if (clean.length < 4) return { ok: false as const };
      if (!lock) {
        // No existing password — treat as first-time setup.
        const salt = await generateSalt();
        const hash = await hashPassword(clean, salt);
        const rec: LockRecord = { salt, hash, trusted: true };
        await saveLock(rec);
        setLock(rec);
        setUnlocked(true);
        return { ok: true as const };
      }
      const current = await hashPassword(currentPw.trim(), lock.salt);
      if (current !== lock.hash) {
        return { ok: false as const, error: "wrong_current" as const };
      }
      const salt = await generateSalt();
      const hash = await hashPassword(clean, salt);
      const rec: LockRecord = { salt, hash, trusted: true };
      await saveLock(rec);
      setLock(rec);
      setUnlocked(true);
      return { ok: true as const };
    },
    [lock]
  );

  // Forgot-password path: ops officer issues a new 6-digit code, pilot
  // re-runs the link flow. Wipe the local lock (password) so the /link
  // → /setup-lock chain will prompt for a fresh password once the new
  // code is consumed. We intentionally keep the LinkRecord and cached
  // snapshot in place so the app doesn't feel "empty" in transit.
  const forgotPassword = useCallback(async () => {
    await clearLock();
    setLock(null);
    setUnlocked(false);
  }, []);

  // Sign out locks the app but keeps the pilot-device pairing intact. We
  // also persist `trusted: false` on the lock record so subsequent cold
  // launches surface the lock screen again — without this, the persisted
  // trusted bit would silently re-unlock the app on the next launch.
  const signOut = useCallback(async () => {
    if (lock) {
      const rec: LockRecord = { ...lock, trusted: false };
      await saveLock(rec);
      setLock(rec);
    }
    setUnlocked(false);
  }, [lock]);

  const value = useMemo<AppDataValue>(
    () => ({
      ready,
      link,
      snapshot,
      refreshing,
      lastError,
      remoteEnabled: supabaseConfigured,
      hasPassword: !!lock,
      unlocked,
      linkAccount,
      refresh,
      unlink,
      createPassword,
      verifyPassword,
      changePassword,
      signOut,
      forgotPassword,
    }),
    [
      ready,
      link,
      snapshot,
      refreshing,
      lastError,
      lock,
      unlocked,
      linkAccount,
      refresh,
      unlink,
      createPassword,
      verifyPassword,
      changePassword,
      signOut,
      forgotPassword,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppDataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppData must be used inside <AppDataProvider>");
  return v;
}
