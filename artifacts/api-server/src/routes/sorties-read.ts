import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * Recent sorties for the ops log — mirrors `select * from sorties order by
 * date desc limit 500` used by the dashboard.
 */
router.get("/sorties", async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 500;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 2000
      ? Math.floor(rawLimit)
      : 500;
    const q = await pool.query(
      `
      select *
      from sorties
      order by date desc
      limit $1::int
      `,
      [limit],
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
