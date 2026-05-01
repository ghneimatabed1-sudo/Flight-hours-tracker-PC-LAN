import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { buildSquadronReadFilter, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

/**
 * Schedule-safe pilot identifiers (flight name > call sign > id), never
 * the full person name. Multi-tier RBAC applies: same scope rules as
 * /pilots so a squadron commander can't enumerate other squadrons'
 * call signs.
 */
router.get("/pilot-options", async (req, res, next) => {
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
    const q = await pool.query<{
      id: string;
      schedule_name: string;
    }>(
      `
      select
        p.id::text as id,
        coalesce(
          nullif(trim(p.data->>'flightName'), ''),
          nullif(trim(p.data->>'flight_name'), ''),
          nullif(trim(p.data->>'callSign'), ''),
          nullif(trim(p.data->>'call_sign'), ''),
          p.id::text
        ) as schedule_name
      from pilots p
      ${where}
      order by schedule_name asc
      `,
      params,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
