/**
 * Inter-PC HTTP transport for the LAN pairing flow (Task T-R, Step 4).
 *
 * Two outbound calls happen during a pairing:
 *
 *  1. The *requester* (Aggregator/Viewer) POSTs its inbound request
 *     to the *Hub* at `POST /api/internal/lan-pairing/inbound-request`.
 *  2. The *Hub* POSTs an encrypted approval back to the requester at
 *     `POST /api/internal/lan-pairing/approval`.
 *
 * Both calls cross the LAN unauthenticated (mDNS is unauthenticated
 * by design) but the bodies are tied together by a UUID and the
 * approval payload is sealed with the requester's persistent X25519
 * pubkey, so an active LAN attacker cannot replay or rewrite either
 * call without the operator noticing in the dialog.
 *
 * The transport is wrapped in this single module so tests can swap
 * in an in-process implementation without exercising the real fetch
 * stack.
 */

export type LanPairingTransport = {
  postInboundRequest(
    url: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }>;
  postApproval(
    url: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }>;
};

const DEFAULT_TIMEOUT_MS = 8_000;

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: "transport_error", message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    clearTimeout(timer);
  }
}

export const httpLanPairingTransport: LanPairingTransport = {
  postInboundRequest(url, body) {
    return postJson(url, body);
  },
  postApproval(url, body) {
    return postJson(url, body);
  },
};

let __activeTransport: LanPairingTransport = httpLanPairingTransport;

export function setLanPairingTransport(t: LanPairingTransport): void {
  __activeTransport = t;
}

export function getLanPairingTransport(): LanPairingTransport {
  return __activeTransport;
}

export function _resetLanPairingTransportForTests(): void {
  __activeTransport = httpLanPairingTransport;
}
