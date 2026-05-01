export type LanUserContext = {
  user_id?: string;
  username?: string;
  display_name?: string;
  role?: string;
  squadron_id?: string | null;
  wing_id?: string | null;
  base_id?: string | null;
};

type ReqWithLanUser = {
  lanUser?: LanUserContext;
};

export function readLanUser(req: unknown): LanUserContext | null {
  const u = (req as ReqWithLanUser)?.lanUser;
  return u && typeof u === "object" ? u : null;
}

/**
 * Explicit role tiers used by the LAN api-server.
 *
 *  - super_admin       — host PC operator. Anything goes.
 *  - admin             — back-office HQ admin. Reads + writes everywhere.
 *  - ops               — squadron ops officer. Reads + writes only their
 *                        squadron's data.
 *  - commander_squadron — single-squadron commander. Reads everywhere in
 *                        their squadron, no writes outside it.
 *  - commander_wing    — wing commander. Reads everything under their
 *                        wing_id; writes only their own squadron.
 *  - commander_base    — base commander. Reads everything under their
 *                        base_id; writes only their own squadron.
 *  - commander         — legacy/unscoped commander. Reads + writes only
 *                        their own squadron (fail-closed default).
 *  - unknown           — unrecognised role. No reads, no writes.
 */
export type LanRole =
  | "super_admin"
  | "admin"
  | "ops"
  | "commander_squadron"
  | "commander_wing"
  | "commander_base"
  | "commander"
  | "unknown";

export function normalizeLanRole(raw: string | null | undefined): LanRole {
  const r = String(raw ?? "").trim().toLowerCase();
  if (r === "super_admin" || r === "superadmin") return "super_admin";
  if (r === "admin") return "admin";
  if (r === "ops") return "ops";
  if (r === "commander_wing" || r === "commander:wing" || r === "wing") {
    return "commander_wing";
  }
  if (r === "commander_base" || r === "commander:base" || r === "base") {
    return "commander_base";
  }
  if (
    r === "commander_squadron"
    || r === "commander:squadron"
    || r === "squadron"
    || r === "flight"
  ) {
    return "commander_squadron";
  }
  if (r === "commander" || r.startsWith("commander:")) return "commander";
  return "unknown";
}

// Fail-closed identity comparison. Empty / null on either side never
// matches — otherwise an actor with a missing scope ID could read or
// write a legacy row whose corresponding scope ID is also null.
export function sameSquadron(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "").trim().toLowerCase();
  const right = String(b ?? "").trim().toLowerCase();
  if (left === "" || right === "") return false;
  return left === right;
}

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "").trim().toLowerCase();
  const right = String(b ?? "").trim().toLowerCase();
  if (left === "" || right === "") return false;
  return left === right;
}

/**
 * Write authorization. Every internal write route should call this with
 * the actor's role + squadron and the target row's squadron.
 *
 * Multi-tier commanders can READ across their wing/base, but they
 * cannot WRITE outside their own squadron — write access is the strong
 * gate, and we fail-closed for any role we don't explicitly recognise.
 */
export function canWriteSquadronData(
  roleRaw: string | null | undefined,
  actorSquadronId: string | null | undefined,
  targetSquadronId: string | null | undefined,
): boolean {
  const role = normalizeLanRole(roleRaw);
  if (role === "super_admin" || role === "admin") return true;
  if (
    role === "ops"
    || role === "commander_squadron"
    || role === "commander_wing"
    || role === "commander_base"
    || role === "commander"
  ) {
    return sameSquadron(actorSquadronId, targetSquadronId);
  }
  return false;
}

/**
 * Read authorization. Wider than write — multi-tier commanders read
 * across their scope.
 *
 * @param actor       resolved LAN user context (must include scope IDs
 *                    when role is multi-tier)
 * @param target      resolved target row's scope IDs
 */
export function canReadSquadronData(
  actor: {
    role: string | null | undefined;
    squadronId?: string | null;
    wingId?: string | null;
    baseId?: string | null;
  },
  target: {
    squadronId?: string | null;
    wingId?: string | null;
    baseId?: string | null;
  },
): boolean {
  const role = normalizeLanRole(actor.role);
  if (role === "super_admin" || role === "admin") return true;
  if (role === "ops") return sameSquadron(actor.squadronId, target.squadronId);
  if (role === "commander_wing") {
    return sameId(actor.wingId, target.wingId)
      || sameSquadron(actor.squadronId, target.squadronId);
  }
  if (role === "commander_base") {
    return sameId(actor.baseId, target.baseId)
      || sameSquadron(actor.squadronId, target.squadronId);
  }
  if (role === "commander_squadron" || role === "commander") {
    return sameSquadron(actor.squadronId, target.squadronId);
  }
  return false;
}

/**
 * Build a parameterised SQL fragment that constrains a query to the
 * rows the actor is allowed to READ. Used by routes that select bulk
 * lists (pilots, sorties, schedule) so the wing/base scope is enforced
 * at the database, not in JS post-filters.
 *
 * @param actor          resolved LAN user context
 * @param squadronColumn fully-qualified squadron-id column on the
 *                       outer query, e.g. `"p.squadron_id"`. Must be
 *                       a literal known to the calling route — never
 *                       caller-supplied — to avoid SQL injection.
 * @param firstParamIndex index of the first $N placeholder this
 *                       fragment should use (so it composes cleanly
 *                       with caller-supplied bind params).
 *
 * Returns:
 *   - `null` when the actor is super_admin/admin (no filter — read
 *     everything).
 *   - `{ sql, params }` otherwise. `sql` already starts with `and`
 *     so it can be appended to an existing `where` clause; pass
 *     `{ sql: " where " + sql.replace(/^and /, "") }` if you need a
 *     standalone `where`.
 *   - `{ sql: "and false", params: [] }` for `unknown` roles —
 *     fail-closed.
 */
export function buildSquadronReadFilter(
  actor: {
    role: string | null | undefined;
    squadronId?: string | null;
    wingId?: string | null;
    baseId?: string | null;
  },
  squadronColumn: string,
  firstParamIndex: number,
): { sql: string; params: unknown[] } | null {
  const role = normalizeLanRole(actor.role);
  if (role === "super_admin" || role === "admin") return null;

  if (role === "commander_wing") {
    const wingId = (actor.wingId ?? "").trim();
    const sqId = (actor.squadronId ?? "").trim();
    if (!wingId && !sqId) return { sql: "and false", params: [] };
    if (!wingId) {
      return {
        sql: `and ${squadronColumn}::text = $${firstParamIndex}`,
        params: [sqId],
      };
    }
    return {
      sql:
        `and (${squadronColumn} in (select id from squadrons where wing_id = $${firstParamIndex})`
        + ` or ${squadronColumn}::text = $${firstParamIndex + 1})`,
      params: [wingId, sqId],
    };
  }
  if (role === "commander_base") {
    const baseId = (actor.baseId ?? "").trim();
    const sqId = (actor.squadronId ?? "").trim();
    if (!baseId && !sqId) return { sql: "and false", params: [] };
    if (!baseId) {
      return {
        sql: `and ${squadronColumn}::text = $${firstParamIndex}`,
        params: [sqId],
      };
    }
    return {
      sql:
        `and (${squadronColumn} in (select id from squadrons where base_id = $${firstParamIndex})`
        + ` or ${squadronColumn}::text = $${firstParamIndex + 1})`,
      params: [baseId, sqId],
    };
  }
  if (role === "ops" || role === "commander_squadron" || role === "commander") {
    const sqId = (actor.squadronId ?? "").trim();
    if (!sqId) return { sql: "and false", params: [] };
    return {
      sql: `and ${squadronColumn}::text = $${firstParamIndex}`,
      params: [sqId],
    };
  }
  // unknown role — fail-closed
  return { sql: "and false", params: [] };
}
