import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canWrite(roleRaw: string | null | undefined): boolean {
  const role = normalizeLanRole(roleRaw);
  return role === "ops" || role === "admin" || role === "super_admin";
}

router.get("/saved-duty-weeks", async (req, res, next) => {
  try {
    const squadron = String(req.query.squadron ?? "").trim();
    if (!squadron) {
      res.status(400).json({ error: "missing_squadron" });
      return;
    }
    const q = await pool.query(
      `
      select squadron, start_date, rows, saved_at
      from saved_duty_weeks
      where squadron = $1
      order by start_date desc
      `,
      [squadron],
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/saved-duty-weeks", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canWrite(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const squadron = String(b.squadron ?? "").trim();
    const startDate = String(b.start_date ?? "").trim();
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const savedAt = String(b.saved_at ?? new Date().toISOString()).trim();
    if (!squadron || !startDate) {
      res.status(400).json({ error: "missing_squadron_or_start_date" });
      return;
    }
    await pool.query(
      `
      insert into saved_duty_weeks (squadron, start_date, rows, saved_at)
      values ($1, $2::date, $3::jsonb, $4::timestamptz)
      on conflict (squadron, start_date)
      do update set rows = excluded.rows, saved_at = excluded.saved_at
      `,
      [squadron, startDate, JSON.stringify(rows), savedAt],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.saved_duty_weeks.upsert",
      { squadron, start_date: startDate, role: normalizeLanRole(lanUser?.role) },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/saved-duty-weeks/old", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canWrite(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const squadron = String(req.query.squadron ?? "").trim();
    const cutoff = String(req.query.cutoff ?? "").trim();
    if (!squadron || !cutoff) {
      res.status(400).json({ error: "missing_squadron_or_cutoff" });
      return;
    }
    const q = await pool.query(
      `
      delete from saved_duty_weeks
      where squadron = $1
        and start_date < $2::date
      returning start_date
      `,
      [squadron, cutoff],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.saved_duty_weeks.delete_old",
      { squadron, cutoff, removed: q.rows.length, role: normalizeLanRole(lanUser?.role) },
    );
    res.json({ removed: q.rows.length });
  } catch (err) {
    next(err);
  }
});

export default router;
