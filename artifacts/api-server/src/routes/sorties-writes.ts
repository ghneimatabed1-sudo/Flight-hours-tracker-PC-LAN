import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { canWriteSquadronData, normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

router.use(requireInternalWriteSecret);

function normText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * Insert one sortie (Ops PC → internal Postgres).
 */
router.post("/sorties", async (req, res, next) => {
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
    const squadronId = String(b.squadron_id ?? "").trim();
    const pilotId = String(b.pilot_id ?? "").trim();
    const date = String(b.date ?? "").trim();
    if (!squadronId || !pilotId || !date) {
      res.status(400).json({ error: "missing_squadron_pilot_or_date" });
      return;
    }
    const coPilotId = normText(b.co_pilot_id);
    const acType = normText(b.ac_type);
    const acNumber = normText(b.ac_number);
    const sortieType = normText(b.sortie_type);
    const sortieName = normText(b.sortie_name) ?? "";
    const data = typeof b.data === "object" && b.data !== null ? b.data : {};
    const createdBy = normText(b.created_by);
    if (lanUser && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, squadronId)) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }

    const q = await pool.query(
      `
      insert into sorties (
        squadron_id, pilot_id, co_pilot_id, date, ac_type, ac_number, sortie_type, sortie_name, data, created_by
      ) values (
        $1::uuid, $2, $3, $4::date, $5, $6, $7, $8, $9::jsonb, $10
      )
      returning *
      `,
      [
        squadronId,
        pilotId,
        coPilotId,
        date,
        acType,
        acNumber,
        sortieType,
        sortieName,
        JSON.stringify(data),
        createdBy,
      ],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.sorties.insert",
      { sortie_id: q.rows[0]?.id ?? null, squadron_id: squadronId, role: normalizeLanRole(lanUser?.role) },
    );
    res.json({ row: q.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch("/sorties/:id", async (req, res, next) => {
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
    const b = req.body as Record<string, unknown>;
    const pilotId = String(b.pilot_id ?? "").trim();
    const date = String(b.date ?? "").trim();
    if (!pilotId || !date) {
      res.status(400).json({ error: "missing_pilot_or_date" });
      return;
    }
    const coPilotId = normText(b.co_pilot_id);
    const acType = normText(b.ac_type);
    const acNumber = normText(b.ac_number);
    const sortieType = normText(b.sortie_type);
    const sortieName = normText(b.sortie_name) ?? "";
    const data = typeof b.data === "object" && b.data !== null ? b.data : {};
    const existingQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from sorties where id = $1::uuid limit 1`,
      [id],
    );
    const existing = existingQ.rows[0];
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (
      lanUser
      && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, existing.squadron_id)
    ) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }

    const q = await pool.query(
      `
      update sorties set
        pilot_id = $2,
        co_pilot_id = $3,
        date = $4::date,
        ac_type = $5,
        ac_number = $6,
        sortie_type = $7,
        sortie_name = $8,
        data = $9::jsonb
      where id = $1::uuid
      returning *
      `,
      [id, pilotId, coPilotId, date, acType, acNumber, sortieType, sortieName, JSON.stringify(data)],
    );
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.sorties.update",
      { sortie_id: id, squadron_id: existing.squadron_id, role: normalizeLanRole(lanUser?.role) },
    );
    res.json({ row: q.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.delete("/sorties/:id", async (req, res, next) => {
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
    const existingQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from sorties where id = $1::uuid limit 1`,
      [id],
    );
    const existing = existingQ.rows[0];
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (
      lanUser
      && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, existing.squadron_id)
    ) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }
    const q = await pool.query(`delete from sorties where id = $1::uuid returning id`, [id]);
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.sorties.delete",
      { sortie_id: id, squadron_id: existing.squadron_id, role: normalizeLanRole(lanUser?.role) },
    );
    res.json({ ok: true, id: String(q.rows[0].id) });
  } catch (err) {
    next(err);
  }
});

export default router;
