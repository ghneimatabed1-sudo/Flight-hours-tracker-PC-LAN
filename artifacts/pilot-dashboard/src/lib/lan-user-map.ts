import type { CommanderScope, User } from "./types";

export type LanAuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  squadronId: string | null;
};

/**
 * Map a `lan_users.role` string from the internal Postgres table into the
 * dashboard's `User` model. The LAN table stores a single `role` text field;
 * commander scope may be embedded as `commander:wing` or carried in the
 * role string `wing` / `squadron` / etc. when operators provision accounts
 * without a scope column.
 */
export function userFromLanAuthProfile(
  row: LanAuthUser,
  usernameForDisplay: string,
): User {
  const raw = row.role.trim().toLowerCase();
  const [head, rest] = raw.includes(":")
    ? (raw.split(":") as [string, string])
    : [raw, ""];

  if (head === "super_admin" || raw === "super_admin") {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName || usernameForDisplay,
      role: "super_admin",
    };
  }

  if (head === "admin" || raw === "admin") {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName || usernameForDisplay,
      role: "admin",
    };
  }

  if (head === "ops" || head === "deputy" || raw === "ops" || raw === "deputy") {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName || usernameForDisplay,
      role: "ops",
      squadronIds: row.squadronId ? [row.squadronId] : undefined,
    };
  }

  // Commander + scope
  const scopeFromRest = normalizeCommanderScope(rest);
  const scopeFromRaw = inferScopeFromLooseRole(raw);
  const scope: CommanderScope | undefined = scopeFromRest ?? scopeFromRaw;

  if (head === "commander" || isLooseCommanderScopeToken(head)) {
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName || usernameForDisplay,
      role: "commander",
      scope: scope ?? "squadron",
      squadronIds: row.squadronId ? [row.squadronId] : undefined,
    };
  }

  // Defensive default — treat unknown values as limited admin UI access.
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName || usernameForDisplay,
    role: "admin",
  };
}

function isLooseCommanderScopeToken(s: string): boolean {
  return (
    s === "flight" ||
    s === "squadron" ||
    s === "wing" ||
    s === "base" ||
    s === "hq"
  );
}

function inferScopeFromLooseRole(raw: string): CommanderScope | undefined {
  if (isLooseCommanderScopeToken(raw)) return raw as CommanderScope;
  return undefined;
}

function normalizeCommanderScope(s: string): CommanderScope | undefined {
  const t = s.trim().toLowerCase();
  if (!t) return undefined;
  if (isLooseCommanderScopeToken(t)) return t as CommanderScope;
  return undefined;
}
