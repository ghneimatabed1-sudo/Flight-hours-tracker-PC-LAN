import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/pilot-options", async (_req, res, next) => {
  try {
    // Supabase-shaped schema: pilots.id + pilots.data JSONB.
    // We deliberately return schedule-safe identifiers only
    // (flight name > call sign > id), never the full person name.
    const q = await pool.query<{
      id: string;
      schedule_name: string;
    }>(`
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
      order by schedule_name asc
    `);
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
