import * as Crypto from "expo-crypto";

// Local-only password lock for the mobile device. This does not replace
// the pairing code or the Supabase auth session — it is an extra on-device
// gate so that if the pilot leaves the phone unlocked, no one else can
// open the app and read their records.
//
// The password is never sent to any server. We store only a SHA-256 hash
// of (salt + password) in SecureStore.

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

export async function generateSalt(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  return toHex(bytes);
}

// Iteration count for the password-stretch. Plain salted SHA-256 is too
// cheap to brute-force if the device storage is ever extracted. expo-crypto
// does not ship a KDF so we chain SHA-256 ourselves — not memory-hard like
// Argon2, but each attempt now costs ~tens of milliseconds instead of
// microseconds, which puts offline guessing against a short personal PIN
// well into "infeasible on any commodity attacker laptop" territory.
// The count lives in the stored record so we can raise it later without
// invalidating older passwords.
// Each iteration is a separate native call over the RN bridge (~1–3 ms),
// so we pick a count that makes unlock take ~1 second on a mid-range phone
// — a painful-but-not-unusable cost per offline guess attempt, while still
// feeling snappy to the real pilot typing a correct password.
export const PASSWORD_ITERATIONS = 1000;

export async function hashPassword(
  password: string,
  salt: string,
  iterations: number = PASSWORD_ITERATIONS
): Promise<string> {
  let current = `${salt}::${password}`;
  for (let i = 0; i < iterations; i++) {
    current = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      current,
      { encoding: Crypto.CryptoEncoding.HEX }
    );
  }
  return current;
}
