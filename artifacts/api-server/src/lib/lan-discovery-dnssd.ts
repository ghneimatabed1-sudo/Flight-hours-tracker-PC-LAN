/**
 * dns-sd.exe-based LAN discovery transport (Task T-R, Step 2).
 *
 * Wraps the bundled Apple Bonjour `dns-sd.exe` browser into a
 * `LanDiscoveryTransport`. Three child processes cooperate:
 *
 *   1. `dns-sd -B _hawkeye._tcp` — long-running browse stream emitting
 *      one line per service "Add" / "Rmv" event.
 *   2. `dns-sd -L "<name>" _hawkeye._tcp .` — per-service one-shot
 *      lookup that yields the TXT record + target host:port; we kill
 *      it once the announce is complete or after `LOOKUP_TIMEOUT_MS`.
 *   3. `dns-sd -G v4 <host>` — per-host one-shot resolver that turns
 *      a `<host>.local.` target into an IPv4 address. Many small LAN
 *      stacks decline reverse-resolution so we treat failure as a
 *      soft warn and report the unresolved host string instead.
 *
 * The transport is best-effort by design: a missing dns-sd.exe, a
 * broken supervisor, or a multicast-blocking switch all degrade to
 * "no peers visible" rather than crashing the api-server.
 */

import { spawn, type ChildProcess } from "node:child_process";

import type {
  LanDiscoveryTransport,
  LanDiscoveryTransportHandlers,
  LanPeerAnnounce,
  LanPeerRole,
} from "./lan-discovery";
import { isLanPeerRole } from "./lan-discovery";
import { logger } from "./logger";

const LOOKUP_TIMEOUT_MS = 5_000;
const RESOLVE_TIMEOUT_MS = 3_000;
const SERVICE_TYPE = "_hawkeye._tcp";

export type DnsSdTransportOptions = {
  /** Absolute path to `dns-sd.exe`. Defaults to `dns-sd` (relies on PATH). */
  binPath?: string;
  serviceType?: string;
  /** Spawn override for tests. */
  spawnFn?: typeof spawn;
};

type ParsedServiceLine = {
  action: "Add" | "Rmv";
  hostname: string;
  serviceType: string;
};

const browseLineRe =
  /^\s*\d+:\d+:\d+(?:\.\d+)?\s+(?<action>Add|Rmv)\s+\S+\s+\d+\s+\S+\s+(?<svc>\S+)\s+(?<name>.+?)\s*$/;

export function parseBrowseLine(line: string): ParsedServiceLine | null {
  // dns-sd browse output sample (real Bonjour 3.0):
  //   "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name"
  //   "13:51:35.123  Add        2   4 local.               _hawkeye._tcp.       WING-HQ-PC"
  const m = browseLineRe.exec(line);
  if (!m || !m.groups) return null;
  const action = m.groups.action as "Add" | "Rmv";
  const svc = m.groups.svc!.replace(/\.$/, "");
  const name = m.groups.name!.trim();
  if (!name) return null;
  return { action, serviceType: svc, hostname: name };
}

export function parseTxtRecord(text: string): Record<string, string> {
  // dns-sd lookup output for a TXT record looks like:
  //   "WING-HQ-PC._hawkeye._tcp.local. can be reached at WING-HQ-PC.local.:3847 (interface 4)"
  //   " role=hub squadron=tigers version=1.1.110 hostname=WING-HQ-PC"
  // The TXT pairs may be on one line or split across many; we extract
  // every `key=value` token regardless of whitespace.
  const out: Record<string, string> = {};
  const tokenRe = /([A-Za-z0-9_.-]+)=([^"\s]+|"[^"]*")/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const k = m[1]!;
    let v = m[2]!;
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k && v) out[k] = v;
  }
  return out;
}

export function parseLookupTarget(
  text: string,
): { host: string; port: number } | null {
  // "WING-HQ-PC._hawkeye._tcp.local. can be reached at WING-HQ-PC.local.:3847 (interface 4)"
  const m = /can be reached at\s+([^\s:]+)(?::(\d+))?/i.exec(text);
  if (!m) return null;
  const host = m[1]!.trim().replace(/\.$/, "");
  const port = m[2] ? Number(m[2]) : 0;
  return { host, port: Number.isFinite(port) ? port : 0 };
}

export function parseResolveLine(line: string): string | null {
  // "13:51:35.123  Add        2   4 WING-HQ-PC.local.    192.168.1.10"
  const m = /^\s*\d+:\d+:\d+(?:\.\d+)?\s+(?:Add|Rmv)\s+\S+\s+\d+\s+\S+\s+(\d+\.\d+\.\d+\.\d+)\s*$/.exec(
    line,
  );
  return m ? m[1]! : null;
}

export function makeDnsSdBrowseTransport(
  opts: DnsSdTransportOptions = {},
): LanDiscoveryTransport {
  const bin = opts.binPath ?? "dns-sd";
  const serviceType = opts.serviceType ?? SERVICE_TYPE;
  const spawnFn = opts.spawnFn ?? spawn;

  let browseProc: ChildProcess | null = null;
  const lookupProcs = new Set<ChildProcess>();
  let stopped = false;

  function killAllLookups(): void {
    for (const p of lookupProcs) {
      try {
        p.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    lookupProcs.clear();
  }

  function lookupOnce(name: string, handlers: LanDiscoveryTransportHandlers): void {
    let buf = "";
    let done = false;
    const proc = spawnFn(bin, ["-L", name, serviceType, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    lookupProcs.add(proc);
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }, LOOKUP_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    proc.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      // We let the line keep arriving until either the timer fires
      // or we have both the target and a TXT block.
    });
    proc.on("error", (err) => {
      if (!done) handlers.onError(err);
    });
    proc.on("exit", () => {
      done = true;
      clearTimeout(timer);
      lookupProcs.delete(proc);
      const target = parseLookupTarget(buf);
      const txt = parseTxtRecord(buf);
      const role = txt["role"];
      if (!isLanPeerRole(role)) return;
      if (!target) return;
      const announce: LanPeerAnnounce = {
        hostname: txt["hostname"]?.toLowerCase() ?? name.toLowerCase(),
        role: role as LanPeerRole,
        address: target.host,
        port: target.port,
        txt,
      };
      handlers.onAnnounce(announce);
      // Best-effort IPv4 resolution. We don't block the announce on
      // it — the dashboard will simply show the `<host>.local` name
      // until the resolver returns.
      resolveHostIp(announce, handlers);
    });
  }

  function resolveHostIp(
    announce: LanPeerAnnounce,
    handlers: LanDiscoveryTransportHandlers,
  ): void {
    if (!announce.address) return;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(announce.address)) return;
    let buf = "";
    const proc = spawnFn(bin, ["-G", "v4", announce.address], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    lookupProcs.add(proc);
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, RESOLVE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    proc.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      for (const line of buf.split(/\r?\n/)) {
        const ip = parseResolveLine(line);
        if (ip) {
          handlers.onAnnounce({ ...announce, address: ip });
          try {
            proc.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          return;
        }
      }
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      lookupProcs.delete(proc);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      lookupProcs.delete(proc);
      // Soft-fail; we already published the announce with the host name.
    });
  }

  return {
    start(handlers) {
      if (browseProc) return;
      stopped = false;
      try {
        browseProc = spawnFn(bin, ["-B", serviceType, "."], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        handlers.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let leftover = "";
      browseProc.stdout?.on("data", (chunk) => {
        leftover += String(chunk);
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseBrowseLine(line);
          if (!parsed || parsed.action !== "Add") continue;
          if (parsed.serviceType !== serviceType) continue;
          lookupOnce(parsed.hostname, handlers);
        }
      });
      browseProc.on("error", (err) => {
        if (!stopped) handlers.onError(err);
      });
      browseProc.on("exit", (code) => {
        if (!stopped) {
          logger.warn(
            { code },
            "dns-sd browse process exited unexpectedly; lan-discovery is now blind until restart",
          );
        }
      });
    },
    stop() {
      stopped = true;
      if (browseProc) {
        try {
          browseProc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        browseProc = null;
      }
      killAllLookups();
    },
  };
}
