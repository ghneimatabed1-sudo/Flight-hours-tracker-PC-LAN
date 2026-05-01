import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";
import {
  hashPeerToken,
  listActivePeers,
  pingPeers,
  probePeerToken,
  type PeerSquadronRow,
} from "../lib/peer-fanout";

/**
 * Aggregator-side address book: the list of squadron hub PCs this
 * Wing/Base PC fans out to. Mounted at `/api/aggregate/peers`.
 *
 * Authorization: super_admin only. The bring-up window before any LAN
 * user is provisioned (no `req.lanUser`) is allowed so the install
 * wizard can seed the first peer entry.
 */
const router: IRouter = Router();

function isSuperAdmin(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true; // bring-up mode (HAWK_INTERNAL_SESSION_AUTH=off)
  return normalizeLanRole(user.role) === "super_admin";
}

function actorName(req: unknown): string {
  const user = readLanUser(req);
  return String(user?.username ?? "system");
}

/** Strip secrets — `auth_token` and `token_hash` never leave the box. */
function publicShape(row: PeerSquadronRow & { added_by?: string | null }) {
  return {
    id: row.id,
    squadron_id: row.squadron_id,
    squadron_name: row.squadron_name,
    base_url: row.base_url,
    last_ok_at: row.last_ok_at ? new Date(row.last_ok_at).toISOString() : null,
    last_error: row.last_error,
    last_error_at: row.last_error_at
      ? new Date(row.last_error_at).toISOString()
      : null,
    has_token: Boolean((row as { auth_token?: string | null }).auth_token),
    added_by: row.added_by ?? null,
  };
}

function statusOf(row: { last_ok_at: Date | null; last_error_at: Date | null }) {
  // Online if we have a last_ok_at and either no error or the OK is more recent.
  if (!row.last_ok_at) return "offline" as const;
  if (!row.last_error_at) return "online" as const;
  return new Date(row.last_ok_at) >= new Date(row.last_error_at)
    ? ("online" as const)
    : ("offline" as const);
}

/** GET /api/aggregate/peers — list address book + status block. */
router.get("/peers", async (req, res, next) => {
  try {
    if (!isSuperAdmin(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const peers = await listActivePeers();
    res.json({
      items: peers.map((p) => ({
        ...publicShape(p),
        status: statusOf(p),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/aggregate/peers/health — per-peer status snapshot via a
 * cheap parallel ping of `/api/peer/healthz`. Cheap enough for a
 * sidebar refresh; no row data flows through here.
 */
router.get("/peers/health", async (req, res, next) => {
  try {
    if (!isSuperAdmin(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const peers = await listActivePeers();
    const statuses = await pingPeers(peers);
    res.json({ peers: statuses });
  } catch (err) {
    next(err);
  }
});

type CreateBody = {
  squadron_id?: unknown;
  squadron_name?: unknown;
  base_url?: unknown;
  token?: unknown;
};

function parseCreateBody(b: CreateBody): {
  squadron_id: string;
  squadron_name: string | null;
  base_url: string;
  token: string;
} | { error: string } {
  const squadronId = String(b.squadron_id ?? "").trim();
  const squadronName =
    b.squadron_name == null || String(b.squadron_name).trim() === ""
      ? null
      : String(b.squadron_name).trim();
  const baseUrlRaw = String(b.base_url ?? "").trim();
  const token = String(b.token ?? "").trim();
  if (!squadronId) return { error: "missing_squadron_id" };
  if (!baseUrlRaw) return { error: "missing_base_url" };
  if (!token) return { error: "missing_token" };
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    return { error: "invalid_base_url" };
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    return { error: "invalid_base_url_protocol" };
  }
  return {
    squadron_id: squadronId,
    squadron_name: squadronName,
    base_url: baseUrl.toString().replace(/\/+$/, ""),
    token,
  };
}

/** POST /api/aggregate/peers — add a new peer to the address book. */
router.post("/peers", async (req, res, next) => {
  try {
    if (!isSuperAdmin(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const parsed = parseCreateBody((req.body ?? {}) as CreateBody);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const ins = await pool.query<{ id: string }>(
        `
        insert into peer_squadrons (
          squadron_id, squadron_name, base_url,
          auth_token, token_hash, added_by
        )
        values ($1, $2, $3, $4, $5, $6)
        returning id::text
        `,
        [
          parsed.squadron_id,
          parsed.squadron_name,
          parsed.base_url,
          parsed.token,
          hashPeerToken(parsed.token),
          actorName(req),
        ],
      );
      const id = ins.rows[0]?.id;
      await appendInternalAudit(actorName(req), "aggregate.peers.add", {
        id,
        squadron_id: parsed.squadron_id,
        base_url: parsed.base_url,
      });
      res.status(201).json({
        id,
        squadron_id: parsed.squadron_id,
        squadron_name: parsed.squadron_name,
        base_url: parsed.base_url,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key|peer_squadrons_squadron_idx/i.test(msg)) {
        res.status(409).json({ error: "peer_already_exists" });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

type PatchBody = {
  squadron_name?: unknown;
  base_url?: unknown;
  token?: unknown;
};

/** PATCH /api/aggregate/peers/:id — rename, swap token, or both. */
router.patch("/peers/:id", async (req, res, next) => {
  try {
    if (!isSuperAdmin(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const b = (req.body ?? {}) as PatchBody;

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (b.squadron_name !== undefined) {
      const v =
        b.squadron_name == null || String(b.squadron_name).trim() === ""
          ? null
          : String(b.squadron_name).trim();
      sets.push(`squadron_name = $${i++}`);
      params.push(v);
    }
    if (b.base_url !== undefined) {
      const raw = String(b.base_url).trim();
      if (!raw) {
        res.status(400).json({ error: "missing_base_url" });
        return;
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        res.status(400).json({ error: "invalid_base_url" });
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        res.status(400).json({ error: "invalid_base_url_protocol" });
        return;
      }
      sets.push(`base_url = $${i++}`);
      params.push(url.toString().replace(/\/+$/, ""));
    }
    if (b.token !== undefined) {
      const tok = String(b.token).trim();
      if (!tok) {
        res.status(400).json({ error: "missing_token" });
        return;
      }
      sets.push(`auth_token = $${i++}`);
      params.push(tok);
      sets.push(`token_hash = $${i++}`);
      params.push(hashPeerToken(tok));
      // A token swap also clears stale error markers so the next call
      // gets evaluated honestly (we no longer know if the previous
      // failure was the old token).
      sets.push(`last_error = null`);
      sets.push(`last_error_at = null`);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "nothing_to_update" });
      return;
    }

    params.push(id);
    const upd = await pool.query(
      `update peer_squadrons set ${sets.join(", ")} where id = $${i}::uuid and removed_at is null`,
      params,
    );
    if ((upd.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "peer_not_found" });
      return;
    }
    await appendInternalAudit(actorName(req), "aggregate.peers.edit", {
      id,
      changed: Object.keys(b),
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/aggregate/peers/:id/probe — try a candidate token against
 * the peer's `/api/peer/healthz` WITHOUT persisting it. Used by the
 * "Test" button in the Refresh Peer Token dialog so the operator can
 * confirm a freshly-pasted token works before clicking Save.
 *
 * Body: `{ auth_token: string }`. Response: `{ ok: true }` on success
 * or `{ ok: false, error: string, error_kind: PeerErrorKind }` so the
 * dialog can localise the failure reason.
 */
router.post("/peers/:id/probe", async (req, res, next) => {
  try {
    if (!isSuperAdmin(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    // Reject malformed ids before they hit Postgres so a typo doesn't
    // surface as an opaque 500 from the `::uuid` cast.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const body = (req.body ?? {}) as { auth_token?: unknown };
    const token = String(body.auth_token ?? "").trim();
    if (!token) {
      res.status(400).json({ error: "missing_token" });
      return;
    }
    const q = await pool.query<{ base_url: string }>(
      `select base_url from peer_squadrons
        where id = $1::uuid and removed_at is null
        limit 1`,
      [id],
    );
    const row = q.rows[0];
    if (!row) {
      res.status(404).json({ error: "peer_not_found" });
      return;
    }
    const result = await probePeerToken(row.base_url, token);
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    res.json({ ok: false, error: result.error, error_kind: result.error_kind });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/aggregate/peers/:id — soft delete (sets removed_at). */
router.delete("/peers/:id", async (req, res, next) => {
  try {
    if (!isSuperAdmin(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const upd = await pool.query(
      `update peer_squadrons set removed_at = now() where id = $1::uuid and removed_at is null`,
      [id],
    );
    if ((upd.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "peer_not_found" });
      return;
    }
    await appendInternalAudit(actorName(req), "aggregate.peers.remove", { id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
