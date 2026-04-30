import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * Super Admin squadron registry mirror — same columns the dashboard reads
 * via `refreshSquadronsFromDb` from Supabase `squadrons`.
 */
router.get("/squadrons", async (_req, res, next) => {
  try {
    const q = await pool.query<{
      id: string;
      number: string;
      name: string;
      base: string;
      wing: string | null;
    }>(`
      select
        s.id::text as id,
        s.number,
        s.name,
        s.base,
        s.wing
      from squadrons s
      order by s.name asc
    `);
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
