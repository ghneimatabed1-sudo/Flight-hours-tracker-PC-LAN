import { Router, type IRouter, type RequestHandler } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { parsePeerToken, verifyPeerSecret } from "../lib/peer-token";

/**
 * Read-only `/api/peer/*` surface.
 *
 * An outside reader (Wing Commander PC, Base Commander PC, …) hits
 * these endpoints with a `X-Hawk-Peer-Token` header issued from the
 * hub's super_admin. The token grants reads on the data we agreed
 * flows up; it never grants writes, never grants access to private
 * squadron data, and can be revoked at any time from the Admin Users
 * page.
 *
 * The four explicitly-blocked surfaces (`/weekly-roster`,
 * `/schedule`, `/pilot-devices`, `/lan-users`) are mounted here too
 * so an operator can tell the difference between "doesn't exist" and
 * "intentionally blocked".
 */

const HEADER = "x-hawk-peer-token";

type PeerActor = {
  tokenId: string;
  label: string | null;
};

type ReqWithPeer = { peerToken?: PeerActor };

function readPeerActor(req: unknown): PeerActor | null {
  return ((req as ReqWithPeer)?.peerToken ?? null);
}

const requirePeerToken: RequestHandler = async (req, res, next) => {
  try {
    const raw = req.get(HEADER);
    const parsed = parsePeerToken(raw ?? null);
    if (!parsed) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    const q = await pool.query<{
      id: string;
      label: string | null;
      token_hash: string;
      revoked_at: string | null;
      expires_at: string | null;
    }>(
      `select id, label, token_hash, revoked_at, expires_at
       from peer_tokens
       where id = $1
       limit 1`,
      [parsed.id],
    );
    const row = q.rows[0];
    if (!row) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (row.revoked_at) {
      // Distinct from `invalid_token` so the aggregator can show the
      // operator a "token revoked → paste new one" prompt instead of a
      // generic "auth failed" badge. `peer-fanout.ts::classifyHttpError`
      // maps this body string onto `PeerErrorKind.auth_revoked` so the
      // /aggregate/peers/health surface stays stable.
      res.status(401).json({ error: "revoked_token" });
      return;
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      // Lapsed-expiry is treated as revocation by the consumer side
      // (it's never going to recover without operator action), so it
      // shares the same `revoked_token` body — `classifyHttpError`
      // routes both onto `auth_revoked`.
      res.status(401).json({ error: "revoked_token" });
      return;
    }
    if (!(await verifyPeerSecret(parsed.secret, row.token_hash))) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    (req as ReqWithPeer).peerToken = {
      tokenId: row.id,
      label: row.label ?? null,
    };
    // Best-effort touch; failure shouldn't block the read.
    pool
      .query(`update peer_tokens set last_used_at = now() where id = $1`, [row.id])
      .catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Look up the hub's primary squadron — the row to tag responses with
 * at envelope level. Returns null on multi-squadron / empty hubs;
 * row-level squadron context still travels with each row via JOIN.
 */
async function readHubSquadronContext(): Promise<{
  squadron_id: string | null;
  squadron_name: string | null;
}> {
  try {
    const q = await pool.query<{
      id: string | null;
      number: string | null;
      name: string | null;
    }>(
      `select id::text as id, number, name
       from squadrons
       order by created_at asc`,
    );
    if (q.rows.length === 1) {
      const r = q.rows[0]!;
      const friendly = (r.name ?? r.number ?? "").trim();
      return {
        squadron_id: r.id,
        squadron_name: friendly === "" ? null : friendly,
      };
    }
    return { squadron_id: null, squadron_name: null };
  } catch {
    return { squadron_id: null, squadron_name: null };
  }
}

async function auditPeerRead(
  actor: PeerActor,
  resource: string,
  outcome: "ok" | "blocked" | "error",
  extra?: Record<string, unknown>,
): Promise<void> {
  await appendInternalAudit(
    `peer:${actor.label ?? actor.tokenId}`,
    "peer.read",
    {
      token_id: actor.tokenId,
      token_label: actor.label,
      resource,
      outcome,
      ...(extra ?? {}),
    },
  );
}

const router: IRouter = Router();

router.use(requirePeerToken);

// ── Read endpoints ──────────────────────────────────────────────────

router.get("/pilots", async (req, res, next) => {
  const actor = readPeerActor(req);
  if (!actor) {
    res.status(401).json({ error: "invalid_peer_token" });
    return;
  }
  try {
    const ctx = await readHubSquadronContext();
    const q = await pool.query(
      `
      select
        p.id,
        p.squadron_id::text as squadron_id,
        coalesce(nullif(s.name, ''), s.number) as squadron_name,
        p.rank,
        p.rank_en,
        p.name,
        p.arabic_name,
        p.unit,
        p.available,
        p.data,
        p.updated_at
      from pilots p
      left join squadrons s on s.id = p.squadron_id
      order by p.id asc
      `,
    );
    await auditPeerRead(actor, "pilots", "ok", { count: q.rows.length });
    res.json({
      squadron_id: ctx.squadron_id,
      squadron_name: ctx.squadron_name,
      items: q.rows,
    });
  } catch (err) {
    await auditPeerRead(actor, "pilots", "error").catch(() => {});
    next(err);
  }
});

router.get("/sorties", async (req, res, next) => {
  const actor = readPeerActor(req);
  if (!actor) {
    res.status(401).json({ error: "invalid_peer_token" });
    return;
  }
  try {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 500;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 2000
      ? Math.floor(rawLimit)
      : 500;
    const ctx = await readHubSquadronContext();
    const q = await pool.query(
      `
      select
        so.id,
        so.squadron_id::text as squadron_id,
        coalesce(nullif(s.name, ''), s.number) as squadron_name,
        so.pilot_id,
        so.co_pilot_id,
        so.date,
        so.ac_type,
        so.ac_number,
        so.sortie_type,
        so.sortie_name,
        so.data,
        so.created_at
      from sorties so
      left join squadrons s on s.id = so.squadron_id
      order by so.date desc
      limit $1::int
      `,
      [limit],
    );
    await auditPeerRead(actor, "sorties", "ok", { count: q.rows.length });
    res.json({
      squadron_id: ctx.squadron_id,
      squadron_name: ctx.squadron_name,
      items: q.rows,
    });
  } catch (err) {
    await auditPeerRead(actor, "sorties", "error").catch(() => {});
    next(err);
  }
});

router.get("/leaves", async (req, res, next) => {
  const actor = readPeerActor(req);
  if (!actor) {
    res.status(401).json({ error: "invalid_peer_token" });
    return;
  }
  try {
    const yearRaw = String(req.query.year ?? "").trim();
    const year = Number.parseInt(yearRaw || String(new Date().getFullYear()), 10);
    if (!Number.isFinite(year) || year < 1990 || year > 2100) {
      res.status(400).json({ error: "invalid_year" });
      return;
    }
    const ctx = await readHubSquadronContext();
    const q = await pool.query(
      `
      select
        l.pilot_id,
        l.year,
        l.months,
        p.squadron_id::text as squadron_id,
        coalesce(nullif(s.name, ''), s.number) as squadron_name
      from leaves l
      left join pilots p on p.id = l.pilot_id
      left join squadrons s on s.id = p.squadron_id
      where l.year = $1
      `,
      [year],
    );
    await auditPeerRead(actor, "leaves", "ok", { year, count: q.rows.length });
    res.json({
      squadron_id: ctx.squadron_id,
      squadron_name: ctx.squadron_name,
      items: q.rows,
    });
  } catch (err) {
    await auditPeerRead(actor, "leaves", "error").catch(() => {});
    next(err);
  }
});

router.get("/unavailable", async (req, res, next) => {
  const actor = readPeerActor(req);
  if (!actor) {
    res.status(401).json({ error: "invalid_peer_token" });
    return;
  }
  try {
    const ctx = await readHubSquadronContext();
    const q = await pool.query(
      `
      select
        u.id,
        u.pilot_id,
        u.from_date,
        u.to_date,
        u.reason,
        p.squadron_id::text as squadron_id,
        coalesce(nullif(s.name, ''), s.number) as squadron_name
      from unavailable u
      left join pilots p on p.id = u.pilot_id
      left join squadrons s on s.id = p.squadron_id
      order by u.from_date desc
      `,
    );
    await auditPeerRead(actor, "unavailable", "ok", { count: q.rows.length });
    res.json({
      squadron_id: ctx.squadron_id,
      squadron_name: ctx.squadron_name,
      items: q.rows,
    });
  } catch (err) {
    await auditPeerRead(actor, "unavailable", "error").catch(() => {});
    next(err);
  }
});

router.get("/notams", async (req, res, next) => {
  const actor = readPeerActor(req);
  if (!actor) {
    res.status(401).json({ error: "invalid_peer_token" });
    return;
  }
  try {
    const ctx = await readHubSquadronContext();
    const q = await pool.query(
      `
      select id, notam_no, posted_on, body, priority
      from notams
      order by posted_on desc
      `,
    );
    await auditPeerRead(actor, "notams", "ok", { count: q.rows.length });
    res.json({
      squadron_id: ctx.squadron_id,
      squadron_name: ctx.squadron_name,
      items: q.rows,
    });
  } catch (err) {
    await auditPeerRead(actor, "notams", "error").catch(() => {});
    next(err);
  }
});

router.get("/readiness-summary", async (req, res, next) => {
  const actor = readPeerActor(req);
  if (!actor) {
    res.status(401).json({ error: "invalid_peer_token" });
    return;
  }
  try {
    const ctx = await readHubSquadronContext();
    const q = await pool.query<{
      squadron_id: string | null;
      squadron_name: string | null;
      pilots_total: string;
      pilots_available: string;
      sorties_30d: string;
    }>(
      `
      select
        s.id::text as squadron_id,
        coalesce(nullif(s.name, ''), s.number) as squadron_name,
        coalesce(p.total, 0)::text as pilots_total,
        coalesce(p.available, 0)::text as pilots_available,
        coalesce(so.recent, 0)::text as sorties_30d
      from squadrons s
      left join (
        select squadron_id,
               count(*)::int as total,
               sum(case when available then 1 else 0 end)::int as available
        from pilots
        group by squadron_id
      ) p on p.squadron_id = s.id
      left join (
        select squadron_id, count(*)::int as recent
        from sorties
        where date >= (current_date - interval '30 days')
        group by squadron_id
      ) so on so.squadron_id = s.id
      order by coalesce(s.number, '') asc
      `,
    );
    const items = q.rows.map((row) => ({
      squadron_id: row.squadron_id,
      squadron_name: row.squadron_name,
      pilots_total: Number(row.pilots_total ?? 0),
      pilots_available: Number(row.pilots_available ?? 0),
      sorties_last_30_days: Number(row.sorties_30d ?? 0),
    }));
    await auditPeerRead(actor, "readiness-summary", "ok", { count: items.length });
    res.json({
      squadron_id: ctx.squadron_id,
      squadron_name: ctx.squadron_name,
      items,
    });
  } catch (err) {
    await auditPeerRead(actor, "readiness-summary", "error").catch(() => {});
    next(err);
  }
});

// ── Block-list with explicit refusal ────────────────────────────────
// Future-proofs against accidentally exposing private resources by
// leaving them unhandled.

const BLOCKED = [
  "weekly-roster",
  "schedule",
  "pilot-devices",
  "lan-users",
] as const;

for (const name of BLOCKED) {
  router.all(`/${name}`, async (req, res) => {
    const actor = readPeerActor(req);
    if (actor) {
      await auditPeerRead(actor, name, "blocked").catch(() => {});
    }
    res.status(403).json({ error: "not_exposed_to_peers", resource: name });
  });
  // Also catch nested paths under each blocked surface, so e.g.
  // GET /api/peer/lan-users/anything is refused identically rather
  // than falling through to the catch-all below.
  router.all(`/${name}/*splat`, async (req, res) => {
    const actor = readPeerActor(req);
    if (actor) {
      await auditPeerRead(actor, name, "blocked").catch(() => {});
    }
    res.status(403).json({ error: "not_exposed_to_peers", resource: name });
  });
}

// Anything else under /api/peer that we haven't explicitly modelled
// is a 404. Prevents accidental data leakage through typos or future
// route mistakes by falling closed.
router.use((_req, res) => {
  res.status(404).json({ error: "not_found", surface: "peer" });
});

export default router;

// Test-only export so unit tests can pin the parser/middleware
// behaviour without round-tripping through HTTP. Production code
// never imports this.
export const __testing__ = { requirePeerToken, readHubSquadronContext, BLOCKED };
