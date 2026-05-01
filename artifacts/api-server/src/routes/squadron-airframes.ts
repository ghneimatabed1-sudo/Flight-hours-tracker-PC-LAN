import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { canReadSquadronData, normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

/**
 * Setup Wizard / migration 0039 squadron defaults — same JSON shape the
 * dashboard reads from Supabase `squadrons`, exposed for LAN-internal DB.
 *
 * Authorisation model:
 *  - The Setup Wizard runs before any LAN auth has been bootstrapped, so we
 *    leave the route open in that "first-run" window. Bring-up is detected
 *    by counting `lan_users` rows (same signal lan-auth-public uses for
 *    `lan_bootstrap_already_done`). Once at least one LAN user exists, this
 *    carve-out closes and an authenticated actor is required.
 *  - Once auth is initialised we require a LAN actor and gate the lookup on
 *    canReadSquadronData so a squadron-tier user cannot pull another
 *    squadron's defaults. super_admin / admin bypass the scope check.
 */
router.get("/squadron-airframes", async (req, res, next) => {
  try {
    const raw = typeof req.query.number === "string" ? req.query.number.trim() : "";
    if (!raw) {
      res.status(400).json({ error: "missing_number", found: false });
      return;
    }
    const actor = readLanUser(req);
    let bootstrapDone = true;
    if (!actor) {
      // No actor attached — only honour the request if LAN auth has not
      // been bootstrapped yet (Setup Wizard window). Otherwise refuse.
      try {
        const c = await pool.query<{ c: number }>(
          `select count(*)::int as c from lan_users`,
        );
        bootstrapDone = (c.rows[0]?.c ?? 0) > 0;
      } catch {
        // If the lan_users table doesn't exist yet, treat as not-bootstrapped.
        bootstrapDone = false;
      }
      if (bootstrapDone) {
        res.status(401).json({ error: "actor_required", found: false });
        return;
      }
    }

    const q = await pool.query<{
      id: string;
      base: string | null;
      wing: string | null;
      wing_id: string | null;
      base_id: string | null;
      default_aircraft: unknown;
      default_monthly_targets: unknown;
    }>(
      `
      select
        s.id::text as id,
        s.base,
        s.wing,
        s.wing_id,
        s.base_id,
        s.default_aircraft,
        s.default_monthly_targets
      from squadrons s
      where s.number = $1
      limit 1
      `,
      [raw],
    );
    const row = q.rows[0];
    if (!row) {
      res.json({ found: false });
      return;
    }
    if (actor) {
      const role = normalizeLanRole(actor.role);
      if (role !== "super_admin" && role !== "admin") {
        if (
          !canReadSquadronData(
            {
              role: actor.role,
              squadronId: actor.squadron_id ?? null,
              wingId: actor.wing_id ?? null,
              baseId: actor.base_id ?? null,
            },
            {
              squadronId: row.id,
              wingId: row.wing_id,
              baseId: row.base_id,
            },
          )
        ) {
          res.status(403).json({ error: "foreign_squadron_forbidden", found: false });
          return;
        }
      }
    }
    res.json({
      found: true,
      base: row.base,
      wing: row.wing,
      default_aircraft: row.default_aircraft,
      default_monthly_targets: row.default_monthly_targets,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
