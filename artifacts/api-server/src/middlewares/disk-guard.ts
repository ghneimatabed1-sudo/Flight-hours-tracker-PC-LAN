import type { NextFunction, Request, Response } from "express";

import { sampleDiskUsage } from "../lib/system-health";

/**
 * Refuse non-GET writes when the data disk is critically low. Designed
 * for unattended 15-year operation: a full disk + a fresh INSERT can
 * leave Postgres in a confused state, so we'd rather return a clear
 * `disk_full` error and let the operator clear space first.
 *
 * Reads (GET, HEAD, OPTIONS) are always allowed so the System Health
 * page itself stays reachable when the disk is full.
 *
 * Sampling is cached for `CACHE_TTL_MS` because `statfs` is a syscall
 * we don't want to run on every request.
 */

const CACHE_TTL_MS = 60_000;
const CRITICAL_FREE_PERCENT = 1;

type CacheEntry = {
  freePercent: number | null;
  expiresAt: number;
};

let cache: CacheEntry | null = null;

function readCachedFreePercent(): number | null {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.freePercent;
  const sample = sampleDiskUsage();
  const freePercent = sample ? sample.freePercent : null;
  cache = { freePercent, expiresAt: now + CACHE_TTL_MS };
  return freePercent;
}

/** Test-only seam used to flush the in-process cache between cases. */
export function _resetDiskGuardCacheForTests(): void {
  cache = null;
}

export function diskGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const method = String(req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    next();
    return;
  }
  const freePercent = readCachedFreePercent();
  // statfs failure → don't block writes (we'd rather over-permit than
  // brick the install when sampling itself is broken).
  if (freePercent == null) {
    next();
    return;
  }
  if (freePercent < CRITICAL_FREE_PERCENT) {
    res.status(507).json({
      ok: false,
      error: "disk_full",
      message: `Refusing write: only ${freePercent.toFixed(2)}% of the data disk is free. Free space then retry.`,
      freePercent,
    });
    return;
  }
  next();
}
