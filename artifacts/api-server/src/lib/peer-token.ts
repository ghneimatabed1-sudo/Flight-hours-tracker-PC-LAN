import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "./password";

/**
 * Peer access token format and helpers.
 *
 * A peer token is what an outside reader (Wing Commander PC, Base
 * Commander PC, ...) sends in `X-Hawk-Peer-Token` to read this hub's
 * read-only `/api/peer/*` surface.
 *
 * The plain-text token is shaped as `phk_<row-id>_<secret>` where
 *   - `phk_` is a fixed prefix so operators can recognise it on sight,
 *   - `<row-id>` is the row's UUID and is used as the indexed lookup
 *     key against `peer_tokens.id`,
 *   - `<secret>` is 32 random bytes hex-encoded and is hashed at rest
 *     using the same scrypt pattern as user passwords. The plain
 *     token is returned to the operator exactly once at create time.
 *
 * Verification is constant-time via scrypt's `verifyPassword`.
 */

const TOKEN_PREFIX = "phk_";
const SECRET_BYTES = 32;

export type IssuedPeerToken = {
  id: string;
  secret: string;
  plain: string;
  hash: string;
};

export async function issuePeerToken(): Promise<IssuedPeerToken> {
  const id = randomUUID();
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const hash = await hashPassword(secret);
  const plain = `${TOKEN_PREFIX}${id}_${secret}`;
  return { id, secret, plain, hash };
}

export type ParsedPeerToken = {
  id: string;
  secret: string;
};

/**
 * Parse a bearer string into its `id` / `secret` parts. Returns `null`
 * when the string is missing the prefix, mis-shaped, or carries an
 * obviously-not-UUID id. Never throws.
 */
export function parsePeerToken(raw: string | null | undefined): ParsedPeerToken | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) return null;
  const body = trimmed.slice(TOKEN_PREFIX.length);
  // First underscore separates id and secret; secret may contain hex
  // characters only, so a single split on the first `_` is enough.
  const sep = body.indexOf("_");
  if (sep <= 0 || sep >= body.length - 1) return null;
  const id = body.slice(0, sep);
  const secret = body.slice(sep + 1);
  // UUID v4-ish sanity check: 36 chars, 4 dashes.
  if (id.length !== 36) return null;
  if ((id.match(/-/g) ?? []).length !== 4) return null;
  if (!/^[0-9a-f-]+$/i.test(id)) return null;
  if (!/^[0-9a-f]+$/i.test(secret)) return null;
  return { id, secret };
}

export async function verifyPeerSecret(secret: string, hash: string): Promise<boolean> {
  return verifyPassword(secret, hash);
}
