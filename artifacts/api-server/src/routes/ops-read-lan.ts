import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { buildSquadronReadFilter, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

router.get("/duty-week", async (_req, res, next) => {
  try {
    const q = await pool.query(
      `
      select day, main_duty, standby, rcm
      from duty_week
      order by effective_from desc
      limit 7
      `,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

router.get("/leaves", async (req, res, next) => {
  try {
    const yearRaw = String(req.query.year ?? "").trim();
    const year = Number.parseInt(yearRaw || String(new Date().getFullYear()), 10);
    if (!Number.isFinite(year) || year < 1990 || year > 2100) {
      res.status(400).json({ error: "invalid_year" });
      return;
    }
    // Multi-tier RBAC: scope per pilot's squadron so a wing/base
    // commander sees their command's leaves, not just their own
    // squadron's. Sourcing squadron from pilots keeps legacy rows
    // (where leaves.squadron_id is NULL) authorising correctly.
    const actor = readLanUser(req);
    const filter = buildSquadronReadFilter(
      {
        role: actor?.role ?? null,
        squadronId: actor?.squadron_id ?? null,
        wingId: actor?.wing_id ?? null,
        baseId: actor?.base_id ?? null,
      },
      "p.squadron_id",
      2,
    );
    const where = filter ? `where l.year = $1 ${filter.sql}` : `where l.year = $1`;
    const params: unknown[] = [year, ...(filter ? filter.params : [])];
    const q = await pool.query(
      `
      select l.pilot_id, l.year, l.months
      from leaves l
      left join pilots p on p.id = l.pilot_id
      ${where}
      `,
      params,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
