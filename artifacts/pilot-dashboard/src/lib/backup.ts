// ─────────────────────────────────────────────────────────────────────────────
// Password-protected backup / restore for the PC squadron install.
//
// The offline squadron copy lives in two places:
//   1. localStorage — all `rjaf.*` / `rjaf_*` keys (config, license, auth
//      hashes, commanders, archive snapshots, currency windows, language…).
//   2. In-memory mock lists inside squadron-data.ts (pilots, sorties,
//      notams, unavail, users) — only populated when Supabase is not
//      configured, which is exactly the offline-squadron deployment model.
//
// If the PC app ever gets uninstalled / the browser profile is wiped, all
// of that is gone. This module lets the super-admin produce an encrypted
// `.rjafbackup` file they can tuck away on a USB stick, then later restore
// into a fresh install on the same PC.
//
// File format (very deliberately simple so a backup is recoverable even if
// a future version of the app changes its schema):
//
//   Line 1: "RJAF-BACKUP-v1"
//   Line 2: base64( JSON.stringify({ salt, iv, ct }) )
//
// Where salt is 16 random bytes, iv is 12 random bytes, and ct is the
// AES-GCM-256 ciphertext of the JSON payload (utf-8). The key is derived
// with PBKDF2-SHA256, 250 000 iterations, from the password the user
// chooses at export time.
//
// We explicitly skip two local keys:
//   - `rjaf.sb`  – Supabase auth session, device-specific, short-lived.
//   - `rjaf.fp`  – per-browser fingerprint; lets the new install earn a
//                  fresh one instead of inheriting the old.
// ─────────────────────────────────────────────────────────────────────────────

import {
  exportSquadronMockState,
  applySquadronMockState,
  type SquadronMockState,
} from "./squadron-data";

const FORMAT_HEADER = "RJAF-BACKUP-v1";
const PBKDF2_ITERATIONS = 250_000;
const AES_KEY_LENGTH = 256;
const SKIP_KEYS = new Set(["rjaf.sb", "rjaf.fp"]);

export interface BackupPayload {
  version: 1;
  createdAt: string;
  squadronId: string | null;
  deviceName: string | null;
  storage: Record<string, string>;
  mock: SquadronMockState;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

function collectStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (SKIP_KEYS.has(k)) continue;
    if (!k.startsWith("rjaf")) continue;
    const v = localStorage.getItem(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

function applyStorage(storage: Record<string, string>): void {
  // Wipe existing rjaf.* keys first so the restore is a faithful snapshot,
  // not a merge. We preserve SKIP_KEYS exactly as they are on this device.
  const toDrop: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (SKIP_KEYS.has(k)) continue;
    if (k.startsWith("rjaf")) toDrop.push(k);
  }
  toDrop.forEach(k => localStorage.removeItem(k));
  for (const [k, v] of Object.entries(storage)) {
    if (SKIP_KEYS.has(k)) continue;
    try { localStorage.setItem(k, v); } catch { /* quota — skip */ }
  }
}

/**
 * Assemble the full backup payload from the current device.
 * Does not touch disk or the filesystem — just returns the plain object
 * so the encrypting wrapper can consume it.
 */
export function buildBackupPayload(): BackupPayload {
  const squadronRaw = localStorage.getItem("rjaf.squadronId");
  const deviceName = localStorage.getItem("rjaf.pcDeviceName");
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    squadronId: squadronRaw || null,
    deviceName: deviceName || null,
    storage: collectStorage(),
    mock: exportSquadronMockState(),
  };
}

/**
 * Encrypt a BackupPayload with the given password and return the full
 * on-disk contents of the `.rjafbackup` file as a string.
 */
export async function exportBackup(password: string): Promise<string> {
  if (!password || password.length < 6) {
    throw new Error("Backup password must be at least 6 characters.");
  }
  const payload = buildBackupPayload();
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource),
  );
  const envelope = JSON.stringify({
    salt: b64encode(salt),
    iv: b64encode(iv),
    ct: b64encode(ct),
  });
  return `${FORMAT_HEADER}\n${btoa(envelope)}\n`;
}

/**
 * Decrypt and parse a `.rjafbackup` file's text contents using the given
 * password. Throws a friendly error on wrong password / corrupt file.
 */
export async function decodeBackup(
  fileText: string,
  password: string,
): Promise<BackupPayload> {
  const lines = fileText.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2 || lines[0] !== FORMAT_HEADER) {
    throw new Error("This does not look like a valid RJAF backup file.");
  }
  let envelope: { salt: string; iv: string; ct: string };
  try {
    envelope = JSON.parse(atob(lines[1])) as { salt: string; iv: string; ct: string };
  } catch {
    throw new Error("Backup file is corrupt or truncated.");
  }
  const salt = b64decode(envelope.salt);
  const iv = b64decode(envelope.iv);
  const ct = b64decode(envelope.ct);
  const key = await deriveKey(password, salt);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
  } catch {
    throw new Error("Wrong password, or this backup was written for a different squadron.");
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as BackupPayload;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported backup version: ${parsed.version}`);
  }
  return parsed;
}

/** Apply a decoded backup to this device, overwriting local state. */
export function applyBackup(payload: BackupPayload): void {
  applyStorage(payload.storage);
  applySquadronMockState(payload.mock);
}

/** Convenience: filename we suggest at download time. */
export function suggestBackupFilename(payload?: Pick<BackupPayload, "squadronId" | "createdAt">): string {
  const now = (payload?.createdAt || new Date().toISOString())
    .slice(0, 16)
    .replace(/[:T]/g, "-");
  const sq = payload?.squadronId || "rjaf";
  return `${sq}-${now}.rjafbackup`;
}
