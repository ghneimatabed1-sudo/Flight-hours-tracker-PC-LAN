#!/usr/bin/env node
// scripts/src/check-super-admin-jwt-gate.mjs
//
// Task #290 — CI guard against the next super-admin JWT-vs-gate
// name-mismatch bug.
//
// Why this exists
// ─────────────────
// Task #289 shipped a fix for an operator-reported defect where the
// Connection Map "Reset PC" button silently rejected a legitimate
// super admin with PostgreSQL errcode 42501 / "reset requires
// super_admin". The root cause was a name-mismatch between two halves
// of the auth flow that nothing in CI exercised end-to-end:
//
//   * The `super-admin-2fa` edge function minted a Supabase auth user
//     with `app_metadata.role = "admin"` (and `tier = "hq"`).
//   * The SQL gate `xpc_is_super_admin()` (migration 0038) compared
//     `app_metadata.role` strictly to the literal string
//     `"super_admin"`.
//
// Either half by itself was internally consistent. They only fell out
// of sync when one was edited without the other. Migration 0067
// widened the gate to accept both shapes and the function was updated
// to mint the canonical `"super_admin"` role going forward, but
// nothing in CI catches the next mismatch — operators do, in
// production, when a super-admin RPC starts returning 42501.
//
// What this script does
// ──────────────────────
// Simulates the real super-admin sign-in flow against the deployed
// Supabase project and asserts that the resulting JWT actually passes
// the SQL gate that protects every super-admin RPC:
//
//   1. POST { action: "start", username, password } to the deployed
//      `super-admin-2fa` edge function. Receives a short-lived
//      challenge token bound to the username.
//   2. Computes a current TOTP code from the test 2FA secret using
//      the same RFC-6238 algorithm the function checks against.
//   3. POST { action: "verify", username, token, code } to receive
//      back the deterministic Supabase auth credentials
//      (supabaseEmail, supabasePassword) that the dashboard would
//      then sign in with.
//   4. Exchanges those credentials for a real JWT via the Supabase
//      auth REST endpoint (`/auth/v1/token?grant_type=password`).
//   5. Decodes the JWT (base64-only — we do not verify the signature;
//      Supabase already did that when issuing it) and prints the
//      `app_metadata` block so a CI failure shows the exact claim
//      shape that broke the gate.
//   6. Calls a representative super-admin RPC
//      (`xpc_admin_create_pair`) with deliberately invalid inputs
//      that trip its post-gate validation. The expected outcome is
//      errcode `22023` (invalid_parameter_value) — proof that the
//      JWT *passed* the `xpc_is_super_admin()` gate. If the call
//      instead returns errcode `42501` or any message containing
//      `requires super_admin`, the JWT does NOT satisfy the gate
//      and we exit non-zero.
//
// `xpc_admin_create_pair` was chosen because it raises `22023` as
// soon as it sees `p_a_pc_id = p_b_pc_id`, BEFORE writing any audit
// rows or touching `xpc_pair_links`. That makes the probe truly
// side-effect-free — every CI run is a no-op transaction.
//
// Required env vars
// ─────────────────
//   SUPABASE_URL                 e.g. https://nklrdhfsbevckovqqkah.supabase.co
//   SUPABASE_ANON_KEY            anon JWT used to reach the edge function
//   SUPER_ADMIN_PASSWORD         plaintext password configured for the
//                                deployed function (matches
//                                `super_admin_credentials.password_hash`)
//   SUPER_ADMIN_TOTP_SECRET      base32 TOTP secret currently enrolled
//                                for the `admin` super admin
//   SUPER_ADMIN_USERNAME         optional, defaults to "admin"
//
// Flags
// ─────
//   --require       Hard-fail (exit 2) if any of the env vars above
//                   is missing. The CI workflow passes this so an
//                   accidentally-unset secret is loud, not silent.
//                   Without `--require`, a missing env var prints
//                   a ::warning:: and exits 0 so local runs never
//                   fail surprisingly.
//   --self-test     Run a no-network sanity check against the TOTP
//                   implementation (RFC 6238 test vectors) and exit.
//
// Exit codes
// ──────────
//   0   The JWT minted by `super-admin-2fa` passed `xpc_is_super_admin()`
//       (or the script was skipped due to missing env without --require).
//   1   The gate rejected the JWT with errcode 42501 / "requires
//       super_admin". This is the regression Task #290 exists to catch.
//   2   Setup error (missing env with --require, network failure,
//       lockout, unexpected response shape).
//
// Usage
// ──────
//   node scripts/src/check-super-admin-jwt-gate.mjs
//   node scripts/src/check-super-admin-jwt-gate.mjs --require
//   node scripts/src/check-super-admin-jwt-gate.mjs --self-test

import { createHmac } from "node:crypto";

// ── Args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const REQUIRE = args.includes("--require");
const SELF_TEST = args.includes("--self-test");

// ── TOTP / Base32 (matches super-admin-2fa/index.ts) ──────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  const clean = String(input).replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out = [];
  let bits = 0, value = 0;
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secretB32, ts) {
  const counter = Math.floor(ts / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const key = base32Decode(secretB32);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
             | (hmac[offset + 1] << 16)
             | (hmac[offset + 2] << 8)
             |  hmac[offset + 3];
  return (code % 1_000_000).toString().padStart(6, "0");
}

// ── Self-test (RFC 6238 test vectors, with Base32-encoded secrets) ─
if (SELF_TEST) {
  // RFC 6238 secret "12345678901234567890" base32-encoded.
  const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const cases = [
    [59 * 1000,         "287082"],
    [1111111109 * 1000, "081804"],
    [1111111111 * 1000, "050471"],
    [1234567890 * 1000, "005924"],
  ];
  let ok = true;
  for (const [ts, want] of cases) {
    const got = totpAt(RFC_SECRET, ts);
    const pass = got === want;
    if (!pass) ok = false;
    console.log(pass ? "PASS" : "FAIL", `ts=${ts} got=${got} want=${want}`);
  }
  console.log(ok ? `OK ${cases.length}/${cases.length}` : "FAIL");
  process.exit(ok ? 0 : 1);
}

// ── Env ──────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY;
const USERNAME      = (process.env.SUPER_ADMIN_USERNAME ?? "admin").trim().toLowerCase();
const PASSWORD      = process.env.SUPER_ADMIN_PASSWORD;
const TOTP_SECRET   = process.env.SUPER_ADMIN_TOTP_SECRET;

const missing = [];
if (!SUPABASE_URL)   missing.push("SUPABASE_URL");
if (!ANON_KEY)       missing.push("SUPABASE_ANON_KEY");
if (!PASSWORD)       missing.push("SUPER_ADMIN_PASSWORD");
if (!TOTP_SECRET)    missing.push("SUPER_ADMIN_TOTP_SECRET");

if (missing.length > 0) {
  const msg =
    `check-super-admin-jwt-gate: missing required env var(s): ${missing.join(", ")}.\n` +
    `Configure these as repository secrets and re-run. Without them this guard cannot ` +
    `simulate the super-admin sign-in flow against the deployed Supabase project.`;
  if (REQUIRE) {
    console.error(`::error::${msg}`);
    process.exit(2);
  }
  console.warn(`::warning::${msg}`);
  console.warn("Skipping (no --require flag).");
  process.exit(0);
}

const FN_URL    = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/super-admin-2fa`;
const AUTH_URL  = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`;
const RPC_URL   = (name) => `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${name}`;

// ── Helpers ──────────────────────────────────────────────────────
function fail(code, message, detail) {
  // GitHub-Actions-friendly annotation. `detail` is appended on its
  // own lines so the workflow run shows it inline without HTML escapes.
  console.error(`::error::check-super-admin-jwt-gate: ${message}`);
  if (detail !== undefined) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    console.error(text);
  }
  process.exit(code);
}

function decodeJwtClaims(jwt) {
  // We DO NOT verify the signature here — Supabase already verified it
  // by accepting the password. We only need the claim shape to display
  // it in the report.
  try {
    const part = jwt.split(".")[1];
    const padded = part + "=".repeat((4 - part.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, text, json };
}

// ── Step 1: action=start ─────────────────────────────────────────
console.log(`[1/6] super-admin-2fa: action=start username=${USERNAME}`);
const start = await postJson(FN_URL, {
  action: "start",
  username: USERNAME,
  password: PASSWORD,
}, { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY });

if (start.status === 423 || start.status === 429 || start.json?.error === "locked") {
  fail(2, `super-admin-2fa is locked (status ${start.status}). The TOTP or password lockout has been tripped — wait for it to expire and re-run, or reset super_admin_2fa.locked_until in the database.`, start.json ?? start.text);
}
if (start.status !== 200 || start.json?.ok !== true || !start.json?.token) {
  fail(2, `super-admin-2fa start did not return ok+token (status ${start.status}). Check that SUPER_ADMIN_PASSWORD matches the live super_admin_credentials.password_hash.`, start.json ?? start.text);
}
console.log(`      ok — enrolled=${start.json.enrolled} (token issued)`);

// ── Step 2: compute current TOTP code ────────────────────────────
console.log(`[2/6] computing current TOTP code from test secret`);
const code = totpAt(TOTP_SECRET, Date.now());
console.log(`      code=${code}`);

// ── Step 3: action=verify ────────────────────────────────────────
console.log(`[3/6] super-admin-2fa: action=verify`);
const verify = await postJson(FN_URL, {
  action: "verify",
  username: USERNAME,
  token: start.json.token,
  code,
}, { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY });

if (verify.status !== 200 || verify.json?.ok !== true) {
  fail(2, `super-admin-2fa verify failed (status ${verify.status}). Either SUPER_ADMIN_TOTP_SECRET is wrong, the function clock has drifted, or super-admin-2fa has been re-enrolled.`, verify.json ?? verify.text);
}
const { supabaseEmail, supabasePassword } = verify.json;
if (!supabaseEmail || !supabasePassword) {
  fail(2, `super-admin-2fa verify did not return supabaseEmail/supabasePassword. The edge function may be a pre-Task-#274 build that does not mint the auth.users credentials.`, verify.json);
}
console.log(`      ok — supabaseEmail=${supabaseEmail}`);

// ── Step 4: exchange creds for a real Supabase JWT ───────────────
console.log(`[4/6] auth: signInWithPassword`);
const auth = await postJson(AUTH_URL, {
  email: supabaseEmail,
  password: supabasePassword,
}, { apikey: ANON_KEY });

if (auth.status !== 200 || !auth.json?.access_token) {
  fail(2, `Supabase auth refused the deterministic super-admin credentials (status ${auth.status}). The auth.users row may have been deleted, the password derivation may have changed, or the project's CHALLENGE_SECRET was rotated without re-syncing the row.`, auth.json ?? auth.text);
}
const jwt = auth.json.access_token;
const claims = decodeJwtClaims(jwt);
console.log(`      ok — JWT issued`);
console.log(`      app_metadata = ${JSON.stringify(claims?.app_metadata ?? null)}`);

// ── Step 5: representative super-admin RPC ───────────────────────
// xpc_admin_create_pair raises errcode 42501 if the gate rejects the
// JWT, OR errcode 22023 ("invalid pc ids") if p_a_pc_id == p_b_pc_id.
// We pass identical IDs on purpose so the SUCCESS path is the 22023
// rejection — proof that the gate let us through. The function bails
// before any INSERT, so this probe is side-effect-free.
console.log(`[5/6] rpc: xpc_admin_create_pair (with intentional 22023 trigger)`);
const probeBody = {
  p_a_pc_id: "__ci_jwt_gate_probe__",
  p_b_pc_id: "__ci_jwt_gate_probe__",
  p_a_tier: "ops", p_b_tier: "ops",
  p_a_squadron: "ci-test", p_b_squadron: "ci-test",
  p_a_seat: "primary", p_b_seat: "primary",
  p_a_user_display: "ci probe", p_b_user_display: "ci probe",
  p_justification: "task #290 CI gate probe",
  p_expires_at: null,
  p_permanent: false,
  p_kind_hint: null,
};
const rpc = await postJson(RPC_URL("xpc_admin_create_pair"), probeBody, {
  Authorization: `Bearer ${jwt}`,
  apikey: ANON_KEY,
});

const rpcMessage = String(rpc.json?.message ?? rpc.json?.error ?? rpc.text ?? "");
const rpcCode    = String(rpc.json?.code ?? "");
const looksLikeGateRejection =
  rpcCode === "42501" ||
  /requires super_admin/i.test(rpcMessage);

console.log(`[6/6] inspecting RPC response`);
console.log(`      status = ${rpc.status}`);
console.log(`      pg_code = ${rpcCode || "(none)"}`);
console.log(`      message = ${rpcMessage.slice(0, 200)}`);

if (looksLikeGateRejection) {
  fail(
    1,
    `xpc_is_super_admin() rejected the JWT minted by super-admin-2fa.\n` +
      `\n` +
      `This is the Task #290 regression — a name-mismatch between the JWT claim\n` +
      `shape and the SQL gate. Compare:\n` +
      `\n` +
      `  - JWT app_metadata that super-admin-2fa minted:\n` +
      `      ${JSON.stringify(claims?.app_metadata ?? null)}\n` +
      `\n` +
      `  - JWT shape(s) accepted by xpc_is_super_admin() (migration 0067):\n` +
      `      role:"super_admin"            (canonical)\n` +
      `      role:"admin" + tier:"hq"      (legacy, post-0067 backstop)\n` +
      `\n` +
      `Fix one or both halves so they line up, then re-run this check. Until\n` +
      `they line up, every super-admin RPC (Reset PC, Create Pair, Bulk Pair,\n` +
      `Sweep, …) will reject the legitimate super admin in production.\n`,
    { status: rpc.status, pgCode: rpcCode, message: rpcMessage, body: rpc.json ?? rpc.text },
  );
}

// Any other error (notably 22023 invalid_parameter_value, the expected
// outcome) is FINE — it proves the gate let the JWT through.
if (rpc.status >= 400 && rpcCode !== "22023") {
  console.warn(
    `::warning::xpc_admin_create_pair returned an unexpected non-gate error ` +
      `(status ${rpc.status}, pg_code ${rpcCode || "?"}, message ${rpcMessage.slice(0, 120)}). ` +
      `The gate itself accepted the JWT (no 42501) so Task #290 is satisfied, ` +
      `but the probe should normally see 22023 — investigate when convenient.`,
  );
}

console.log("");
console.log("✓ check-super-admin-jwt-gate: PASS");
console.log(`  super-admin-2fa minted a JWT with app_metadata=${JSON.stringify(claims?.app_metadata ?? null)},`);
console.log(`  and xpc_is_super_admin() accepted it (no 42501 / "requires super_admin").`);
process.exit(0);
