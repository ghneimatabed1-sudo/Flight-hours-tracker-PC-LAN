export type Role = "super_admin" | "commander" | "ops" | "deputy" | "admin";

export type CommanderScope = "flight" | "squadron" | "wing" | "base" | "hq";

export interface User {
  id?: string;
  username: string;
  displayName: string;
  // Optional military rank (e.g. "Maj", "Capt"). Sourced from
  // `user_metadata.rank` when present so message inboxes and schedule
  // history can render proper "Maj. Ahmad" labels instead of cryptic
  // auth usernames. Falls back to "" for legacy accounts.
  rank?: string;
  role: Role;
  scope?: CommanderScope;
  squadronIds?: string[];
}

// Render a friendly seat label from a user's role + commander scope.
// Used by the message inbox / schedule chain to show "Flight Cmdr" or
// "Wing Cmdr" alongside the operator's name. Ops officers come back as
// "Ops Pilot"; commanders without a recognised scope fall through to
// "Commander". Returns an empty string for non-operational roles
// (super_admin, admin) so the surrounding UI just renders the name.
export function seatLabelFromRoleScope(
  role: Role | null | undefined,
  scope: CommanderScope | null | undefined,
): string {
  if (!role) return "";
  if (role === "ops" || role === "deputy") return "Ops Pilot";
  if (role === "commander") {
    if (scope === "flight")   return "Flight Cmdr";
    if (scope === "squadron") return "Sqn Cmdr";
    if (scope === "wing")     return "Wing Cmdr";
    if (scope === "base")     return "Base Cmdr";
    if (scope === "hq")       return "HQ";
    return "Commander";
  }
  return "";
}

// Compose the rich "Maj. Ahmad · Flight Cmdr · NO.8 SQDN" identity
// label used across every audit/inbox surface. Each segment is
// optional — passing only `displayName` returns just the name; passing
// rank + name + seat + pcName returns the full string. Falls back to
// the legacy `username` if no displayName is available so old rows
// still render something readable instead of "—".
export function composeIdentityLabel(parts: {
  rank?: string | null;
  displayName?: string | null;
  username?: string | null;
  seatLabel?: string | null;
  pcName?: string | null;
}): string {
  const name = (parts.displayName ?? "").trim() || (parts.username ?? "").trim();
  const rank = (parts.rank ?? "").trim();
  const head = rank && name
    ? `${rank}. ${name}`
    : (rank || name);
  const tail: string[] = [];
  const seat = (parts.seatLabel ?? "").trim();
  const pc   = (parts.pcName ?? "").trim();
  if (seat) tail.push(seat);
  if (pc && pc !== name) tail.push(pc);
  if (!head && tail.length === 0) return "";
  if (!head) return tail.join(" · ");
  if (tail.length === 0) return head;
  return `${head} · ${tail.join(" · ")}`;
}

export interface Squadron {
  id: string;
  name: string;
  nameAr: string;
  code: string;
  base: string;
  baseAr: string;
  wing: string;
  wingAr: string;
  enabled: boolean;
  keyHolder: string | null;
}

export interface Pilot {
  id: string;
  callSign: string;
  // Optional flight name — personal handle distinct from the tactical
  // callSign. Shown on commander / HQ roster views next to the callSign.
  flightName?: string;
  rank: string;
  rankAr: string;
  fullName: string;
  fullNameAr: string;
  squadronId: string;
  monthlyHours: number;
  grandTotalHours: number;
  nvgTotalHours: number;
  // Detailed hour breakdown — only shown on the pilot detail ("View") page,
  // not in the main commander roster. Optional so older records still work.
  dayHours?: number;
  nightHours?: number;
  simHours?: number;
  captainHours?: number;
  instrumentHours?: number;
  dayCurrencyDate: string;
  nightCurrencyDate: string;
  // v1.1.69 — NVG is its own currency, fully independent from Night.
  // Optional so older snapshots that predate the split still parse.
  nvgCurrencyDate?: string;
  irtCurrencyDate: string;
  medicalCurrencyDate: string;
  // Pilot qualifications (e.g. "MTP", "QHI", "IP"). Manually entered by ops
  // officer; displayed as badges on commander / HQ views.
  qualifications?: string[];
  // Date of the pilot's most recent simulator session. Entered by ops officer
  // and visible only to the squadron commander (not wing/base/HQ).
  lastSimDate?: string;
}

export interface LicenseKey {
  id: string;
  squadronId: string;
  keyPreview: string;
  status: "active" | "revoked" | "locked";
  issuedAt: string;
  // ISO date string when this key stops being valid, or null for "never expires".
  // The desktop client refuses activation past this date and existing
  // installations are signed out on next license check.
  expiresAt: string | null;
  // The exact operator username this key was issued for. Activation rejects
  // any other username — the same key string with a different name will not
  // unlock the desktop app. Case-insensitive when comparing.
  assignedUsername: string;
  lockedToDevice: string | null;
  lastSyncAt: string | null;
  // Optional: role tier the Super Admin pre-assigned this key to. When
  // present, the activating PC is locked to this role (the operator can't
  // pick a different one in the Setup dialog). Values mirror SetupRoleUI in
  // LicenseKeys.tsx.
  assignedRole?: "ops" | "flight_commander" | "squadron_commander" | "wing_commander" | "base_commander" | "hq_commander" | "super_admin";
  // Optional: squadron IDs this commander PC is allowed to monitor. Only
  // meaningful for commander tiers (flight/squadron). HQ commanders implicitly
  // see every squadron; ops PCs only ever see their own. The Super Admin sets
  // this at key-generation time so the field commander can't widen their own
  // visibility.
  authorizedSquadronIds?: string[];
}

// License-key validity durations the super admin can pick when issuing a key.
export type LicenseDuration = "1d" | "2d" | "1m" | "3m" | "6m" | "1y" | "3y" | "never";

export function addDuration(fromIsoDate: string, d: LicenseDuration): string | null {
  if (d === "never") return null;
  const t = new Date(fromIsoDate);
  if (Number.isNaN(t.getTime())) return null;
  switch (d) {
    case "1d": t.setDate(t.getDate() + 1); break;
    case "2d": t.setDate(t.getDate() + 2); break;
    case "1m": t.setMonth(t.getMonth() + 1); break;
    case "3m": t.setMonth(t.getMonth() + 3); break;
    case "6m": t.setMonth(t.getMonth() + 6); break;
    case "1y": t.setFullYear(t.getFullYear() + 1); break;
    case "3y": t.setFullYear(t.getFullYear() + 3); break;
  }
  return t.toISOString().slice(0, 10);
}

// Custom duration in whole days — used when the super admin wants something
// the preset list doesn't cover (e.g. "5 days" for a temporary handover).
export function addDays(fromIsoDate: string, days: number): string | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const t = new Date(fromIsoDate);
  if (Number.isNaN(t.getTime())) return null;
  t.setDate(t.getDate() + Math.floor(days));
  return t.toISOString().slice(0, 10);
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  user: string;
  role: Role | "ops_officer";
  action: string;
  target: string;
  ip: string;
}

export type CurrencyStatus = "current" | "unset" | "warning" | "expiringSoon" | "critical" | "expired";
