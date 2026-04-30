import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canUseMessages(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true;
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

function getPeerSquadronId(forPcId: string): string | null {
  if (forPcId.startsWith("SQDNCMD:")) return forPcId.slice("SQDNCMD:".length);
  if (!forPcId.includes(":")) return `SQDNCMD:${forPcId}`;
  return null;
}

function getLogicalSeat(forPcId: string): string | null {
  const i = forPcId.indexOf("#");
  return i < 0 ? null : forPcId.slice(0, i);
}

router.get("/xpc/messages", async (req, res, next) => {
  try {
    if (!canUseMessages(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const forPcId = String(req.query.for_pc_id ?? "").trim();
    if (!forPcId) {
      res.status(400).json({ error: "missing_for_pc_id" });
      return;
    }
    const daysRaw = Number.parseInt(String(req.query.retention_days ?? "30"), 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 30;
    const peerSquadronId = getPeerSquadronId(forPcId);
    const logicalSeat = getLogicalSeat(forPcId);
    try {
      const q = await pool.query<Record<string, unknown>>(
        `
        select *
        from xpc_messages
        where sent_at >= now() - $4::interval
          and (
            from_pc_id = $1
            or to_pc_id = $1
            or ($2::text is not null and (from_pc_id = $2 or to_pc_id = $2))
            or ($3::text is not null and (
              from_pc_id like ($3 || '#%')
              or to_pc_id like ($3 || '#%')
              or from_pc_id = $3
              or to_pc_id = $3
            ))
          )
        order by sent_at desc
        limit 5000
        `,
        [forPcId, peerSquadronId, logicalSeat, `${days} days`],
      );
      res.json({ items: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_messages.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/messages", async (req, res, next) => {
  try {
    if (!canUseMessages(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "").trim();
    const threadId = String(b.thread_id ?? "").trim();
    const fromPcId = String(b.from_pc_id ?? "").trim();
    const fromPcName = String(b.from_pc_name ?? "").trim();
    const fromTierRaw = String(b.from_tier ?? "squadron").trim().toLowerCase();
    const fromTier =
      fromTierRaw === "wing" || fromTierRaw === "base" ? fromTierRaw : "squadron";
    const fromUser = String(b.from_user ?? "").trim();
    const fromDisplayName =
      b.from_display_name == null || b.from_display_name === ""
        ? null
        : String(b.from_display_name);
    const fromRank =
      b.from_rank == null || b.from_rank === "" ? null : String(b.from_rank);
    const fromSeatLabel =
      b.from_seat_label == null || b.from_seat_label === ""
        ? null
        : String(b.from_seat_label);
    const toPcId = String(b.to_pc_id ?? "").trim();
    const toPcName = String(b.to_pc_name ?? "").trim();
    const toTierRaw = String(b.to_tier ?? "squadron").trim().toLowerCase();
    const toTier = toTierRaw === "wing" || toTierRaw === "base" ? toTierRaw : "squadron";
    const subject = String(b.subject ?? "").trim();
    const body = String(b.body ?? "").trim();
    const priorityRaw = String(b.priority ?? "normal").trim().toLowerCase();
    const priority =
      priorityRaw === "urgent" || priorityRaw === "medium" ? priorityRaw : "normal";
    const sentAt = String(b.sent_at ?? "").trim();
    const readAt = b.read_at == null || b.read_at === "" ? null : String(b.read_at);
    const inHistory = Boolean(b.in_history ?? false);

    if (!id || !threadId || !fromPcId || !toPcId || !fromPcName || !toPcName || !fromUser) {
      res.status(400).json({ error: "missing_required_fields" });
      return;
    }

    await pool.query(
      `
      insert into xpc_messages (
        id, thread_id, from_pc_id, from_pc_name, from_tier, from_user,
        from_display_name, from_rank, from_seat_label,
        to_pc_id, to_pc_name, to_tier,
        subject, body, priority, sent_at, read_at, in_history
      ) values (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,
        $10,$11,$12,
        $13,$14,$15,coalesce(nullif($16,'')::timestamptz, now()),nullif($17,'')::timestamptz,$18
      )
      on conflict (id) do nothing
      `,
      [
        id, threadId, fromPcId, fromPcName, fromTier, fromUser,
        fromDisplayName, fromRank, fromSeatLabel,
        toPcId, toPcName, toTier,
        subject, body, priority, sentAt, readAt, inHistory,
      ],
    );

    await appendInternalAudit(
      String(readLanUser(req)?.username ?? fromUser ?? "system"),
      "internal.xpc.message.sent",
      { id, from_pc_id: fromPcId, to_pc_id: toPcId, priority },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/messages/read", async (req, res, next) => {
  try {
    if (!canUseMessages(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String((req.body as { id?: unknown } | null | undefined)?.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const q = await pool.query<Record<string, unknown>>(
      `
      update xpc_messages
      set read_at = now(), in_history = true
      where id = $1
      returning *
      `,
      [id],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.message.read",
      { id },
    );
    res.json({ item: q.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

export default router;
