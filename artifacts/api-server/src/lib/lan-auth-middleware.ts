import type { RequestHandler } from "express";
import { pool } from "@workspace/db";
import { internalSessionAuthMode, readLanSessionTokenFromRequest } from "./lan-auth-config";

export const requireInternalLanSession: RequestHandler = async (req, res, next) => {
  if (internalSessionAuthMode() === "off") {
    next();
    return;
  }
  const token = readLanSessionTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "lan_session_required" });
    return;
  }
  try {
    const q = await pool.query<{
      user_id: string;
      username: string;
      display_name: string;
      role: string;
      squadron_id: string | null;
      wing_id: string | null;
      base_id: string | null;
    }>(
      `
      select
        u.id as user_id,
        u.username,
        u.display_name,
        u.role,
        u.squadron_id,
        u.wing_id,
        u.base_id
      from lan_sessions s
      join lan_users u on u.id = s.user_id
      where s.token = $1
        and s.expires_at > now()
        and u.disabled_at is null
      limit 1
      `,
      [token],
    );
    const row = q.rows[0];
    if (!row) {
      res.status(401).json({ error: "lan_session_invalid" });
      return;
    }
    (req as { lanUser?: typeof row }).lanUser = row;
    next();
  } catch (err) {
    next(err);
  }
};
