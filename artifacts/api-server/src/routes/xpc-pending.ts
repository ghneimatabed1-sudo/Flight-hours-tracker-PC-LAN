import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canUsePending(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true;
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

router.get("/xpc/pending", async (req, res, next) => {
  try {
    if (!canUsePending(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const homeSquadronId = String(req.query.home_squadron_id ?? "").trim();
    const statusCsv = String(req.query.status ?? "").trim();
    const statuses = statusCsv
      ? statusCsv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];
    const validStatuses = statuses.filter((s) =>
      s === "pending" || s === "accepted" || s === "rejected" || s === "edited" || s === "deleted",
    );
    const limitRaw = Number.parseInt(String(req.query.limit ?? "5000"), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 10000 ? limitRaw : 5000;
    try {
      if (homeSquadronId && validStatuses.length > 0) {
        const q = await pool.query<Record<string, unknown>>(
          `
          select *
          from xpc_pending
          where home_squadron_id = $1
            and status = any($2::text[])
          order by submitted_at desc
          limit $3
          `,
          [homeSquadronId, validStatuses, limit],
        );
        res.json({ items: q.rows });
        return;
      }
      if (homeSquadronId) {
        const q = await pool.query<Record<string, unknown>>(
          `
          select *
          from xpc_pending
          where home_squadron_id = $1
          order by submitted_at desc
          limit $2
          `,
          [homeSquadronId, limit],
        );
        res.json({ items: q.rows });
        return;
      }
      if (validStatuses.length > 0) {
        const q = await pool.query<Record<string, unknown>>(
          `
          select *
          from xpc_pending
          where status = any($1::text[])
          order by submitted_at desc
          limit $2
          `,
          [validStatuses, limit],
        );
        res.json({ items: q.rows });
        return;
      }
      const q = await pool.query<Record<string, unknown>>(
        `
        select *
        from xpc_pending
        order by submitted_at desc
        limit $1
        `,
        [limit],
      );
      res.json({ items: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_pending.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pending", async (req, res, next) => {
  try {
    if (!canUsePending(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "").trim();
    const hostingSquadronId = String(b.hosting_squadron_id ?? "").trim();
    const homeSquadronId = String(b.home_squadron_id ?? "").trim();
    const submittedBy = String(b.submitted_by ?? "").trim();
    if (!id || !hostingSquadronId || !homeSquadronId || !submittedBy) {
      res.status(400).json({ error: "missing_required_fields" });
      return;
    }
    await pool.query(
      `
      insert into xpc_pending (
        id, hosting_squadron_id, hosting_squadron_name, home_squadron_id, home_squadron_name,
        guest_pilot_name, guest_pilot_military_number, guest_seat, sortie,
        submitted_at, submitted_by, submitter_display_name, submitter_rank, submitter_seat_label,
        status, decided_at, decided_by, decision_reason, edited_sortie
      ) values (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,
        coalesce(nullif($10,'')::timestamptz, now()),$11,$12,$13,$14,
        $15,nullif($16,'')::timestamptz,$17,$18,$19
      )
      on conflict (id) do nothing
      `,
      [
        id,
        hostingSquadronId,
        String(b.hosting_squadron_name ?? ""),
        homeSquadronId,
        String(b.home_squadron_name ?? ""),
        String(b.guest_pilot_name ?? ""),
        b.guest_pilot_military_number == null || b.guest_pilot_military_number === ""
          ? null
          : String(b.guest_pilot_military_number),
        String(b.guest_seat ?? "pilot"),
        (b.sortie ?? {}) as Record<string, unknown>,
        String(b.submitted_at ?? ""),
        submittedBy,
        b.submitter_display_name == null || b.submitter_display_name === ""
          ? null
          : String(b.submitter_display_name),
        b.submitter_rank == null || b.submitter_rank === "" ? null : String(b.submitter_rank),
        b.submitter_seat_label == null || b.submitter_seat_label === ""
          ? null
          : String(b.submitter_seat_label),
        String(b.status ?? "pending"),
        b.decided_at == null || b.decided_at === "" ? "" : String(b.decided_at),
        b.decided_by == null || b.decided_by === "" ? null : String(b.decided_by),
        b.decision_reason == null || b.decision_reason === ""
          ? null
          : String(b.decision_reason),
        b.edited_sortie ?? null,
      ],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? submittedBy),
      "internal.xpc.pending.submitted",
      { id, hosting_squadron_id: hostingSquadronId, home_squadron_id: homeSquadronId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/pending/update", async (req, res, next) => {
  try {
    if (!canUsePending(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const q = await pool.query<Record<string, unknown>>(
      `
      update xpc_pending
      set
        status = coalesce($2::text, status),
        decided_at = coalesce(nullif($3,'')::timestamptz, decided_at),
        decided_by = coalesce($4::text, decided_by),
        decision_reason = coalesce($5::text, decision_reason),
        edited_sortie = coalesce($6::jsonb, edited_sortie),
        guest_pilot_military_number = coalesce($7::text, guest_pilot_military_number)
      where id = $1
      returning *
      `,
      [
        id,
        b.status == null || b.status === "" ? null : String(b.status),
        b.decided_at == null || b.decided_at === "" ? "" : String(b.decided_at),
        b.decided_by == null || b.decided_by === "" ? null : String(b.decided_by),
        b.decision_reason == null || b.decision_reason === ""
          ? null
          : String(b.decision_reason),
        b.edited_sortie ?? null,
        b.guest_pilot_military_number == null || b.guest_pilot_military_number === ""
          ? null
          : String(b.guest_pilot_military_number),
      ],
    );
    const actor = String(
      readLanUser(req)?.username
      ?? (b.decided_by != null ? String(b.decided_by) : b.by != null ? String(b.by) : "system"),
    );
    await appendInternalAudit(actor, "internal.xpc.pending.updated", {
      id,
      status: b.status ?? null,
      guest_pilot_military_number: b.guest_pilot_military_number ?? null,
    });
    res.json({ item: q.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

export default router;
