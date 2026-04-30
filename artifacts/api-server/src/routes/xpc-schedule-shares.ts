import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function canUseScheduleShares(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true;
  const role = normalizeLanRole(user.role);
  return role === "ops" || role === "admin" || role === "super_admin" || role === "commander";
}

function asNullableText(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

router.get("/xpc/schedule-shares", async (req, res, next) => {
  try {
    if (!canUseScheduleShares(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const status = String(req.query.status ?? "").trim().toLowerCase();
    const limitRaw = Number.parseInt(String(req.query.limit ?? "5000"), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 10000 ? limitRaw : 5000;
    try {
      if (status) {
        const q = await pool.query<Record<string, unknown>>(
          `
          select *
          from xpc_schedule_shares
          where status = $1
          order by flight_date desc, updated_at desc nulls last
          limit $2
          `,
          [status, limit],
        );
        res.json({ items: q.rows });
        return;
      }
      const q = await pool.query<Record<string, unknown>>(
        `
        select *
        from xpc_schedule_shares
        order by flight_date desc, updated_at desc nulls last
        limit $1
        `,
        [limit],
      );
      res.json({ items: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/relation .*xpc_schedule_shares.* does not exist/i.test(msg)) {
        res.json({ items: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.get("/xpc/schedule-shares/:id", async (req, res, next) => {
  try {
    if (!canUseScheduleShares(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const q = await pool.query<Record<string, unknown>>(
      `select * from xpc_schedule_shares where id = $1 limit 1`,
      [id],
    );
    res.json({ item: q.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

router.post("/xpc/schedule-shares", async (req, res, next) => {
  try {
    if (!canUseScheduleShares(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = String(b.id ?? "").trim();
    const originSquadronId = String(b.origin_squadron_id ?? "").trim();
    const flightDate = String(b.flight_date ?? "").trim();
    if (!id || !originSquadronId || !flightDate) {
      res.status(400).json({ error: "missing_id_origin_or_flight_date" });
      return;
    }
    await pool.query(
      `
      insert into xpc_schedule_shares (
        id, flight_date, origin_squadron_id, origin_squadron_name,
        current_tier, current_pc_id, current_pc_name, status,
        rows, baseline_rows, history,
        edited_rows, edited_by, program, edited_program,
        chain_pc_ids, approved_at, approved_by, rejected_by_pc_ids,
        originator_dismissed_at, updated_at
      ) values (
        $1, $2::date, $3, $4,
        $5, $6, $7, $8,
        $9::jsonb, $10::jsonb, $11::jsonb,
        $12::jsonb, $13, $14::jsonb, $15::jsonb,
        $16::text[], nullif($17,'')::timestamptz, $18, $19::text[],
        nullif($20,'')::timestamptz, coalesce(nullif($21,'')::timestamptz, now())
      )
      on conflict (id) do nothing
      `,
      [
        id,
        flightDate,
        originSquadronId,
        String(b.origin_squadron_name ?? ""),
        String(b.current_tier ?? "squadron"),
        asNullableText(b.current_pc_id),
        asNullableText(b.current_pc_name),
        String(b.status ?? "submitted"),
        JSON.stringify(b.rows ?? []),
        JSON.stringify(b.baseline_rows ?? []),
        JSON.stringify(b.history ?? []),
        b.edited_rows == null ? null : JSON.stringify(b.edited_rows),
        asNullableText(b.edited_by),
        b.program == null ? null : JSON.stringify(b.program),
        b.edited_program == null ? null : JSON.stringify(b.edited_program),
        Array.isArray(b.chain_pc_ids) ? b.chain_pc_ids.map((x) => String(x)) : [],
        asNullableText(b.approved_at),
        asNullableText(b.approved_by),
        Array.isArray(b.rejected_by_pc_ids) ? b.rejected_by_pc_ids.map((x) => String(x)) : [],
        asNullableText(b.originator_dismissed_at),
        asNullableText(b.updated_at),
      ],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.schedule.submitted",
      { id, origin_squadron_id: originSquadronId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.patch("/xpc/schedule-shares/:id", async (req, res, next) => {
  try {
    if (!canUseScheduleShares(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const q = await pool.query<Record<string, unknown>>(
      `
      update xpc_schedule_shares
      set
        flight_date = coalesce($2::date, flight_date),
        origin_squadron_id = coalesce($3::text, origin_squadron_id),
        origin_squadron_name = coalesce($4::text, origin_squadron_name),
        current_tier = coalesce($5::text, current_tier),
        current_pc_id = coalesce($6::text, current_pc_id),
        current_pc_name = coalesce($7::text, current_pc_name),
        status = coalesce($8::text, status),
        rows = coalesce($9::jsonb, rows),
        baseline_rows = coalesce($10::jsonb, baseline_rows),
        history = coalesce($11::jsonb, history),
        edited_rows = $12::jsonb,
        edited_by = $13::text,
        program = $14::jsonb,
        edited_program = $15::jsonb,
        chain_pc_ids = coalesce($16::text[], chain_pc_ids),
        approved_at = nullif($17,'')::timestamptz,
        approved_by = $18::text,
        rejected_by_pc_ids = coalesce($19::text[], rejected_by_pc_ids),
        originator_dismissed_at = nullif($20,'')::timestamptz,
        updated_at = coalesce(nullif($21,'')::timestamptz, now())
      where id = $1
      returning *
      `,
      [
        id,
        asNullableText(b.flight_date),
        asNullableText(b.origin_squadron_id),
        asNullableText(b.origin_squadron_name),
        asNullableText(b.current_tier),
        asNullableText(b.current_pc_id),
        asNullableText(b.current_pc_name),
        asNullableText(b.status),
        b.rows == null ? null : JSON.stringify(b.rows),
        b.baseline_rows == null ? null : JSON.stringify(b.baseline_rows),
        b.history == null ? null : JSON.stringify(b.history),
        b.edited_rows == null ? null : JSON.stringify(b.edited_rows),
        asNullableText(b.edited_by),
        b.program == null ? null : JSON.stringify(b.program),
        b.edited_program == null ? null : JSON.stringify(b.edited_program),
        Array.isArray(b.chain_pc_ids) ? b.chain_pc_ids.map((x) => String(x)) : null,
        asNullableText(b.approved_at),
        asNullableText(b.approved_by),
        Array.isArray(b.rejected_by_pc_ids) ? b.rejected_by_pc_ids.map((x) => String(x)) : null,
        asNullableText(b.originator_dismissed_at),
        asNullableText(b.updated_at),
      ],
    );
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.schedule.updated",
      { id, status: b.status ?? null, current_tier: b.current_tier ?? null },
    );
    res.json({ item: q.rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

router.delete("/xpc/schedule-shares/:id", async (req, res, next) => {
  try {
    if (!canUseScheduleShares(req)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    await pool.query(`delete from xpc_schedule_shares where id = $1`, [id]);
    await appendInternalAudit(
      String(readLanUser(req)?.username ?? "system"),
      "internal.xpc.schedule.deleted",
      { id },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
