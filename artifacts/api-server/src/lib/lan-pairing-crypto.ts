/**
 * LAN one-click pairing crypto (Task T-R, Step 4).
 *
 * The Hub super_admin's approval payload contains a freshly-issued
 * peer token that grants the requester read-only access to the hub's
 * `/api/peer/*` surface. We encrypt that token end-to-end so it
 * never crosses the LAN in cleartext, even though both PCs are on
 * the same trusted segment.
 *
 * Scheme: ECDH(X25519) → HKDF-SHA256 → AES-256-GCM. Each PC keeps a
 * persistent X25519 keypair in `lan_pairing_keypair` (raw SQL, never
 * Drizzle) so a reboot doesn't invalidate an outstanding pairing
 * request. Approval payloads carry an ephemeral hub pubkey alongside
 * the AES-GCM ciphertext so the requester can derive the shared
 * secret without needing the hub's persistent identity.
 *
 * Threat model — LAN-segment attacker:
 *   - Eavesdropping: defeated by AES-GCM with a per-message nonce.
 *   - Replay of an old approval: each request carries a unique
 *     `id`; the requester refuses approvals whose `request_id`
 *     doesn't match a request it actually sent.
 *   - Active MITM rewriting an approval: the requester verifies an
 *     HMAC computed from the same shared secret over a canonical
 *     envelope (`request_id|ciphertext|nonce|hub_pub`). Tampering
 *     fails the HMAC.
 *   - Malicious LAN host announcing a fake "Hub": the operator must
 *     visually verify hostname + IP + squadron in the dialog before
 *     clicking Approve; the runbook spells this out (Step 8).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

import { pool } from "@workspace/db";

export type LanPairingKeypair = {
  publicKeyHex: string;
  privateKeyHex: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type EncryptedApproval = {
  /** Ephemeral hub pubkey (raw 32-byte X25519 in hex). */
  hubPubKey: string;
  /** AES-GCM 12-byte nonce, hex. */
  nonce: string;
  /** AES-GCM ciphertext + 16-byte tag concatenated, hex. */
  ciphertext: string;
  /** HMAC over the envelope, hex. */
  hmac: string;
};

const X25519_KEY_LEN = 32;

/**
 * Generate a fresh persistent X25519 keypair for this PC. The private
 * key is stored at rest in the `lan_pairing_keypair` row (id=1).
 */
export function generateKeypair(): LanPairingKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pubRaw = exportRawX25519(publicKey, "public");
  const privRaw = exportRawX25519(privateKey, "private");
  return {
    publicKeyHex: pubRaw.toString("hex"),
    privateKeyHex: privRaw.toString("hex"),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

function exportRawX25519(
  key: ReturnType<typeof createPublicKey>,
  kind: "public" | "private",
): Buffer {
  // Node's `export({ format: "der", type: "spki" })` includes a fixed
  // 12-byte (public) / 16-byte (private) ASN.1 prefix in front of the
  // 32-byte X25519 raw key. Slicing the trailing 32 bytes is
  // deterministic and the cleanest portable way to get the wire
  // representation we want to ship in TXT records and approvals.
  if (kind === "public") {
    const der = key.export({ format: "der", type: "spki" }) as Buffer;
    return der.subarray(der.length - X25519_KEY_LEN);
  }
  const der = key.export({ format: "der", type: "pkcs8" }) as Buffer;
  return der.subarray(der.length - X25519_KEY_LEN);
}

function publicKeyFromRawHex(hex: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== X25519_KEY_LEN) throw new Error("invalid_public_key_length");
  // SPKI DER prefix for X25519 public keys: 0x302a300506032b656e0321 00
  const prefix = Buffer.from("302a300506032b656e032100", "hex");
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  });
}

function privateKeyFromRawHex(hex: string): ReturnType<typeof createPrivateKey> {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== X25519_KEY_LEN) throw new Error("invalid_private_key_length");
  // PKCS8 DER prefix for an X25519 private key + the 0x04 0x20 OCTET-STRING
  // header that wraps the 32-byte key.
  const prefix = Buffer.from("302e020100300506032b656e042204200", "hex").subarray(0, 14);
  // Actually: 30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 <key32>
  const fullPrefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  void prefix;
  return createPrivateKey({
    key: Buffer.concat([fullPrefix, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function deriveSharedSecret(privHex: string, peerPubHex: string): Buffer {
  const priv = privateKeyFromRawHex(privHex);
  const peer = publicKeyFromRawHex(peerPubHex);
  return diffieHellman({ privateKey: priv, publicKey: peer });
}

function deriveAesAndHmacKeys(
  shared: Buffer,
  contextLabel: Buffer,
): { aesKey: Buffer; hmacKey: Buffer } {
  // Two independent 32-byte keys via HKDF-SHA256 with disjoint info
  // strings so the same shared secret can safely back encryption and
  // an envelope HMAC without key reuse.
  const aesKey = Buffer.from(
    hkdfSync("sha256", shared, contextLabel, Buffer.from("hawkeye-pair-aes-v1"), 32),
  );
  const hmacKey = Buffer.from(
    hkdfSync("sha256", shared, contextLabel, Buffer.from("hawkeye-pair-hmac-v1"), 32),
  );
  return { aesKey, hmacKey };
}

/**
 * Encrypt an approval payload for the requester. `requesterPubKeyHex`
 * is the persistent X25519 key the requester sent in the inbound
 * pairing request. We mint a fresh ephemeral hub keypair per
 * approval so a single stolen long-term hub key cannot decrypt
 * historical approvals.
 */
export function encryptApprovalForRequester(opts: {
  requesterPubKeyHex: string;
  requestId: string;
  plaintext: string;
}): EncryptedApproval {
  const ephemeral = generateKeypair();
  const shared = deriveSharedSecret(
    ephemeral.privateKeyHex,
    opts.requesterPubKeyHex,
  );
  const contextLabel = Buffer.from(`hawkeye-pair:${opts.requestId}`);
  const { aesKey, hmacKey } = deriveAesAndHmacKeys(shared, contextLabel);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(opts.plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([ct, tag]);
  const envelope = Buffer.concat([
    Buffer.from(opts.requestId, "utf8"),
    Buffer.from("|"),
    Buffer.from(ephemeral.publicKeyHex, "utf8"),
    Buffer.from("|"),
    nonce,
    Buffer.from("|"),
    ciphertext,
  ]);
  const hmac = createHmac("sha256", hmacKey).update(envelope).digest();
  return {
    hubPubKey: ephemeral.publicKeyHex,
    nonce: nonce.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    hmac: hmac.toString("hex"),
  };
}

export function decryptApprovalFromHub(opts: {
  myPrivateKeyHex: string;
  requestId: string;
  approval: EncryptedApproval;
}): string {
  const shared = deriveSharedSecret(opts.myPrivateKeyHex, opts.approval.hubPubKey);
  const contextLabel = Buffer.from(`hawkeye-pair:${opts.requestId}`);
  const { aesKey, hmacKey } = deriveAesAndHmacKeys(shared, contextLabel);
  const nonce = Buffer.from(opts.approval.nonce, "hex");
  const ciphertext = Buffer.from(opts.approval.ciphertext, "hex");
  const envelope = Buffer.concat([
    Buffer.from(opts.requestId, "utf8"),
    Buffer.from("|"),
    Buffer.from(opts.approval.hubPubKey, "utf8"),
    Buffer.from("|"),
    nonce,
    Buffer.from("|"),
    ciphertext,
  ]);
  const expected = createHmac("sha256", hmacKey).update(envelope).digest();
  const provided = Buffer.from(opts.approval.hmac, "hex");
  if (
    expected.length !== provided.length ||
    !timingSafeEqualHex(expected, provided)
  ) {
    throw new Error("approval_envelope_tampered");
  }
  if (ciphertext.length < 16) throw new Error("approval_ciphertext_too_short");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString("utf8");
}

function timingSafeEqualHex(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

// ── Persistent keypair storage ──────────────────────────────────────

let __cached: LanPairingKeypair | null = null;

/**
 * Load this PC's persistent X25519 keypair, creating one on first
 * call. The row is pinned to id=1 so concurrent boots can never spawn
 * a parallel identity even if `ensureFullSchema` runs in two
 * processes simultaneously (the unique primary key stops the second
 * insert).
 */
export async function getLocalPairingKeypair(): Promise<LanPairingKeypair> {
  if (__cached) return __cached;
  const existing = await pool.query<{ public_key: string; private_key: string }>(
    `select public_key, private_key from lan_pairing_keypair where id = 1`,
  );
  if (existing.rows[0]) {
    const pubHex = existing.rows[0].public_key;
    const privHex = existing.rows[0].private_key;
    __cached = {
      publicKeyHex: pubHex,
      privateKeyHex: privHex,
      publicKeyPem: publicKeyFromRawHex(pubHex)
        .export({ format: "pem", type: "spki" })
        .toString(),
      privateKeyPem: privateKeyFromRawHex(privHex)
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    return __cached;
  }
  const fresh = generateKeypair();
  await pool.query(
    `
    insert into lan_pairing_keypair (id, public_key, private_key)
    values (1, $1, $2)
    on conflict (id) do nothing
    `,
    [fresh.publicKeyHex, fresh.privateKeyHex],
  );
  // Re-read to pick up a row some other process might have inserted
  // between the SELECT above and the INSERT.
  const after = await pool.query<{ public_key: string; private_key: string }>(
    `select public_key, private_key from lan_pairing_keypair where id = 1`,
  );
  if (after.rows[0]) {
    const pubHex = after.rows[0].public_key;
    const privHex = after.rows[0].private_key;
    __cached = {
      publicKeyHex: pubHex,
      privateKeyHex: privHex,
      publicKeyPem: publicKeyFromRawHex(pubHex)
        .export({ format: "pem", type: "spki" })
        .toString(),
      privateKeyPem: privateKeyFromRawHex(privHex)
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    return __cached;
  }
  __cached = fresh;
  return fresh;
}

export function _resetCachedKeypairForTests(): void {
  __cached = null;
}

/** Generate a new pairing-request id (UUID v4 hex with dashes). */
export function newPairingRequestId(): string {
  return randomUUID();
}

// ── Ed25519 request-signing keypair ─────────────────────────────────
//
// In addition to the X25519 encryption keypair above, each PC holds a
// persistent Ed25519 *signing* keypair.  When the requester POSTs an
// inbound pairing request to the Hub it includes:
//   - requester_sign_pub_key  — the Ed25519 public key (64 hex chars)
//   - requester_sig           — Ed25519 signature over the canonical
//                               request payload (see signPairingRequest)
//
// The Hub verifies the signature before accepting the request.  This
// proof-of-possession ties the claim "my encryption pubkey is X" to an
// entity that actually holds the corresponding signing private key.  An
// active LAN attacker who replaces requester_pub_key must substitute a
// different signing key (they lack the legitimate PC's signing private
// key), which causes the fingerprint shown in the Hub inbox to differ
// from the one displayed on the legitimate PC — giving the operator a
// detectable signal.

const ED25519_KEY_LEN = 32;

// SPKI DER prefix for Ed25519 public key (12 bytes).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// PKCS8 DER prefix for Ed25519 private key seed (16 bytes).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519PublicKeyFromRawHex(hex: string): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== ED25519_KEY_LEN) throw new Error("invalid_ed25519_public_key_length");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function ed25519PrivateKeyFromRawHex(hex: string): ReturnType<typeof createPrivateKey> {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== ED25519_KEY_LEN) throw new Error("invalid_ed25519_private_key_length");
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

export type LanPairingSigningKeypair = {
  signPubKeyHex: string;
  signPrivKeyHex: string;
};

/**
 * Build the canonical message that is signed over a pairing request.
 * All mutable fields that an attacker could swap are included so that
 * any substitution invalidates the signature.
 */
export function pairingRequestCanonical(fields: {
  id: string;
  requester_pub_key: string;
  requester_callback_url: string;
  requester_role: string;
  requester_address: string;
}): Buffer {
  const msg = [
    "hawkeye-pair-request-v1",
    fields.id,
    fields.requester_pub_key,
    fields.requester_callback_url,
    fields.requester_role,
    fields.requester_address,
  ].join("|");
  return Buffer.from(msg, "utf8");
}

/**
 * Sign a canonical pairing request payload with the local Ed25519
 * signing private key.  Returns the signature as a 128-char hex string.
 */
export function signPairingRequest(
  signPrivKeyHex: string,
  canonical: Buffer,
): string {
  const privKey = ed25519PrivateKeyFromRawHex(signPrivKeyHex);
  const sig = cryptoSign(undefined, canonical, privKey);
  return sig.toString("hex");
}

/**
 * Verify an Ed25519 signature over a canonical pairing request payload.
 * Returns true only when the signature is cryptographically valid for
 * the given public key and canonical message.
 */
export function verifyPairingRequestSignature(
  signPubKeyHex: string,
  canonical: Buffer,
  sigHex: string,
): boolean {
  try {
    const pubKey = ed25519PublicKeyFromRawHex(signPubKeyHex);
    const sig = Buffer.from(sigHex, "hex");
    return cryptoVerify(undefined, canonical, pubKey, sig);
  } catch {
    return false;
  }
}

let __cachedSigning: LanPairingSigningKeypair | null = null;

/**
 * Load this PC's persistent Ed25519 signing keypair, creating one on
 * first call.  Stored alongside the X25519 keypair in
 * `lan_pairing_keypair` (columns `sign_pub_key` / `sign_priv_key`).
 */
export async function getLocalSigningKeypair(): Promise<LanPairingSigningKeypair> {
  if (__cachedSigning) return __cachedSigning;

  const existing = await pool.query<{ sign_pub_key: string | null; sign_priv_key: string | null }>(
    `select sign_pub_key, sign_priv_key from lan_pairing_keypair where id = 1`,
  );
  const row = existing.rows[0];
  if (row?.sign_pub_key && row?.sign_priv_key) {
    __cachedSigning = {
      signPubKeyHex: row.sign_pub_key,
      signPrivKeyHex: row.sign_priv_key,
    };
    return __cachedSigning;
  }

  // Generate a fresh Ed25519 keypair.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const privDer = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const pubHex = pubDer.subarray(pubDer.length - ED25519_KEY_LEN).toString("hex");
  const privHex = privDer.subarray(privDer.length - ED25519_KEY_LEN).toString("hex");

  // Upsert into the existing row (id=1 must exist from getLocalPairingKeypair).
  await pool.query(
    `update lan_pairing_keypair
        set sign_pub_key  = coalesce(sign_pub_key, $1),
            sign_priv_key = coalesce(sign_priv_key, $2)
      where id = 1`,
    [pubHex, privHex],
  );

  // Re-read to pick up any value another concurrent process inserted.
  const after = await pool.query<{ sign_pub_key: string | null; sign_priv_key: string | null }>(
    `select sign_pub_key, sign_priv_key from lan_pairing_keypair where id = 1`,
  );
  const afterRow = after.rows[0];
  if (afterRow?.sign_pub_key && afterRow?.sign_priv_key) {
    __cachedSigning = {
      signPubKeyHex: afterRow.sign_pub_key,
      signPrivKeyHex: afterRow.sign_priv_key,
    };
    return __cachedSigning;
  }

  __cachedSigning = { signPubKeyHex: pubHex, signPrivKeyHex: privHex };
  return __cachedSigning;
}

export function _resetCachedSigningKeypairForTests(): void {
  __cachedSigning = null;
}
