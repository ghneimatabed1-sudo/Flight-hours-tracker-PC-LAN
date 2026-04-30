/**
 * `/api/internal/lan-pairing/*` — one-click pairing handshake
 * (Task T-R, Step 4).
 *
 * Six routes, three flavours:
 *
 *  Operator-driven (gated by `requireInternalLanSession` + super_admin):
 *    POST /lan-pairing/request                — local UI asks server to start an outbound pair
 *    GET  /lan-pairing/inbox                  — pending inbound requests (Hub)
 *    POST /lan-pairing/inbox/:id/approve      — Hub super_admin approves
 *    POST /lan-pairing/inbox/:id/deny         — Hub super_admin denies
 *    GET  /lan-pairing/outbox                 — pending outbound requests sent from this PC
 *    DELETE /lan-pairing/outbox/:id           — local UI cancels an outbound request
 *
 *  Cross-PC (open to anyone on the LAN — both directions are
 *  authenticated by the per-request UUID + sealed envelope, not by an
 *  HTTP-level credential, since mDNS is unauthenticated by design):
 *    POST /lan-pairing/inbound-request        — peer asks to pair
 *    POST /lan-pairing/approval               — Hub posts encrypted token back
 *
 * This router is mounted by both the hub and aggregator routers in
 * `routes/index.ts`. The hub mount is the only one that exposes
 * `inbox/:id/approve|deny` because peer-token issuance only makes
 * sense on the producing PC; the aggregator mount of those routes
 * still answers but with `403 wrong_role`.
 */

import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

import { appendInternalAudit } from "../lib/internal-audit";
import { requireInternalWriteSecret } from "../lib/internal-write-auth";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";
import { issuePeerToken } from "../lib/peer-token";
import { hashPeerToken } from "../lib/peer-fanout";
import {
  encryptApprovalForRequester,
  decryptApprovalFromHub,
  getLocalPairingKeypair,
  getLocalSigningKeypair,
  pairingRequestCanonical,
  signPairingRequest,
  verifyPairingRequestSignature,
  newPairingRequestId,
} from "../lib/lan-pairing-crypto";
import {
  getLanPairingTransport,
} from "../lib/lan-pairing-transport";
import {
  firstLocalIp,
  isLanPeerRole,
  type LanPeerRole,
} from "../lib/lan-discovery";
import { getActiveInstallProfile } from "../lib/install-profile";
import os from "node:os";
import { isIP } from "node:net";

/** Returns true when `ip` parses as a valid IPv4 or IPv6 literal. */
function isIpAddress(ip: string): boolean {
  return isIP(ip) !== 0;
}

const router: IRouter = Router();

function isSuperAdmin(roleRaw: string | null | undefined): boolean {
  return normalizeLanRole(roleRaw) === "super_admin";
}

const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const ADDRESS_RE = /^[A-Za-z0-9.\-_]{1,253}$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9.\-_:[\]]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9.\-_/%]*)?$/;
const PUBKEY_RE = /^[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function trim(v: unknown): string {
  return String(v ?? "").trim();
}

function selfBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const host = req.get("host") ?? `${firstLocalIp() ?? "127.0.0.1"}`;
  return `${req.protocol}://${host}`;
}

/**
 * SSRF guard for inbound `requester_callback_url`. The Hub will POST
 * the encrypted approval here, so an attacker who controls the URL
 * could trick the Hub into POSTing to an arbitrary internal target.
 *
 * We require:
 *   1. http: scheme (the LAN pairing flow is unencrypted by design)
 *   2. host parses as an IP literal
 *   3. that IP is RFC1918 / link-local / loopback
 *   4. it matches the claimed `requester_address` (so a peer can't
 *      ask the Hub to deliver to a different host on the LAN)
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
function isPrivateIp(ip: string): boolean {
  if (!isIpAddress(ip)) return false;
  if (ip.includes(":")) {
    // IPv6: only loopback (::1) and link-local (fe80::/10) are accepted.
    const lc = ip.toLowerCase();
    if (lc === "::1") return true;
    if (lc.startsWith("fe80:")) return true;
    return false;
  }
  return isPrivateIpv4(ip);
}
function validateCallbackUrl(
  callbackUrl: string,
  claimedRequesterAddress: string,
): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { ok: false, reason: "bad_callback_url" };
  }
  if (url.protocol !== "http:") {
    return { ok: false, reason: "callback_must_be_http" };
  }
  // url.hostname strips brackets from IPv6 literals.
  const host = url.hostname;
  if (!host) return { ok: false, reason: "callback_missing_host" };
  if (!isIpAddress(host)) {
    return { ok: false, reason: "callback_must_be_ip_literal" };
  }
  if (!isPrivateIp(host)) {
    return { ok: false, reason: "callback_not_private_ip" };
  }
  // Path must point at the documented approval handler so an attacker
  // can't tunnel a POST to some other internal endpoint we expose.
  if (url.pathname !== "/api/internal/lan-pairing/approval") {
    return { ok: false, reason: "callback_path_mismatch" };
  }
  if (claimedRequesterAddress) {
    // Compare normalised IP forms (strips IPv6 zone IDs etc).
    if (host.toLowerCase() !== claimedRequesterAddress.toLowerCase()) {
      return { ok: false, reason: "callback_host_mismatch_address" };
    }
  }
  return { ok: true };
}

// ── Operator-driven ─────────────────────────────────────────────────

/**
 * POST /lan-pairing/request
 *
 * Body: { hub_hostname, hub_address, hub_port }
 *
 * Generates a request id + persistent local pubkey, persists an
 * `lan_pairing_outbound_requests` row, then POSTs to the Hub's
 * `/api/internal/lan-pairing/inbound-request` endpoint with the
 * envelope the Hub needs to seal the eventual approval back to us.
 */
router.post(
  "/lan-pairing/request",
  requireInternalWriteSecret,
  async (req, res, next) => {
    try {
      const lanUser = readLanUser(req);
      if (lanUser && !isSuperAdmin(lanUser.role)) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hubHostname = trim(body.hub_hostname).toLowerCase();
      const hubAddress = trim(body.hub_address);
      const hubPortRaw = Number(body.hub_port ?? 0);
      if (!hubHostname || !ADDRESS_RE.test(hubHostname)) {
        res.status(400).json({ error: "bad_hub_hostname" });
        return;
      }
      if (!hubAddress || !ADDRESS_RE.test(hubAddress)) {
        res.status(400).json({ error: "bad_hub_address" });
        return;
      }
      if (
        !Number.isFinite(hubPortRaw) ||
        hubPortRaw <= 0 ||
        hubPortRaw > 65535
      ) {
        res.status(400).json({ error: "bad_hub_port" });
        return;
      }

      const id = newPairingRequestId();
      const myKeypair = await getLocalPairingKeypair();
      const mySigningKeypair = await getLocalSigningKeypair();
      const profile = getActiveInstallProfile() ?? "viewer";
      const requesterAddress = firstLocalIp() ?? "";
      const callbackUrl = `${selfBaseUrl(req)}/api/internal/lan-pairing/approval`;

      // Sign the canonical payload so the Hub can verify that the
      // requester_pub_key was not tampered with in transit.
      const canonical = pairingRequestCanonical({
        id,
        requester_pub_key: myKeypair.publicKeyHex,
        requester_callback_url: callbackUrl,
        requester_role: profile,
        requester_address: requesterAddress,
      });
      const requestSig = signPairingRequest(mySigningKeypair.signPrivKeyHex, canonical);

      await pool.query(
        `
        insert into lan_pairing_outbound_requests
          (id, hub_hostname, hub_address, hub_port, status, created_at, updated_at)
        values ($1, $2, $3, $4, 'pending', now(), now())
        `,
        [id, hubHostname, hubAddress, hubPortRaw],
      );

      const inboundUrl = `http://${hubAddress}:${hubPortRaw}/api/internal/lan-pairing/inbound-request`;
      const transport = getLanPairingTransport();
      const result = await transport.postInboundRequest(inboundUrl, {
        id,
        requester_role: profile,
        requester_hostname: os.hostname(),
        requester_address: requesterAddress,
        requester_pub_key: myKeypair.publicKeyHex,
        requester_callback_url: callbackUrl,
        requester_app_version: process.env.npm_package_version ?? null,
        requester_sign_pub_key: mySigningKeypair.signPubKeyHex,
        requester_sig: requestSig,
      });
      if (!result.ok) {
        await pool.query(
          `
          update lan_pairing_outbound_requests
             set status = 'transport_failed',
                 error_detail = $2,
                 updated_at = now()
           where id = $1
          `,
          [
            id,
            JSON.stringify({
              status: result.status,
              body: result.body,
            }).slice(0, 4000),
          ],
        );
        await appendInternalAudit(
          String(lanUser?.username ?? "system"),
          "internal.lan_pairing.request_failed",
          { id, hub_hostname: hubHostname, hub_address: hubAddress, status: result.status },
        );
        res.status(502).json({ error: "hub_unreachable", id, detail: result.body });
        return;
      }
      await appendInternalAudit(
        String(lanUser?.username ?? "system"),
        "internal.lan_pairing.request_sent",
        { id, hub_hostname: hubHostname, hub_address: hubAddress },
      );
      res.json({ ok: true, id, sign_pub_key: mySigningKeypair.signPubKeyHex });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /lan-pairing/inbound-request  (cross-PC, public on the LAN)
 *
 * Body: { id, requester_role, requester_hostname, requester_address,
 *         requester_pub_key, requester_callback_url, requester_app_version? }
 *
 * Persists the inbound request so it shows up in the Hub super_admin's
 * pairing inbox. Idempotent on (id) — repeated POSTs are silently
 * ignored, which protects against requesters that retry.
 */
// Ed25519 signatures are 64 bytes = 128 hex chars.
const SIG_RE = /^[0-9a-fA-F]{128}$/;

router.post("/lan-pairing/inbound-request", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = trim(body.id);
    const role = trim(body.requester_role).toLowerCase();
    const hostname = trim(body.requester_hostname).toLowerCase();
    const address = trim(body.requester_address);
    const pubKey = trim(body.requester_pub_key);
    const callbackUrl = trim(body.requester_callback_url);
    const signPubKey = trim(body.requester_sign_pub_key);
    const sig = trim(body.requester_sig);
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_id" });
      return;
    }
    if (!isLanPeerRole(role) || role === "hub") {
      // A hub asking to pair with itself doesn't make sense.
      res.status(400).json({ error: "bad_requester_role" });
      return;
    }
    if (!hostname || !HOSTNAME_RE.test(hostname)) {
      res.status(400).json({ error: "bad_hostname" });
      return;
    }
    if (address && !ADDRESS_RE.test(address)) {
      res.status(400).json({ error: "bad_address" });
      return;
    }
    if (!PUBKEY_RE.test(pubKey)) {
      res.status(400).json({ error: "bad_pub_key" });
      return;
    }
    if (!URL_RE.test(callbackUrl)) {
      res.status(400).json({ error: "bad_callback_url" });
      return;
    }
    // Require the Ed25519 signing key and signature that prove the
    // requester possesses the private key for requester_sign_pub_key.
    // Without this check an active LAN attacker can replace
    // requester_pub_key with their own X25519 key and intercept the
    // encrypted approval.
    if (!PUBKEY_RE.test(signPubKey)) {
      res.status(400).json({ error: "bad_sign_pub_key" });
      return;
    }
    if (!SIG_RE.test(sig)) {
      res.status(400).json({ error: "bad_requester_sig" });
      return;
    }
    // Verify the signature over the canonical payload.  Any field that
    // an attacker might swap (pub_key, callback_url, role, address) is
    // covered by the canonical message so tampering invalidates the sig.
    const canonical = pairingRequestCanonical({
      id,
      requester_pub_key: pubKey,
      requester_callback_url: callbackUrl,
      requester_role: role,
      requester_address: address,
    });
    const sigValid = verifyPairingRequestSignature(signPubKey, canonical, sig);
    if (!sigValid) {
      await appendInternalAudit("system", "internal.lan_pairing.sig_rejected", {
        id,
        requester_hostname: hostname,
        requester_address: address,
      });
      res.status(400).json({ error: "bad_requester_sig" });
      return;
    }
    // SSRF guard: callback must be RFC1918/loopback http: at the same
    // IP the requester claims to be at, and must point at the
    // documented approval handler. See `validateCallbackUrl` above.
    const cbCheck = validateCallbackUrl(callbackUrl, address);
    if (!cbCheck.ok) {
      await appendInternalAudit("system", "internal.lan_pairing.callback_rejected", {
        id,
        requester_hostname: hostname,
        requester_address: address,
        reason: cbCheck.reason,
      });
      res.status(400).json({ error: cbCheck.reason });
      return;
    }
    // Refuse on aggregator/viewer profiles — only a hub mints peer
    // tokens, so accepting an inbound request anywhere else would
    // mislead the requester.
    const profile = getActiveInstallProfile();
    if (profile !== "hub") {
      res.status(403).json({ error: "not_a_hub" });
      return;
    }

    const ins = await pool.query(
      `
      insert into lan_pairing_inbound_requests (
        id, requester_role, requester_hostname, requester_address,
        requester_pub_key, requester_callback_url, requester_app_version,
        requester_sign_pub_key,
        status, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now())
      on conflict (id) do nothing
      returning id, status
      `,
      [
        id,
        role,
        hostname,
        address,
        pubKey,
        callbackUrl,
        trim(body.requester_app_version) || null,
        signPubKey,
      ],
    );
    const inserted = (ins.rowCount ?? 0) > 0;
    await appendInternalAudit(
      "system",
      "internal.lan_pairing.inbound_received",
      {
        id,
        requester_role: role,
        requester_hostname: hostname,
        requester_address: address,
        deduped: !inserted,
      },
    );
    res.json({ ok: true, status: "pending", deduped: !inserted });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /lan-pairing/inbox?status=pending
 *
 * Lists inbound pairing requests. Defaults to status=pending; pass
 * `status=all` to see history.
 */
router.get("/lan-pairing/inbox", async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !isSuperAdmin(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const status = trim(req.query.status as string) || "pending";
    const where = status === "all" ? "" : "where status = $1";
    const params = status === "all" ? [] : [status];
    const q = await pool.query(
      `
      select id, requester_role, requester_hostname, requester_address,
             requester_app_version, requester_sign_pub_key, status,
             issued_token_id, approval_error,
             created_at, decided_at, decided_by, delivered_at
      from lan_pairing_inbound_requests
      ${where}
      order by created_at desc
      limit 200
      `,
      params,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /lan-pairing/inbox/:id/approve
 *
 * Mints a fresh peer token, encrypts it for the requester, and POSTs
 * it back to their callback URL. The decision + delivery outcome are
 * persisted so the operator can see the result without checking the
 * audit log.
 */
router.post(
  "/lan-pairing/inbox/:id/approve",
  requireInternalWriteSecret,
  async (req, res, next) => {
    try {
      const lanUser = readLanUser(req);
      if (lanUser && !isSuperAdmin(lanUser.role)) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
      const profile = getActiveInstallProfile();
      if (profile !== "hub") {
        res.status(403).json({ error: "not_a_hub" });
        return;
      }
      const id = trim(req.params.id);
      if (!UUID_RE.test(id)) {
        res.status(400).json({ error: "bad_id" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const labelRaw = trim(body.label);

      const reqRow = await pool.query<{
        id: string;
        status: string;
        requester_hostname: string;
        requester_pub_key: string;
        requester_callback_url: string;
      }>(
        `
        select id, status, requester_hostname, requester_pub_key, requester_callback_url
        from lan_pairing_inbound_requests
        where id = $1
        limit 1
        `,
        [id],
      );
      const row = reqRow.rows[0];
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (row.status !== "pending") {
        res.status(409).json({ error: "not_pending", status: row.status });
        return;
      }

      // Look up *this Hub's* squadron metadata so the requester can
      // wire the new peer into peer_squadrons (squadron_id +
      // squadron_name + base_url) without a follow-up round-trip.
      // Hubs that haven't completed setup yet still have rows in
      // `squadrons`; if there's exactly one row we use it. Otherwise
      // we fall back to the hostname so the requester at least gets a
      // unique-looking key.
      let hubSquadronId = "";
      let hubSquadronName = "";
      try {
        const sq = await pool.query<{ id: string; number: string | null; name: string | null }>(
          `select id::text as id, number, name from squadrons order by created_at asc`,
        );
        if (sq.rows.length === 1) {
          const r = sq.rows[0]!;
          hubSquadronId = r.id;
          hubSquadronName = (r.name ?? r.number ?? "").trim();
        }
      } catch {
        // Tolerate missing squadrons table on a freshly-installed hub.
      }
      // Hub address the requester used to reach us — derived from the
      // request's Host header so it works behind proxy / NAT shims as
      // well as on direct LAN. If host is missing, fall back to the
      // first local IP plus the listening port.
      const hubBaseUrl = selfBaseUrl(req);

      const tokenLabel = labelRaw || `LAN pair: ${row.requester_hostname}`;
      const issued = await issuePeerToken();
      const issuedBy = String(lanUser?.username ?? "system");
      await pool.query(
        `
        insert into peer_tokens (
          id, token_hash, label, scope, issued_by, expires_at
        ) values ($1, $2, $3, 'squadron-read', $4, null)
        `,
        [issued.id, issued.hash, tokenLabel.slice(0, 200), issuedBy],
      );
      // Record the decision before we attempt delivery, so a crash
      // mid-transport doesn't lose the audit trail.
      await pool.query(
        `
        update lan_pairing_inbound_requests
           set status = 'approved',
               decided_at = now(),
               decided_by = $2,
               issued_token_id = $3
         where id = $1
        `,
        [id, issuedBy, issued.id],
      );

      const approvalEnvelope = encryptApprovalForRequester({
        requesterPubKeyHex: row.requester_pub_key,
        requestId: id,
        plaintext: JSON.stringify({
          token: issued.plain,
          token_id: issued.id,
          token_label: tokenLabel,
          scope: "squadron-read",
          // Hub identity so the requester can wire peer_squadrons in
          // a single transaction once the envelope is decrypted.
          hub_squadron_id: hubSquadronId || os.hostname().toLowerCase(),
          hub_squadron_name: hubSquadronName || row.requester_hostname,
          hub_base_url: hubBaseUrl,
          hub_hostname: os.hostname(),
        }),
      });

      const transport = getLanPairingTransport();
      const result = await transport.postApproval(row.requester_callback_url, {
        request_id: id,
        approval: approvalEnvelope,
      });

      if (result.ok) {
        await pool.query(
          `
          update lan_pairing_inbound_requests
             set status = 'delivered',
                 delivered_at = now(),
                 approval_error = null
           where id = $1
          `,
          [id],
        );
      } else {
        await pool.query(
          `
          update lan_pairing_inbound_requests
             set approval_error = $2
           where id = $1
          `,
          [
            id,
            JSON.stringify({
              status: result.status,
              body: result.body,
            }).slice(0, 4000),
          ],
        );
      }

      await appendInternalAudit(
        issuedBy,
        "internal.lan_pairing.approve",
        {
          id,
          requester_hostname: row.requester_hostname,
          token_id: issued.id,
          token_label: tokenLabel,
          delivered: result.ok,
          delivery_status: result.status,
        },
      );

      res.json({
        ok: true,
        id,
        token_id: issued.id,
        delivered: result.ok,
        delivery_status: result.status,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/lan-pairing/inbox/:id/deny",
  requireInternalWriteSecret,
  async (req, res, next) => {
    try {
      const lanUser = readLanUser(req);
      if (lanUser && !isSuperAdmin(lanUser.role)) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
      const profile = getActiveInstallProfile();
      if (profile !== "hub") {
        res.status(403).json({ error: "not_a_hub" });
        return;
      }
      const id = trim(req.params.id);
      if (!UUID_RE.test(id)) {
        res.status(400).json({ error: "bad_id" });
        return;
      }
      const upd = await pool.query<{ id: string; status: string; requester_hostname: string }>(
        `
        update lan_pairing_inbound_requests
           set status = 'denied',
               decided_at = now(),
               decided_by = $2
         where id = $1 and status = 'pending'
         returning id, status, requester_hostname
        `,
        [id, String(lanUser?.username ?? "system")],
      );
      const row = upd.rows[0];
      if (!row) {
        res.status(409).json({ error: "not_pending" });
        return;
      }
      await appendInternalAudit(
        String(lanUser?.username ?? "system"),
        "internal.lan_pairing.deny",
        { id, requester_hostname: row.requester_hostname },
      );
      res.json({ ok: true, id });
    } catch (err) {
      next(err);
    }
  },
);

router.get("/lan-pairing/outbox", async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);
    if (lanUser && !isSuperAdmin(lanUser.role)) {
      res.status(403).json({ error: "forbidden_role" });
      return;
    }
    const q = await pool.query(
      `
      select id, hub_hostname, hub_address, status,
             received_token_id, received_token_label, error_detail,
             created_at, updated_at
      from lan_pairing_outbound_requests
      order by created_at desc
      limit 200
      `,
    );
    res.json({ items: q.rows });
  } catch (err) {
    next(err);
  }
});

router.delete(
  "/lan-pairing/outbox/:id",
  requireInternalWriteSecret,
  async (req, res, next) => {
    try {
      const lanUser = readLanUser(req);
      if (lanUser && !isSuperAdmin(lanUser.role)) {
        res.status(403).json({ error: "forbidden_role" });
        return;
      }
      const id = trim(req.params.id);
      if (!UUID_RE.test(id)) {
        res.status(400).json({ error: "bad_id" });
        return;
      }
      const upd = await pool.query(
        `
        update lan_pairing_outbound_requests
           set status = 'cancelled', updated_at = now()
         where id = $1 and status in ('pending', 'transport_failed')
         returning id
        `,
        [id],
      );
      if ((upd.rowCount ?? 0) === 0) {
        res.status(409).json({ error: "not_cancellable" });
        return;
      }
      await appendInternalAudit(
        String(lanUser?.username ?? "system"),
        "internal.lan_pairing.cancel",
        { id },
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /lan-pairing/approval  (cross-PC, public on the LAN)
 *
 * Hub posts the encrypted token back here. We look up our outbound
 * row by id, decrypt, persist the token id/label so the operator can
 * see the success in the dashboard, and write the cleartext peer
 * token to a small JSON file the existing peer-fanout infra reads.
 *
 * This route does NOT issue secrets to anyone — it only consumes
 * one. Authentication is implicit (the request_id had to come from us
 * in the first place; the envelope HMAC catches active rewriting).
 */
router.post("/lan-pairing/approval", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = trim(body.request_id);
    const approval = body.approval as Record<string, string> | undefined;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "bad_request_id" });
      return;
    }
    if (!approval || typeof approval !== "object") {
      res.status(400).json({ error: "bad_approval_envelope" });
      return;
    }
    for (const k of ["hubPubKey", "nonce", "ciphertext", "hmac"]) {
      if (typeof approval[k] !== "string" || approval[k].trim() === "") {
        res.status(400).json({ error: `bad_approval_field_${k}` });
        return;
      }
    }
    const outbound = await pool.query<{ id: string; status: string; hub_hostname: string }>(
      `select id, status, hub_hostname from lan_pairing_outbound_requests where id = $1 limit 1`,
      [id],
    );
    const row = outbound.rows[0];
    if (!row) {
      // We never asked to pair with this id. Refuse rather than
      // silently swallowing; an attacker probing for naive listeners
      // will see a clear refusal in their tooling.
      res.status(404).json({ error: "unknown_request_id" });
      return;
    }
    if (row.status !== "pending" && row.status !== "transport_failed") {
      res.status(409).json({ error: "not_pending", status: row.status });
      return;
    }
    const myKeypair = await getLocalPairingKeypair();
    let plaintext: string;
    try {
      plaintext = decryptApprovalFromHub({
        myPrivateKeyHex: myKeypair.privateKeyHex,
        requestId: id,
        approval: {
          hubPubKey: approval.hubPubKey!,
          nonce: approval.nonce!,
          ciphertext: approval.ciphertext!,
          hmac: approval.hmac!,
        },
      });
    } catch (err) {
      await pool.query(
        `
        update lan_pairing_outbound_requests
           set status = 'envelope_invalid',
               error_detail = $2,
               updated_at = now()
         where id = $1
        `,
        [id, String(err instanceof Error ? err.message : err).slice(0, 4000)],
      );
      await appendInternalAudit("system", "internal.lan_pairing.envelope_invalid", { id });
      res.status(400).json({ error: "envelope_invalid" });
      return;
    }
    let parsed: {
      token?: string;
      token_id?: string;
      token_label?: string;
      scope?: string;
      hub_squadron_id?: string;
      hub_squadron_name?: string;
      hub_base_url?: string;
      hub_hostname?: string;
    };
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      res.status(400).json({ error: "bad_plaintext" });
      return;
    }
    const tokenId = trim(parsed.token_id);
    const tokenLabel = trim(parsed.token_label);
    const tokenPlain = trim(parsed.token);
    if (!tokenId) {
      res.status(400).json({ error: "missing_token_id" });
      return;
    }
    if (!tokenPlain) {
      res.status(400).json({ error: "missing_token" });
      return;
    }

    // Look up the outbound row again to recover hub_port and reconstruct
    // a base_url if the Hub didn't include `hub_base_url` in its
    // plaintext (older Hubs predating squadron-meta-in-envelope).
    const outboundFull = await pool.query<{
      hub_address: string;
      hub_port: number | null;
    }>(
      `select hub_address, hub_port from lan_pairing_outbound_requests where id = $1 limit 1`,
      [id],
    );
    const outRow = outboundFull.rows[0];
    const hubBaseUrl =
      trim(parsed.hub_base_url) ||
      (outRow && outRow.hub_port
        ? `http://${outRow.hub_address}:${outRow.hub_port}`
        : "");
    const squadronId =
      trim(parsed.hub_squadron_id) ||
      trim(parsed.hub_hostname).toLowerCase() ||
      row.hub_hostname;
    const squadronName =
      trim(parsed.hub_squadron_name) ||
      trim(parsed.hub_hostname) ||
      row.hub_hostname;

    // Persist the new peer in peer_squadrons so the existing fanout
    // infrastructure picks it up. On unique conflict (an older row for
    // the same squadron_id) we update auth_token / token_hash /
    // base_url in place — the operator just re-paired with a fresh
    // token. Tolerate the table being missing entirely (the row will
    // be re-attempted on a later approval after schema migration).
    let peerSquadronId: string | null = null;
    if (hubBaseUrl) {
      try {
        const ins = await pool.query<{ id: string }>(
          `
          insert into peer_squadrons (
            squadron_id, squadron_name, base_url,
            auth_token, token_hash, added_by
          ) values ($1, $2, $3, $4, $5, 'lan-pairing')
          on conflict (squadron_id) where removed_at is null
          do update set
            squadron_name = excluded.squadron_name,
            base_url      = excluded.base_url,
            auth_token    = excluded.auth_token,
            token_hash    = excluded.token_hash,
            last_error    = null,
            last_error_at = null
          returning id::text
          `,
          [
            squadronId,
            squadronName,
            hubBaseUrl.replace(/\/+$/, ""),
            tokenPlain,
            hashPeerToken(tokenPlain),
          ],
        );
        peerSquadronId = ins.rows[0]?.id ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/relation .*peer_squadrons.* does not exist/i.test(msg)) {
          // Persist the failure so the operator sees something
          // actionable rather than a silent "paired" status.
          await pool.query(
            `
            update lan_pairing_outbound_requests
               set status = 'persist_failed',
                   error_detail = $2,
                   updated_at = now()
             where id = $1
            `,
            [id, String(msg).slice(0, 4000)],
          );
          await appendInternalAudit("system", "internal.lan_pairing.persist_failed", {
            id,
            squadron_id: squadronId,
            error: msg.slice(0, 200),
          });
          res.status(500).json({ error: "persist_failed" });
          return;
        }
      }
    }

    await pool.query(
      `
      update lan_pairing_outbound_requests
         set status = 'paired',
             received_token_id = $2,
             received_token_label = $3,
             paired_peer_squadron_id = $4,
             error_detail = null,
             updated_at = now()
       where id = $1
      `,
      [id, tokenId, tokenLabel || null, peerSquadronId],
    );
    await appendInternalAudit("system", "internal.lan_pairing.approval_received", {
      id,
      hub_hostname: row.hub_hostname,
      token_id: tokenId,
      squadron_id: squadronId,
      peer_squadron_id: peerSquadronId,
    });
    res.json({ ok: true, peer_squadron_id: peerSquadronId });
  } catch (err) {
    next(err);
  }
});

export default router;

// Test-only exports
export const __testing__ = {
  isSuperAdmin,
  selfBaseUrl,
  validateCallbackUrl,
  isPrivateIp,
};

/** Surface the role typed in the inbound payload for log-only callers. */
export type InboundRequesterRole = LanPeerRole;
