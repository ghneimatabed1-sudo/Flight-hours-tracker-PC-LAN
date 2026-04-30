import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canManageOpsBoard(roleRaw: string | null | undefined): boolean {
  const role = normalizeLanRole(roleRaw);
  return role === "ops" || role === "admin" || role === "super_admin";
}

router.get("/alerts", async (_req, res, next) => {
  try {
    const q = await pool.query(
      `
      select id, posted_at, body, author, priority
      from alerts
      order by posted_at desc
      limit 200
      `,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/alerts", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageOpsBoard(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const postedAt = String(b.posted_at ?? new Date().toISOString()).trim();
    const body = String(b.body ?? "").trim();
    const author = String(b.author ?? "").trim();
    const priority = String(b.priority ?? "normal").trim() || "normal";
    if (!body) {
      res.status(400).json({ error: "missing_body" });
      return;
    }
    const q = await pool.query(
      `
      insert into alerts (posted_at, body, author, priority)
      values ($1::timestamptz, $2, nullif($3, ''), nullif($4, ''))
      returning id, posted_at, body, author, priority
      `,
      [postedAt, body, author, priority],
    );
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.alerts.insert", {
      alert_id: q.rows[0]?.id ?? null,
      role: normalizeLanRole(lanUser?.role),
    });
    res.json({ row: q.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch("/alerts/:id", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageOpsBoard(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    const b = req.body as Record<string, unknown>;
    const body = String(b.body ?? "").trim();
    const priority = String(b.priority ?? "normal").trim() || "normal";
    if (!id || !body) {
      res.status(400).json({ error: "missing_id_or_body" });
      return;
    }
    const q = await pool.query(
      `
      update alerts
      set body = $2, priority = nullif($3, '')
      where id = $1
      returning id, posted_at, body, author, priority
      `,
      [id, body, priority],
    );
    if (!q.rows[0]) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.alerts.update", {
      alert_id: id,
      role: normalizeLanRole(lanUser?.role),
    });
    res.json({ row: q.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete("/alerts/:id", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageOpsBoard(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const q = await pool.query(`delete from alerts where id = $1 returning id`, [id]);
    if (!q.rows[0]) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.alerts.delete", {
      alert_id: id,
      role: normalizeLanRole(lanUser?.role),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/notams", async (_req, res, next) => {
  try {
    const q = await pool.query(
      `
      select id, notam_no, posted_on, body, priority
      from notams
      order by posted_on desc
      `,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/notams", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageOpsBoard(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = req.body as Record<string, unknown>;
    const notamNo = String(b.notam_no ?? "").trim();
    const postedOn = String(b.posted_on ?? "").trim();
    const body = String(b.body ?? "").trim();
    const priority = String(b.priority ?? "normal").trim() || "normal";
    if (!notamNo || !postedOn || !body) {
      res.status(400).json({ error: "missing_notam_fields" });
      return;
    }
    const q = await pool.query(
      `
      insert into notams (notam_no, posted_on, body, priority)
      values ($1, $2::date, $3, nullif($4, ''))
      returning id, notam_no, posted_on, body, priority
      `,
      [notamNo, postedOn, body, priority],
    );
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.notams.insert", {
      notam_id: q.rows[0]?.id ?? null,
      notam_no: notamNo,
      role: normalizeLanRole(lanUser?.role),
    });
    res.json({ row: q.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch("/notams/:id", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageOpsBoard(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    const b = req.body as Record<string, unknown>;
    const body = String(b.body ?? "").trim();
    const priority = String(b.priority ?? "normal").trim() || "normal";
    if (!id || !body) {
      res.status(400).json({ error: "missing_id_or_body" });
      return;
    }
    const q = await pool.query(
      `
      update notams
      set body = $2, priority = nullif($3, '')
      where id = $1
      returning id, notam_no, posted_on, body, priority
      `,
      [id, body, priority],
    );
    if (!q.rows[0]) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.notams.update", {
      notam_id: id,
      role: normalizeLanRole(lanUser?.role),
    });
    res.json({ row: q.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete("/notams/:id", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageOpsBoard(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const q = await pool.query(`delete from notams where id = $1 returning id`, [id]);
    if (!q.rows[0]) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.notams.delete", {
      notam_id: id,
      role: normalizeLanRole(lanUser?.role),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/schedule", async (req, res, next) => {
  try {
    const forDate = String(req.query.date ?? new Date().toISOString().slice(0, 10)).trim();
    if (!forDate) {
      res.status(400).json({ error: "missing_date" });
      return;
    }
    const q = await pool.query(
      `
      select *
      from schedule
      where flight_date = $1::date
      order by takeoff asc
      `,
      [forDate],
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
