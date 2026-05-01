import { Router, type Request, type Response } from "express";

import { gatherSystemHealth } from "../lib/system-health";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router = Router();

/**
 * `GET /system-health` — operator-facing diagnostic snapshot.
 *
 * Mounted under both `/api/internal` (hub) and `/api/aggregate`
 * (aggregator) by `routes/index.ts`. Always super_admin only — even
 * regular admins can't read the disk free percent. The route reads
 * the same `lanUser` context that other internal routes use.
 *
 * In `HAWK_INTERNAL_SESSION_AUTH=off` (bring-up / dev) the upstream
 * `requireInternalLanSession` middleware short-circuits without
 * setting `req.lanUser`, so we treat that as super_admin too — same
 * convention as the rest of the LAN api.
 */
router.get("/system-health", async (req: Request, res: Response) => {
  const sessionAuthMode = String(
    process.env["HAWK_INTERNAL_SESSION_AUTH"] ?? "",
  ).trim().toLowerCase();
  const sessionAuthOff = sessionAuthMode === "off";

  const u = readLanUser(req);
  const role = normalizeLanRole(u?.role);
  if (!sessionAuthOff && role !== "super_admin") {
    res.status(403).json({ ok: false, error: "super_admin_required" });
    return;
  }

  try {
    const report = await gatherSystemHealth();
    res.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.error?.({ err }, "system-health: gather failed");
    res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
