import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { canWriteSquadronData, normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

async function runOptionalUpdate(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  sql: string,
  params: unknown[],
) {
  try {
    await client.query(sql, params);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01") return;
    throw err;
  }
}

router.post("/pilots/transfer", requireInternalWriteSecret, async (req, res, next) => {
  const lanUser = readLanUser(req);
  try {
    if (!lanUser) {
      res.status(401).json({ error: "lan_session_required" });
      return;
    }
    const role = normalizeLanRole(lanUser.role);
    if (!(role === "ops" || role === "admin" || role === "super_admin")) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pilotId = String(b.pilot_id ?? "").trim();
    const toSquadronId = String(b.to_squadron_id ?? "").trim();
    if (!pilotId || !toSquadronId) {
      res.status(400).json({ error: "missing_pilot_or_destination" });
      return;
    }
    const fromQ = await pool.query<{ squadron_id: string | null }>(
      `select squadron_id from pilots where id = $1 limit 1`,
      [pilotId],
    );
    const from = fromQ.rows[0]?.squadron_id;
    if (!from) {
      res.status(404).json({ error: "pilot_not_found" });
      return;
    }
    if (!canWriteSquadronData(lanUser.role, lanUser.squadron_id, from)) {
      res.status(403).json({ error: "foreign_squadron_forbidden" });
      return;
    }
    if (String(from).toLowerCase() === toSquadronId.toLowerCase()) {
      res.status(409).json({ error: "already_in_target_squadron" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update pilots set squadron_id = $2::uuid, updated_at = now() where id = $1`,
        [pilotId, toSquadronId],
      );
      await client.query(
        `
        update sorties
        set squadron_id = $2::uuid
        where pilot_id = $1
           or co_pilot_id = $1
        `,
        [pilotId, toSquadronId],
      );
      await runOptionalUpdate(
        client,
        `
        update currencies
        set squadron_id = $2::uuid
        where pilot_id = $1
        `,
        [pilotId, toSquadronId],
      );
      await runOptionalUpdate(
        client,
        `
        update leaves
        set squadron_id = $2::uuid
        where pilot_id = $1
        `,
        [pilotId, toSquadronId],
      );
      await client.query(
        `
        update unavailable
        set squadron_id = $2::uuid
        where pilot_id = $1
        `,
        [pilotId, toSquadronId],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }

    await appendInternalAudit(
      String(lanUser.username ?? "system"),
      "internal.pilot.transfer",
      {
        pilot_id: pilotId,
        from_squadron_id: from,
        to_squadron_id: toSquadronId,
        role,
      },
    );
    res.json({
      ok: true,
      pilotId,
      fromSquadron: from,
      toSquadron: toSquadronId,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
