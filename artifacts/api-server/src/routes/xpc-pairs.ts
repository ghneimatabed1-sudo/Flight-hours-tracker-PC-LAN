import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

type PairKind =
  | "in_squadron"
  | "sqn_to_wing"
  | "wing_to_base"
  | "cross_squadron_ops"
  | "peer_flight"
  | "peer_sqn"
  | "peer_wing"
  | "peer_base";

type PcTier = "flight" | "squadron" | "wing" | "base" | "hq";

function canUsePairs(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true;
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

function isSuperAdmin(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true;
  return normalizeLanRole(user.role) === "super_admin";
}

function canonSeat(seat: string | null | undefined): string | null {
  if (seat == null) return null;
  return seat.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolvePairKind(args: {
  aTier: PcTier;
  bTier: PcTier;
  aSquadron: string | null;
  bSquadron: string | null;
  aSeat?: string | null;
  bSeat?: string | null;
  superAdmin: boolean;
  justification?: string | null;
  expiresAt?: string | null;
  kindHint?: PairKind | null;
}): PairKind | null {
  const { aTier, bTier, aSquadron, bSquadron, aSeat, bSeat, superAdmin, justification, expiresAt } = args;
  const same = aSquadron && bSquadron
    && aSquadron.toLowerCase() === bSquadron.toLowerCase();
  const bothCmdr = canonSeat(aSeat) === "sqncmdr"
    && canonSeat(bSeat) === "sqncmdr";
  if (aTier === bTier) {
    if (aTier === "flight") return "peer_flight";
    if (aTier === "squadron") {
      if (same) return "in_squadron";
      if (superAdmin && (bothCmdr || args.kindHint === "peer_sqn")) return "peer_sqn";
      if (superAdmin && justification && justification.length >= 8 && expiresAt) {
        return "cross_squadron_ops";
      }
      return null;
    }
    if (aTier === "wing") return "peer_wing";
    if (aTier === "base") return superAdmin ? "peer_base" : null;
    return null;
  }
  const pair = `${aTier}-${bTier}`;
  if (pair === "flight-squadron" || pair === "squadron-flight") return "in_squadron";
  if (pair === "squadron-wing" || pair === "wing-squadron") return "sqn_to_wing";
  if (pair === "wing-base" || pair === "base-wing") return "wing_to_base";
  return null;
}

function asText(v: unknown): string {
  return String(v ?? "").trim();
}

function asNullableText(v: unknown): string | null {
  const s = asText(v);
  return s.length ? s : null;
}

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.get("/xpc/pairs", async (req, res, next) => {
  try {
    if (!canUsePairs(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const mine = asText(req.query.mine);
    const since = asText(req.query.since);
    const limitRaw = Number.parseInt(String(req.query.limit ?? "2000"), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 5000 ? limitRaw : 2000;
    try {
      if (mine) {
        const q = await pool.query<Record<string, unknown>>(
          `
          select *
          from xpc_pair_links
          where revoked_at is null
            and (a_pc_id = $1 or b_pc_id = $1)
            and ($2::timestamptz is null or paired_at >= $2::timestamptz)
          order by paired_at desc
          limit $3
          `,
          [mine, since || null, limit],
        );
        res.json({ items: q.rows });
        return;
      }
      const q = await pool.query<Record<string, unknown>>(
        `
        select *
        from xpc_pair_links
        where revoked_at is null
        order by paired_at desc
        limit $1
        `,
        [limit],
      );
      res.json({ items: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_pair_links.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get("/xpc/pairs/audit", async (req, res, next) => {
  try {
    if (!canUsePairs(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    if (!isSuperAdmin(req)) {
      res.json({ items: [], rlsDenied: true });
      return;
    }
    const limitRaw = Number.parseInt(String(req.query.limit ?? "200"), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 2000 ? limitRaw : 200;
    try {
      const q = await pool.query<Record<string, unknown>>(
        `
        select *
        from xpc_pair_audit
        order by at desc
        limit $1
        `,
        [limit],
      );
      res.json({ items: q.rows, rlsDenied: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_pair_audit.* does not exist/i.test(msg)) {
        res.json({ items: [], rlsDenied: false });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pairs/code/issue", async (req, res, next) => {
  try {
    if (!canUsePairs(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const hostPcId = asText(b.host_pc_id);
    if (!hostPcId) {
      res.status(400).json({ error: "missing_host_pc_id" });
      return;
    }
    const hostTier = asText(b.host_tier) || "squadron";
    const hostSquadron = asNullableText(b.host_squadron);
    const hostUserDisplay = asNullableText(b.host_user_display);
    const hostUserSeat = asNullableText(b.host_user_seat);
    let created: Record<string, unknown> | null = null;
    for (let i = 0; i < 3; i++) {
      const code = generateCode();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      try {
        const q = await pool.query<Record<string, unknown>>(
          `
          insert into xpc_pair_codes (
            code, host_pc_id, host_tier, host_squadron, host_user_display, host_user_seat, expires_at
          ) values ($1,$2,$3,$4,$5,$6,$7::timestamptz)
          returning *
          `,
          [code, hostPcId, hostTier, hostSquadron, hostUserDisplay, hostUserSeat, expiresAt],
        );
        created = q.rows[0] ?? null;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate key|unique/i.test(msg)) continue;
        throw err;
      }
    }
    if (!created) {
      res.status(500).json({ error: "code_issue_failed" });
      return;
    }
    res.json({ item: created });
  } catch (err) {
    next(err);
  }
});

router.get("/xpc/pairs/code/:code", async (req, res, next) => {
  try {
    if (!canUsePairs(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const code = asText(req.params.code).replace(/\D/g, "").slice(0, 6);
    if (!code) {
      res.status(400).json({ error: "missing_code" });
      return;
    }
    const q = await pool.query<Record<string, unknown>>(
      `select * from xpc_pair_codes where code = $1 limit 1`,
      [code],
    );
    res.json({ item: q.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pairs/code/redeem", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!canUsePairs(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const code = asText(b.code).replace(/\D/g, "").slice(0, 6);
    const joinerPcId = asText(b.joiner_pc_id);
    const joinerTier = (asText(b.joiner_tier) || "squadron") as PcTier;
    const joinerSquadron = asNullableText(b.joiner_squadron);
    const joinerDisplay = asNullableText(b.joiner_user_display);
    const joinerSeat = asNullableText(b.joiner_user_seat);
    if (!code || !joinerPcId) {
      res.status(400).json({ error: "missing_code_or_joiner" });
      return;
    }
    await client.query("begin");
    const codeQ = await client.query<Record<string, unknown>>(
      `select * from xpc_pair_codes where code = $1 for update`,
      [code],
    );
    const row = codeQ.rows[0];
    if (!row) {
      await client.query("rollback");
      res.status(404).json({ error: "code_not_found" });
      return;
    }
    const consumedAt = asNullableText(row.consumed_at);
    if (consumedAt) {
      await client.query("rollback");
      res.status(409).json({ error: "code_already_used" });
      return;
    }
    const expiresAt = asText(row.expires_at);
    if (new Date(expiresAt).getTime() < Date.now()) {
      await client.query("rollback");
      res.status(409).json({ error: "code_expired" });
      return;
    }
    const hostPcId = asText(row.host_pc_id);
    if (hostPcId === joinerPcId) {
      await client.query("rollback");
      res.status(400).json({ error: "same_pc_forbidden" });
      return;
    }
    const hostTier = (asText(row.host_tier) || "squadron") as PcTier;
    const hostSquadron = asNullableText(row.host_squadron);
    const hostSeat = asNullableText(row.host_user_seat);
    const kind = resolvePairKind({
      aTier: hostTier,
      bTier: joinerTier,
      aSquadron: hostSquadron,
      bSquadron: joinerSquadron,
      aSeat: hostSeat,
      bSeat: joinerSeat,
      superAdmin: false,
    });
    if (!kind) {
      await client.query("rollback");
      res.status(403).json({ error: "matrix_forbidden" });
      return;
    }
    const aFirst = hostPcId < joinerPcId;
    const aPcId = aFirst ? hostPcId : joinerPcId;
    const bPcId = aFirst ? joinerPcId : hostPcId;
    const aTier = aFirst ? hostTier : joinerTier;
    const bTier = aFirst ? joinerTier : hostTier;
    const aSquadron = aFirst ? hostSquadron : joinerSquadron;
    const bSquadron = aFirst ? joinerSquadron : hostSquadron;
    const aDisplay = aFirst ? asNullableText(row.host_user_display) : joinerDisplay;
    const bDisplay = aFirst ? joinerDisplay : asNullableText(row.host_user_display);
    const aSeat = aFirst ? hostSeat : joinerSeat;
    const bSeat = aFirst ? joinerSeat : hostSeat;
    await client.query(
      `
      insert into xpc_pair_links (
        a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
        a_user_display, b_user_display, a_user_seat, b_user_seat,
        kind, paired_by_label, revoked_at, revoked_reason, last_activity_at, paired_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,null,now(),now()
      )
      on conflict (a_pc_id, b_pc_id) do update
        set kind = excluded.kind,
            a_tier = excluded.a_tier, b_tier = excluded.b_tier,
            a_squadron = excluded.a_squadron, b_squadron = excluded.b_squadron,
            a_user_display = excluded.a_user_display, b_user_display = excluded.b_user_display,
            a_user_seat = excluded.a_user_seat, b_user_seat = excluded.b_user_seat,
            paired_at = now(),
            paired_by_label = excluded.paired_by_label,
            revoked_at = null, revoked_reason = null,
            last_activity_at = now()
      `,
      [aPcId, bPcId, aTier, bTier, aSquadron, bSquadron, aDisplay, bDisplay, aSeat, bSeat, kind, joinerDisplay ?? "lan"],
    );
    await client.query(`update xpc_pair_codes set consumed_at = now() where code = $1`, [code]);
    await client.query("commit");
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? joinerDisplay ?? "system"),
      "internal.xpc.pair.created",
      { a_pc_id: aPcId, b_pc_id: bPcId, kind, via: "code" },
    );
    res.json({
      item: { a_pc_id: aPcId, b_pc_id: bPcId, kind },
      host: {
        host_pc_id: hostPcId,
        host_tier: hostTier,
        host_squadron: hostSquadron,
        host_user_display: asNullableText(row.host_user_display),
      },
    });
  } catch (err) {
    try { await client.query("rollback"); } catch { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
});

router.post("/xpc/pairs/admin/create", async (req, res, next) => {
  try {
    if (!canUsePairs(req) || !isSuperAdmin(req)) {
      res.status(403).json({ error: "super_admin_required" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const aPcId = asText(b.a_pc_id);
    const bPcId = asText(b.b_pc_id);
    if (!aPcId || !bPcId || aPcId === bPcId) {
      res.status(400).json({ error: "invalid_pc_ids" });
      return;
    }
    const aTier = (asText(b.a_tier) || "squadron") as PcTier;
    const bTier = (asText(b.b_tier) || "squadron") as PcTier;
    const aSquadron = asNullableText(b.a_squadron);
    const bSquadron = asNullableText(b.b_squadron);
    const aSeat = asNullableText(b.a_user_seat);
    const bSeat = asNullableText(b.b_user_seat);
    const aDisplay = asNullableText(b.a_user_display);
    const bDisplay = asNullableText(b.b_user_display);
    const justification = asNullableText(b.justification);
    const expiresAt = asNullableText(b.expires_at);
    const permanent = Boolean(b.permanent ?? false);
    const kindHint = asNullableText(b.kind_hint) as PairKind | null;
    const kind = resolvePairKind({
      aTier, bTier, aSquadron, bSquadron, aSeat, bSeat,
      superAdmin: true, justification, expiresAt, kindHint,
    });
    if (!kind) {
      res.status(403).json({ error: "matrix_forbidden" });
      return;
    }
    const ord = aPcId < bPcId
      ? { aPcId, bPcId, aTier, bTier, aSquadron, bSquadron, aSeat, bSeat, aDisplay, bDisplay }
      : { aPcId: bPcId, bPcId: aPcId, aTier: bTier, bTier: aTier, aSquadron: bSquadron, bSquadron: aSquadron, aSeat: bSeat, bSeat: aSeat, aDisplay: bDisplay, bDisplay: aDisplay };
    await pool.query(
      `
      insert into xpc_pair_links (
        a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
        a_user_seat, b_user_seat, a_user_display, b_user_display,
        kind, paired_by_label, justification, expires_at, permanent,
        revoked_at, revoked_reason, last_activity_at, paired_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'super_admin',$12,$13::timestamptz,$14,
        null,null,now(),now()
      )
      on conflict (a_pc_id, b_pc_id) do update
        set kind = excluded.kind,
            a_tier = excluded.a_tier, b_tier = excluded.b_tier,
            a_squadron = excluded.a_squadron, b_squadron = excluded.b_squadron,
            a_user_seat = excluded.a_user_seat, b_user_seat = excluded.b_user_seat,
            a_user_display = excluded.a_user_display, b_user_display = excluded.b_user_display,
            paired_at = now(),
            paired_by_label = 'super_admin',
            justification = excluded.justification,
            expires_at = excluded.expires_at,
            permanent = excluded.permanent,
            revoked_at = null, revoked_reason = null,
            last_activity_at = now()
      `,
      [
        ord.aPcId, ord.bPcId, ord.aTier, ord.bTier, ord.aSquadron, ord.bSquadron,
        ord.aSeat, ord.bSeat, ord.aDisplay, ord.bDisplay, kind, justification, expiresAt, permanent,
      ],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.pair.created",
      { a_pc_id: ord.aPcId, b_pc_id: ord.bPcId, kind, via: "admin" },
    );
    res.json({ item: { a_pc_id: ord.aPcId, b_pc_id: ord.bPcId, kind } });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pairs/revoke", async (req, res, next) => {
  try {
    if (!canUsePairs(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const aPcId = asText(b.a_pc_id);
    const bPcId = asText(b.b_pc_id);
    if (!aPcId || !bPcId) {
      res.status(400).json({ error: "missing_pair_ids" });
      return;
    }
    const reason = asNullableText(b.reason) ?? "participant revoke";
    await pool.query(
      `
      update xpc_pair_links
      set revoked_at = now(), revoked_reason = $3
      where a_pc_id = $1 and b_pc_id = $2 and revoked_at is null
      `,
      [aPcId, bPcId, reason],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.pair.revoked",
      { a_pc_id: aPcId, b_pc_id: bPcId, reason },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pairs/admin/set-permanent", async (req, res, next) => {
  try {
    if (!canUsePairs(req) || !isSuperAdmin(req)) {
      res.status(403).json({ error: "super_admin_required" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const aPcId = asText(b.a_pc_id);
    const bPcId = asText(b.b_pc_id);
    if (!aPcId || !bPcId) {
      res.status(400).json({ error: "missing_pair_ids" });
      return;
    }
    const permanent = Boolean(b.permanent ?? false);
    await pool.query(
      `
      update xpc_pair_links
      set permanent = $3, last_activity_at = now()
      where a_pc_id = $1 and b_pc_id = $2
      `,
      [aPcId, bPcId, permanent],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.pair.extended",
      { a_pc_id: aPcId, b_pc_id: bPcId, permanent },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pairs/admin/reset-pc", async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!canUsePairs(req) || !isSuperAdmin(req)) {
      res.status(403).json({ error: "super_admin_required" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pcId = asText(b.pc_id);
    const reason = asNullableText(b.reason) ?? "super_admin reset";
    if (!pcId) {
      res.status(400).json({ error: "missing_pc_id" });
      return;
    }
    await client.query("begin");
    const rev = await client.query<{ count: string }>(
      `
      with x as (
        update xpc_pair_links
        set revoked_at = now(), revoked_reason = $2
        where revoked_at is null and (a_pc_id = $1 or b_pc_id = $1)
        returning 1
      ) select count(*)::text as count from x
      `,
      [pcId, reason],
    );
    const revokedPairCount = Number(rev.rows[0]?.count ?? "0");
    await client.query(`delete from xpc_registry where id = $1`, [pcId]);
    await client.query(`delete from xpc_user_pcs where pc_id = $1`, [pcId]);
    await client.query("commit");
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.pc_reset",
      { pc_id: pcId, revokedPairCount, reason },
    );
    res.json({ revokedPairCount });
  } catch (err) {
    try { await client.query("rollback"); } catch { /* ignore */ }
    next(err);
  } finally {
    client.release();
  }
});

router.post("/xpc/pairs/admin/bulk-in-squadron", async (req, res, next) => {
  try {
    if (!canUsePairs(req) || !isSuperAdmin(req)) {
      res.status(403).json({ error: "super_admin_required" });
      return;
    }
    const rowsQ = await pool.query<{
      id: string;
      squadron_name: string | null;
      tier: string | null;
      device_name: string | null;
    }>(
      `
      select id, squadron_name, tier, device_name
      from xpc_registry
      where tier in ('squadron', 'flight')
      `,
    );
    const rows = rowsQ.rows;
    const ops = rows.filter((r) => r.tier === "squadron");
    const flights = rows.filter((r) => r.tier === "flight");
    let created = 0;
    for (const o of ops) {
      for (const f of flights) {
        if (!o.squadron_name || !f.squadron_name) continue;
        if (o.squadron_name !== f.squadron_name) continue;
        const aPcId = o.id < f.id ? o.id : f.id;
        const bPcId = o.id < f.id ? f.id : o.id;
        const aTier: PcTier = o.id < f.id ? "squadron" : "flight";
        const bTier: PcTier = o.id < f.id ? "flight" : "squadron";
        const q = await pool.query(
          `
          insert into xpc_pair_links (
            a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
            kind, paired_by_label, revoked_at, revoked_reason, paired_at, last_activity_at
          ) values ($1,$2,$3,$4,$5,$6,'in_squadron','bulk: in_squadron',null,null,now(),now())
          on conflict (a_pc_id, b_pc_id) do nothing
          `,
          [aPcId, bPcId, aTier, bTier, o.squadron_name, f.squadron_name],
        );
        if ((q.rowCount ?? 0) > 0) created += 1;
      }
    }
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.pair.bulk_created",
      { created },
    );
    res.json({ created });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pairs/admin/sweep", async (req, res, next) => {
  try {
    if (!canUsePairs(req) || !isSuperAdmin(req)) {
      res.status(403).json({ error: "super_admin_required" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const inactiveDaysRaw = Number.parseInt(String(b.inactive_days ?? "90"), 10);
    const inactiveDays =
      Number.isFinite(inactiveDaysRaw) && inactiveDaysRaw > 0 && inactiveDaysRaw <= 3650
        ? inactiveDaysRaw
        : 90;

    const expired = await pool.query<{ count: string }>(
      `
      with x as (
        update xpc_pair_links
        set revoked_at = now(), revoked_reason = 'auto: time-bound expiry'
        where revoked_at is null
          and expires_at is not null
          and expires_at < now()
          and not permanent
        returning 1
      ) select count(*)::text as count from x
      `,
    );
    const expiredCount = Number(expired.rows[0]?.count ?? "0");
    const stale = await pool.query<{ count: string }>(
      `
      with x as (
        update xpc_pair_links
        set revoked_at = now(), revoked_reason = $1
        where revoked_at is null
          and not permanent
          and last_activity_at < now() - ($2::text || ' days')::interval
        returning 1
      ) select count(*)::text as count from x
      `,
      [`auto: no activity in ${inactiveDays} days`, String(inactiveDays)],
    );
    const revokedCount = Number(stale.rows[0]?.count ?? "0");
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.pair.sweep",
      { revoked_count: revokedCount, expired_count: expiredCount, inactive_days: inactiveDays },
    );
    res.json({ revoked_count: revokedCount, expired_count: expiredCount });
  } catch (err) {
    next(err);
  }
});

export default router;
