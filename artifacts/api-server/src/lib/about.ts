import os from "node:os";
import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve as pathResolve } from "node:path";

import { pool } from "@workspace/db";

import {
  getActiveInstallProfile,
  isAggregatorProfile,
  type InstallProfile,
} from "./install-profile";
import { logger } from "./logger";

/**
 * Stale-threshold (seconds) for the dashboard-supervisor heartbeat.
 * Matches `check-host-health.ps1`'s default and the `mdns-supervisor`
 * threshold (`STALE_THRESHOLD_SEC` in `mdns-health.ts`) so all three
 * watchdog rows on the About panel use the same goalposts.
 */
const DASHBOARD_SUPERVISOR_STALE_SEC = 90;

/**
 * "About this PC" is a Settings-level snapshot intended for the
 * super_admin who is operating the LAN install. It bundles together
 * the small handful of facts an operator needs when reporting an
 * issue ("which install profile, which version, when did it boot,
 * was it backed up recently?") in a single payload so the React
 * Settings panel does not have to make four separate calls to
 * different routes.
 *
 * Mounted under both `/api/internal/about` (hub) and
 * `/api/aggregate/about` (aggregator-wing / aggregator-base) by
 * `routes/index.ts`. Always super_admin only.
 */
export type LastBackupAge = {
  ageSeconds: number;
  path: string;
  fileName: string;
};

export type LastBackupVerifyAge = {
  ageSeconds: number;
  ok: boolean;
};

/**
 * Snapshot of the dashboard-launcher watchdog (Task #399 / T-O).
 *
 * Mirrors the on-disk JSON tick written by
 * `scripts/lan-host/dashboard-supervisor.ps1` plus a derived
 * `state` field. `null` here means the heartbeat file does not
 * exist on disk yet — typically a hub-only install where the
 * dashboard is consumed from a different PC.
 */
export type DashboardSupervisorReport = {
  /** Derived badge state for the dashboard row. */
  state:
    | "alive"
    | "stale"
    | "restarting"
    | "spawn-failed"
    | "starting"
    | "unreadable";
  /** Raw `state` value from the heartbeat (when readable). */
  supervisorState: string | null;
  /** Heartbeat age in seconds (whole number). `null` if unparsed. */
  ageSeconds: number | null;
  /** Threshold used to flag `stale`; informational. */
  staleThresholdSec: number;
  restartCount: number | null;
  childPid: number | null;
  /** Path of the wrapped child script (for diagnostics). */
  childScript: string | null;
  /** Heartbeat path the agent actually read. */
  heartbeatPath: string;
};

export type AboutThisPcReport = {
  installProfile: InstallProfile;
  hostname: string;
  apiServerVersion: string;
  buildTime: string;
  uptimeSeconds: number;
  databaseName: string | null;
  /** Active (non-revoked) peer-token count. Only populated on the hub. */
  peerTokenCount: number | null;
  /** Address-book size. Only populated on aggregator profiles. */
  peerSquadronCount: number | null;
  lastBackupAge: LastBackupAge | null;
  lastBackupVerifyAge: LastBackupVerifyAge | null;
  /**
   * Dashboard-launcher watchdog snapshot (Task T-O #399). `null`
   * when the heartbeat file does not exist on this host (e.g. a
   * hub PC that does not auto-launch the dashboard locally).
   */
  dashboardSupervisor: DashboardSupervisorReport | null;
  nodeVersion: string;
};

function safeApiVersion(): string {
  try {
    if (typeof __APISERVER_VERSION__ === "string" && __APISERVER_VERSION__) {
      return __APISERVER_VERSION__;
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

function safeBuildTime(): string {
  try {
    if (typeof __BUILD_TIME__ === "string" && __BUILD_TIME__) {
      return __BUILD_TIME__;
    }
  } catch {
    /* fall through */
  }
  return "";
}

function backupsDir(): string {
  const raw = String(process.env["HAWK_BACKUP_DIR"] ?? "").trim();
  if (raw && isAbsolute(raw)) return raw;
  return pathResolve(process.cwd(), "artifacts", "api-server", "backups");
}

async function readDatabaseName(): Promise<string | null> {
  try {
    const r = await pool.query<{ name: string }>(`select current_database() as name`);
    return r.rows[0]?.name ?? null;
  } catch (err) {
    logger.warn({ err }, "about: current_database failed");
    return null;
  }
}

async function readPeerTokenCount(): Promise<number | null> {
  try {
    const r = await pool.query<{ c: string }>(
      `select count(*)::text as c from peer_tokens where revoked_at is null`,
    );
    return Number(r.rows[0]?.c ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_tokens.* does not exist/i.test(msg)) return 0;
    logger.warn({ err }, "about: peer_tokens count failed");
    return null;
  }
}

async function readPeerSquadronCount(): Promise<number | null> {
  try {
    const r = await pool.query<{ c: string }>(
      `select count(*)::text as c from peer_squadrons`,
    );
    return Number(r.rows[0]?.c ?? 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*peer_squadrons.* does not exist/i.test(msg)) return 0;
    logger.warn({ err }, "about: peer_squadrons count failed");
    return null;
  }
}

async function readLastBackupAge(): Promise<LastBackupAge | null> {
  const dir = backupsDir();
  try {
    const entries = await fs.readdir(dir);
    const dumps = entries.filter((n) => n.toLowerCase().endsWith(".dump"));
    if (dumps.length === 0) return null;
    let newest: { name: string; mtimeMs: number } | null = null;
    for (const name of dumps) {
      try {
        const st = await fs.stat(join(dir, name));
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { name, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* ignore one-off stat failure */
      }
    }
    if (!newest) return null;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - newest.mtimeMs) / 1000));
    return {
      ageSeconds,
      path: join(dir, newest.name),
      fileName: newest.name,
    };
  } catch {
    // Directory doesn't exist / not readable — treat as "no backup".
    return null;
  }
}

function dashboardSupervisorHeartbeatPath(): string {
  // Override hook for tests + Linux dev hosts that have no
  // `%PROGRAMDATA%`. Same convention as `mdns-health.ts`.
  const raw = String(process.env["HAWK_DASHBOARD_HEARTBEAT_PATH"] ?? "").trim();
  if (raw && isAbsolute(raw)) return raw;
  const programData =
    String(process.env["ProgramData"] ?? "").trim() ||
    (process.platform === "win32" ? "C:\\ProgramData" : "/var/lib");
  return join(programData, "HawkEye", "dashboard-supervisor.heartbeat");
}

type DashboardSupervisorHeartbeatJson = {
  timestamp?: unknown;
  childPid?: unknown;
  restartCount?: unknown;
  state?: unknown;
  childScript?: unknown;
};

function asNullableInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function asNullableString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

async function readDashboardSupervisorReport(
  now: Date = new Date(),
  heartbeatPath: string = dashboardSupervisorHeartbeatPath(),
): Promise<DashboardSupervisorReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(heartbeatPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    logger.warn(
      { err, heartbeatPath },
      "about: dashboard-supervisor heartbeat unreadable",
    );
    return {
      state: "unreadable",
      supervisorState: null,
      ageSeconds: null,
      staleThresholdSec: DASHBOARD_SUPERVISOR_STALE_SEC,
      restartCount: null,
      childPid: null,
      childScript: null,
      heartbeatPath,
    };
  }

  let parsed: DashboardSupervisorHeartbeatJson;
  try {
    parsed = JSON.parse(raw) as DashboardSupervisorHeartbeatJson;
  } catch (err) {
    logger.warn(
      { err, heartbeatPath },
      "about: dashboard-supervisor heartbeat JSON parse failed",
    );
    return {
      state: "unreadable",
      supervisorState: null,
      ageSeconds: null,
      staleThresholdSec: DASHBOARD_SUPERVISOR_STALE_SEC,
      restartCount: null,
      childPid: null,
      childScript: null,
      heartbeatPath,
    };
  }

  const tsRaw = asNullableString(parsed.timestamp);
  const supervisorState = asNullableString(parsed.state);
  const restartCount = asNullableInt(parsed.restartCount);
  const childPid = asNullableInt(parsed.childPid);
  const childScript = asNullableString(parsed.childScript);

  let ageSeconds: number | null = null;
  if (tsRaw) {
    const ts = new Date(tsRaw);
    if (!Number.isNaN(ts.getTime())) {
      ageSeconds = Math.max(
        0,
        Math.floor((now.getTime() - ts.getTime()) / 1000),
      );
    }
  }

  let state: DashboardSupervisorReport["state"];
  if (ageSeconds == null) {
    state = "unreadable";
  } else if (ageSeconds > DASHBOARD_SUPERVISOR_STALE_SEC) {
    state = "stale";
  } else if (supervisorState === "running") {
    state = "alive";
  } else if (supervisorState === "restarting") {
    state = "restarting";
  } else if (supervisorState === "spawn-failed") {
    state = "spawn-failed";
  } else if (supervisorState === "starting") {
    state = "starting";
  } else {
    state = "restarting";
  }

  return {
    state,
    supervisorState,
    ageSeconds,
    staleThresholdSec: DASHBOARD_SUPERVISOR_STALE_SEC,
    restartCount,
    childPid,
    childScript,
    heartbeatPath,
  };
}

async function readLastBackupVerifyAge(): Promise<LastBackupVerifyAge | null> {
  try {
    const r = await pool.query<{ ok: boolean; observed_at: string }>(
      `select ok, observed_at::text as observed_at
       from system_health_marker
       where key = 'last_backup_verify'
       limit 1`,
    );
    const row = r.rows[0];
    if (!row) return null;
    const at = new Date(row.observed_at);
    if (Number.isNaN(at.getTime())) return null;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
    return { ageSeconds, ok: row.ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*system_health_marker.* does not exist/i.test(msg)) return null;
    logger.warn({ err }, "about: system_health_marker read failed");
    return null;
  }
}

export async function gatherAboutThisPc(): Promise<AboutThisPcReport> {
  const profile = getActiveInstallProfile();
  const isAgg = isAggregatorProfile(profile);
  const [
    databaseName,
    peerTokenCount,
    peerSquadronCount,
    lastBackupAge,
    lastBackupVerifyAge,
    dashboardSupervisor,
  ] = await Promise.all([
    readDatabaseName(),
    profile === "hub" ? readPeerTokenCount() : Promise.resolve(null),
    isAgg ? readPeerSquadronCount() : Promise.resolve(null),
    readLastBackupAge(),
    readLastBackupVerifyAge(),
    readDashboardSupervisorReport(),
  ]);
  return {
    installProfile: profile,
    hostname: os.hostname(),
    apiServerVersion: safeApiVersion(),
    buildTime: safeBuildTime(),
    uptimeSeconds: Math.floor(process.uptime()),
    databaseName,
    peerTokenCount,
    peerSquadronCount,
    lastBackupAge,
    lastBackupVerifyAge,
    dashboardSupervisor,
    nodeVersion: process.version,
  };
}

// Exported for tests so the heartbeat parsing can be exercised without
// spinning up the express app.
export { readDashboardSupervisorReport };
