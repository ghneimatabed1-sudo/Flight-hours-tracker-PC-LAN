import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";

import { logger } from "./logger";

/**
 * mDNS supervisor heartbeat reader (Task #398).
 *
 * Mirrors the on-disk contract written by `scripts/lan-host/mdns-supervisor.ps1`
 * and the health logic in `scripts/lan-host/check-mdns-health.ps1`, so a
 * dashboard badge can replace `RDP + run check-mdns-health.ps1` for ops.
 *
 * Heartbeat file (Windows host):
 *   `%PROGRAMDATA%\HawkEye\mdns-supervisor.heartbeat`
 *
 * Operators may override the path with `HAWK_MDNS_HEARTBEAT_PATH` (used by
 * tests and by Linux-side dev hosts that have no `%PROGRAMDATA%`).
 */

/** Matches `check-mdns-health.ps1`'s default. */
export const STALE_THRESHOLD_SEC = 90;

/**
 * State the dashboard badge can render. Mirrors the supervisor state
 * machine plus two derived states:
 *  - `disabled`  — heartbeat file does not exist (mDNS never enabled).
 *  - `unreadable` — file exists but is missing/garbled fields.
 *  - `stale`     — supervisor task itself died; heartbeat older than
 *                  `STALE_THRESHOLD_SEC`.
 *  - `restarting` — supervisor wrote a non-running tick (between dns-sd
 *                   restarts).
 *  - `alive`     — recent heartbeat AND state === "running".
 */
export type MdnsBadgeState =
  | "alive"
  | "stale"
  | "restarting"
  | "spawn-failed"
  | "starting"
  | "unreadable"
  | "disabled";

export type MdnsHealthReport = {
  /** Derived badge state for the dashboard. */
  state: MdnsBadgeState;
  /** Raw `state` field from the heartbeat (when readable). */
  supervisorState: string | null;
  /** Heartbeat age in seconds (whole number). `null` when no heartbeat. */
  ageSec: number | null;
  /** Threshold the agent uses to decide `stale`. */
  staleThresholdSec: number;
  /** Restart counter from the supervisor. */
  restartCount: number | null;
  squadronName: string | null;
  apiPort: string | null;
  /** Heartbeat timestamp echoed back for debugging. */
  timestamp: string | null;
  /** Path the agent actually read. */
  heartbeatPath: string;
};

export function resolveHeartbeatPath(): string {
  const raw = String(process.env["HAWK_MDNS_HEARTBEAT_PATH"] ?? "").trim();
  if (raw && isAbsolute(raw)) return raw;
  const programData =
    String(process.env["ProgramData"] ?? "").trim() ||
    (process.platform === "win32" ? "C:\\ProgramData" : "/var/lib");
  return join(programData, "HawkEye", "mdns-supervisor.heartbeat");
}

type HeartbeatJson = {
  timestamp?: unknown;
  squadronName?: unknown;
  apiPort?: unknown;
  childPid?: unknown;
  restartCount?: unknown;
  state?: unknown;
};

function asString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function asInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Read and interpret the supervisor heartbeat file.
 *
 * Returns `null` when the file does not exist (mDNS was never enabled on
 * this host) so callers can map that to a 404 — same convention as the
 * task spec ("404 if mDNS was never enabled").
 *
 * Returns a `state: "unreadable"` report (NOT null) when the file exists
 * but cannot be parsed; that's an actionable problem the dashboard should
 * surface, not "feature disabled".
 */
export async function readMdnsHealth(
  now: Date = new Date(),
  heartbeatPath: string = resolveHeartbeatPath(),
): Promise<MdnsHealthReport | null> {
  let raw: string;
  try {
    raw = await fs.readFile(heartbeatPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    logger.warn(
      { err, heartbeatPath },
      "mdns-health: heartbeat file unreadable",
    );
    return {
      state: "unreadable",
      supervisorState: null,
      ageSec: null,
      staleThresholdSec: STALE_THRESHOLD_SEC,
      restartCount: null,
      squadronName: null,
      apiPort: null,
      timestamp: null,
      heartbeatPath,
    };
  }

  let parsed: HeartbeatJson;
  try {
    parsed = JSON.parse(raw) as HeartbeatJson;
  } catch (err) {
    logger.warn(
      { err, heartbeatPath },
      "mdns-health: heartbeat JSON parse failed",
    );
    return {
      state: "unreadable",
      supervisorState: null,
      ageSec: null,
      staleThresholdSec: STALE_THRESHOLD_SEC,
      restartCount: null,
      squadronName: null,
      apiPort: null,
      timestamp: null,
      heartbeatPath,
    };
  }

  const tsRaw = asString(parsed.timestamp);
  const supervisorState = asString(parsed.state);
  const restartCount = asInt(parsed.restartCount);
  const squadronName = asString(parsed.squadronName);
  // The supervisor writes apiPort as a string; preserve that.
  const apiPort = asString(parsed.apiPort);

  if (!tsRaw) {
    return {
      state: "unreadable",
      supervisorState,
      ageSec: null,
      staleThresholdSec: STALE_THRESHOLD_SEC,
      restartCount,
      squadronName,
      apiPort,
      timestamp: null,
      heartbeatPath,
    };
  }

  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) {
    return {
      state: "unreadable",
      supervisorState,
      ageSec: null,
      staleThresholdSec: STALE_THRESHOLD_SEC,
      restartCount,
      squadronName,
      apiPort,
      timestamp: tsRaw,
      heartbeatPath,
    };
  }

  // Negative ages can happen if the host clock jumps backward — clamp to
  // 0 so the dashboard does not print "-3s old".
  const ageSec = Math.max(
    0,
    Math.round((now.getTime() - ts.getTime()) / 1000),
  );

  let badge: MdnsBadgeState;
  if (ageSec > STALE_THRESHOLD_SEC) {
    badge = "stale";
  } else if (supervisorState === "running") {
    badge = "alive";
  } else if (supervisorState === "restarting") {
    badge = "restarting";
  } else if (supervisorState === "spawn-failed") {
    badge = "spawn-failed";
  } else if (supervisorState === "starting") {
    badge = "starting";
  } else {
    // Unknown supervisor state but heartbeat is fresh — surface as
    // restarting so the dashboard pushes the operator to re-check.
    badge = "restarting";
  }

  return {
    state: badge,
    supervisorState,
    ageSec,
    staleThresholdSec: STALE_THRESHOLD_SEC,
    restartCount,
    squadronName,
    apiPort,
    timestamp: ts.toISOString(),
    heartbeatPath,
  };
}
