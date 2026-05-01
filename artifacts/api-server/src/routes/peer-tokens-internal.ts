import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";
import { issuePeerToken } from "../lib/peer-token";

/**
 * Admin CRUD for peer access tokens. Only super_admin may create or
 * revoke tokens; reads are restricted to super_admin too because the
 * list (label + last_used_at) is sensitive operational information.
 *
 * The plain token is returned exactly once at create time; we never
 * store it and never expose it through GET / list responses — only the
 * row's id, label, scope, expires_at, last_used_at and revoked_at are
 * surfaced afterwards.
 */

const router: IRouter = Router();

function isSuperAdmin(roleRaw: string | null | undefined): boolean {
  return normalizeLanRole(roleRaw) === "super_admin";
}

type PeerTokenRow = {
  id: string;
  label: string | null;
  scope: string;
  issued_at: string;
  issued_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
};

function publicRow(r: PeerTokenRow): PeerTokenRow {
  // Strip token_hash, never returned. Other columns are safe to expose.
  return {
    id: r.id,
    label: r.label,
    scope: r.scope,
    issued_at: r.issued_at,
    issued_by: r.issued_by,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    revoked_by: r.revoked_by,
    last_used_at: r.last_used_at,
  };
}

router.get("/peer-tokens", async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !isSuperAdmin(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const q = await pool.query<PeerTokenRow>(
      `select id, label, scope, issued_at, issued_by, expires_at,
              revoked_at, revoked_by, last_used_at
       from peer_tokens
       order by issued_at desc`,
    );
    res.json({ items: q.rows.map(publicRow) });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/peer-tokens",
  requireInternalWriteSecret,
  async (req, res, next) => {
    try {
      const lanUser = readLanUser(req);
      if (lanUser && !isSuperAdmin(lanUser.role)) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const label = String(body.name ?? body.label ?? "").trim();
      if (label.length < 1) {
        res.status(400).json({ error: "missing_name" });
        return;
      }
      if (label.length > 200) {
        res.status(400).json({ error: "name_too_long" });
        return;
      }
      const scope = String(body.scope ?? "squadron-read").trim() || "squadron-read";
      const expiresRaw =
        body.expires_at ?? body.expiresAt ?? null;
      const expiresAt = expiresRaw == null || String(expiresRaw).trim() === ""
        ? null
        : String(expiresRaw).trim();
      if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
        res.status(400).json({ error: "invalid_expires_at" });
        return;
      }

      const issued = await issuePeerToken();
      const issuedBy = String(lanUser?.username ?? "system");
      const ins = await pool.query<PeerTokenRow>(
        `
        insert into peer_tokens (
          id, token_hash, label, scope, issued_by, expires_at
        ) values ($1, $2, $3, $4, $5, $6::timestamptz)
        returning id, label, scope, issued_at, issued_by, expires_at,
                  revoked_at, revoked_by, last_used_at
        `,
        [issued.id, issued.hash, label, scope, issuedBy, expiresAt],
      );
      const row = ins.rows[0]!;
      await appendInternalAudit(issuedBy, "internal.peer_tokens.create", {
        token_id: row.id,
        token_label: row.label,
        scope: row.scope,
        expires_at: row.expires_at,
        actor_role: normalizeLanRole(lanUser?.role),
      });
      res.json({ token: issued.plain, row: publicRow(row) });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/peer-tokens/:id",
  requireInternalWriteSecret,
  async (req, res, next) => {
    try {
      const lanUser = readLanUser(req);
      if (lanUser && !isSuperAdmin(lanUser.role)) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
      const id = String(req.params.id ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "id_required" });
        return;
      }
      const revokedBy = String(lanUser?.username ?? "system");
      const upd = await pool.query<PeerTokenRow>(
        `
        update peer_tokens
        set revoked_at = now(), revoked_by = $2
        where id = $1
          and revoked_at is null
        returning id, label, scope, issued_at, issued_by, expires_at,
                  revoked_at, revoked_by, last_used_at
        `,
        [id, revokedBy],
      );
      const row = upd.rows[0];
      if (!row) {
        // Either does not exist or already revoked. Distinguish.
        const existsQ = await pool.query<{ id: string }>(
          `select id from peer_tokens where id = $1 limit 1`,
          [id],
        );
        if (!existsQ.rows[0]) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.status(409).json({ error: "already_revoked" });
        return;
      }
      await appendInternalAudit(revokedBy, "internal.peer_tokens.revoke", {
        token_id: row.id,
        token_label: row.label,
        actor_role: normalizeLanRole(lanUser?.role),
      });
      res.json({ ok: true, row: publicRow(row) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;

// Test-only exports so unit tests can pin the role gate without
// round-tripping through HTTP. Production code never imports this.
export const __testing__ = { isSuperAdmin };
