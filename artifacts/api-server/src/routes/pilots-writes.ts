import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { canWriteSquadronData, normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

router.use(requireInternalWriteSecret);

/**
 * Insert or update one pilot row (same fields the Ops PC sends to Supabase).
 */
router.post("/pilots/upsert", async (req, res, next) => {
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
    const id = String(b.id ?? "").trim();
    const squadronId = String(b.squadron_id ?? "").trim();
    if (!id || !squadronId) {
      res.status(400).json({ error: "missing_id_or_squadron_id" });
      return;
    }
    const name = String(b.name ?? "").trim();
    const rank = String(b.rank ?? "").trim();
    if (!name || !rank) {
      res.status(400).json({ error: "missing_name_or_rank" });
      return;
    }
    const arabicName = b.arabic_name == null || b.arabic_name === "" ? null : String(b.arabic_name);
    const unit = b.unit == null ? null : String(b.unit);
    const phone = b.phone == null ? "" : String(b.phone);
    const available = Boolean(b.available ?? true);
    const data = typeof b.data === "object" && b.data !== null ? b.data : {};
    const rankEn = b.rank_en == null || b.rank_en === "" ? null : String(b.rank_en);
    if (lanUser && !canWriteSquadronData(lanUser.role, lanUser.squadron_id, squadronId)) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }

    try {
      const q = await pool.query(
        `
        insert into pilots (
          id, squadron_id, rank, name, arabic_name, unit, phone, available, data, updated_at, rank_en
        ) values (
          $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), $10
        )
        on conflict (id) do update set
          squadron_id = excluded.squadron_id,
          rank = excluded.rank,
          name = excluded.name,
          arabic_name = excluded.arabic_name,
          unit = excluded.unit,
          phone = excluded.phone,
          available = excluded.available,
          data = excluded.data,
          updated_at = now(),
          rank_en = excluded.rank_en
        returning *
        `,
        [id, squadronId, rank, name, arabicName, unit, phone, available, JSON.stringify(data), rankEn],
      );
      const row = q.rows[0];
      await appendInternalAudit(
        String(lanUser?.username ?? "system"),
        "internal.pilots.upsert",
        { pilot_id: id, squadron_id: squadronId, role: normalizeLanRole(lanUser?.role) },
      );
      res.json({ row });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "23505") {
        res.status(409).json({ error: "duplicate_key" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.delete("/pilots/:id", async (req, res, next) => {
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
    const existsQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from pilots where id = $1 limit 1`,
      [id],
    );
    const existing = existsQ.rows[0];
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
    const q = await pool.query(`delete from pilots where id = $1 returning id`, [id]);
    await appendInternalAudit(
      String(lanUser?.username ?? "system"),
      "internal.pilots.delete",
      { pilot_id: id, squadron_id: existing.squadron_id, role: normalizeLanRole(lanUser?.role) },
    );
    res.json({ ok: true, id: q.rows[0].id });
  } catch (err) {
    next(err);
  }
});

export default router;
