import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { readLanUser, normalizeLanRole } from "../lib/lan-authz";

const router: IRouter = Router();

const AuditLogPostSchema = z.object({
  type: z.string().min(1).max(120),
  actor: z.string().max(120).nullish(),
  detail: z.record(z.unknown()).nullish(),
});

router.post("/audit/log", async (req, res, next) => {
  try {
    const parsed = AuditLogPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_audit_payload" });
      return;
    }
    const { type, actor, detail } = parsed.data;
    const lanUser = (req as unknown as { lanUser?: { username?: string } | null }).lanUser ?? null;
    const resolvedActor = (actor ?? lanUser?.username ?? null) || null;
    const actorUnknown = !resolvedActor;
    if (actorUnknown) {
      req.log?.warn?.(
        { type, route: "/api/audit/log" },
        "audit row written with no resolvable actor",
      );
    }
    try {
      await pool.query(
        `
        insert into audit_log (occurred_at, actor, type, detail)
        values (now(), $1, $2, $3::jsonb)
        `,
        [
          resolvedActor,
          type,
          JSON.stringify({
            ...(detail ?? {}),
            ...(actorUnknown ? { actor_unknown: true } : {}),
          }),
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*audit_log.* does not exist/i.test(msg)) {
        // Bootstrap before schema landed — best-effort no-op so the
        // user's real action never fails because of audit insert.
        res.json({ ok: true, skipped: "audit_log_table_missing" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get("/audit-log", async (req, res, next) => {
  try {
    const user = readLanUser(req);
    // In bring-up mode (no session system) there is no user context; allow.
    // When auth is active, only super_admin may read the audit log.
    if (user !== null) {
      const role = normalizeLanRole(user.role);
      if (role !== "super_admin") {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
    }
    const raw = String(req.query.limit ?? "").trim();
    const n = Number.parseInt(raw || "2500", 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 5000) : 2500;
    try {
      const q = await pool.query<{
        occurred_at: string;
        actor: string | null;
        type: string;
        detail: unknown;
      }>(
        `
        select occurred_at, actor, type, detail
        from audit_log
        order by occurred_at desc
        limit $1
        `,
        [limit],
      );
      res.json({ items: q.rows });
    } catch (err) {
      // LAN bring-up can start before audit table migration lands.
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*audit_log.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

export default router;
