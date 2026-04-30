import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * Full pilot rows for the ops roster — same columns the dashboard reads with
 * `select * from pilots` via Supabase (PostgREST shape, snake_case keys).
 */
router.get("/pilots", async (_req, res, next) => {
  try {
    const q = await pool.query(`
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
      order by p.id asc
    `);
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
