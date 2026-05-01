/**
 * `/api/internal/lan-discovery/*` — read-only view onto the LAN
 * auto-discovery service (Task T-R, Step 2 + Step 3).
 *
 * Surfaces the in-memory peer map maintained by
 * `lib/lan-discovery.ts` so the dashboard can render the "PCs on this
 * LAN" panel and decide whether to offer the first-launch pairing
 * card. Both the hub mount (`/api/internal/lan-discovery/peers`) and
 * the aggregator mount (`/api/aggregate/lan-discovery/peers`) share
 * this exact router; routes/index.ts mounts it under both prefixes
 * so every role's dashboard can read its own peer list.
 *
 * Authentication: `requireInternalLanSession` (already mounted by
 * the parent router) gates this surface. Within the request handler
 * we additionally restrict to `super_admin` because peer-list
 * disclosure is operationally sensitive (it's the LAN topology
 * diagram of the squadron).
 */

import { Router, type IRouter } from "express";

import { getLanDiscoveryService } from "../lib/lan-discovery";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

function isSuperAdmin(roleRaw: string | null | undefined): boolean {
  return normalizeLanRole(roleRaw) === "super_admin";
}

router.get("/lan-discovery/peers", (req, res) => {
  const lanUser = readLanUser(req);
  if (lanUser && !isSuperAdmin(lanUser.role)) {
    res.status(403).json({ error: "forbidden_role" });
    return;
  }
  const svc = getLanDiscoveryService();
  if (!svc) {
    // Discovery loop not started (test harness, dev box, etc.). Be
    // explicit so the UI can render a "discovery offline" hint
    // instead of "no peers".
    res.json({
      enabled: false,
      self: null,
      peers: [],
    });
    return;
  }
  const self = svc.getSelf();
  const peers = svc.listPeers();
  res.json({
    enabled: true,
    self,
    peers,
  });
});

export default router;
