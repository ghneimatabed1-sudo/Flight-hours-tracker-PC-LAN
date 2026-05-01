import { promises as fs, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";

import { pool } from "@workspace/db";

import { getActiveInstallProfile, isAggregatorProfile } from "./install-profile";
import { getRecentPeerSkewMs, listActivePeers, pingPeers } from "./peer-fanout";
import { logger } from "./logger";

/**
 * Tagged schema version. Bumped any time `ensureFullSchema()` adds a
 * column, table, or index that an older binary should refuse to ignore.
 * Operators see this on the System Health page so a 2026-installed PC
 * booting with the 2030 binary can be cross-checked against the marker
 * recorded in `install_profile_meta`.
 */
export const SCHEMA_VERSION = 2;

export type Severity = "ok" | "warn" | "fail";

export type ComponentReport = {
  key: string;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown>;
};

export type SystemHealthReport = {
  generatedAt: string;
  installProfile: string;
  schemaVersion: number;
  overall: Severity;
  components: ComponentReport[];
};

/**
 * Resolve the on-disk directory whose free space we should sample.
 * Defaults to `process.cwd()` (the install root the api-server was
 * started from). The operator may override with `HAWK_DATA_DIR`.
 */
function resolveDataDir(): string {
  const raw = String(process.env["HAWK_DATA_DIR"] ?? "").trim();
  if (raw && isAbsolute(raw)) return raw;
  return process.cwd();
}

function backupsDir(): string {
  const raw = String(process.env["HAWK_BACKUP_DIR"] ?? "").trim();
  if (raw && isAbsolute(raw)) return raw;
  // The PowerShell scripts default to `<repo>/artifacts/api-server/backups`.
  return pathResolve(process.cwd(), "artifacts", "api-server", "backups");
}

export type DiskUsage = {
  path: string;
  totalBytes: number;
  freeBytes: number;
  freePercent: number;
};

/** Sample disk usage. Returns `null` if statfs fails (Windows < ?). */
export function sampleDiskUsage(path = resolveDataDir()): DiskUsage | null {
  try {
    // statfsSync exists on Node 18.15+.
    const stats = statfsSync(path);
    const blockSize = Number(stats.bsize ?? 0);
    const totalBlocks = Number(stats.blocks ?? 0);
    const freeBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    if (blockSize <= 0 || totalBlocks <= 0) return null;
    const totalBytes = blockSize * totalBlocks;
    const freeBytes = blockSize * freeBlocks;
    const freePercent = totalBytes === 0 ? 0 : (freeBytes / totalBytes) * 100;
    return { path, totalBytes, freeBytes, freePercent };
  } catch (err) {
    logger.warn({ err, path }, "system-health: statfs failed");
    // Try the parent (Windows reports per-volume; cwd may be a junction).
    if (path !== dirname(path)) {
      return sampleDiskUsage(dirname(path));
    }
    return null;
  }
}

/**
 * Disk-warning bands match the task spec:
 *   < 1%  → fail (the disk-guard middleware refuses writes)
 *   < 5%  → warn (95% used; "hard warning")
 *   < 20% → warn (80% used; "in-app warning")
 *   else  → ok
 */
function diskComponent(): ComponentReport {
  const u = sampleDiskUsage();
  if (!u) {
    return {
      key: "disk",
      severity: "warn",
      message: "Could not read disk usage (statfs failed). Operator action: check the data drive is mounted.",
    };
  }
  const pct = Math.round(u.freePercent * 10) / 10;
  const detail = {
    path: u.path,
    freeBytes: u.freeBytes,
    totalBytes: u.totalBytes,
    freePercent: pct,
  };
  if (u.freePercent < 1) {
    return {
      key: "disk",
      severity: "fail",
      message: `Disk is ${pct}% free — writes are being refused to protect the database. Free space immediately.`,
      detail,
    };
  }
  if (u.freePercent < 5) {
    return {
      key: "disk",
      severity: "warn",
      message: `Disk is ${pct}% free (less than 5%). Free space soon — writes will be refused below 1%.`,
      detail,
    };
  }
  if (u.freePercent < 20) {
    return {
      key: "disk",
      severity: "warn",
      message: `Disk is ${pct}% free (less than 20%). Plan to free space.`,
      detail,
    };
  }
  return {
    key: "disk",
    severity: "ok",
    message: `Disk is ${pct}% free.`,
    detail,
  };
}

async function postgresComponent(): Promise<ComponentReport> {
  try {
    const r = await pool.query<{ ver: string; now: string }>(
      `select version() as ver, now()::text as now`,
    );
    return {
      key: "postgres",
      severity: "ok",
      message: "Postgres responded.",
      detail: {
        version: r.rows[0]?.ver ?? "unknown",
        serverNow: r.rows[0]?.now ?? null,
      },
    };
  } catch (err) {
    return {
      key: "postgres",
      severity: "fail",
      message: `Postgres did not respond: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function auditLogComponent(): Promise<ComponentReport> {
  try {
    const r = await pool.query<{
      row_count: string;
      oldest: string | null;
      newest: string | null;
      sz: string;
    }>(
      `
      select
        coalesce(count(*), 0)::text as row_count,
        min(occurred_at)::text as oldest,
        max(occurred_at)::text as newest,
        coalesce(pg_total_relation_size('audit_log'), 0)::text as sz
      from audit_log
      `,
    );
    const row = r.rows[0];
    if (!row) {
      return {
        key: "audit_log",
        severity: "ok",
        message: "Audit log is empty.",
      };
    }
    const rowCount = Number(row.row_count ?? 0);
    const sizeBytes = Number(row.sz ?? 0);
    return {
      key: "audit_log",
      severity: "ok",
      message: `${rowCount.toLocaleString("en-US")} rows · ${(sizeBytes / 1024 / 1024).toFixed(1)} MB on disk.`,
      detail: {
        rowCount,
        sizeBytes,
        oldest: row.oldest,
        newest: row.newest,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*audit_log.* does not exist/i.test(msg)) {
      return {
        key: "audit_log",
        severity: "warn",
        message: "Audit log table not initialized yet.",
      };
    }
    return {
      key: "audit_log",
      severity: "warn",
      message: `Audit log read failed: ${msg}`,
    };
  }
}

async function lastBackupComponent(): Promise<ComponentReport> {
  const dir = backupsDir();
  try {
    const entries = await fs.readdir(dir);
    const dumps = entries.filter((n) => n.toLowerCase().endsWith(".dump"));
    if (dumps.length === 0) {
      return {
        key: "last_backup",
        severity: "warn",
        message: `No backup files in ${dir}. The nightly Hawk Eye backup task may not be installed.`,
      };
    }
    let newest: { name: string; mtimeMs: number } | null = null;
    for (const name of dumps) {
      try {
        const st = await fs.stat(join(dir, name));
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { name, mtimeMs: st.mtimeMs };
        }
      } catch {
        // ignore one-off stat failures
      }
    }
    if (!newest) {
      return {
        key: "last_backup",
        severity: "warn",
        message: `Could not stat any backup file in ${dir}.`,
      };
    }
    const ageMs = Date.now() - newest.mtimeMs;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const detail = {
      path: join(dir, newest.name),
      ageHours: Math.round(ageMs / 1000 / 60 / 60),
    };
    if (ageDays > 7) {
      return {
        key: "last_backup",
        severity: "fail",
        message: `Last backup was ${Math.round(ageDays)} days ago (${newest.name}). The nightly task is not running.`,
        detail,
      };
    }
    if (ageDays > 2) {
      return {
        key: "last_backup",
        severity: "warn",
        message: `Last backup was ${Math.round(ageDays)} days ago (${newest.name}). Expected nightly.`,
        detail,
      };
    }
    return {
      key: "last_backup",
      severity: "ok",
      message: `Last backup ${Math.round(ageMs / 1000 / 60 / 60)}h ago (${newest.name}).`,
      detail,
    };
  } catch (err) {
    return {
      key: "last_backup",
      severity: "warn",
      message: `Backup directory ${dir} not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function lastBackupVerifyComponent(): Promise<ComponentReport> {
  try {
    const r = await pool.query<{
      ok: boolean;
      observed_at: string;
      message: string | null;
      detail: unknown;
    }>(
      `select ok, observed_at::text as observed_at, message, detail
       from system_health_marker
       where key = 'last_backup_verify'
       limit 1`,
    );
    const row = r.rows[0];
    if (!row) {
      return {
        key: "last_backup_verify",
        severity: "warn",
        message: "Backup has never been verified by self-restore. Install verify-backup quarterly task.",
      };
    }
    const observedAt = new Date(row.observed_at);
    const ageDays = (Date.now() - observedAt.getTime()) / (1000 * 60 * 60 * 24);
    const detail = {
      observedAt: observedAt.toISOString(),
      ageDays: Math.round(ageDays),
      ...(row.detail && typeof row.detail === "object" ? (row.detail as Record<string, unknown>) : {}),
    };
    if (!row.ok) {
      return {
        key: "last_backup_verify",
        severity: "fail",
        message: `Last backup verification FAILED${row.message ? `: ${row.message}` : ""}.`,
        detail,
      };
    }
    if (ageDays > 120) {
      return {
        key: "last_backup_verify",
        severity: "warn",
        message: `Backup last verified ${Math.round(ageDays)} days ago — overdue (quarterly cadence).`,
        detail,
      };
    }
    return {
      key: "last_backup_verify",
      severity: "ok",
      message: `Backup last verified ${Math.round(ageDays)} days ago.`,
      detail,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*system_health_marker.* does not exist/i.test(msg)) {
      return {
        key: "last_backup_verify",
        severity: "warn",
        message: "system_health_marker table not initialized yet.",
      };
    }
    return {
      key: "last_backup_verify",
      severity: "warn",
      message: `Verify marker read failed: ${msg}`,
    };
  }
}

async function installProfileComponent(): Promise<ComponentReport> {
  const current = getActiveInstallProfile();
  try {
    const r = await pool.query<{ profile: string; first_booted_at: string }>(
      `select profile, first_booted_at::text from install_profile_meta where id = 1 limit 1`,
    );
    const row = r.rows[0];
    if (!row) {
      return {
        key: "install_profile",
        severity: "ok",
        message: `Install profile: ${current}.`,
        detail: { current },
      };
    }
    if (row.profile !== current) {
      return {
        key: "install_profile",
        severity: "fail",
        message: `Install profile drift: first booted as '${row.profile}' but currently '${current}'. Treat the original as canonical.`,
        detail: { current, firstBooted: row.profile, firstBootedAt: row.first_booted_at },
      };
    }
    return {
      key: "install_profile",
      severity: "ok",
      message: `Install profile: ${current} (since ${row.first_booted_at}).`,
      detail: { current, firstBooted: row.profile, firstBootedAt: row.first_booted_at },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*install_profile_meta.* does not exist/i.test(msg)) {
      return {
        key: "install_profile",
        severity: "ok",
        message: `Install profile: ${current} (first-boot marker not yet recorded).`,
        detail: { current },
      };
    }
    return {
      key: "install_profile",
      severity: "warn",
      message: `Install profile read failed: ${msg}`,
    };
  }
}

async function peerReachabilityComponent(): Promise<ComponentReport | null> {
  const profile = getActiveInstallProfile();
  if (!isAggregatorProfile(profile)) return null;
  try {
    const peers = await listActivePeers();
    if (peers.length === 0) {
      return {
        key: "peers",
        severity: "warn",
        message: "Aggregator has no peers in the address book yet.",
      };
    }
    const statuses = await pingPeers(peers, { timeoutMs: 2_000 });
    const offline = statuses.filter((s) => s.status === "offline");
    const skew = getRecentPeerSkewMs();
    const skewWarn = Object.entries(skew).filter(
      ([, ms]) => Math.abs(ms) > 5 * 60 * 1000,
    );
    const detail: Record<string, unknown> = {
      total: statuses.length,
      online: statuses.length - offline.length,
      offline: offline.length,
      offlinePeers: offline.map((s) => s.squadron_name ?? s.squadron_id),
      clockSkewMsByPeer: skew,
    };
    if (offline.length > 0) {
      return {
        key: "peers",
        severity: "warn",
        message: `${offline.length} of ${statuses.length} squadron peers are offline.`,
        detail,
      };
    }
    if (skewWarn.length > 0) {
      return {
        key: "peers",
        severity: "warn",
        message: `${skewWarn.length} peer(s) report a clock skew >5 minutes — verify those PCs' system clocks.`,
        detail,
      };
    }
    return {
      key: "peers",
      severity: "ok",
      message: `All ${statuses.length} squadron peers are reachable.`,
      detail,
    };
  } catch (err) {
    return {
      key: "peers",
      severity: "warn",
      message: `Peer health probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function rollupSeverity(components: ComponentReport[]): Severity {
  if (components.some((c) => c.severity === "fail")) return "fail";
  if (components.some((c) => c.severity === "warn")) return "warn";
  return "ok";
}

/** Top-level entry point used by the System Health admin page. */
export async function gatherSystemHealth(): Promise<SystemHealthReport> {
  const [pg, audit, backup, verify, profile, peers] = await Promise.all([
    postgresComponent(),
    auditLogComponent(),
    lastBackupComponent(),
    lastBackupVerifyComponent(),
    installProfileComponent(),
    peerReachabilityComponent(),
  ]);
  const disk = diskComponent();
  const components: ComponentReport[] = [
    profile,
    disk,
    pg,
    audit,
    backup,
    verify,
  ];
  if (peers) components.push(peers);
  return {
    generatedAt: new Date().toISOString(),
    installProfile: getActiveInstallProfile(),
    schemaVersion: SCHEMA_VERSION,
    overall: rollupSeverity(components),
    components,
  };
}
