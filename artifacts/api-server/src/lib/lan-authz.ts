export type LanUserContext = {
  user_id?: string;
  username?: string;
  display_name?: string;
  role?: string;
  squadron_id?: string | null;
};

type ReqWithLanUser = {
  lanUser?: LanUserContext;
};

export function readLanUser(req: unknown): LanUserContext | null {
  const u = (req as ReqWithLanUser)?.lanUser;
  return u && typeof u === "object" ? u : null;
}

export type LanRole = "super_admin" | "admin" | "ops" | "commander" | "unknown";

export function normalizeLanRole(raw: string | null | undefined): LanRole {
  const r = String(raw ?? "").trim().toLowerCase();
  if (r === "super_admin" || r === "superadmin") return "super_admin";
  if (r === "admin") return "admin";
  if (r === "ops") return "ops";
  if (
    r === "commander"
    || r.startsWith("commander:")
    || r === "squadron"
    || r === "wing"
    || r === "base"
    || r === "flight"
  ) {
    return "commander";
  }
  return "unknown";
}

export function sameSquadron(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

export function canWriteSquadronData(
  roleRaw: string | null | undefined,
  actorSquadronId: string | null | undefined,
  targetSquadronId: string | null | undefined,
): boolean {
  const role = normalizeLanRole(roleRaw);
  if (role === "super_admin" || role === "admin") return true;
  if (role === "ops") return sameSquadron(actorSquadronId, targetSquadronId);
  return false;
}
