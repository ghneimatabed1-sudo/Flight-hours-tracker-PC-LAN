import { Router, type IRouter } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { hashPassword, verifyPassword } from "../lib/password";
import { readLanSessionTokenFromRequest } from "../lib/lan-auth-config";

const router: IRouter = Router();

const SESSION_DAYS = 30;
const LAN_DEV_NO_AUTH_ENABLED =
  String(process.env.HAWK_LAN_DEV_NO_AUTH ?? "").trim() === "1";

// ── Server-side brute-force protection ────────────────────────────────
// Tracks per-username failed login attempts in process memory.
// After MAX_ATTEMPTS failures within WINDOW_MS the account is locked
// for LOCKOUT_MS regardless of what the desktop UI shows.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

type LoginAttemptEntry = {
  count: number;
  windowStart: number;
  lockedUntil: number | null;
};

const loginAttempts = new Map<string, LoginAttemptEntry>();

function getLoginEntry(username: string): LoginAttemptEntry {
  let entry = loginAttempts.get(username);
  if (!entry) {
    entry = { count: 0, windowStart: Date.now(), lockedUntil: null };
    loginAttempts.set(username, entry);
  }
  return entry;
}

function isLoginLocked(username: string): boolean {
  const entry = loginAttempts.get(username);
  if (!entry || entry.lockedUntil == null) return false;
  if (Date.now() < entry.lockedUntil) return true;
  // Lockout expired — reset state
  loginAttempts.delete(username);
  return false;
}

function recordLoginFailure(username: string): void {
  const entry = getLoginEntry(username);
  const now = Date.now();
  // Reset window if expired
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
    entry.lockedUntil = null;
  }
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

function recordLoginSuccess(username: string): void {
  loginAttempts.delete(username);
}

function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** First user on a fresh internal DB. Requires HAWK_LAN_BOOTSTRAP_TOKEN on the server. */
router.post("/auth/lan/bootstrap", async (req, res, next) => {
  try {
    const serverTok = (process.env.HAWK_LAN_BOOTSTRAP_TOKEN ?? "").trim();
    if (!serverTok) {
      res.status(403).json({ error: "lan_bootstrap_disabled" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = String(b.token ?? "").trim();
    if (token !== serverTok) {
      res.status(403).json({ error: "lan_bootstrap_forbidden" });
      return;
    }
    const username = String(b.username ?? "").trim().toLowerCase();
    const displayName = String(b.displayName ?? b.display_name ?? "").trim();
    const password = String(b.password ?? "");
    const role = String(b.role ?? "super_admin").trim();
    const squadronId =
      b.squadronId == null || b.squadronId === "" ? null : String(b.squadronId);
    if (username.length < 3) {
      res.status(400).json({ error: "username_too_short" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "password_too_short" });
      return;
    }
    const countQ = await pool.query(`select count(*)::int as c from lan_users`);
    const c = countQ.rows[0]?.c ?? 0;
    if (c > 0) {
      res.status(409).json({ error: "lan_bootstrap_already_done" });
      return;
    }
    const id = randomUUID();
    const ph = await hashPassword(password);
    await pool.query(
      `
      insert into lan_users (id, username, display_name, role, squadron_id, password_hash)
      values ($1, $2, $3, $4, $5, $6)
      `,
      [id, username, displayName, role, squadronId, ph],
    );
    res.json({ ok: true, userId: id, username, role, squadronId: squadronId });
  } catch (err) {
    next(err);
  }
});

router.post("/auth/lan/login", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = String(b.username ?? "").trim().toLowerCase();
    const password = String(b.password ?? "");
    if (username.length < 3) {
      res.status(400).json({ error: "username_too_short" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "password_too_short" });
      return;
    }
    // Server-side lockout check — must run before any DB or crypto work.
    if (isLoginLocked(username)) {
      res.status(429).json({ error: "lan_account_locked" });
      return;
    }
    const uq = await pool.query<{
      id: string;
      display_name: string;
      role: string;
      squadron_id: string | null;
      password_hash: string;
      disabled_at: string | null;
    }>(
      `select id, display_name, role, squadron_id, password_hash, disabled_at from lan_users where lower(username) = lower($1) limit 1`,
      [username],
    );
    const u = uq.rows[0];
    if (!u) {
      recordLoginFailure(username);
      res.status(401).json({ error: "lan_bad_creds" });
      return;
    }
    if (!(await verifyPassword(password, u.password_hash))) {
      recordLoginFailure(username);
      res.status(401).json({ error: "lan_bad_creds" });
      return;
    }
    if (u.disabled_at) {
      res.status(403).json({ error: "lan_user_disabled" });
      return;
    }
    recordLoginSuccess(username);
    const sessionTok = newSessionToken();
    const sessionId = randomUUID();
    await pool.query(
      `
      insert into lan_sessions (id, user_id, token, expires_at)
      values ($1, $2, $3, now() + $4::int * interval '1 day')
      `,
      [sessionId, u.id, sessionTok, SESSION_DAYS],
    );
    res.json({
      ok: true,
      token: sessionTok,
      user: {
        id: u.id,
        username,
        displayName: u.display_name,
        role: u.role,
        squadronId: u.squadron_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DEV/bring-up only: mint a LAN session without password checks when
 * `HAWK_LAN_DEV_NO_AUTH=1`. Helps LAN cutover rehearsals where the operator
 * explicitly wants security disabled temporarily.
 */
router.post("/auth/lan/dev-session", async (req, res, next) => {
  try {
    if (!LAN_DEV_NO_AUTH_ENABLED) {
      res.status(403).json({ error: "lan_dev_no_auth_disabled" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = String(b.username ?? "").trim().toLowerCase();
    if (username.length < 3) {
      res.status(400).json({ error: "username_too_short" });
      return;
    }
    const displayName = String(b.displayName ?? b.display_name ?? username).trim();
    const role = String(b.role ?? "super_admin").trim() || "super_admin";
    const squadronId =
      b.squadronId == null || b.squadronId === "" ? null : String(b.squadronId);

    const existingQ = await pool.query<{
      id: string;
      username: string;
      display_name: string;
      role: string;
      squadron_id: string | null;
    }>(
      `
      select id, username, display_name, role, squadron_id
      from lan_users
      where lower(username) = lower($1)
      limit 1
      `,
      [username],
    );

    let user = existingQ.rows[0];
    if (!user) {
      const id = randomUUID();
      const ph = await hashPassword(`dev-no-auth-${randomUUID()}`);
      const ins = await pool.query<{
        id: string;
        username: string;
        display_name: string;
        role: string;
        squadron_id: string | null;
      }>(
        `
        insert into lan_users (id, username, display_name, role, squadron_id, password_hash)
        values ($1, $2, $3, $4, $5, $6)
        returning id, username, display_name, role, squadron_id
        `,
        [id, username, displayName || username, role, squadronId, ph],
      );
      user = ins.rows[0];
    }

    const sessionTok = newSessionToken();
    const sessionId = randomUUID();
    await pool.query(
      `
      insert into lan_sessions (id, user_id, token, expires_at)
      values ($1, $2, $3, now() + $4::int * interval '1 day')
      `,
      [sessionId, user.id, sessionTok, SESSION_DAYS],
    );

    res.json({
      ok: true,
      token: sessionTok,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        squadronId: user.squadron_id,
      },
      noAuth: true,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/auth/lan/logout", async (req, res, next) => {
  try {
    const t =
      readLanSessionTokenFromRequest({
        get(name: string) {
          if (name.toLowerCase() === "x-hawk-lan-session")
            return req.get("x-hawk-lan-session");
          if (name.toLowerCase() === "authorization")
            return req.get("Authorization") ?? req.get("authorization");
          return req.get(name);
        },
      }) ?? String((req.body as { token?: string })?.token ?? "").trim();
    if (t) {
      await pool.query(`delete from lan_sessions where token = $1`, [t]);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/auth/lan/me", async (req, res, next) => {
  try {
    const token = readLanSessionTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "lan_session_required" });
      return;
    }
    const q = await pool.query<{
      user_id: string;
      username: string;
      display_name: string;
      role: string;
      squadron_id: string | null;
    }>(
      `
      select
        u.id as user_id,
        u.username,
        u.display_name,
        u.role,
        u.squadron_id
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
    res.json({
      ok: true,
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        squadronId: row.squadron_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
