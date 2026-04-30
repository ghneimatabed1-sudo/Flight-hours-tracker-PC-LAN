import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { appendInternalAudit } from "../lib/internal-audit";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

const REMINDER_NAME = "notify-currency-expiry-daily";
const DEFAULT_CRON = "0 6 * * *";

function canManageReminders(req: unknown): boolean {
  const user = readLanUser(req);
  if (!user) return true; // Session auth is optional during migration bring-up.
  const role = normalizeLanRole(String(user.role ?? ""));
  return role === "super_admin" || role === "admin";
}

async function ensureReminderSchema(): Promise<void> {
  await pool.query(`
    create table if not exists hawk_reminder_schedule_local (
      id int primary key check (id = 1),
      enabled boolean not null default false,
      schedule text not null default '${DEFAULT_CRON}',
      updated_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    create table if not exists hawk_reminder_runs_local (
      runid bigserial primary key,
      start_time timestamptz not null default now(),
      end_time timestamptz,
      status text not null default 'succeeded',
      return_message text
    );
  `);
  await pool.query(`
    create table if not exists hawk_reminder_http_local (
      id bigserial primary key,
      status_code int,
      error_msg text,
      created timestamptz not null default now(),
      content_preview text
    );
  `);
  await pool.query(`
    insert into hawk_reminder_schedule_local (id, enabled, schedule)
    values (1, false, '${DEFAULT_CRON}')
    on conflict (id) do nothing;
  `);
}

async function readReminderStatus() {
  await ensureReminderSchema();
  const scheduleQ = await pool.query<{
    enabled: boolean;
    schedule: string;
  }>(`
    select enabled, schedule
    from hawk_reminder_schedule_local
    where id = 1
    limit 1
  `);
  const runsQ = await pool.query<{
    runid: number;
    start_time: string;
    end_time: string | null;
    status: string;
    return_message: string | null;
  }>(`
    select runid, start_time, end_time, status, return_message
    from hawk_reminder_runs_local
    order by runid desc
    limit 25
  `);
  const httpQ = await pool.query<{
    id: number;
    status_code: number | null;
    error_msg: string | null;
    created: string;
    content_preview: string | null;
  }>(`
    select id, status_code, error_msg, created, content_preview
    from hawk_reminder_http_local
    order by id desc
    limit 50
  `);

  const s = scheduleQ.rows[0] ?? { enabled: false, schedule: DEFAULT_CRON };
  return {
    enabled: !!s.enabled,
    extensionMissing: false,
    jobid: 1,
    schedule: s.schedule || DEFAULT_CRON,
    runs: runsQ.rows,
    httpResults: httpQ.rows,
  };
}

router.get("/reminders/status", async (req, res, next) => {
  try {
    if (!canManageReminders(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const status = await readReminderStatus();
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

router.post("/reminders/action", async (req, res, next) => {
  try {
    if (!canManageReminders(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    await ensureReminderSchema();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = String(body.action ?? "").trim().toLowerCase();
    const actor = String(readLanUser(req)?.username ?? "system");

    if (action === "enable") {
      const cron = String(body.cron ?? "").trim() || DEFAULT_CRON;
      await pool.query(
        `
        update hawk_reminder_schedule_local
        set enabled = true, schedule = $1, updated_at = now()
        where id = 1
        `,
        [cron],
      );
      await appendInternalAudit(actor, "internal.reminders.enable", {
        source: "lan",
        schedule_name: REMINDER_NAME,
        cron,
      });
      res.json({ ok: true, result: { enabled: true, schedule: cron } });
      return;
    }

    if (action === "disable") {
      await pool.query(
        `
        update hawk_reminder_schedule_local
        set enabled = false, updated_at = now()
        where id = 1
        `,
      );
      await appendInternalAudit(actor, "internal.reminders.disable", {
        source: "lan",
        schedule_name: REMINDER_NAME,
      });
      res.json({ ok: true, result: { enabled: false } });
      return;
    }

    if (action === "run-now") {
      const runQ = await pool.query<{ runid: number }>(
        `
        insert into hawk_reminder_runs_local (start_time, end_time, status, return_message)
        values (now(), now(), 'succeeded', 'Manual LAN run recorded (delivery integration pending).')
        returning runid
        `,
      );
      await pool.query(
        `
        insert into hawk_reminder_http_local (status_code, error_msg, content_preview)
        values (202, null, 'LAN manual reminder run acknowledged')
        `,
      );
      await appendInternalAudit(actor, "internal.reminders.run_now", {
        source: "lan",
        schedule_name: REMINDER_NAME,
        runid: runQ.rows[0]?.runid ?? null,
      });
      res.json({
        ok: true,
        result: { sent: 0, failed: 0, candidates: 0, note: "delivery_integration_pending" },
      });
      return;
    }

    res.status(400).json({ error: "unknown_action" });
  } catch (err) {
    next(err);
  }
});

router.get("/reminders/log", async (req, res, next) => {
  try {
    if (!canManageReminders(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const q = await pool.query<{
        sent_at: string;
        pilot_id: string;
        pilot_name: string;
        pilot_name_ar: string | null;
        currency_key: string;
        expiry_date: string;
        threshold_days: number;
      }>(`
        select
          n.sent_at,
          n.pilot_id,
          coalesce(p.name, p.id) as pilot_name,
          p.arabic_name as pilot_name_ar,
          n.currency_key,
          n.expiry_date,
          n.threshold_days
        from pilot_currency_notifications n
        left join pilots p on p.id = n.pilot_id
        order by n.sent_at desc
        limit 200
      `);
      res.json({ ok: true, log: q.rows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /relation .*pilot_currency_notifications.* does not exist/i.test(msg)
        || /relation .*pilots.* does not exist/i.test(msg)
      ) {
        res.json({ ok: true, log: [] });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

export default router;
