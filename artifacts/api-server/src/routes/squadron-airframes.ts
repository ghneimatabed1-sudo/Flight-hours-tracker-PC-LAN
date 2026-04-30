import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * Setup Wizard / migration 0039 squadron defaults — same JSON shape the
 * dashboard reads from Supabase `squadrons`, exposed for LAN-internal DB.
 */
router.get("/squadron-airframes", async (req, res, next) => {
  try {
    const raw = typeof req.query.number === "string" ? req.query.number.trim() : "";
    if (!raw) {
      res.status(400).json({ error: "missing_number", found: false });
      return;
    }
    const q = await pool.query<{
      base: string | null;
      wing: string | null;
      default_aircraft: unknown;
      default_monthly_targets: unknown;
    }>(
      `
      select
        s.base,
        s.wing,
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
