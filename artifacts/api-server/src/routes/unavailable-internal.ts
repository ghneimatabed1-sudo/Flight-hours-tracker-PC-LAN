import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import {
  buildSquadronReadFilter,
  canWriteSquadronData,
  normalizeLanRole,
  readLanUser,
} from "../lib/lan-authz";

const router: IRouter = Router();

router.get("/unavailable", async (req, res, next) => {
  try {
    const actor = readLanUser(req);
    // Source of truth for the row's squadron is the pilot, not
    // unavailable.squadron_id (which legacy inserts don't populate).
    // commander_wing/commander_base must see every pilot under their
    // wing/base; ops/commander_squadron only their own squadron.
    const filter = buildSquadronReadFilter(
      {
        role: actor?.role ?? null,
        squadronId: actor?.squadron_id ?? null,
        wingId: actor?.wing_id ?? null,
        baseId: actor?.base_id ?? null,
      },
      "p.squadron_id",
      1,
    );
    const where = filter ? `where 1 = 1 ${filter.sql}` : "";
    const params = filter ? filter.params : [];
    const q = await pool.query(
      `
      select u.id, u.pilot_id, u.from_date, u.to_date, u.reason
      from unavailable u
      left join pilots p on p.id = u.pilot_id
      ${where}
      order by u.from_date desc
      `,
      params,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

router.post("/unavailable", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser) {
      const role = normalizeLanRole(lanUser.role);
      if (!(role === "ops" || role === "admin" || role === "super_admin")) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
    }
    const b = req.body as Record<string, unknown>;
    const pilotId = String(b.pilot_id ?? "").trim();
    const fromDate = String(b.from_date ?? "").trim();
    const toDate = String(b.to_date ?? "").trim();
    const reason = String(b.reason ?? "").trim();
    if (!pilotId || !fromDate || !toDate) {
      res.status(400).json({ error: "missing_pilot_or_date_range" });
      return;
    }
    const pilotQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from pilots where id = $1 limit 1`,
      [pilotId],
    );
    const pilot = pilotQ.rows[0];
    if (!pilot) {
      res.status(404).json({ error: "pilot_not_found" });
      return;
    }
    if (
      lanUser
      && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, pilot.squadron_id)
    ) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }
    const ins = await pool.query(
      `
      insert into unavailable (pilot_id, from_date, to_date, reason)
      values ($1, $2::date, $3::date, nullif($4, ''))
      returning id, pilot_id, from_date, to_date, reason
      `,
      [pilotId, fromDate, toDate, reason],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.unavailable.insert",
      { pilot_id: pilotId, from_date: fromDate, to_date: toDate, squadron_id: pilot.squadron_id },
    );
    res.json({ row: ins.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post("/unavailable/upsert-day", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser) {
      const role = normalizeLanRole(lanUser.role);
      if (!(role === "ops" || role === "admin" || role === "super_admin")) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
    }
    const b = req.body as Record<string, unknown>;
    const pilotId = String(b.pilot_id ?? "").trim();
    const dayIso = String(b.day_iso ?? "").trim();
    const reason = String(b.reason ?? "").trim();
    if (!pilotId || !dayIso || !reason) {
      res.status(400).json({ error: "missing_pilot_day_or_reason" });
      return;
    }

    const pilotQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from pilots where id = $1 limit 1`,
      [pilotId],
    );
    const pilot = pilotQ.rows[0];
    if (!pilot) {
      res.status(404).json({ error: "pilot_not_found" });
      return;
    }
    if (
      lanUser
      && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, pilot.squadron_id)
    ) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }

    await pool.query(
      `
      delete from unavailable
      where pilot_id = $1
        and from_date <= $2::date
        and to_date >= $2::date
      `,
      [pilotId, dayIso],
    );
    const ins = await pool.query(
      `
      insert into unavailable (pilot_id, from_date, to_date, reason)
      values ($1, $2::date, $2::date, $3)
      returning id, pilot_id, from_date, to_date, reason
      `,
      [pilotId, dayIso, reason],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.unavailable.upsert_day",
      { pilot_id: pilotId, from_date: dayIso, to_date: dayIso, squadron_id: pilot.squadron_id },
    );
    res.json({ row: ins.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete("/unavailable/day", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser) {
      const role = normalizeLanRole(lanUser.role);
      if (!(role === "ops" || role === "admin" || role === "super_admin")) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
    }
    const b = req.body as Record<string, unknown>;
    const pilotId = String(b.pilot_id ?? "").trim();
    const dayIso = String(b.day_iso ?? "").trim();
    if (!pilotId || !dayIso) {
      res.status(400).json({ error: "missing_pilot_or_day" });
      return;
    }

    const pilotQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from pilots where id = $1 limit 1`,
      [pilotId],
    );
    const pilot = pilotQ.rows[0];
    if (!pilot) {
      res.status(404).json({ error: "pilot_not_found" });
      return;
    }
    if (
      lanUser
      && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, pilot.squadron_id)
    ) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }

    await pool.query(
      `
      delete from unavailable
      where pilot_id = $1
        and from_date = $2::date
        and to_date = $2::date
      `,
      [pilotId, dayIso],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.unavailable.delete_day",
      { pilot_id: pilotId, day_iso: dayIso, squadron_id: pilot.squadron_id },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/unavailable/:id", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser) {
      const role = normalizeLanRole(lanUser.role);
      if (!(role === "ops" || role === "admin" || role === "super_admin")) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const q = await pool.query<{ pilot_id: string; squadron_id: string | null }>(
      `
      select u.pilot_id, p.squadron_id
      from unavailable u
      left join pilots p on p.id = u.pilot_id
      where u.id = $1
      limit 1
      `,
      [id],
    );
    const row = q.rows[0];
    if (!row) {
      res.status(404).json({ error: "unavailable_not_found" });
      return;
    }
    if (
      lanUser
      && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, row.squadron_id)
    ) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }
    await pool.query(`delete from unavailable where id = $1`, [id]);
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.unavailable.delete",
      { id, pilot_id: row.pilot_id, squadron_id: row.squadron_id },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
