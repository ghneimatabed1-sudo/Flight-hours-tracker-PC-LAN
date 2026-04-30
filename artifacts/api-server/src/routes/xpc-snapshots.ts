import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canUseSnapshots(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true;
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

router.get("/xpc/snapshots", async (req, res, next) => {
  try {
    if (!canUseSnapshots(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const squadronId = String(req.query.squadron_id ?? "").trim();
    try {
      if (squadronId) {
        const q = await pool.query<Record<string, unknown>>(
          `
          select squadron_id, ops_pc_id, snapshot_at, payload
          from xpc_squadron_snapshot
          where squadron_id = $1
          limit 1
          `,
          [squadronId],
        );
        res.json({ items: q.rows });
        return;
      }
      const q = await pool.query<Record<string, unknown>>(
        `
        select squadron_id, ops_pc_id, snapshot_at, payload
        from xpc_squadron_snapshot
        order by snapshot_at desc
        `,
      );
      res.json({ items: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_squadron_snapshot.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/snapshots", async (req, res, next) => {
  try {
    if (!canUseSnapshots(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const squadronId = String(b.squadron_id ?? "").trim();
    const opsPcId = String(b.ops_pc_id ?? "").trim();
    if (!squadronId || !opsPcId) {
      res.status(400).json({ error: "missing_squadron_or_ops_pc" });
      return;
    }
    await pool.query(
      `
      insert into xpc_squadron_snapshot (
        squadron_id, ops_pc_id, snapshot_at, payload
      ) values (
        $1, $2, coalesce(nullif($3,'')::timestamptz, now()), $4::jsonb
      )
      on conflict (squadron_id) do update set
        ops_pc_id = excluded.ops_pc_id,
        snapshot_at = excluded.snapshot_at,
        payload = excluded.payload
      `,
      [
        squadronId,
        opsPcId,
        String(b.snapshot_at ?? ""),
        JSON.stringify(b.payload ?? {}),
      ],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.snapshot.publish",
      { squadron_id: squadronId, ops_pc_id: opsPcId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
