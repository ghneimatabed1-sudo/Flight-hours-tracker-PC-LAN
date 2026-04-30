import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canReadRegistry(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true; // bring-up mode when session auth is off
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

function canWriteRegistry(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true; // bring-up mode when session auth is off
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

router.get("/xpc/registry", async (req, res, next) => {
  try {
    if (!canReadRegistry(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const includeStale = String(req.query.include_stale ?? "").trim() === "1";
    const staleHoursRaw = Number.parseInt(String(req.query.stale_hours ?? "24"), 10);
    const staleHours =
      Number.isFinite(staleHoursRaw) && staleHoursRaw > 0 && staleHoursRaw <= 24 * 14
        ? staleHoursRaw
        : 24;
    const activeSecondsRaw = Number.parseInt(String(req.query.active_seconds ?? "90"), 10);
    const activeSeconds =
      Number.isFinite(activeSecondsRaw) && activeSecondsRaw > 0 && activeSecondsRaw <= 60 * 60
        ? activeSecondsRaw
        : 90;
    const windowExpr = includeStale
      ? `${staleHours} hours`
      : `${activeSeconds} seconds`;
    try {
      const q = await pool.query<{
        id: string;
        squadron_name: string | null;
        tier: string | null;
        base: string | null;
        wing: string | null;
        device_name: string | null;
        last_seen: string | null;
        parent_pc_id: string | null;
        squadron_pc_id: string | null;
      }>(
        `
        select
          id,
          squadron_name,
          tier,
          base,
          wing,
          device_name,
          last_seen,
          parent_pc_id,
          squadron_pc_id
        from xpc_registry
        where last_seen >= now() - $1::interval
        order by last_seen desc
        limit 5000
        `,
        [windowExpr],
      );
      res.json({ items: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_registry.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/registry/heartbeat", async (req, res, next) => {
  try {
    if (!canWriteRegistry(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "").trim();
    const squadronName = String(b.squadron_name ?? "").trim();
    const tierRaw = String(b.tier ?? "squadron").trim().toLowerCase();
    const tier =
      tierRaw === "wing" || tierRaw === "base" || tierRaw === "hq"
        ? tierRaw
        : "squadron";
    const base = b.base == null || b.base === "" ? null : String(b.base);
    const wing = b.wing == null || b.wing === "" ? null : String(b.wing);
    const deviceName =
      b.device_name == null || b.device_name === "" ? null : String(b.device_name);
    const parentPcId =
      b.parent_pc_id == null || b.parent_pc_id === "" ? null : String(b.parent_pc_id);
    const squadronPcId =
      b.squadron_pc_id == null || b.squadron_pc_id === "" ? null : String(b.squadron_pc_id);
    const lastSeen = String(b.last_seen ?? "").trim();

    if (!id || !squadronName) {
      res.status(400).json({ error: "missing_id_or_squadron_name" });
      return;
    }

    try {
      await pool.query(
        `
        insert into xpc_registry (
          id, squadron_name, tier, base, wing, device_name, last_seen, parent_pc_id, squadron_pc_id
        ) values (
          $1, $2, $3, $4, $5, $6, coalesce(nullif($7,'' )::timestamptz, now()), $8, $9
        )
        on conflict (id) do update set
          squadron_name = excluded.squadron_name,
          tier = excluded.tier,
          base = excluded.base,
          wing = excluded.wing,
          device_name = excluded.device_name,
          last_seen = excluded.last_seen,
          parent_pc_id = excluded.parent_pc_id,
          squadron_pc_id = excluded.squadron_pc_id
        `,
        [id, squadronName, tier, base, wing, deviceName, lastSeen, parentPcId, squadronPcId],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const missingNewColumns =
        /parent_pc_id|squadron_pc_id/i.test(msg) && /does not exist|schema cache/i.test(msg);
      if (missingNewColumns) {
        await pool.query(
          `
          insert into xpc_registry (
            id, squadron_name, tier, base, wing, device_name, last_seen
          ) values (
            $1, $2, $3, $4, $5, $6, coalesce(nullif($7,'' )::timestamptz, now())
          )
          on conflict (id) do update set
            squadron_name = excluded.squadron_name,
            tier = excluded.tier,
            base = excluded.base,
            wing = excluded.wing,
            device_name = excluded.device_name,
            last_seen = excluded.last_seen
          `,
          [id, squadronName, tier, base, wing, deviceName, lastSeen],
        );
      } else if (/relation .*xpc_registry.* does not exist/i.test(msg)) {
        res.status(503).json({ error: "xpc_registry_missing" });
        return;
      } else {
        throw err;
      }
    }

    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.registry.heartbeat",
      { id, tier, squadron_name: squadronName },
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/xpc/registry", async (req, res, next) => {
  try {
    if (!canWriteRegistry(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const q = req.query as Record<string, unknown>;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const includeSelfRaw = q.include_self ?? b.include_self;
    const includeSelf = String(includeSelfRaw ?? "").trim() === "1"
      || String(includeSelfRaw ?? "").trim().toLowerCase() === "true";
    const keepPcIdRaw = q.keep_pc_id ?? b.keep_pc_id;
    const keepPcId = keepPcIdRaw == null || keepPcIdRaw === ""
      ? null
      : String(keepPcIdRaw).trim();

    let removedRegistry = 0;
    let removedClaims = 0;
    try {
      const reg = includeSelf || !keepPcId
        ? await pool.query<{ id: string }>(
          "delete from xpc_registry returning id",
        )
        : await pool.query<{ id: string }>(
          "delete from xpc_registry where id <> $1 returning id",
          [keepPcId],
        );
      removedRegistry = reg.rowCount ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/relation .*xpc_registry.* does not exist/i.test(msg)) throw err;
    }

    try {
      const claims = includeSelf || !keepPcId
        ? await pool.query<{ pc_id: string }>(
          "delete from xpc_user_pcs returning pc_id",
        )
        : await pool.query<{ pc_id: string }>(
          "delete from xpc_user_pcs where pc_id <> $1 returning pc_id",
          [keepPcId],
        );
      removedClaims = claims.rowCount ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/relation .*xpc_user_pcs.* does not exist/i.test(msg)) throw err;
    }

    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.registry.wipe",
      {
        include_self: includeSelf,
        keep_pc_id: keepPcId,
        removed_registry: removedRegistry,
        removed_claims: removedClaims,
      },
    );
    res.json({
      ok: true,
      removed_registry: removedRegistry,
      removed_claims: removedClaims,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
