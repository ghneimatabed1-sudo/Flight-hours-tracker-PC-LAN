import { Router, type IRouter } from "express";
import { normalizeLanRole, readLanUser, type LanUserContext } from "../lib/lan-authz";
import {
  fanOutResource,
  listActivePeers,
  listPeersForActor,
  type FanoutDeps,
} from "../lib/peer-fanout";

/**
 * Aggregate read endpoints. Each handler is a thin wrapper around
 * `fanOutResource()` for one resource path on the producer
 * (`/api/peer/[resource]`). Rows come back tagged with their
 * originating squadron and a per-peer status block lets the dashboard
 * render the honest "Tigers — offline since 14:22" banner.
 */
const router: IRouter = Router();

/**
 * Returns the actor context when the caller is authorised to read
 * aggregate data, or `null` when access must be denied.
 *
 * Returns a sentinel `{ _bringUp: true }` object when running in
 * bring-up mode (HAWK_INTERNAL_SESSION_AUTH=off) so downstream code
 * can still distinguish "no session system" from "denied".
 */
function resolveAggregateActor(
  req: unknown,
): LanUserContext | { _bringUp: true } | null {
  const user = readLanUser(req);
  if (!user) return { _bringUp: true }; // bring-up mode
  const role = normalizeLanRole(user.role);
  if (
    role === "super_admin"
    || role === "admin"
    || role === "commander_wing"
    || role === "commander_base"
  ) {
    return user;
  }
  return null;
}

type AggregateOpts = {
  /**
   * Test seam: route handlers don't take this arg directly, but we
   * keep `fanOutResource` injection-friendly via module-level wiring
   * if a test ever needs it. Today the tests exercise the library
   * directly and the address-book CRUD via real Express, so this
   * stays plumbed but unused.
   */
  deps?: FanoutDeps;
};

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v != null) return v;
  }
  return null;
}

function asTime(v: unknown): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

const aggregateOpts: AggregateOpts = {};

async function runAggregate<R extends Record<string, unknown>>(
  actor: LanUserContext | { _bringUp: true },
  resource: string,
  cacheKind: string,
  sortKey: ((row: R) => string | number | null) | null,
  sortOrder: "asc" | "desc" = "asc",
) {
  const peers =
    "_bringUp" in actor
      ? await listActivePeers()
      : await listPeersForActor(actor);
  return fanOutResource<R>(peers, resource, {
    cacheKind,
    deps: aggregateOpts.deps,
    ...(sortKey ? { sortKey, sortOrder } : {}),
  });
}

router.get("/pilots", async (req, res, next) => {
  try {
    const actor = resolveAggregateActor(req);
    if (!actor) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const result = await runAggregate(
      actor,
      "pilots",
      "pilots",
      (row) =>
        String(pick(row, "name", "arabic_name", "id") ?? "").toLowerCase(),
    );
    res.json({ items: result.rows, peers: result.peers });
  } catch (err) {
    next(err);
  }
});

router.get("/sorties", async (req, res, next) => {
  try {
    const actor = resolveAggregateActor(req);
    if (!actor) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const result = await runAggregate(
      actor,
      "sorties",
      "sorties",
      (row) => -asTime(pick(row, "date", "flight_date", "created_at")),
    );
    res.json({ items: result.rows, peers: result.peers });
  } catch (err) {
    next(err);
  }
});

router.get("/leaves", async (req, res, next) => {
  try {
    const actor = resolveAggregateActor(req);
    if (!actor) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const result = await runAggregate(
      actor,
      "leaves",
      "leaves",
      (row) => {
        const yr = Number(pick(row, "year") ?? 0);
        const pid = String(pick(row, "pilot_id", "id") ?? "");
        return `${yr.toString().padStart(6, "0")}|${pid}`;
      },
    );
    res.json({ items: result.rows, peers: result.peers });
  } catch (err) {
    next(err);
  }
});

router.get("/unavailable", async (req, res, next) => {
  try {
    const actor = resolveAggregateActor(req);
    if (!actor) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const result = await runAggregate(
      actor,
      "unavailable",
      "unavailable",
      (row) => asTime(pick(row, "from_date", "start_date", "created_at")),
      "asc",
    );
    res.json({ items: result.rows, peers: result.peers });
  } catch (err) {
    next(err);
  }
});

router.get("/notams", async (req, res, next) => {
  try {
    const actor = resolveAggregateActor(req);
    if (!actor) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const result = await runAggregate(
      actor,
      "notams",
      "notams",
      (row) => -asTime(pick(row, "posted_on", "created_at")),
    );
    res.json({ items: result.rows, peers: result.peers });
  } catch (err) {
    next(err);
  }
});

router.get("/readiness-summary", async (req, res, next) => {
  try {
    const actor = resolveAggregateActor(req);
    if (!actor) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const result = await runAggregate(
      actor,
      "readiness-summary",
      "readiness-summary",
      (row) =>
        String(pick(row, "squadron_name", "squadron_id") ?? "").toLowerCase(),
    );
    res.json({ items: result.rows, peers: result.peers });
  } catch (err) {
    next(err);
  }
});

export default router;
