// Persistent store for access accounts created by the Super Admin through
// the Admin → Access Accounts page. Each record holds a User object plus a
// SHA-256 hash of the account's password. The raw password is shown exactly
// once at creation/reset time and is never persisted.
//
// Two kinds of accounts live here:
//   - role="commander" — HQ / base / wing / squadron / flight commanders
//     with a squadron-visibility scope.
//   - role="ops" — flight operations officers who run the app on THIS PC.
//     Scope/squadronIds are not used for ops (they operate this squadron).
//
// If the Super Admin never creates an account of a given role, users of
// that role simply cannot log in on this PC. That is the entire access
// model: no default credentials, no implicit access.
//
// In Supabase mode the real source of truth is the `commander_accounts`
// table; this localStorage store is the fallback used by the standalone
// installer where each squadron runs its own offline copy.

import type { CommanderScope, User } from "./types";

const STORE_KEY = "rjaf.commanders";
const HASH_KEY = "rjaf.commanderPwHashes";

export type AccountRole = "commander" | "ops";

export interface CommanderRecord extends User {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  // Commanders carry a scope + list of authorized squadrons. Ops officers
  // leave scope undefined and squadronIds empty — they always operate the
  // current squadron this PC is bound to.
  scope?: CommanderScope;
  squadronIds: string[];
  createdAt: string;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function readList(): CommanderRecord[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeList(list: CommanderRecord[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(list));
}

function readHashes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(HASH_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

function writeHashes(hashes: Record<string, string>): void {
  localStorage.setItem(HASH_KEY, JSON.stringify(hashes));
}

export function listCommanders(): CommanderRecord[] {
  return readList();
}

export function findCommanderByUsername(username: string): CommanderRecord | null {
  const u = username.trim().toLowerCase();
  return readList().find(c => c.username === u) ?? null;
}

// Generates a short, easy-to-read one-time password for new commanders.
// Returned once to the Super Admin (shown in the dialog); only the hash
// is persisted. 10 chars, uppercase alphanumeric minus ambiguous 0/O/1/I.
export function generateInitialPassword(): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alpha[bytes[i] % alpha.length];
  return out;
}

export interface CreateCommanderInput {
  username: string;
  displayName: string;
  role: AccountRole;
  // Required when role === "commander"; ignored for role === "ops".
  scope?: CommanderScope;
  squadronIds?: string[];
  // Optional: lead-chosen password. When omitted or empty, a random one is generated.
  password?: string;
}

export interface CreateCommanderResult {
  ok: boolean;
  error?: string;
  record?: CommanderRecord;
  initialPassword?: string;
}

export async function createCommander(input: CreateCommanderInput): Promise<CreateCommanderResult> {
  const username = input.username.trim().toLowerCase();
  if (!username) return { ok: false, error: "missing_username" };
  if (username === "admin") return { ok: false, error: "reserved_username" };
  const list = readList();
  if (list.some(c => c.username === username)) {
    return { ok: false, error: "duplicate_username" };
  }

  const prefix = input.role === "ops" ? "ops" : "cmdr";
  const record: CommanderRecord = {
    id: `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
    username,
    displayName: input.displayName.trim() || username,
    role: input.role,
    // Only commanders carry scope / squadron lists. For ops the visibility
    // is implicitly "this PC's squadron" — the store stays agnostic.
    scope: input.role === "commander" ? input.scope : undefined,
    squadronIds: input.role === "commander" ? [...(input.squadronIds ?? [])] : [],
    createdAt: new Date().toISOString(),
  };

  const chosen = (input.password ?? "").trim();
  const initialPassword = chosen.length >= 4 ? chosen : generateInitialPassword();
  const hashes = readHashes();
  hashes[record.id] = await sha256Hex(initialPassword);

  writeList([...list, record]);
  writeHashes(hashes);

  return { ok: true, record, initialPassword };
}

export function updateCommanderSquadrons(id: string, scope: CommanderScope, squadronIds: string[]): boolean {
  const list = readList();
  const idx = list.findIndex(c => c.id === id);
  if (idx < 0) return false;
  list[idx] = { ...list[idx], scope, squadronIds: [...squadronIds] };
  writeList(list);
  return true;
}

export function deleteCommander(id: string): boolean {
  const list = readList();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  writeList(next);
  const hashes = readHashes();
  if (id in hashes) {
    delete hashes[id];
    writeHashes(hashes);
  }
  return true;
}

export async function resetCommanderPassword(id: string, password?: string): Promise<string | null> {
  const list = readList();
  if (!list.some(c => c.id === id)) return null;
  const chosen = (password ?? "").trim();
  const newPassword = chosen.length >= 4 ? chosen : generateInitialPassword();
  const hashes = readHashes();
  hashes[id] = await sha256Hex(newPassword);
  writeHashes(hashes);
  return newPassword;
}

export async function verifyCommanderPassword(username: string, password: string): Promise<CommanderRecord | null> {
  const rec = findCommanderByUsername(username);
  if (!rec) return null;
  const hashes = readHashes();
  const expected = hashes[rec.id];
  if (!expected) return null;
  const actual = await sha256Hex(password);
  // Constant-time-ish comparison: both strings are the same length hex so
  // a simple === is fine for our threat model (offline local app).
  return actual === expected ? rec : null;
}
