import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { hashPassword } from "../lib/password";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canManageUsers(roleRaw: string | null | undefined): boolean {
  const role = normalizeLanRole(roleRaw);
  return role === "ops" || role === "admin" || role === "super_admin";
}

function isMissingTableError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01";
}

router.get("/users", async (_req, res, next) => {
  try {
    const q = await pool.query(
      `
      select id, username, role, created_at
      from lan_users
      where lower(role) in ('ops', 'deputy')
      order by created_at asc
      `,
    );
    res.json({ items: q.rows });
  } catch (err) {
    if (isMissingTableError(err)) {
      res.json({ items: [] });
      return;
    }
    next(err);
  }
});

router.post("/users", requireInternalWriteSecret, async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !canManageUsers(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = String(b.username ?? "").trim().toLowerCase();
    const password = String(b.password ?? "");
    const role = String(b.role ?? "deputy").trim().toLowerCase() || "deputy";
    const displayName = String(b.display_name ?? b.displayName ?? username).trim() || username;
    const squadronId = lanUser?.squadron_id ? String(lanUser.squadron_id) : null;
    if (username.length < 3) {
      res.status(400).json({ error: "username_too_short" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "password_too_short" });
      return;
    }
    if (!(role === "deputy" || role === "ops")) {
      res.status(400).json({ error: "invalid_role" });
      return;
    }
    const exists = await pool.query(`select 1 from lan_users where lower(username)=lower($1) limit 1`, [username]);
    if (exists.rows[0]) {
      res.status(409).json({ error: "username_exists" });
      return;
    }
    const id = randomUUID();
    const ph = await hashPassword(password);
    const ins = await pool.query(
      `
      insert into lan_users (id, username, display_name, role, squadron_id, password_hash)
      values ($1, $2, $3, $4, $5, $6)
      returning id, username, role, created_at
      `,
      [id, username, displayName, role, squadronId, ph],
    );
    await appendInternalAudit(String(lanUser?.username ?? "system"), "internal.users.create", {
      user_id: id,
      username,
      role,
      squadron_id: squadronId,
      actor_role: normalizeLanRole(lanUser?.role),
    });
    res.json({ row: ins.rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get("/reminders/overview", async (_req, res, next) => {
  try {
    const [prefsQ, notifQ] = await Promise.all([
      pool.query(
        `
        select pilot_id, thresholds, push_enabled, expo_push_token, platform, updated_at
        from pilot_reminder_prefs
        `,
      ),
      pool.query(
        `
        select distinct on (pilot_id)
          pilot_id, currency_key, expiry_date, threshold_days, sent_at
        from pilot_currency_notifications
        order by pilot_id, sent_at desc
        `,
      ),
    ]);
    const lastByPilot = new Map<string, Record<string, unknown>>();
    for (const row of notifQ.rows as Record<string, unknown>[]) {
      lastByPilot.set(String(row.pilot_id ?? ""), row);
    }
    const byPilot = new Map<string, Record<string, unknown>>();
    for (const p of prefsQ.rows as Record<string, unknown>[]) {
      const pid = String(p.pilot_id ?? "");
      const last = lastByPilot.get(pid);
      byPilot.set(pid, {
        pilotId: pid,
        pushEnabled: Boolean(p.push_enabled),
        expoPushToken: (p.expo_push_token as string | null) ?? null,
        platform: (p.platform as string | null) ?? null,
        thresholds: (p.thresholds as Record<string, unknown> | null) ?? {},
        updatedAt: (p.updated_at as string | null) ?? null,
        lastSentAt: (last?.sent_at as string | null) ?? null,
        lastSentCurrency: (last?.currency_key as string | null) ?? null,
        lastSentThresholdDays: (last?.threshold_days as number | null) ?? null,
        lastSentExpiry: (last?.expiry_date as string | null) ?? null,
      });
    }
    for (const [pid, last] of lastByPilot) {
      if (byPilot.has(pid)) continue;
      byPilot.set(pid, {
        pilotId: pid,
        pushEnabled: false,
        expoPushToken: null,
        platform: null,
        thresholds: {},
        updatedAt: null,
        lastSentAt: (last.sent_at as string | null) ?? null,
        lastSentCurrency: (last.currency_key as string | null) ?? null,
        lastSentThresholdDays: (last.threshold_days as number | null) ?? null,
        lastSentExpiry: (last.expiry_date as string | null) ?? null,
      });
    }
    res.json({ items: Array.from(byPilot.values()) });
  } catch (err) {
    if (isMissingTableError(err)) {
      res.json({ items: [] });
      return;
    }
    next(err);
  }
});

export default router;
