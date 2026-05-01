import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import {
  canReadSquadronData,
  canWriteSquadronData,
  normalizeLanRole,
  readLanUser,
} from "../lib/lan-authz";

const router: IRouter = Router();

function canWrite(roleRaw: string | null | undefined): boolean {
  const role = normalizeLanRole(roleRaw);
  return role === "ops" || role === "admin" || role === "super_admin";
}

type SquadronScope = {
  id: string | null;
  wing_id: string | null;
  base_id: string | null;
};

async function resolveSquadronScope(
  squadron: string,
): Promise<SquadronScope | null> {
  const q = await pool.query<SquadronScope>(
    `select id::text as id, wing_id, base_id
     from squadrons
     where number = $1 or name = $1
     limit 1`,
    [squadron],
  );
  return q.rows[0] ?? null;
}

router.get("/saved-duty-weeks", async (req, res, next) => {
  try {
    const squadron = String(req.query.squadron ?? "").trim();
    if (!squadron) {
      res.status(400).json({ error: "missing_squadron" });
      return;
    }
    const actor = readLanUser(req);
    if (actor) {
      const role = normalizeLanRole(actor.role);
      // saved_duty_weeks identifies its squadron by display
      // name/number text rather than a UUID, so we must resolve the
      // requested squadron back to a row in `squadrons` to obtain the
      // wing/base ids that canReadSquadronData needs.
      if (role !== "super_admin" && role !== "admin") {
        const target = await resolveSquadronScope(squadron);
        if (!target) {
          res.status(404).json({ error: "squadron_not_found" });
          return;
        }
        if (
          !canReadSquadronData(
            {
              role: actor.role,
              squadronId: actor.squadron_id ?? null,
              wingId: actor.wing_id ?? null,
              baseId: actor.base_id ?? null,
            },
            {
              squadronId: target.id,
              wingId: target.wing_id,
              baseId: target.base_id,
            },
          )
        ) {
          res.status(403).json({ error: "foreign_squadron_forbidden" });
          return;
        }
      }
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
    if (lanUser) {
      const role = normalizeLanRole(lanUser.role);
      if (role !== "super_admin" && role !== "admin") {
        // ops/commander_* may only write their own squadron. Resolve
        // the target squadron's UUID and compare against the actor's.
        const target = await resolveSquadronScope(squadron);
        if (!target) {
          res.status(404).json({ error: "squadron_not_found" });
          return;
        }
        if (
          !canWriteSquadronData(
            lanUser.role,
            lanUser.squadron_id ?? null,
            target.id,
          )
        ) {
          res.status(403).json({ error: "foreign_squadron_forbidden" });
          return;
        }
      }
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
    if (lanUser) {
      const role = normalizeLanRole(lanUser.role);
      if (role !== "super_admin" && role !== "admin") {
        const target = await resolveSquadronScope(squadron);
        if (!target) {
          res.status(404).json({ error: "squadron_not_found" });
          return;
        }
        if (
          !canWriteSquadronData(
            lanUser.role,
            lanUser.squadron_id ?? null,
            target.id,
          )
        ) {
          res.status(403).json({ error: "foreign_squadron_forbidden" });
          return;
        }
      }
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
