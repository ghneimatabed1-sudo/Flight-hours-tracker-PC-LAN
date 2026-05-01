import { Router, type Request, type Response } from "express";

import { pool } from "@workspace/db";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

/**
 * `GET /backup-verify-status` — focused read of the
 * `system_health_marker` row written by `scripts/lan-host/verify-backup.ps1`.
 *
 * Mounted under `/api/internal` (hub only). The dashboard's
 * `BackupVerifyBanner` polls this on every super-admin login and shows
 * a site-wide red banner when the verify is overdue (>120 days) or
 * explicitly FAILED. Air-gapped installs cannot email the operator,
 * so the banner is the loudest channel we have.
 *
 * The endpoint is intentionally lighter than `/system-health` so we
 * can fetch it on every page load without paying for a full health
 * gather (postgres, audit_log, peers, etc).
 */
const router = Router();

router.get("/backup-verify-status", async (req: Request, res: Response) => {
  const sessionAuthMode = String(
    process.env["HAWK_INTERNAL_SESSION_AUTH"] ?? "",
  )
    .trim()
    .toLowerCase();
  const sessionAuthOff = sessionAuthMode === "off";

  const u = readLanUser(req);
  const role = normalizeLanRole(u?.role);
  if (!sessionAuthOff && role !== "super_admin") {
    res.status(403).json({ ok: false, error: "super_admin_required" });
    return;
  }

  try {
    const r = await pool.query<{
      ok: boolean;
      observed_at: string;
      message: string | null;
    }>(
      `select ok, observed_at::text as observed_at, message
       from system_health_marker
       where key = 'last_backup_verify'
       limit 1`,
    );
    const row = r.rows[0];
    if (!row) {
      res.json({ ok: true, marker: null });
      return;
    }
    const observedAt = new Date(row.observed_at);
    const ageDays = Math.round(
      (Date.now() - observedAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    res.json({
      ok: true,
      marker: {
        ok: row.ok,
        observedAt: observedAt.toISOString(),
        ageDays,
        message: row.message,
      },
    });
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*system_health_marker.* does not exist/i.test(msg)) {
      // Schema not yet ensured — treat as "never verified" so the
      // banner reminds the operator to install the verify task.
      res.json({ ok: true, marker: null });
      return;
    }
    req.log?.error?.({ err }, "backup-verify-status: read failed");
    res.status(500).json({ ok: false, error: msg });
    return;
  }
});

export default router;
