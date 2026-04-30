import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { canWriteSquadronData, normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function normText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

router.post("/import/history", requireInternalWriteSecret, async (req, res, next) => {
  const lanUser = readLanUser(req);
  try {
    if (!lanUser) {
      res.status(401).json({ error: "lan_session_required" });
      return;
    }
    if (!canWriteSquadronData(lanUser.role, lanUser.squadron_id, lanUser.squadron_id)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const squadronId = String(lanUser.squadron_id ?? "").trim();
    if (!squadronId) {
      res.status(400).json({ error: "missing_actor_squadron" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pilots = Array.isArray(b.pilots) ? (b.pilots as Record<string, unknown>[]) : [];
    const sorties = Array.isArray(b.sorties) ? (b.sorties as Record<string, unknown>[]) : [];
    const stamp = normText(b.stamp) ?? new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const p of pilots) {
        const id = String(p.id ?? "").trim();
        const name = String(p.name ?? "").trim();
        const rank = String(p.rank ?? "").trim();
        if (!id || !name || !rank) continue;
        const data = typeof p === "object" && p ? p : {};
        await client.query(
          `
          insert into pilots (id, squadron_id, rank, name, arabic_name, unit, phone, available, data, updated_at, rank_en)
          values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), $10)
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
          `,
          [
            id,
            squadronId,
            rank,
            name,
            normText(p.arabicName),
            normText(p.unit),
            normText(p.phone) ?? "",
            Boolean(p.available ?? true),
            JSON.stringify({ ...data, imported: true, importedAt: stamp }),
            normText(p.rankEn),
          ],
        );
      }
      for (const s of sorties) {
        const id = String(s.id ?? "").trim();
        const pilotId = String(s.pilotId ?? "").trim();
        const date = String(s.date ?? "").trim();
        if (!id || !pilotId || !date) continue;
        const data = typeof s === "object" && s ? s : {};
        await client.query(
          `
          insert into sorties (
            id, squadron_id, pilot_id, co_pilot_id, date, ac_type, ac_number, sortie_type, sortie_name, data, created_by
          ) values (
            $1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9, $10::jsonb, $11
          )
          on conflict (id) do update set
            squadron_id = excluded.squadron_id,
            pilot_id = excluded.pilot_id,
            co_pilot_id = excluded.co_pilot_id,
            date = excluded.date,
            ac_type = excluded.ac_type,
            ac_number = excluded.ac_number,
            sortie_type = excluded.sortie_type,
            sortie_name = excluded.sortie_name,
            data = excluded.data
          `,
          [
            id,
            squadronId,
            pilotId,
            normText(s.coPilotId),
            date,
            normText(s.acType),
            normText(s.acNumber),
            normText(s.sortieType),
            normText(s.name) ?? "",
            JSON.stringify({ ...data, imported: true, importedAt: stamp }),
            normText(lanUser.username),
          ],
        );
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    await appendInternalAudit(
      String(lanUser.username ?? "system"),
      "internal.import.history.ok",
      {
        imported: true,
        stamp,
        pilots: pilots.length,
        sorties: sorties.length,
        squadron_id: squadronId,
        role: normalizeLanRole(lanUser.role),
      },
    );
    res.json({ ok: true, stamp, pilotsInserted: pilots.length, sortiesInserted: sorties.length });
  } catch (err) {
    next(err);
  }
});

router.post("/import/undo", requireInternalWriteSecret, async (req, res, next) => {
  const lanUser = readLanUser(req);
  try {
    if (!lanUser) {
      res.status(401).json({ error: "lan_session_required" });
      return;
    }
    if (!canWriteSquadronData(lanUser.role, lanUser.squadron_id, lanUser.squadron_id)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const squadronId = String(lanUser.squadron_id ?? "").trim();
    const stamp = String((req.body as Record<string, unknown>)?.stamp ?? "").trim();
    if (!squadronId || !stamp) {
      res.status(400).json({ error: "missing_squadron_or_stamp" });
      return;
    }
    const client = await pool.connect();
    let sortiesRemoved = 0;
    let pilotsRemoved = 0;
    try {
      await client.query("begin");
      const sDel = await client.query(
        `
        delete from sorties
        where squadron_id = $1::uuid
          and data->>'importedAt' = $2
        returning id
        `,
        [squadronId, stamp],
      );
      sortiesRemoved = sDel.rows.length;
      const pDel = await client.query(
        `
        delete from pilots
        where squadron_id = $1::uuid
          and data->>'importedAt' = $2
        returning id
        `,
        [squadronId, stamp],
      );
      pilotsRemoved = pDel.rows.length;
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    await appendInternalAudit(
      String(lanUser.username ?? "system"),
      "internal.import.history.undone",
      {
        stamp,
        pilots: pilotsRemoved,
        sorties: sortiesRemoved,
        squadron_id: squadronId,
        role: normalizeLanRole(lanUser.role),
      },
    );
    res.json({ ok: true, pilotsRemoved, sortiesRemoved });
  } catch (err) {
    next(err);
  }
});

export default router;
