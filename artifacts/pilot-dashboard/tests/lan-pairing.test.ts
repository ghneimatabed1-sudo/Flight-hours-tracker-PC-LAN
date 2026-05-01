// Tests for the magic LAN pairing crypto + transport
// (`api-server/src/lib/lan-pairing-crypto.ts` and
// `lan-pairing-transport.ts`).
//
// Coverage:
//   - generateKeypair → encryptApprovalForRequester →
//     decryptApprovalFromHub round-trip recovers the cleartext
//     peer-token plaintext byte-for-byte.
//   - Tampering with any field of the envelope (hubPubKey, nonce,
//     ciphertext, hmac, request_id) makes decrypt throw with the
//     expected error code so a MITM cannot silently substitute a
//     different token.
//   - The HTTP transport (httpLanPairingTransport) can be replaced
//     in-process via setLanPairingTransport, which the routes use to
//     simulate cross-PC delivery in tests without spinning up a
//     second http.Server.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:lan-pairing

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateKeypair,
  encryptApprovalForRequester,
  decryptApprovalFromHub,
  newPairingRequestId,
  _resetCachedKeypairForTests,
  type EncryptedApproval,
} from "../../api-server/src/lib/lan-pairing-crypto";
import {
  httpLanPairingTransport,
  setLanPairingTransport,
  getLanPairingTransport,
  _resetLanPairingTransportForTests,
  type LanPairingTransport,
} from "../../api-server/src/lib/lan-pairing-transport";
import { __testing__ as lanPairingRouteTesting } from "../../api-server/src/routes/internal-lan-pairing";

test("generateKeypair returns 32-byte hex private + public", () => {
  const kp = generateKeypair();
  assert.match(kp.privateKeyHex, /^[0-9a-f]{64}$/);
  assert.match(kp.publicKeyHex, /^[0-9a-f]{64}$/);
  // Distinct keys on every call.
  const kp2 = generateKeypair();
  assert.notEqual(kp.privateKeyHex, kp2.privateKeyHex);
  assert.notEqual(kp.publicKeyHex, kp2.publicKeyHex);
});

test("newPairingRequestId returns a UUID v4 shaped string", () => {
  const id = newPairingRequestId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  assert.notEqual(newPairingRequestId(), id);
});

test("encrypt → decrypt round-trip recovers the peer-token plaintext", () => {
  const requester = generateKeypair();
  const requestId = newPairingRequestId();
  const plaintext = JSON.stringify({
    token_id: "11111111-1111-1111-1111-111111111111",
    token_label: "wing-pc-02",
    plain: "ht_" + "a".repeat(40),
  });
  const env = encryptApprovalForRequester({
    requesterPubKeyHex: requester.publicKeyHex,
    requestId,
    plaintext,
  });
  // Envelope shape sanity.
  assert.match(env.hubPubKey, /^[0-9a-f]{64}$/);
  assert.match(env.nonce, /^[0-9a-f]{24}$/);
  assert.match(env.ciphertext, /^[0-9a-f]+$/);
  assert.match(env.hmac, /^[0-9a-f]{64}$/);
  // Decrypt must recover plaintext bit-for-bit.
  const recovered = decryptApprovalFromHub({
    myPrivateKeyHex: requester.privateKeyHex,
    requestId,
    approval: env,
  });
  assert.equal(recovered, plaintext);
});

test("decrypt rejects HMAC tampering", () => {
  const requester = generateKeypair();
  const requestId = newPairingRequestId();
  const env = encryptApprovalForRequester({
    requesterPubKeyHex: requester.publicKeyHex,
    requestId,
    plaintext: "secret",
  });
  // Flip a single bit of the HMAC.
  const flipped: EncryptedApproval = {
    ...env,
    hmac:
      env.hmac.slice(0, env.hmac.length - 2) +
      (env.hmac.endsWith("0") ? "1f" : "00"),
  };
  assert.throws(
    () =>
      decryptApprovalFromHub({
        myPrivateKeyHex: requester.privateKeyHex,
        requestId,
        approval: flipped,
      }),
    /approval_envelope_tampered/,
  );
});

test("decrypt rejects requestId substitution (envelope binds the id)", () => {
  const requester = generateKeypair();
  const requestId = newPairingRequestId();
  const env = encryptApprovalForRequester({
    requesterPubKeyHex: requester.publicKeyHex,
    requestId,
    plaintext: "secret",
  });
  // Try to replay the envelope under a different request id.
  const otherId = newPairingRequestId();
  assert.throws(
    () =>
      decryptApprovalFromHub({
        myPrivateKeyHex: requester.privateKeyHex,
        requestId: otherId,
        approval: env,
      }),
    /approval_envelope_tampered/,
  );
});

test("decrypt rejects ciphertext tampering", () => {
  const requester = generateKeypair();
  const requestId = newPairingRequestId();
  const env = encryptApprovalForRequester({
    requesterPubKeyHex: requester.publicKeyHex,
    requestId,
    plaintext: "the original token plain text",
  });
  const tampered: EncryptedApproval = {
    ...env,
    // Bit-flip a byte well inside the ciphertext (leaves length so
    // the GCM auth-tag is still 16B, but bumps the HMAC mismatch).
    ciphertext:
      env.ciphertext.slice(0, 4) +
      (env.ciphertext[4] === "0" ? "f" : "0") +
      env.ciphertext.slice(5),
  };
  assert.throws(
    () =>
      decryptApprovalFromHub({
        myPrivateKeyHex: requester.privateKeyHex,
        requestId,
        approval: tampered,
      }),
    /approval_envelope_tampered/,
  );
});

test("decrypt rejects substituted ephemeral hub pub key", () => {
  const requester = generateKeypair();
  const attacker = generateKeypair();
  const requestId = newPairingRequestId();
  const env = encryptApprovalForRequester({
    requesterPubKeyHex: requester.publicKeyHex,
    requestId,
    plaintext: "secret",
  });
  // Swap in attacker public key — HMAC is over the original key, so
  // the envelope must be rejected.
  const swapped: EncryptedApproval = { ...env, hubPubKey: attacker.publicKeyHex };
  assert.throws(
    () =>
      decryptApprovalFromHub({
        myPrivateKeyHex: requester.privateKeyHex,
        requestId,
        approval: swapped,
      }),
    /approval_envelope_tampered/,
  );
});

test("setLanPairingTransport allows tests to inject a fake transport", async () => {
  // Default is the real HTTP transport.
  assert.equal(getLanPairingTransport(), httpLanPairingTransport);

  const calls: Array<{
    fn: string;
    arg: unknown;
  }> = [];
  const fake: LanPairingTransport = {
    async postInboundRequest(target, body) {
      calls.push({ fn: "postInboundRequest", arg: { target, body } });
      return { ok: true, status: 202, body: { id: "abc" } };
    },
    async postApproval(callbackUrl, body) {
      calls.push({ fn: "postApproval", arg: { callbackUrl, body } });
      return { ok: true, status: 202, body: {} };
    },
  };
  setLanPairingTransport(fake);
  try {
    const t = getLanPairingTransport();
    const ack = await t.postInboundRequest(
      "http://10.0.0.5:80/api/internal/lan-pairing/inbound-request",
      { id: "11111111-1111-1111-1111-111111111111" },
    );
    assert.equal(ack.ok, true);
    assert.equal(ack.status, 202);
    assert.deepEqual(ack.body, { id: "abc" });

    const ackApproval = await t.postApproval(
      "http://10.0.0.6:80/api/internal/lan-pairing/approval",
      { request_id: "x" },
    );
    assert.equal(ackApproval.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.fn, "postInboundRequest");
    assert.equal(calls[1]!.fn, "postApproval");
  } finally {
    _resetLanPairingTransportForTests();
    _resetCachedKeypairForTests();
  }
  // After reset we are back to the real http transport singleton.
  assert.equal(getLanPairingTransport(), httpLanPairingTransport);
});

// ── SSRF guard for /lan-pairing/inbound-request callback URL ──────────

const { validateCallbackUrl, isPrivateIp } = lanPairingRouteTesting;

test("isPrivateIp accepts RFC1918 / loopback / link-local, rejects public IPs", () => {
  // Acceptable
  for (const ip of [
    "10.0.0.1", "10.255.255.254",
    "172.16.0.1", "172.31.255.254",
    "192.168.1.1", "192.168.0.254",
    "127.0.0.1",
    "169.254.1.1",
    "::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateIp(ip), true, `expected ${ip} to be private`);
  }
  // Public / not allowed
  for (const ip of [
    "8.8.8.8", "1.1.1.1",
    "172.32.0.1", "172.15.255.254",
    "169.255.0.1",
    "192.169.0.1", "11.0.0.1",
    "2001:db8::1",
    "not-an-ip",
    "",
  ]) {
    assert.equal(isPrivateIp(ip), false, `expected ${ip} to be rejected`);
  }
});

test("validateCallbackUrl accepts a well-formed RFC1918 callback at the matching address", () => {
  const ok = validateCallbackUrl(
    "http://10.0.0.42:3847/api/internal/lan-pairing/approval",
    "10.0.0.42",
  );
  assert.deepEqual(ok, { ok: true });
});

test("validateCallbackUrl rejects https:, public hosts, wrong path, host mismatch", () => {
  // https:// is not allowed (LAN flow is plain HTTP)
  assert.deepEqual(
    validateCallbackUrl("https://10.0.0.5/api/internal/lan-pairing/approval", "10.0.0.5"),
    { ok: false, reason: "callback_must_be_http" },
  );
  // hostname (not literal IP) is rejected
  assert.deepEqual(
    validateCallbackUrl("http://attacker.example/api/internal/lan-pairing/approval", "10.0.0.5"),
    { ok: false, reason: "callback_must_be_ip_literal" },
  );
  // Public IP is rejected
  assert.deepEqual(
    validateCallbackUrl("http://8.8.8.8/api/internal/lan-pairing/approval", "8.8.8.8"),
    { ok: false, reason: "callback_not_private_ip" },
  );
  // Wrong path is rejected
  assert.deepEqual(
    validateCallbackUrl("http://10.0.0.5/api/admin/wipe", "10.0.0.5"),
    { ok: false, reason: "callback_path_mismatch" },
  );
  // Host vs claimed-address mismatch is rejected
  assert.deepEqual(
    validateCallbackUrl(
      "http://10.0.0.99/api/internal/lan-pairing/approval",
      "10.0.0.5",
    ),
    { ok: false, reason: "callback_host_mismatch_address" },
  );
  // Malformed URL is rejected
  assert.deepEqual(
    validateCallbackUrl("not-a-url", "10.0.0.5"),
    { ok: false, reason: "bad_callback_url" },
  );
});
