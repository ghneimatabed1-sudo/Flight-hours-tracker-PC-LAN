import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { buildSquadronReadFilter, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

/**
 * Full pilot rows for the ops roster. Multi-tier RBAC: super_admin and
 * admin see every pilot; ops / commander_squadron / commander see only
 * their squadron; commander_wing sees every squadron under their wing;
 * commander_base sees every squadron under their base; an unknown role
 * sees nothing (fail-closed).
 */
router.get("/pilots", async (req, res, next) => {
  try {
    const actor = readLanUser(req);
    const filter = buildSquadronReadFilter(
      {
        role: actor?.role ?? null,
        squadronId: actor?.squadron_id ?? null,
        wingId: actor?.wing_id ?? null,
        baseId: actor?.base_id ?? null,
      },
      "p.squadron_id",
      1,
    );
    const where = filter ? `where 1 = 1 ${filter.sql}` : "";
    const params = filter ? filter.params : [];
    const q = await pool.query(
      `
      select
        p.id,
        p.squadron_id,
        p.rank,
        p.name,
        p.arabic_name,
        p.unit,
        p.phone,
        p.available,
        p.data,
        p.updated_at,
        p.rank_en
      from pilots p
      ${where}
      order by p.id asc
      `,
      params,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
