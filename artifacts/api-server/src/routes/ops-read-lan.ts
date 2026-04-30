import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

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
    const q = await pool.query(
      `
      select pilot_id, year, months
      from leaves
      where year = $1
      `,
      [year],
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
