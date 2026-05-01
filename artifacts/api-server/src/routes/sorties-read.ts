import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { buildSquadronReadFilter, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

/**
 * Recent sorties for the ops log. Multi-tier RBAC: super_admin and
 * admin see every sortie; ops / commander_squadron / commander see
 * only their squadron's; commander_wing sees every squadron under
 * their wing; commander_base sees every squadron under their base.
 */
router.get("/sorties", async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 500;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 2000
      ? Math.floor(rawLimit)
      : 500;
    const actor = readLanUser(req);
    const filter = buildSquadronReadFilter(
      {
        role: actor?.role ?? null,
        squadronId: actor?.squadron_id ?? null,
        wingId: actor?.wing_id ?? null,
        baseId: actor?.base_id ?? null,
      },
      "squadron_id",
      2,
    );
    const where = filter ? `where 1 = 1 ${filter.sql}` : "";
    const params: unknown[] = [limit, ...(filter ? filter.params : [])];
    const q = await pool.query(
      `
      select *
      from sorties
      ${where}
      order by date desc
      limit $1::int
      `,
      params,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
