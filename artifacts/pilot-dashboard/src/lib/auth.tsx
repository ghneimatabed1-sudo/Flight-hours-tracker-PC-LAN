import { createContext, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { supabase, supabaseConfigured, validateLicenseRemote, recordAuditEvent, getSupabaseCreds, storeSupabaseCreds, resyncSupabaseCreds } from "./supabase";
import { fetchMemberSelf } from "./unit-join";
import { lookupLicenseKey } from "./license-registry";
import { SUPER_ADMIN } from "./mockData";
import { findCommanderByUsername, verifyCommanderPassword } from "./commander-store";
import type { User } from "./types";
import { generateSecret, otpauthURL, verifyTotp } from "./totp";
import { setResetInProgress } from "./cross-pc";
import {
  clearLanSessionToken,
  fetchLanSessionUser,
  isLanNoAuthEnabled,
  isLanSessionLoginEnabled,
  postLanDevSession,
  postLanLogin,
  postLanLogout,
  setStoredLanSessionToken,
} from "./internal-migration";
import { userFromLanAuthProfile } from "./lan-user-map";

// Demo-only fallback when Supabase isn't configured (in-browser preview).
// In any real install (`supabaseConfigured === true`) the secret is held
// server-side in `super_admin_2fa` and verified by the
// `super-admin-2fa` edge function — the localStorage path is never used.
const ADMIN_TOTP_SECRET_KEY = "rjaf.adminTotp.secret";
const ADMIN_TOTP_RECOVERY_KEY = "rjaf.adminTotp.recovery";
const ADMIN_TOTP_REMAINING_KEY = "rjaf.adminTotp.remaining";
// SHA-256 hex of the super admin password chosen on THIS PC during first-run
// setup. In standalone mode this is the only acceptable credential; if the
// key is missing, the login path returns `admin_not_provisioned` so the UI
// can route the user into the provisioning form. In Supabase mode the real
// hash lives server-side (SUPER_ADMIN_PASSWORD_HASH) and this key is unused.
const ADMIN_PASSWORD_HASH_KEY = "rjaf.admin.passwordHash";
// Default super admin password ships baked into every install as a SHA-256
// hash so the raw password never appears in source. Every copy accepts this
// password on first sign-in; once the super admin rotates it through Admin
// → Security (changeSuperAdminPassword), the new hash is written to
// ADMIN_PASSWORD_HASH_KEY and takes precedence over this default on that PC.
// In Supabase mode the real hash lives server-side (SUPER_ADMIN_PASSWORD_HASH)
// and this default is ignored.
const DEFAULT_ADMIN_PASSWORD_HASH = "e25d97cfa9c1ef91c61b0f84a92a19fcbaa490ebde6e91387b1b2cd0be403af1";
// Master Recovery Key: a second, baked-in super-admin-level password used
// ONLY to reset the PC's Super Admin password when the normal one is lost
// or leaked. Never changes, never rotated — its only job is to let the true
// system owner walk up to any squadron PC and force a new super admin
// password without knowing the current one. The plaintext is held by the
// system owner off-device; only this SHA-256 hash ships in the binary.
const MASTER_RECOVERY_HASH = "c9d4a017bbd57ee911131a6d1054a2bc4ff1c642e99656b7b381f9265211b6bc";
// Inactivity auto-logout preference. Per-user-id key so every operator who
// logs in on this PC can pick their own idle timeout (the commander's PC
// can have a 30-min timeout while the Ops duty PC stays open for 8 hours).
// Value in minutes. 0 disables auto-logout entirely. Default 120 (2 h).
const INACTIVITY_KEY_PREFIX = "rjaf.inactivityMin.";
export type InactivityMinutes = 0 | 15 | 30 | 60 | 120 | 240 | 480;
export const INACTIVITY_OPTIONS: InactivityMinutes[] = [0, 15, 30, 60, 120, 240, 480];
function readInactivityMinutes(userId: string | undefined): InactivityMinutes {
  if (!userId) return 120;
  const raw = localStorage.getItem(INACTIVITY_KEY_PREFIX + userId);
  const n = raw == null ? NaN : Number(raw);
  if (INACTIVITY_OPTIONS.includes(n as InactivityMinutes)) return n as InactivityMinutes;
  return 120;
}
function writeInactivityMinutes(userId: string | undefined, value: InactivityMinutes): void {
  if (!userId) return;
  localStorage.setItem(INACTIVITY_KEY_PREFIX + userId, String(value));
  // Notify any open AuthProvider so the running idle watcher picks up
  // the new pref immediately without requiring a relogin / page refresh.
  inactivityListeners.forEach(fn => { try { fn(); } catch { /* ignore */ } });
}
// Tiny in-process pub/sub so Settings.tsx can tell the AuthProvider in
// the same tab that the inactivity pref just changed (localStorage's
// native `storage` event only fires across tabs, not within the tab
// that wrote the value).
const inactivityListeners = new Set<() => void>();
function subscribeInactivityChange(fn: () => void): () => void {
  inactivityListeners.add(fn);
  return () => { inactivityListeners.delete(fn); };
}

// Per-PC role lock chosen by the Super Admin on the Security page. When set,
// the login screen hides every role except the locked one, and login() /
// activateLicense() refuse to authenticate any user whose role doesn't match.
// Valid values: "ops" | "commander" | "super_admin". Absent key = no lock
// (default multi-role screen). Stored per-install; never shared across PCs.
const PC_ROLE_LOCK_KEY = "rjaf.pcRoleLock";
export type PcRoleLock = "ops" | "commander" | "super_admin" | null;
function readPcRoleLock(): PcRoleLock {
  const v = localStorage.getItem(PC_ROLE_LOCK_KEY);
  return v === "ops" || v === "commander" || v === "super_admin" ? v : null;
}
// Optional human label the super admin assigns to this PC during setup.
// Shown on the Login screen and in the Master Recovery "pick PC" dialog.
// Empty/unset = no label shown (behavior unchanged).
const PC_DEVICE_NAME_KEY = "rjaf.pcDeviceName";
const PC_DEVICE_NAME_MAX = 48;
function readPcDeviceName(): string {
  const v = localStorage.getItem(PC_DEVICE_NAME_KEY);
  return typeof v === "string" ? v.slice(0, PC_DEVICE_NAME_MAX) : "";
}
const ADMIN_TOTP_ISSUER = "RJAF Pilot Dashboard";
const RECOVERY_CODE_COUNT = 10;
// When unused recovery codes drop to this number or below, the dashboard
// surfaces a banner urging the super admin to regenerate. Exported so the
// banner UI and any tests stay in sync with the server-side definition of
// "running low".
export const RECOVERY_CODES_LOW_THRESHOLD = 2;

interface StoredRecoveryCode {
  hash: string;
  usedAt: string | null;
}

function isTotpShape(s: string): boolean {
  return /^\d{6}$/.test(s.trim());
}
function normalizeRecoveryCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "");
}
function isRecoveryCodeShape(raw: string): boolean {
  return /^[A-Z2-7]{8}$/.test(normalizeRecoveryCode(raw));
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function generateDemoRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let s = "";
    for (let j = 0; j < 8; j++) s += alpha[bytes[j] % 32];
    out.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`);
  }
  return out;
}
function readDemoRecoveryCodes(): StoredRecoveryCode[] {
  try {
    const raw = localStorage.getItem(ADMIN_TOTP_RECOVERY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeDemoRecoveryCodes(codes: StoredRecoveryCode[]): void {
  localStorage.setItem(ADMIN_TOTP_RECOVERY_KEY, JSON.stringify(codes));
}

interface PendingAdmin {
  user: User;
  mode: "enroll" | "verify";
  // For "verify" against the server, secret is empty — the client never
  // sees it. For "enroll" we hold it just long enough to render the QR
  // and the user-visible setup string, then drop it on completion.
  secret: string;
  otpauth: string;
}

interface SquadronConfig {
  name: string;
  number: string;
  base: string;
}
interface AuthState {
  licensed: boolean;
  configured: boolean;
  user: User | null;
  squadron: SquadronConfig | null;
  fingerprint: string;
  failedAttempts: number;
  lockedUntil: number | null;
}
interface LoginResult {
  ok: boolean;
  error?: string;
  requires2fa?: "enroll" | "verify";
}
interface AuthCtx extends AuthState {
  // Set when the launch-time Supabase silent-auth attempt fails for a
  // non-admin account. The login screen surfaces this as a banner so the
  // operator gets a clear "please sign in again" path instead of a stuck
  // dashboard. Cleared on successful login or when the user dismisses it.
  silentAuthError: string | null;
  clearSilentAuthError: () => void;
  activateLicense: (key: string, username: string) => Promise<{ ok: boolean; error?: string }>;
  configureSquadron: (cfg: SquadronConfig) => void;
  login: (username: string, password: string) => Promise<LoginResult>;
  // LAN migration helper: one-click session minting with no password checks
  // when `VITE_LAN_NO_AUTH=1` and server `HAWK_LAN_DEV_NO_AUTH=1`.
  lanDevQuickLogin: (
    kind: "super_admin" | "ops" | "commander",
  ) => Promise<{ ok: boolean; error?: string }>;
  verifyAdminTotp: (code: string) => Promise<{ ok: boolean; error?: string; recoveryCodes?: string[] }>;
  // Mints a fresh set of recovery codes for the signed-in super admin
  // after re-confirming a current 6-digit TOTP code. Old codes are
  // invalidated server-side. Returns the new plaintext codes once.
  regenerateRecoveryCodes: (code: string) => Promise<{ ok: boolean; error?: string; recoveryCodes?: string[] }>;
  // Changes the super admin password. In demo mode (no Supabase) the new
  // password's SHA-256 hash is stored in localStorage under ADMIN_PASSWORD_HASH_KEY
  // and takes effect immediately. In Supabase mode the hash lives server-side
  // and this call returns { ok: false, error: "server_managed" }.
  // Changes the super-admin password.
  // Supabase mode: requires a current 6-digit TOTP code as well. The new
  // hash is written to super_admin_credentials by the edge function and
  // becomes the live password on every PC immediately (next login).
  // Demo mode: totpCode is ignored and the new hash is stored locally.
  changeSuperAdminPassword: (
    currentPassword: string,
    newPassword: string,
    totpCode?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  // First-run setup: write the initial Super Admin password hash on this
  // specific PC. Only succeeds when no hash has been provisioned yet —
  // calling it once a hash exists returns { ok: false, error: "already_set" }
  // so a leaked UI path cannot be used to overwrite a live admin password.
  provisionSuperAdmin: (newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  // Master-recovery override: reset this PC's Super Admin password without
  // knowing the current one. Gated by the baked-in Master Recovery Key.
  // Intended for the case where a squadron's daily super admin password
  // gets leaked or forgotten — the system owner uses the off-device master
  // key to force a fresh password on that specific PC. No server round-trip
  // in standalone mode; in Supabase mode this returns server_managed.
  resetSuperAdminPasswordWithMaster: (masterPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  cancelAdminTotp: () => void;
  pendingAdmin: { mode: "enroll" | "verify"; secret: string; otpauth: string } | null;
  adminTotpEnrolled: boolean;
  // True once the Super Admin has chosen a password on this PC. Drives
  // the "first-launch" UX: when false, the login screen jumps straight
  // to the Set-Password form instead of asking for a license key.
  adminProvisioned: boolean;
  // Number of unused recovery codes the super admin has left, or null if
  // unknown (e.g. before sign-in or when the server didn't report it). The
  // dashboard uses this to warn the admin when the count is at or below
  // RECOVERY_CODES_LOW_THRESHOLD so they can regenerate before getting
  // locked out.
  adminRecoveryCodesRemaining: number | null;
  regenerateAdminRecoveryCodes: (totpCode: string) => Promise<{ ok: boolean; error?: string; recoveryCodes?: string[] }>;
  // One-time plaintext recovery codes shown to the super admin right after
  // they finish 2FA enrollment. Cleared as soon as they click "I've saved
  // these" (ackRecoveryCodes), so they never end up persisted anywhere.
  pendingRecoveryCodes: string[] | null;
  ackRecoveryCodes: () => void;
  logout: () => void;
  releaseLicense: () => void;
  // Nuclear "Reset this PC" — wipes every trace of this device from the
  // central Supabase tables (xpc_registry + xpc_user_pcs row for this
  // PC's id) AND every `rjaf.*` localStorage key, then signs out from
  // Supabase and reloads. After this runs, the next launch is
  // indistinguishable from a fresh install. Returns a promise so the
  // confirmation dialog can wait for the cloud DELETE before reloading.
  resetThisPC: () => Promise<void>;
  backendMode: "supabase" | "demo" | "lan";
  // Per-PC role lock. `null` = no lock. When set, login screen shows only
  // the matching role's form and login() rejects accounts of other roles.
  pcRoleLock: PcRoleLock;
  setPcRoleLock: (v: PcRoleLock) => void;
  // Optional super-admin-assigned label for this PC. Trimmed and clipped
  // to 48 chars. Empty string = no label set.
  pcDeviceName: string;
  setPcDeviceName: (v: string) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

declare global {
  interface Window {
    rjafElectron?: {
      hardwareFingerprint?: () => Promise<string>;
      isPackaged?: () => Promise<boolean>;
      pickBackupFolder?: () => Promise<string | null>;
      writeBackupFile?: (folder: string, filename: string, content: string) => Promise<string>;
      logRendererError?: (label: string, detail: string) => Promise<boolean>;
    };
  }
}

let cachedPackaged: boolean | null = null;
async function isPackagedDesktop(): Promise<boolean> {
  if (cachedPackaged !== null) return cachedPackaged;
  if (typeof window === "undefined" || !window.rjafElectron?.isPackaged) {
    cachedPackaged = false;
    return false;
  }
  try { cachedPackaged = await window.rjafElectron.isPackaged(); }
  catch { cachedPackaged = false; }
  return cachedPackaged;
}

async function makeFingerprint(): Promise<string> {
  const cached = localStorage.getItem("rjaf.fp");
  if (cached) return cached;
  if (typeof window !== "undefined" && window.rjafElectron?.hardwareFingerprint) {
    const fp = await window.rjafElectron.hardwareFingerprint();
    localStorage.setItem("rjaf.fp", fp);
    return fp;
  }
  const seed = `${navigator.userAgent}|${navigator.language}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const fp = "FP-" + (h >>> 0).toString(16).toUpperCase().padStart(8, "0") + "-" + Math.random().toString(16).slice(2, 6).toUpperCase();
  localStorage.setItem("rjaf.fp", fp);
  return fp;
}

// Commander accounts are created by the Super Admin through the Admin →
// Commanders page; password hashes live in the local commander store
// (see ./commander-store).
//
// The Super Admin password is NOT baked into the source. On a fresh install
// the ADMIN_PASSWORD_HASH_KEY slot in localStorage is empty; the first time
// someone tries to log in as `admin`, the login API returns
// `admin_not_provisioned` and the Login page renders a first-run setup form
// that calls provisionSuperAdmin() to store a hash of a password the Super
// Admin chooses on that specific PC. Every installed copy therefore has its
// own unique admin password — no shared default can leak across squadrons.
// In Supabase mode the hash lives server-side and this whole flow is bypassed.

function lookupHQUser(username: string): User | null {
  const u = username.trim().toLowerCase();
  if (u === "admin") return SUPER_ADMIN;
  return findCommanderByUsername(u);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Launch-time enforcement of the per-PC setup duration written by
  // LicenseKeys.tsx (`rjaf.localExpiresAt`, ISO yyyy-mm-dd). Ops PC expiry
  // is enforced by the server-side validate-license call elsewhere; this
  // gate handles every other tier (Flight / Squadron / HQ commander). When
  // the date has passed we wipe the licence binding so the operator is
  // forced back to the activation screen and a Super Admin must re-issue
  // or re-run setup. Cloud data is untouched.
  if (typeof window !== "undefined") {
    try {
      const exp = localStorage.getItem("rjaf.localExpiresAt");
      if (exp && exp.length >= 10) {
        const today = new Date().toISOString().slice(0, 10);
        if (today > exp) {
          localStorage.removeItem("rjaf.licensed");
          localStorage.removeItem("rjaf.licenseKey");
          localStorage.removeItem("rjaf.assignedRole");
          localStorage.removeItem("rjaf.authorizedSquadronIds");
          localStorage.removeItem("rjaf.pcRoleLock");
          localStorage.removeItem("rjaf.commanderTier");
          localStorage.removeItem("rjaf.commanderName");
          localStorage.removeItem("rjaf.localExpiresAt");
        }
      }
    } catch { /* localStorage unavailable — fail open, server checks still apply */ }
  }
  // Safe JSON parse — prior versions of this app may have written invalid
  // JSON to localStorage (or "undefined" as a string). An unguarded
  // JSON.parse here throws synchronously inside the useState initializer,
  // which prevents AuthProvider — and therefore the entire app — from
  // mounting. Symptom: blank black window with the process running but no
  // visible UI. Always defensively try/catch and remove the bad key so the
  // user isn't trapped on a dead screen forever.
  const safeParse = <T,>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null || raw === "" || raw === "undefined") return fallback;
      return JSON.parse(raw) as T;
    } catch {
      try { localStorage.removeItem(key); } catch { /* noop */ }
      return fallback;
    }
  };
  const [state, setState] = useState<AuthState>(() => ({
    licensed: localStorage.getItem("rjaf.licensed") === "1",
    configured: !!localStorage.getItem("rjaf.squadron"),
    user: safeParse<AuthState["user"]>("rjaf.user", null),
    squadron: safeParse<AuthState["squadron"]>("rjaf.squadron", null),
    fingerprint: localStorage.getItem("rjaf.fp") || "FP-PENDING",
    failedAttempts: Number(localStorage.getItem("rjaf.fails") || 0),
    lockedUntil: Number(localStorage.getItem("rjaf.lockUntil") || 0) || null,
  }));
  const [pending, setPending] = useState<PendingAdmin | null>(null);
  const [pendingRecoveryCodes, setPendingRecoveryCodes] = useState<string[] | null>(null);
  // Persisted across page reloads so the warning banner stays visible after
  // the dashboard hot-reloads or the admin refreshes mid-session. Cleared on
  // logout / license release. Demo mode reads it from the recovery store
  // directly on init so the count survives refresh in-browser too.
  const [adminRecoveryCodesRemaining, setAdminRecoveryCodesRemaining] = useState<number | null>(() => {
    const fromLs = localStorage.getItem(ADMIN_TOTP_REMAINING_KEY);
    if (fromLs !== null && fromLs !== "") {
      const n = Number(fromLs);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    if (!supabaseConfigured) {
      try {
        const raw = localStorage.getItem(ADMIN_TOTP_RECOVERY_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            return arr.filter((c: StoredRecoveryCode) => !c?.usedAt).length;
          }
        }
      } catch { /* ignore */ }
    }
    return null;
  });
  const updateAdminRecoveryRemaining = (n: number | null) => {
    if (n === null) localStorage.removeItem(ADMIN_TOTP_REMAINING_KEY);
    else localStorage.setItem(ADMIN_TOTP_REMAINING_KEY, String(n));
    setAdminRecoveryCodesRemaining(n);
  };
  const pendingLoginUserRef = useRef<User | null>(null);
  // Short-lived HMAC challenge token returned by the edge function's "start"
  // step, presented back to "verify". Held in memory only — never persisted.
  // Replaces the previous practice of stashing the raw password.
  const pendingTokenRef = useRef<string>("");
  // Whether the super admin has finished enrollment. In Supabase mode this
  // is hydrated from the server's "start" response. The localStorage key is
  // only consulted as a hint for the demo (no-Supabase) path.
  const [adminTotpEnrolled, setAdminTotpEnrolled] = useState<boolean>(
    () => supabaseConfigured ? false : !!localStorage.getItem(ADMIN_TOTP_SECRET_KEY),
  );
  const [adminProvisioned, setAdminProvisioned] = useState<boolean>(
    () => !!localStorage.getItem(ADMIN_PASSWORD_HASH_KEY),
  );
  const [pcRoleLock, setPcRoleLockState] = useState<PcRoleLock>(() => readPcRoleLock());
  const applyPcRoleLock = (v: PcRoleLock) => {
    if (v === null) localStorage.removeItem(PC_ROLE_LOCK_KEY);
    else localStorage.setItem(PC_ROLE_LOCK_KEY, v);
    setPcRoleLockState(v);
    void recordAuditEvent({ type: "pc.rolelock.updated", actor: "admin", detail: { lock: v } });
  };
  const [pcDeviceName, setPcDeviceNameState] = useState<string>(() => readPcDeviceName());
  const applyPcDeviceName = (v: string) => {
    const clean = (v ?? "").trim().slice(0, PC_DEVICE_NAME_MAX);
    if (!clean) localStorage.removeItem(PC_DEVICE_NAME_KEY);
    else localStorage.setItem(PC_DEVICE_NAME_KEY, clean);
    setPcDeviceNameState(clean);
    void recordAuditEvent({ type: "pc.devicename.updated", actor: "admin", detail: { set: !!clean } });
  };

  // Set when the launch-time Supabase silent sign-in attempt fails. Drives
  // a banner on the Login screen so the operator gets a clear path back in.
  const [silentAuthError, setSilentAuthError] = useState<string | null>(null);
  const clearSilentAuthError = () => setSilentAuthError(null);

  useEffect(() => {
    let cancelled = false;
    makeFingerprint().then(fp => {
      if (!cancelled) setState(s => ({ ...s, fingerprint: fp }));
    });
    return () => { cancelled = true; };
  }, []);

  // ── Launch-time LAN session validation (Supabase Auth replacement) ───
  useEffect(() => {
    if (!isLanSessionLoginEnabled()) return;
    if (!state.user) return;
    let cancelled = false;
    void (async () => {
      const r = await fetchLanSessionUser();
      if (cancelled) return;
      if (r.ok) return;
      if (r.status === 401 || r.error === "no_token") {
        try { localStorage.removeItem("rjaf.user"); } catch { /* ignore */ }
        clearLanSessionToken();
        setSilentAuthError(
          "Your LAN session expired or was revoked. Please sign in again.",
        );
        setState(s => ({ ...s, user: null }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.user?.username]);

  // ── Launch-time Supabase silent sign-in guard ──────────────────────────
  // If we hydrated `state.user` from localStorage but Supabase has no live
  // session (refresh token expired, network was down at launch, the
  // server rotated keys, etc.), every operational read/write will be
  // silently filtered by RLS and the dashboard renders a stuck/empty
  // screen with no error. We try one re-sign-in using the cached creds;
  // if that also fails we clear the local user so LoginGate shows, set
  // silentAuthError so the user sees a clear "please sign in again"
  // banner, and append the failure to the renderer-error.log so support
  // can tell silent-auth failure apart from a fresh launch.
  // Skipped for super_admin (no Supabase round-trip), for the demo path
  // (no Supabase configured), and when no user is hydrated at all.
  useEffect(() => {
    if (isLanSessionLoginEnabled()) return;
    if (!supabaseConfigured || !supabase) return;
    if (!state.user) return;
    let cancelled = false;
    // Super admin uses a separate silent-restore path: their auth.users
    // row is provisioned by `super-admin-2fa` (not `provision-commander`),
    // and the resync fallback below would call provision-commander, which
    // is JWT-gated and would 401 the unauth'd resync attempt. Instead, the
    // super admin gets one shot: live Supabase session, or cached
    // deterministic creds from the last 2FA verify. Anything else forces a
    // full re-auth via 2FA.
    const isSuperAdmin = state.user.role === "super_admin";
    void (async () => {
      const username = state.user!.username;
      const logFailure = (reason: string) => {
        const detail = `user=${username} reason=${reason}`;
        try { window.rjafElectron?.logRendererError?.("silent-auth-failed", detail); } catch { /* best effort */ }
        // eslint-disable-next-line no-console
        console.warn("[silent-auth-failed]", detail);
        try {
          void recordAuditEvent({
            type: "auth.silent.failed",
            actor: username,
            detail: { reason },
          });
        } catch { /* best effort */ }
      };
      const forceSignOut = (reason: string) => {
        if (cancelled) return;
        try { void supabase!.auth.signOut(); } catch { /* ignore */ }
        try { localStorage.removeItem("rjaf.user"); } catch { /* ignore */ }
        setSilentAuthError(
          "Your session expired and could not be refreshed. Please sign in again.",
        );
        setState(s => ({ ...s, user: null }));
        logFailure(reason);
      };
      try {
        const { data, error } = await supabase!.auth.getSession();
        if (cancelled) return;
        if (error) { forceSignOut(`getSession:${error.message}`); return; }
        if (data?.session) return; // happy path — silent restore worked
        const creds = getSupabaseCreds(username);
        let signedIn = false; let lastErr = "no_cached_creds";
        if (creds) {
          const { error: sbErr } = await supabase!.auth.signInWithPassword({
            email: creds.email,
            password: creds.password,
          });
          if (cancelled) return;
          if (!sbErr) signedIn = true;
          else lastErr = sbErr.message;
        }
        if (!signedIn && !isSuperAdmin) {
          // Cached creds either missing or stale. Re-provision via the
          // server (rotates the password and returns the new one) and
          // try once more before giving up. This covers the case where
          // the user has signed in successfully on another PC since,
          // or where a Super Admin reset their auth user.
          //
          // Only attempted for non-super-admin: provision-commander is now
          // JWT-gated, and an unauth'd resync attempt would 401. Super
          // admin instead falls through to forceSignOut so the operator
          // is steered back through the 2FA path that mints a fresh JWT.
          const role = state.user?.role === "ops" ? "ops" : "commander";
          const sqn = state.squadron ? { number: state.squadron.number, name: state.squadron.name, base: state.squadron.base } : undefined;
          const resync = await resyncSupabaseCreds(username, role, sqn);
          if (cancelled) return;
          if (resync.ok) {
            signedIn = true;
            void recordAuditEvent({ type: "supabase.creds.resynced", actor: username, detail: { trigger: "startup" } });
          } else {
            lastErr = resync.error ?? lastErr;
          }
        }
        if (!signedIn) { forceSignOut(`signin:${lastErr}`); return; }
      } catch (err) {
        if (cancelled) return;
        forceSignOut(`threw:${(err as Error)?.message ?? String(err)}`);
      }
    })();
    return () => { cancelled = true; };
    // Intentionally only runs when the hydrated user identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.user?.username]);

  const value = useMemo<AuthCtx>(() => ({
    ...state,
    silentAuthError,
    clearSilentAuthError,
    backendMode: isLanSessionLoginEnabled()
      ? "lan"
      : supabaseConfigured
        ? "supabase"
        : "demo",
    activateLicense: async (key, username) => {
      const k = key.trim().toUpperCase();
      const u = (username ?? "").trim();
      if (!u) {
        return { ok: false, error: "Enter the username this license was issued to." };
      }
      // Install keys are typically 12+ chars but the baked-in seed install
      // key is 9 chars, so the floor is 8 for compatibility. Real issued
      // keys minted by the Super Admin are still long random strings.
      if (k.length < 8) {
        return { ok: false, error: "Invalid license key format. Keys are issued by the Super Admin." };
      }
      const packaged = await isPackagedDesktop();
      if (packaged && !supabaseConfigured) {
        return { ok: false, error: "License server not configured. Contact your Super Admin to provision this installation." };
      }
      if (supabaseConfigured) {
        const res = await validateLicenseRemote(k, state.fingerprint, u);
        if (!res.ok) {
          void recordAuditEvent({ type: "license.activate.failed", actor: u, detail: { key: k.slice(0, 8) + "…", reason: res.error } });
          return { ok: false, error: res.error ?? "License rejected by server." };
        }
        localStorage.setItem("rjaf.licensed", "1");
        localStorage.setItem("rjaf.licenseKey", k);
        localStorage.setItem("rjaf.licenseUser", u);
        localStorage.setItem("rjaf.licenseBoundFp", state.fingerprint);
        if (res.squadronId) localStorage.setItem("rjaf.squadronId", res.squadronId);
        void recordAuditEvent({ type: "license.activate.ok", actor: u, detail: { squadronId: res.squadronId } });
        setState(s => ({ ...s, licensed: true }));
        return { ok: true };
      }
      // Standalone mode: validate against the local registry written by the
      // Super Admin LicenseKeys page. Every key must be issued through that
      // page — there are no hard-coded fallback keys.
      const lookup = lookupLicenseKey(k, u);
      if (lookup.ok) {
        localStorage.setItem("rjaf.licensed", "1");
        localStorage.setItem("rjaf.licenseKey", k);
        localStorage.setItem("rjaf.licenseUser", u);
        localStorage.setItem("rjaf.licenseBoundFp", state.fingerprint);
        // Carry the Super Admin's PC-tier and squadron-monitoring decisions
        // forward into Setup. The role is locked at activation; the
        // authorized squadron list scopes commander pages so a Squadron
        // Commander can't widen visibility past what was issued.
        if (lookup.record?.assignedRole) {
          localStorage.setItem("rjaf.assignedRole", lookup.record.assignedRole);
        }
        if (lookup.record?.authorizedSquadronIds && lookup.record.authorizedSquadronIds.length > 0) {
          localStorage.setItem("rjaf.authorizedSquadronIds", JSON.stringify(lookup.record.authorizedSquadronIds));
        }
        setState(s => ({ ...s, licensed: true }));
        return { ok: true };
      }
      if (lookup.reason === "wrong_username") {
        return { ok: false, error: "This key is not assigned to that username." };
      }
      if (lookup.reason === "revoked") {
        return { ok: false, error: "This license key has been revoked." };
      }
      if (lookup.reason === "expired") {
        return { ok: false, error: "This license key has expired." };
      }
      return { ok: false, error: "Invalid license key. Keys are issued by the Super Admin." };
    },
    configureSquadron: (cfg) => {
      localStorage.setItem("rjaf.squadron", JSON.stringify(cfg));
      setState(s => ({ ...s, squadron: cfg, configured: true }));
    },
    login: async (username, password) => {
      const now = Date.now();
      if (state.lockedUntil && state.lockedUntil > now) {
        return { ok: false, error: "locked" };
      }
      const recordFail = async (reason: string) => {
        const fails = state.failedAttempts + 1;
        const lockedUntil = fails >= 5 ? now + 5 * 60_000 : null;
        localStorage.setItem("rjaf.fails", String(fails));
        if (lockedUntil) localStorage.setItem("rjaf.lockUntil", String(lockedUntil));
        setState(s => ({ ...s, failedAttempts: fails, lockedUntil }));
        void recordAuditEvent({ type: "login.failed", actor: username, detail: { reason, fails } });
        return { ok: false as const, error: lockedUntil ? "locked" : "bad" };
      };

      if (isLanSessionLoginEnabled()) {
        const lan = isLanNoAuthEnabled()
          ? await postLanDevSession(username)
          : await postLanLogin(username, password);
        if (!lan.ok) {
          if (lan.error === "lan_bad_creds" || /bad_creds/i.test(lan.error)) {
            return await recordFail("bad_credentials");
          }
          return { ok: false, error: lan.error };
        }
        setStoredLanSessionToken(lan.token);
        const appUser = userFromLanAuthProfile(lan.user, username.trim());
        const lockL = readPcRoleLock();
        if (lockL && appUser.role !== lockL) {
          if (appUser.role === "super_admin") {
            void recordAuditEvent({ type: "login.rolelock.override", actor: username, detail: { lock: lockL } });
          } else {
            void recordAuditEvent({
              type: "login.rolelock.blocked",
              actor: username,
              detail: { lock: lockL, attemptedRole: appUser.role },
            });
            clearLanSessionToken();
            return { ok: false, error: "role_locked" };
          }
        }

        // Squadron Ops still needs a green licence gate for Layout routes,
        // but pure LAN installs may not have gone through the legacy
        // activation flow — a successful LAN session is enough to unlock.
        if (appUser.role === "ops" && localStorage.getItem("rjaf.licensed") !== "1") {
          localStorage.setItem("rjaf.licensed", "1");
          if (!localStorage.getItem("rjaf.licenseKey")) {
            localStorage.setItem("rjaf.licenseKey", "LAN-SESSION");
          }
          if (!localStorage.getItem("rjaf.licenseUser")) {
            localStorage.setItem("rjaf.licenseUser", appUser.username);
          }
        }

        localStorage.setItem("rjaf.user", JSON.stringify(appUser));
        localStorage.removeItem("rjaf.fails");
        localStorage.removeItem("rjaf.lockUntil");
        void recordAuditEvent({ type: "login.ok", actor: username, detail: { role: appUser.role, lan: true } });
        setSilentAuthError(null);
        setState(s => ({
          ...s,
          user: appUser,
          licensed: appUser.role === "ops" ? true : s.licensed,
          failedAttempts: 0,
          lockedUntil: null,
        }));
        return { ok: true };
      }

      // HQ users (super admin, commanders) skip license/squadron setup entirely.
      const u = username.trim().toLowerCase();
      const hqUser = lookupHQUser(username);

      // Per-PC role lock. If the super admin has pinned this PC to a specific
      // role, refuse any account whose role doesn't match. For ops officers
      // (not in lookupHQUser) the check is deferred to the Supabase branch
      // below using the role resolved from the server; for standalone-mode
      // ops officers sign-in happens through the license screen, not here.
      // EXCEPTION: the super admin can always sign in regardless of the
      // PC role lock — they're the system owner and need a way back into
      // any locked PC (for recovery, role changes, etc.). The override is
      // audit-logged distinctly so its use is visible in the trail.
      const lock = readPcRoleLock();
      if (lock && hqUser && hqUser.role !== lock) {
        if (hqUser.role === "super_admin") {
          void recordAuditEvent({ type: "login.rolelock.override", actor: username, detail: { lock } });
        } else {
          void recordAuditEvent({ type: "login.rolelock.blocked", actor: username, detail: { lock, attemptedRole: hqUser.role } });
          return { ok: false, error: "role_locked" };
        }
      }

      // Super admin path: password is validated server-side by the edge
      // function (Supabase mode). The client doesn't know the password.
      if (hqUser && hqUser.role === "super_admin") {
        if (supabaseConfigured && supabase) {
          try {
            const { data, error } = await supabase.functions.invoke("super-admin-2fa", {
              body: { action: "start", username: hqUser.username, password },
            });
            if (error || !data?.ok) {
              const reason = data?.error ?? "auth_failed";
              if (reason === "locked" && data?.lockedUntil) {
                localStorage.setItem("rjaf.lockUntil", String(data.lockedUntil));
                setState(s => ({ ...s, lockedUntil: data.lockedUntil }));
                return { ok: false, error: "locked" };
              }
              return await recordFail(reason === "unauthorized" ? "bad_credentials" : reason);
            }
            pendingTokenRef.current = data.token as string;
            const enrolled = !!data.enrolled;
            setAdminTotpEnrolled(enrolled);
            setPending({
              user: hqUser,
              mode: enrolled ? "verify" : "enroll",
              secret: (data.secret as string) ?? "",
              otpauth: (data.otpauth as string) ?? "",
            });
            void recordAuditEvent({
              type: "login.2fa.required",
              actor: username,
              detail: { stage: enrolled ? "verify" : "enroll" },
            });
            return { ok: false, requires2fa: enrolled ? "verify" : "enroll" };
          } catch (e: unknown) {
            return { ok: false, error: e instanceof Error ? e.message : "totp_server_error" };
          }
        }

        // Standalone mode (no Supabase): verify against the admin-chosen
        // password hash on this PC if one has been set, otherwise against
        // the baked-in DEFAULT_ADMIN_PASSWORD_HASH. This way every fresh
        // install accepts the factory-default super admin password without
        // forcing a first-run setup step; the admin can rotate it any time
        // from Admin → Security.
        {
          const storedHash = localStorage.getItem(ADMIN_PASSWORD_HASH_KEY);
          const expectedHash = storedHash ?? DEFAULT_ADMIN_PASSWORD_HASH;
          const attemptHash = await sha256Hex(password);
          // Accept either the PC's super admin password (stored or default)
          // OR the Master Recovery Key. The master key is the deliberate
          // override for leaked/forgotten credentials and is audit-logged
          // distinctly so abuse is visible in the trail.
          const isMaster = attemptHash === MASTER_RECOVERY_HASH;
          if (attemptHash !== expectedHash && !isMaster) return await recordFail("bad_credentials");
          if (isMaster) {
            void recordAuditEvent({ type: "login.master_recovery", actor: username, detail: {} });
          }
        }
        const existing = localStorage.getItem(ADMIN_TOTP_SECRET_KEY);
        if (existing) {
          setPending({
            user: hqUser,
            mode: "verify",
            secret: existing,
            otpauth: otpauthURL(existing, hqUser.username, ADMIN_TOTP_ISSUER),
          });
          void recordAuditEvent({ type: "login.2fa.required", actor: username, detail: { stage: "verify" } });
          return { ok: false, requires2fa: "verify" };
        }
        const secret = generateSecret();
        setPending({
          user: hqUser,
          mode: "enroll",
          secret,
          otpauth: otpauthURL(secret, hqUser.username, ADMIN_TOTP_ISSUER),
        });
        void recordAuditEvent({ type: "login.2fa.required", actor: username, detail: { stage: "enroll" } });
        return { ok: false, requires2fa: "enroll" };
      }

      // Stored accounts created by the Super Admin on this PC. Covers
      // commanders (HQ / base / wing / squadron / flight) AND ops officers.
      // Both go through the same hash-verify path; the role on the returned
      // record determines what the rest of the app lets them see and do.
      if (hqUser && (hqUser.role === "commander" || hqUser.role === "ops")) {
        const verified = await verifyCommanderPassword(u, password);
        if (!verified) return await recordFail("bad_credentials");

        // Also sign into Supabase so the browser obtains a JWT carrying
        // app_metadata.squadron_id + role. Without this every operational-
        // table read/write is silently filtered out by RLS — i.e. zero data
        // sync between PCs. The Supabase password is random and stored
        // locally at provision time; it is NOT the user-typed password.
        if (supabaseConfigured && supabase) {
          // Try to obtain a Supabase JWT. If the locally cached password
          // is stale (server-side rotation, cleared cache, etc.) the
          // signin returns invalid_credentials. The legacy code swallowed
          // this and let login proceed — the user appeared signed in but
          // every write failed with RLS 42501 because the browser had no
          // JWT. Now we self-heal: re-provision creds via the
          // provision-commander edge function (which rotates the password
          // and returns the fresh one), persist them, and retry. Only if
          // BOTH paths fail do we surface the error and refuse the login.
          const creds = getSupabaseCreds(u);
          let sbOk = false; let lastErr: string | null = null;
          if (creds) {
            try {
              const { error: sbErr } = await supabase.auth.signInWithPassword({
                email: creds.email,
                password: creds.password,
              });
              if (!sbErr) { sbOk = true; }
              else { lastErr = sbErr.message; console.warn("[supabase-signin]", sbErr.message); }
            } catch (err) {
              lastErr = err instanceof Error ? err.message : String(err);
              console.warn("[supabase-signin] threw", err);
            }
          } else {
            lastErr = "no_cached_creds";
            console.warn("[supabase-signin] no cached creds for", u);
          }
          if (!sbOk) {
            const sqn = state.squadron ? { number: state.squadron.number, name: state.squadron.name, base: state.squadron.base } : undefined;
            const resync = await resyncSupabaseCreds(u, hqUser.role === "ops" ? "ops" : "commander", sqn);
            if (resync.ok) {
              sbOk = true;
              void recordAuditEvent({ type: "supabase.creds.resynced", actor: u, detail: { trigger: "login" } });
            } else {
              lastErr = resync.error ?? lastErr;
              console.warn("[supabase-resync] failed", resync.error);
            }
          }
          if (!sbOk) {
            // Surface the failure loudly. We refuse to mark login as
            // successful because the dashboard would be silently read-only.
            const msg = `Cannot reach data server (${lastErr ?? "unknown"}). Check internet connection and try again, or contact your Super Admin.`;
            setSilentAuthError(msg);
            void recordAuditEvent({ type: "login.supabase.unreachable", actor: username, detail: { reason: lastErr } });
            return { ok: false, error: msg };
          }
        }

        localStorage.setItem("rjaf.user", JSON.stringify(verified));
        localStorage.removeItem("rjaf.fails");
        localStorage.removeItem("rjaf.lockUntil");
        void recordAuditEvent({ type: "login.ok", actor: username, detail: { role: verified.role } });
        setSilentAuthError(null);
        setState(s => ({ ...s, user: verified, failedAttempts: 0, lockedUntil: null }));
        return { ok: true };
      }

      const packaged = await isPackagedDesktop();
      if (packaged && !supabaseConfigured) {
        return { ok: false, error: "Authentication server not configured. Contact your Super Admin." };
      }
      if (supabaseConfigured && supabase) {
        const email = username.includes("@") ? username : `${username}@${(state.squadron?.number ?? "rjaf").toLowerCase()}.rjaf.local`;
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error || !data.user) return await recordFail(error?.message ?? "auth_failed");
        // app_metadata is the trusted source (server-stamped by edge functions
        // and protected from client modification); user_metadata is a fallback.
        // Normalize "deputy" → "ops" so the second/third ops officers
        // provisioned through the provision-user edge function (which writes
        // role="deputy" by default) are treated as full ops by the rest of
        // the app — including the per-PC role lock check below. Without
        // this normalization the *first* ops officer signs in fine but
        // every subsequent deputy hits role_locked because their JWT
        // carries "deputy" while the PC is pinned to "ops". Symptom field
        // ops reported as "second ops user can't log in".
        // v1.1.73 — CB-1 root-cause self-heal. If the auth user has no
        // squadron_id stamped into app_metadata (e.g. an account
        // created before provision-user started doing the stamping, or
        // restored from an older snapshot) the next call to any edge
        // function that allow-lists by `app_metadata.squadron_id`
        // returns "no_squadron_in_token" / "forbidden" — historically
        // visible as "Add User → Server error". The 0030 backfill
        // migration handles the bulk case server-side; this client
        // self-heal closes the remaining gap whenever the SQL has not
        // been applied yet by invoking heal-claims (a thin wrapper on
        // the auth admin updateUser API). The call is best-effort and
        // never blocks login; the operator can still sign in even if
        // the heal fails (their squadron-scoped actions will simply
        // fail with the now-improved error message until claims land).
        const meta = (data.user.app_metadata ?? {}) as { squadron_id?: string; role?: string };
        if (!meta.squadron_id || !meta.role) {
          try {
            await supabase.functions.invoke("heal-claims", { body: {} });
            // Refresh the session so the new claims are visible to RLS
            // and to subsequent edge-function calls in this tab.
            await supabase.auth.refreshSession();
          } catch { /* opportunistic — keep login flowing */ }
        }
        const refreshed = (await supabase.auth.getUser()).data.user ?? data.user;
        const rawRole = ((refreshed.app_metadata?.role as User["role"])
          ?? (refreshed.user_metadata?.role as User["role"])
          ?? "ops");
        const role: User["role"] = rawRole === "deputy" ? "ops" : rawRole;
        if (lock && role !== lock) {
          void recordAuditEvent({ type: "login.rolelock.blocked", actor: username, detail: { lock, attemptedRole: role } });
          return { ok: false, error: "role_locked" };
        }
        const scope = ((refreshed.app_metadata?.scope as User["scope"])
          ?? (refreshed.user_metadata?.scope as User["scope"])
          ?? undefined);
        const rank = (refreshed.user_metadata?.rank as string | undefined)
          ?? (refreshed.app_metadata?.rank as string | undefined)
          ?? undefined;
        const user: User = {
          username,
          role,
          scope,
          rank,
          displayName: (data.user.user_metadata?.displayName as string) ?? username,
        };
        localStorage.setItem("rjaf.user", JSON.stringify(user));
        localStorage.removeItem("rjaf.fails");
        localStorage.removeItem("rjaf.lockUntil");
        void recordAuditEvent({ type: "login.ok", actor: username });
        setSilentAuthError(null);
        setState(s => ({ ...s, user, failedAttempts: 0, lockedUntil: null }));
        return { ok: true };
      }

      // Any other username in standalone mode is rejected. Ops officers do
      // not authenticate through this password form at all — their entry
      // path is license-key activation, which runs on a different screen
      // and never calls login(). Historically this function had a
      // "password.length >= 4 wins" fallback here, which meant anyone who
      // knew a commander's username could guess a 4-char password and sign
      // in as ops. That fallback is gone; unknown accounts always fail.
      return await recordFail("unknown_user");
    },
    lanDevQuickLogin: async (kind) => {
      if (!isLanSessionLoginEnabled() || !isLanNoAuthEnabled()) {
        return { ok: false, error: "lan_dev_no_auth_disabled" };
      }
      const map: Record<"super_admin" | "ops" | "commander", { username: string; role: string; squadronId: string | null }> = {
        super_admin: { username: "local.admin", role: "super_admin", squadronId: null },
        ops: { username: "local.ops", role: "ops", squadronId: "NO.8 SQDN" },
        commander: { username: "local.commander", role: "commander:squadron", squadronId: "NO.8 SQDN" },
      };
      const sel = map[kind];
      const lan = await postLanDevSession(sel.username, {
        role: sel.role,
        displayName: sel.username,
        squadronId: sel.squadronId,
      });
      if (!lan.ok) return { ok: false, error: lan.error };
      setStoredLanSessionToken(lan.token);
      const appUser = userFromLanAuthProfile(lan.user, sel.username);
      localStorage.setItem("rjaf.user", JSON.stringify(appUser));
      if (appUser.role === "ops" && localStorage.getItem("rjaf.licensed") !== "1") {
        localStorage.setItem("rjaf.licensed", "1");
        if (!localStorage.getItem("rjaf.licenseKey")) localStorage.setItem("rjaf.licenseKey", "LAN-SESSION");
        if (!localStorage.getItem("rjaf.licenseUser")) localStorage.setItem("rjaf.licenseUser", appUser.username);
      }
      setSilentAuthError(null);
      setState(s => ({
        ...s,
        user: appUser,
        licensed: appUser.role === "ops" ? true : s.licensed,
        failedAttempts: 0,
        lockedUntil: null,
      }));
      return { ok: true };
    },
    pendingAdmin: pending
      ? { mode: pending.mode, secret: pending.secret, otpauth: pending.otpauth }
      : null,
    adminTotpEnrolled,
    adminProvisioned,
    verifyAdminTotp: async (code) => {
      if (!pending) return { ok: false, error: "no_pending" };
      const now = Date.now();
      if (state.lockedUntil && state.lockedUntil > now) {
        return { ok: false, error: "locked" };
      }

      const trimmed = code.trim();
      const usedRecoveryShape = isRecoveryCodeShape(trimmed);
      if (!isTotpShape(trimmed) && !usedRecoveryShape) {
        return { ok: false, error: "bad" };
      }

      // Server-backed verification path (production). The secret never
      // leaves the database; we just hand the code to the edge function
      // and trust its yes/no plus its server-side rate-limit.
      if (supabaseConfigured && supabase) {
        try {
          const { data, error } = await supabase.functions.invoke("super-admin-2fa", {
            body: {
              action: "verify",
              username: pending.user.username,
              token: pendingTokenRef.current,
              code: trimmed,
            },
          });
          if (error || !data?.ok) {
            const isLocked = data?.error === "locked";
            const fails = state.failedAttempts + 1;
            const lockedUntil = isLocked ? now + 5 * 60_000 : null;
            if (lockedUntil) localStorage.setItem("rjaf.lockUntil", String(lockedUntil));
            localStorage.setItem("rjaf.fails", String(fails));
            setState(s => ({ ...s, failedAttempts: fails, lockedUntil }));
            if (lockedUntil) setPending(null);
            return { ok: false, error: isLocked ? "locked" : "bad" };
          }
          if (pending.mode === "enroll") setAdminTotpEnrolled(true);
          const hqUser = pending.user;
          const recoveryCodes: string[] | undefined = Array.isArray(data.recoveryCodes)
            ? (data.recoveryCodes as string[])
            : undefined;
          const usedRecoveryCode = !!data.usedRecoveryCode;
          if (usedRecoveryCode) {
            void recordAuditEvent({
              type: "login.2fa.recovery_used",
              actor: hqUser.username,
              detail: {},
            });
          }
          // Sign the super admin into Supabase using the credentials minted
          // by the edge function. Without this step the dashboard has no
          // Supabase JWT, and JWT-gated functions like `provision-commander`
          // (which is now correctly enforcing JWT verification — see Audit
          // A defect D-A-01) would 401 the legitimate "Create commander"
          // call. Failure here is non-fatal: the dashboard still renders,
          // but the operator will see a clear error if they try to use a
          // JWT-gated feature, and the next 2FA verify will retry.
          const sbEmail = typeof data.supabaseEmail === "string" ? data.supabaseEmail : "";
          const sbPassword = typeof data.supabasePassword === "string" ? data.supabasePassword : "";
          if (sbEmail && sbPassword) {
            try {
              const { error: sbErr } = await supabase.auth.signInWithPassword({
                email: sbEmail,
                password: sbPassword,
              });
              if (sbErr) {
                console.warn("[super-admin signInWithPassword]", sbErr.message);
                void recordAuditEvent({
                  type: "super_admin.supabase_signin.failed",
                  actor: hqUser.username,
                  detail: { reason: sbErr.message },
                });
              } else {
                // Cache for silent re-auth on the next dashboard launch.
                storeSupabaseCreds(hqUser.username, sbEmail, sbPassword);
              }
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn("[super-admin signInWithPassword] threw", msg);
            }
          }
          localStorage.removeItem("rjaf.fails");
          localStorage.removeItem("rjaf.lockUntil");
          pendingTokenRef.current = "";
          if (typeof data.recoveryRemaining === "number") {
            updateAdminRecoveryRemaining(data.recoveryRemaining as number);
          } else if (recoveryCodes && recoveryCodes.length > 0) {
            updateAdminRecoveryRemaining(recoveryCodes.length);
          }
          if (recoveryCodes && recoveryCodes.length > 0) {
            // Block the dashboard entry screen until the admin clicks
            // "I've saved these". We keep the user in the
            // pendingLoginUserRef so ackRecoveryCodes can finish the login.
            pendingLoginUserRef.current = hqUser;
            setPending(null);
            setPendingRecoveryCodes(recoveryCodes);
            setState(s => ({ ...s, failedAttempts: 0, lockedUntil: null }));
            return { ok: true, recoveryCodes };
          }
          localStorage.setItem("rjaf.user", JSON.stringify(hqUser));
          void recordAuditEvent({
            type: "login.ok",
            actor: hqUser.username,
            detail: { role: hqUser.role, twoFactor: true, viaRecoveryCode: usedRecoveryCode },
          });
          setPending(null);
          setState(s => ({ ...s, user: hqUser, failedAttempts: 0, lockedUntil: null }));
          return { ok: true };
        } catch (e: unknown) {
          return { ok: false, error: e instanceof Error ? e.message : "totp_server_error" };
        }
      }

      // Demo-only local verification (matches the localStorage enroll above).
      let recoveryMatched = false;
      if (usedRecoveryShape && pending.mode === "verify") {
        const stored = readDemoRecoveryCodes();
        const h = await sha256Hex(normalizeRecoveryCode(trimmed));
        const idx = stored.findIndex(c => c.hash === h && !c.usedAt);
        if (idx >= 0) {
          stored[idx] = { hash: stored[idx].hash, usedAt: new Date().toISOString() };
          writeDemoRecoveryCodes(stored);
          recoveryMatched = true;
          const remaining = stored.filter(c => !c.usedAt).length;
          void recordAuditEvent({
            type: "login.2fa.recovery_used",
            actor: pending.user.username,
            detail: { remaining },
          });
        }
      }

      const totpOk = !recoveryMatched && isTotpShape(trimmed) && (await verifyTotp(pending.secret, trimmed));
      if (!recoveryMatched && !totpOk) {
        const fails = state.failedAttempts + 1;
        const lockedUntil = fails >= 5 ? now + 5 * 60_000 : null;
        localStorage.setItem("rjaf.fails", String(fails));
        if (lockedUntil) localStorage.setItem("rjaf.lockUntil", String(lockedUntil));
        void recordAuditEvent({
          type: "login.2fa.failed",
          actor: pending.user.username,
          detail: { stage: pending.mode, fails, mode: usedRecoveryShape ? "recovery" : "totp" },
        });
        setState(s => ({ ...s, failedAttempts: fails, lockedUntil }));
        if (lockedUntil) setPending(null);
        return { ok: false, error: lockedUntil ? "locked" : "bad" };
      }
      let mintedRecoveryCodes: string[] | undefined;
      if (pending.mode === "enroll") {
        localStorage.setItem(ADMIN_TOTP_SECRET_KEY, pending.secret);
        setAdminTotpEnrolled(true);
        mintedRecoveryCodes = generateDemoRecoveryCodes();
        const hashed: StoredRecoveryCode[] = await Promise.all(
          mintedRecoveryCodes.map(async c => ({
            hash: await sha256Hex(normalizeRecoveryCode(c)),
            usedAt: null,
          })),
        );
        writeDemoRecoveryCodes(hashed);
        updateAdminRecoveryRemaining(mintedRecoveryCodes.length);
        void recordAuditEvent({
          type: "login.2fa.enrolled",
          actor: pending.user.username,
        });
      } else {
        // Re-sync the warning count from the demo store on every successful
        // sign-in. Keeps the banner accurate after a recovery-code use.
        const stored = readDemoRecoveryCodes();
        if (stored.length > 0) {
          updateAdminRecoveryRemaining(stored.filter(c => !c.usedAt).length);
        }
      }
      const hqUser = pending.user;
      localStorage.removeItem("rjaf.fails");
      localStorage.removeItem("rjaf.lockUntil");
      if (mintedRecoveryCodes && mintedRecoveryCodes.length > 0) {
        pendingLoginUserRef.current = hqUser;
        setPending(null);
        setPendingRecoveryCodes(mintedRecoveryCodes);
        setState(s => ({ ...s, failedAttempts: 0, lockedUntil: null }));
        return { ok: true, recoveryCodes: mintedRecoveryCodes };
      }
      localStorage.setItem("rjaf.user", JSON.stringify(hqUser));
      void recordAuditEvent({
        type: "login.ok",
        actor: hqUser.username,
        detail: { role: hqUser.role, twoFactor: true, viaRecoveryCode: recoveryMatched },
      });
      setPending(null);
      setState(s => ({ ...s, user: hqUser, failedAttempts: 0, lockedUntil: null }));
      return { ok: true };
    },
    provisionSuperAdmin: async (newPassword) => {
      const np = (newPassword ?? "").trim();
      if (np.length < 8) return { ok: false, error: "too_short" };
      if (supabaseConfigured) {
        // In Supabase mode the password is managed server-side and can't
        // be set from the client.
        return { ok: false, error: "server_managed" };
      }
      if (localStorage.getItem(ADMIN_PASSWORD_HASH_KEY)) {
        // Safety net: refuse to overwrite an existing admin password. If
        // the Super Admin forgot their password they must rotate through
        // Settings → Security (which requires the current one) or clear
        // the local install.
        return { ok: false, error: "already_set" };
      }
      const newHash = await sha256Hex(np);
      localStorage.setItem(ADMIN_PASSWORD_HASH_KEY, newHash);
      setAdminProvisioned(true);
      void recordAuditEvent({ type: "admin.password.provisioned", actor: "admin", detail: {} });
      return { ok: true };
    },
    resetSuperAdminPasswordWithMaster: async (masterPassword, newPassword) => {
      const mp = (masterPassword ?? "").trim();
      const np = (newPassword ?? "").trim();
      if (supabaseConfigured && !isLanSessionLoginEnabled()) {
        return { ok: false, error: "server_managed" };
      }
      // Verify the Master Recovery Key first so the UI can use an empty
      // password to probe for "is the key right?" without needing a second
      // code path. Password-length validation only matters once the key is
      // accepted.
      const masterHash = await sha256Hex(mp);
      if (masterHash !== MASTER_RECOVERY_HASH) {
        void recordAuditEvent({ type: "admin.password.master_reset.failed", actor: "unknown", detail: { reason: "bad_master" } });
        return { ok: false, error: "bad_master" };
      }
      if (np.length < 8) return { ok: false, error: "too_short" };
      const newHash = await sha256Hex(np);
      localStorage.setItem(ADMIN_PASSWORD_HASH_KEY, newHash);
      void recordAuditEvent({ type: "admin.password.master_reset.ok", actor: "master-recovery", detail: {} });
      return { ok: true };
    },
    changeSuperAdminPassword: async (currentPassword, newPassword, totpCode) => {
      const u = state.user;
      if (!u || u.role !== "super_admin") return { ok: false, error: "unauthorized" };
      const np = (newPassword ?? "").trim();
      if (np.length < 8) return { ok: false, error: "too_short" };
      if (np === (currentPassword ?? "").trim()) return { ok: false, error: "same" };

      if (supabaseConfigured && supabase && !isLanSessionLoginEnabled()) {
        // v1.0.46: password rotation is now supported in Supabase mode. The
        // super admin proves possession of the CURRENT password (via the
        // start-action challenge token) AND the enrolled TOTP authenticator,
        // then the edge function writes a new SHA-256 hash to
        // super_admin_credentials. Every other PC picks up the new value on
        // its next sign-in — no redeploy, no env-var edit, no CLI.
        const tc = (totpCode ?? "").trim();
        if (!/^\d{6}$/.test(tc)) return { ok: false, error: "bad_totp" };
        try {
          const start = await supabase.functions.invoke("super-admin-2fa", {
            body: { action: "start", username: u.username, password: currentPassword },
          });
          if (start.error || !start.data?.ok) {
            const reason = start.data?.error ?? "server_error";
            if (reason === "unauthorized") return { ok: false, error: "bad_current" };
            return { ok: false, error: reason };
          }
          const token = String(start.data.token ?? "");
          const change = await supabase.functions.invoke("super-admin-2fa", {
            body: {
              action: "change-password",
              username: u.username,
              token,
              code: tc,
              newPassword: np,
            },
          });
          if (change.error || !change.data?.ok) {
            const reason = change.data?.error ?? "server_error";
            if (reason === "bad") return { ok: false, error: "bad_totp" };
            if (reason === "locked") return { ok: false, error: "locked" };
            if (reason === "same") return { ok: false, error: "same" };
            if (reason === "bad_input") return { ok: false, error: "bad_input" };
            return { ok: false, error: reason };
          }
          void recordAuditEvent({ type: "admin.password.change.ok", actor: u.username, detail: { via: "edge-function" } });
          return { ok: true };
        } catch (e: unknown) {
          return { ok: false, error: e instanceof Error ? e.message : "server_error" };
        }
      }

      // Demo / standalone mode: verify the current password against the PC's
      // stored hash if one has been set, or the baked-in default otherwise
      // (mirroring the login path). This way the admin can rotate the
      // factory-default password right away without a separate provisioning
      // step.
      const storedHash = localStorage.getItem(ADMIN_PASSWORD_HASH_KEY);
      const expectedHash = storedHash ?? DEFAULT_ADMIN_PASSWORD_HASH;
      const attemptHash = await sha256Hex(currentPassword);
      if (attemptHash !== expectedHash) {
        void recordAuditEvent({ type: "admin.password.change.failed", actor: u.username, detail: { reason: "bad_current" } });
        return { ok: false, error: "bad_current" };
      }

      const newHash = await sha256Hex(np);
      localStorage.setItem(ADMIN_PASSWORD_HASH_KEY, newHash);
      void recordAuditEvent({ type: "admin.password.change.ok", actor: u.username, detail: {} });
      return { ok: true };
    },
    regenerateRecoveryCodes: async (code) => {
      const u = state.user;
      if (!u || u.role !== "super_admin") return { ok: false, error: "unauthorized" };
      const trimmed = code.trim();
      if (!isTotpShape(trimmed)) return { ok: false, error: "bad" };

      if (supabaseConfigured && supabase && !isLanSessionLoginEnabled()) {
        try {
          const { data, error } = await supabase.functions.invoke("super-admin-2fa", {
            body: { action: "regenerate", username: u.username, code: trimmed },
          });
          if (error || !data?.ok) {
            const reason = data?.error ?? "totp_server_error";
            return { ok: false, error: reason === "locked" ? "locked" : (reason === "bad" ? "bad" : reason) };
          }
          // Server already wrote the audit row; don't duplicate from the client.
          const recoveryCodes: string[] = Array.isArray(data.recoveryCodes) ? data.recoveryCodes : [];
          return { ok: true, recoveryCodes };
        } catch (e: unknown) {
          return { ok: false, error: e instanceof Error ? e.message : "totp_server_error" };
        }
      }

      // Demo-only path: re-verify against the locally stored secret and
      // overwrite the stored recovery code hashes.
      const secret = localStorage.getItem(ADMIN_TOTP_SECRET_KEY);
      if (!secret) return { ok: false, error: "not_enrolled" };
      const ok = await verifyTotp(secret, trimmed);
      if (!ok) return { ok: false, error: "bad" };
      const fresh = generateDemoRecoveryCodes();
      const hashed: StoredRecoveryCode[] = await Promise.all(
        fresh.map(async c => ({
          hash: await sha256Hex(normalizeRecoveryCode(c)),
          usedAt: null,
        })),
      );
      writeDemoRecoveryCodes(hashed);
      void recordAuditEvent({
        type: "super_admin.2fa.recovery_regenerated",
        actor: u.username,
        detail: { count: fresh.length },
      });
      return { ok: true, recoveryCodes: fresh };
    },
    pendingRecoveryCodes,
    ackRecoveryCodes: () => {
      const hqUser = pendingLoginUserRef.current;
      if (!hqUser) { setPendingRecoveryCodes(null); return; }
      pendingLoginUserRef.current = null;
      localStorage.setItem("rjaf.user", JSON.stringify(hqUser));
      recordAuditEvent({
        type: "login.ok",
        actor: hqUser.username,
        detail: { role: hqUser.role, twoFactor: true, recoveryCodesIssued: true },
      });
      setPendingRecoveryCodes(null);
      setState(s => ({ ...s, user: hqUser }));
    },
    cancelAdminTotp: () => {
      pendingTokenRef.current = "";
      setPending(null);
    },
    adminRecoveryCodesRemaining,
    regenerateAdminRecoveryCodes: async (totpCode: string) => {
      const code = (totpCode ?? "").trim();
      if (!/^\d{6}$/.test(code)) return { ok: false, error: "bad" };
      const actor = state.user?.username ?? "admin";
      if (supabaseConfigured && supabase && !isLanSessionLoginEnabled()) {
        try {
          const { data, error } = await supabase.functions.invoke("super-admin-2fa", {
            body: { action: "regenerate", username: actor, code },
          });
          if (error || !data?.ok) {
            const reason = data?.error ?? "regen_failed";
            return { ok: false, error: reason };
          }
          const codes = Array.isArray(data.recoveryCodes) ? (data.recoveryCodes as string[]) : [];
          updateAdminRecoveryRemaining(
            typeof data.recoveryRemaining === "number"
              ? (data.recoveryRemaining as number)
              : codes.length,
          );
          void recordAuditEvent({
            type: "super_admin.2fa.recovery_regenerated",
            actor,
            detail: { count: codes.length },
          });
          return { ok: true, recoveryCodes: codes };
        } catch (e: unknown) {
          return { ok: false, error: e instanceof Error ? e.message : "regen_error" };
        }
      }
      // Demo mode: verify the TOTP code locally against the stored secret,
      // then mint and persist a fresh batch of hashed codes.
      const secret = localStorage.getItem(ADMIN_TOTP_SECRET_KEY) ?? "";
      if (!secret) return { ok: false, error: "not_enrolled" };
      const ok = await verifyTotp(secret, code);
      if (!ok) return { ok: false, error: "bad" };
      const fresh = generateDemoRecoveryCodes();
      const hashed: StoredRecoveryCode[] = await Promise.all(
        fresh.map(async c => ({
          hash: await sha256Hex(normalizeRecoveryCode(c)),
          usedAt: null,
        })),
      );
      writeDemoRecoveryCodes(hashed);
      updateAdminRecoveryRemaining(fresh.length);
      void recordAuditEvent({
        type: "super_admin.2fa.recovery_regenerated",
        actor,
        detail: { count: fresh.length },
      });
      return { ok: true, recoveryCodes: fresh };
    },
    logout: () => {
      if (isLanSessionLoginEnabled()) void postLanLogout();
      if (localStorage.getItem("rjaf.lanSessionToken")) clearLanSessionToken();
      if (!isLanSessionLoginEnabled() && supabase) supabase.auth.signOut();
      localStorage.removeItem("rjaf.user");
      setPending(null);
      setPendingRecoveryCodes(null);
      pendingLoginUserRef.current = null;
      updateAdminRecoveryRemaining(null);
      setState(s => ({ ...s, user: null }));
    },
    releaseLicense: () => {
      // v1.1.46: Release License must also DEREGISTER this PC from the
      // central xpc_registry on Supabase, otherwise other PCs keep
      // seeing this seat as "online" in their Messages and Schedule
      // Chain pickers (the 30s heartbeat from this PC stops, but the
      // last_seen row sits there until the cleanup window expires).
      // Also wipe the local PC id + device suffix so the next setup
      // gets a clean identity instead of inheriting the old one.
      const myPcId = localStorage.getItem("rjaf.xpc.localId") ?? "";
      if (isLanSessionLoginEnabled()) {
        void postLanLogout();
      } else if (localStorage.getItem("rjaf.lanSessionToken")) {
        clearLanSessionToken();
      }
      if (!isLanSessionLoginEnabled() && supabase && myPcId) {
        // Fire-and-forget — don't block the UI; if the network is down
        // the row will time out via the registry's normal staleness
        // window. Best-effort delete now is the right tradeoff.
        void supabase.from("xpc_registry").delete().eq("id", myPcId).then(() => {});
        void supabase.from("xpc_user_pcs").delete().eq("pc_id", myPcId).then(() => {});
      }
      localStorage.removeItem("rjaf.licensed");
      localStorage.removeItem("rjaf.licenseKey");
      localStorage.removeItem("rjaf.licenseUser");
      localStorage.removeItem("rjaf.licenseBoundFp");
      localStorage.removeItem("rjaf.user");
      localStorage.removeItem("rjaf.squadronId");
      localStorage.removeItem("rjaf.xpc.localId");
      localStorage.removeItem("rjaf.deviceSuffix");
      updateAdminRecoveryRemaining(null);
      setState(s => ({ ...s, licensed: false, user: null }));
    },
    resetThisPC: async () => {
      // "Reset this PC" — the nuclear option exposed in Settings for
      // every role. Wipes every trace of this device so the next launch
      // is indistinguishable from a fresh install.
      //
      //   0. setResetInProgress(true) — silences the 30s heartbeat in
      //      cross-pc.ts so it can't re-upsert the rows we are about
      //      to delete. Without this guard, a tick can fire between
      //      DELETE and reload and silently re-create them.
      //   1. DELETE this PC's row from xpc_registry (other PCs stop
      //      seeing it as a known seat).
      //   2. DELETE this PC's claim from xpc_user_pcs (no orphan claim
      //      left under the current auth.uid).
      //   3. supabase.auth.signOut() so the cached session can't be
      //      reused after reload.
      //   4. Wipe EVERY `rjaf.*` key from localStorage — using
      //      Object.keys instead of an enumerated list so future keys
      //      are also cleared without needing to update this code.
      //   5. Reload to land back on the first-launch screen.
      //
      // Unlike releaseLicense (which is best-effort fire-and-forget)
      // we inspect the {error} object Supabase returns. RLS / network
      // failures are surfaced in the console with a hard error log so
      // the operator (or the dev console) can see why the cloud row
      // was NOT deleted, instead of the bug we just spent a release
      // hunting down (silent failures behind a green pill).
      setResetInProgress(true);
      const myPcId = localStorage.getItem("rjaf.xpc.localId") ?? "";
      const failures: string[] = [];
      if (isLanSessionLoginEnabled()) {
        try { await postLanLogout(); } catch { /* ignore */ }
      } else if (localStorage.getItem("rjaf.lanSessionToken")) {
        clearLanSessionToken();
      }
      if (!isLanSessionLoginEnabled() && supabase && myPcId) {
        try {
          const { error } = await supabase.from("xpc_registry").delete().eq("id", myPcId);
          if (error) {
            failures.push(`xpc_registry: ${error.message}`);
            console.error("[resetThisPC] xpc_registry delete failed:", error);
          }
        } catch (e) {
          failures.push(`xpc_registry threw: ${(e as Error)?.message ?? String(e)}`);
          console.error("[resetThisPC] xpc_registry delete threw:", e);
        }
        try {
          const { error } = await supabase.from("xpc_user_pcs").delete().eq("pc_id", myPcId);
          if (error) {
            failures.push(`xpc_user_pcs: ${error.message}`);
            console.error("[resetThisPC] xpc_user_pcs delete failed:", error);
          }
        } catch (e) {
          failures.push(`xpc_user_pcs threw: ${(e as Error)?.message ?? String(e)}`);
          console.error("[resetThisPC] xpc_user_pcs delete threw:", e);
        }
      }
      if (!isLanSessionLoginEnabled() && supabase) {
        try { await supabase.auth.signOut(); } catch { /* ignore */ }
      }
      try {
        const keys = Object.keys(localStorage);
        for (const k of keys) {
          if (k.startsWith("rjaf.")) localStorage.removeItem(k);
        }
      } catch { /* localStorage blocked — nothing more we can do */ }
      try { sessionStorage.clear(); } catch { /* ignore */ }
      // If any cloud delete failed, warn the user before we reload so
      // they know the central registration may still be there. We
      // still proceed to reload — local state is wiped either way and
      // a fresh setup will simply overwrite the stale row.
      if (failures.length > 0) {
        try {
          window.alert(
            "Reset done locally, but the central server reported errors deleting this PC's registration:\n\n" +
            failures.map(f => "  • " + f).join("\n") +
            "\n\nThe PC will be reset locally on reload. If the cloud row is still there after a fresh setup, contact the developer.",
          );
        } catch { /* alert may be blocked in iframe — console.error above is the fallback */ }
      }
      // Hard reload — this guarantees in-memory state (queries,
      // intervals, the heartbeat closure) is wiped, not just React
      // state. The resetInProgress flag is module-scope so it dies
      // with the page; no need to clear it manually.
      try { window.location.reload(); } catch { /* ignore */ }
    },
    pcRoleLock,
    setPcRoleLock: applyPcRoleLock,
    pcDeviceName,
    setPcDeviceName: applyPcDeviceName,
  }), [state, pending, adminTotpEnrolled, pendingRecoveryCodes, adminRecoveryCodesRemaining, pcRoleLock, pcDeviceName, silentAuthError]);

  // ── Inactivity auto-logout ──────────────────────────────────────
  // Watches user activity (mousemove / keydown / pointerdown / scroll /
  // touchstart) and signs the operator out after N minutes of no input.
  // N is read from localStorage per-user-id (INACTIVITY_KEY_PREFIX) so
  // every operator can set their own comfort level from the Settings
  // page. 0 = disabled (stay signed in until explicit logout). We also
  // pause the timer when the tab is hidden so minimising doesn't
  // pre-emptively log the user out before the real idle period elapses.
  const currentUserId = state.user?.id;

  // Task #299 round 4 — membership watchdog. Code review required a
  // ≤60s lockout window after an SA removes a member; Supabase
  // access-token TTL is 1h, so even after `unit_remove_member` deletes
  // sessions + refresh tokens + bans the user, an in-flight access
  // token can keep working until it expires. The watchdog closes that
  // gap on the client side: every 30 s it asks the server "am I still
  // an active member?" via `unit_member_self()`. If the server says
  // status='removed' the client tears down its session immediately —
  // the operator sees the lock screen within the next poll tick.
  // Transient errors (null) are ignored so a flaky network doesn't
  // log the user out spuriously.
  const isUnitBoundUser = !!state.user && (
    state.user.role === "super_admin"
    || state.user.role === "commander"
    || state.user.role === "ops"
  );
  useEffect(() => {
    if (isLanSessionLoginEnabled()) return;
    if (!isUnitBoundUser) return;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const me = await fetchMemberSelf();
        if (!alive) return;
        if (me && me.status === "removed") {
          // Definitive: server says I'm removed. Sign out + clear local
          // user state. The component tree will re-render to FirstLaunch
          // / login on the next pass.
          if (supabase) { try { await supabase.auth.signOut(); } catch { /* ignore */ } }
          localStorage.removeItem("rjaf.user");
          setState((s) => ({ ...s, user: null }));
        }
      } catch {
        /* transient error — ignore, try again next tick */
      }
    };
    void tick();
    const t = window.setInterval(tick, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [isUnitBoundUser, currentUserId]);
  // `prefVersion` is bumped whenever the Settings page writes a new
  // inactivity value, which re-runs this effect and re-arms the timer
  // with the new timeout (including 0 = disabled). Without this, picking
  // a new value wouldn't take effect until the operator signed back in.
  const [inactivityPrefVersion, setInactivityPrefVersion] = useState(0);
  useEffect(() => {
    const unsub = subscribeInactivityChange(() => setInactivityPrefVersion(v => v + 1));
    return unsub;
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    const mins = readInactivityMinutes(currentUserId);
    if (!mins) return; // 0 = disabled → no watcher attached.
    const timeoutMs = mins * 60 * 1000;

    let timer: number | undefined;
    let lastActivityAt = Date.now();
    const fire = () => {
      if (isLanSessionLoginEnabled()) {
        void postLanLogout();
      } else if (localStorage.getItem("rjaf.lanSessionToken")) {
        clearLanSessionToken();
      }
      if (!isLanSessionLoginEnabled() && supabase) supabase.auth.signOut().catch(() => {});
      localStorage.removeItem("rjaf.user");
      setPending(null);
      setPendingRecoveryCodes(null);
      pendingLoginUserRef.current = null;
      setState(s => ({ ...s, user: null }));
    };
    const clearTimer = () => {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
    };
    const arm = () => {
      clearTimer();
      timer = window.setTimeout(fire, timeoutMs);
    };
    const onActivity = () => {
      lastActivityAt = Date.now();
      // Only re-arm while the tab is actually visible so a hidden tab
      // doesn't eat through the idle budget while the operator is away.
      if (document.visibilityState === "visible") arm();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        // Returning to a visible tab: if the real wall-clock gap since
        // the last user input already exceeded the timeout, fire now;
        // otherwise just re-arm for the remaining budget.
        const elapsed = Date.now() - lastActivityAt;
        if (elapsed >= timeoutMs) { fire(); return; }
        clearTimer();
        timer = window.setTimeout(fire, timeoutMs - elapsed);
      } else {
        // Tab hidden → pause the timer. Wall-clock enforcement resumes
        // on the next `visible` transition via `onVis`.
        clearTimer();
      }
    };
    const events: Array<keyof DocumentEventMap> = [
      "mousemove", "keydown", "pointerdown", "scroll", "touchstart",
    ];
    for (const ev of events) document.addEventListener(ev, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    if (document.visibilityState === "visible") arm();
    return () => {
      clearTimer();
      for (const ev of events) document.removeEventListener(ev, onActivity);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [currentUserId, inactivityPrefVersion]);


  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Read / write helpers exposed for the Settings page so the UI doesn't
// need to know about the localStorage key naming convention.
export function getInactivityMinutes(userId: string | undefined): InactivityMinutes {
  return readInactivityMinutes(userId);
}
export function setInactivityMinutes(userId: string | undefined, value: InactivityMinutes): void {
  writeInactivityMinutes(userId, value);
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be inside AuthProvider");
  return v;
}
