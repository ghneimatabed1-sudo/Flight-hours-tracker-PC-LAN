import { Router, type Request, type Response } from "express";
import { spawn } from "node:child_process";

import { readMdnsHealth } from "../lib/mdns-health";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router = Router();

// In-flight guard for the LAN-broadcast restart endpoint (#403). The
// underlying scheduled task is process-wide on the host so two
// concurrent /End → /Run sequences would race against each other and
// can leave dns-sd.exe in a half-killed state.
let restartInFlight = false;

/**
 * `GET /system/mdns-health` — operator-facing badge for the LAN broadcast.
 *
 * Mounted under both `/api/internal` (hub) and `/api/aggregate`
 * (aggregator) by `routes/index.ts`. Always super_admin only — same
 * convention as the sibling `system-health` route.
 *
 * Replaces the "RDP into the host and run check-mdns-health.ps1" loop
 * (Task #398). Distinct from the scheduled-task-failure surface: the
 * supervisor task itself stays Running even when dns-sd.exe is between
 * restarts, so a generic scheduled-task view does not catch a dead
 * broadcast.
 *
 * Responses:
 *   200 { ok: true, report }  — heartbeat file present & readable.
 *   404 { ok: false, error: "mdns_disabled" } — file does not exist
 *        (mDNS never enabled with -EnableMdns / supervisor task not
 *        registered).
 *   500 on unexpected agent failures.
 */
router.get("/system/mdns-health", async (req: Request, res: Response) => {
  if (!isSuperAdmin(req, res)) return;
  try {
    const report = await readMdnsHealth();
    if (!report) {
      res
        .status(404)
        .json({ ok: false, error: "mdns_disabled" });
      return;
    }
    res.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log?.error?.({ err }, "mdns-health: gather failed");
    res.status(500).json({ ok: false, error: msg });
  }
});

/**
 * `POST /lan-broadcast/restart` — one-click "kick the LAN broadcast"
 * action for the MdnsHealthCard (#403).
 *
 * Calls the Windows scheduled task that owns the dns-sd.exe child:
 *   schtasks /End /TN HawkEye-Mdns-OnStartup
 *   schtasks /Run /TN HawkEye-Mdns-OnStartup
 *
 * The supervisor task itself is the canonical entry point — restarting
 * it from elsewhere (e.g. `Stop-Process dns-sd`) leaves the
 * supervisor unaware and produces a stale heartbeat. Going through
 * schtasks is the same flow the operator would use over RDP.
 *
 * super_admin only. The endpoint waits for both schtasks invocations
 * to complete and returns `{ ok, endExitCode, runExitCode, durationMs }`
 * so the dashboard can show success/failure inline.
 *
 * Refuses with 503 when running on a non-Windows host (dev / Linux
 * CI) — there is no scheduled task to drive there.
 */
router.post(
  "/lan-broadcast/restart",
  async (req: Request, res: Response) => {
    if (!isSuperAdmin(req, res)) return;
    if (process.platform !== "win32") {
      res
        .status(503)
        .json({ ok: false, error: "schtasks_unavailable_non_windows" });
      return;
    }
    if (restartInFlight) {
      res.status(409).json({ ok: false, error: "already_running" });
      return;
    }

    const taskName =
      String(process.env["HAWK_MDNS_TASK_NAME"] ?? "").trim() ||
      "HawkEye-Mdns-OnStartup";

    restartInFlight = true;
    const startedAt = Date.now();
    try {
      // /End is allowed to fail (task may not be currently running);
      // we surface the exit code but treat ok-ness on the /Run step.
      const endExit = await runSchtasks(["/End", "/TN", taskName]);
      const runExit = await runSchtasks(["/Run", "/TN", taskName]);
      const durationMs = Date.now() - startedAt;
      const ok = runExit === 0;
      req.log?.info?.(
        { endExit, runExit, ok, taskName, durationMs },
        "lan-broadcast: restart",
      );
      res.status(ok ? 200 : 500).json({
        ok,
        endExitCode: endExit,
        runExitCode: runExit,
        taskName,
        durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log?.error?.({ err, taskName }, "lan-broadcast: restart threw");
      res.status(500).json({ ok: false, error: msg, taskName });
    } finally {
      restartInFlight = false;
    }
  },
);

function runSchtasks(args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn("schtasks", args, { stdio: "ignore" });
    let settled = false;
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(-1);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? -1);
    });
  });
}

function isSuperAdmin(req: Request, res: Response): boolean {
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
    return false;
  }
  return true;
}

export default router;
