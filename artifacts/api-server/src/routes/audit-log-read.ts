import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/audit-log", async (req, res, next) => {
  try {
    const raw = String(req.query.limit ?? "").trim();
    const n = Number.parseInt(raw || "2500", 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 5000) : 2500;
    try {
      const q = await pool.query<{
        occurred_at: string;
        actor: string | null;
        type: string;
        detail: unknown;
      }>(
        `
        select occurred_at, actor, type, detail
        from audit_log
        order by occurred_at desc
        limit $1
        `,
        [limit],
      );
      res.json({ items: q.rows });
    } catch (err) {
      // LAN bring-up can start before audit table migration lands.
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*audit_log.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

export default router;
