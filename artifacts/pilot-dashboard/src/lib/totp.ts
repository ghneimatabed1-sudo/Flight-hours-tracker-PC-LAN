// RFC 6238 TOTP / RFC 4648 Base32 — implemented on top of Web Crypto so the
// dashboard does not need a native 2FA library. Used to gate the super admin
// account behind a real authenticator-app code.

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateSecret(byteLength = 20): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base32Encode(buf);
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter >>> 0;
  view.setUint32(0, high);
  view.setUint32(4, low);
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return (code % 1_000_000).toString().padStart(6, "0");
}

export async function totp(secret: string, atMs: number = Date.now()): Promise<string> {
  const counter = Math.floor(atMs / 30_000);
  return hotp(base32Decode(secret), counter);
}

export async function verifyTotp(
  secret: string,
  code: string,
  atMs: number = Date.now(),
  windowSteps = 1,
): Promise<boolean> {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const bytes = base32Decode(secret);
  const counter = Math.floor(atMs / 30_000);
  for (let w = -windowSteps; w <= windowSteps; w++) {
    if ((await hotp(bytes, counter + w)) === clean) return true;
  }
  return false;
}

export function otpauthURL(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
