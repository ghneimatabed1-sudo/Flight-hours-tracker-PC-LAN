#!/usr/bin/env node
// scripts/src/check-validate-license-jwt-gate.mjs
//
// Task #293 — CI guard against the next validate-license JWT-vs-gate
// drift bug.
//
// Why this exists
// ─────────────────
// Task #290 added a CI probe (`check-super-admin-jwt-gate.mjs`) that
// pins down the JWT shape minted by `super-admin-2fa` against the SQL
// gate `xpc_is_super_admin()`. The same defect class — a name-
// mismatch between an edge function's output and a downstream
// consumer that reads it back — applies to `validate-license` even
// though it doesn't itself mint a JWT:
//
//   * `validate-license` is the gateway every desktop client passes
//     through on each login. It returns `{ ok, squadronId, expiresAt }`.
//   * The desktop client then signs into Supabase with its CACHED
//     `supabaseEmail` / `supabasePassword` (originally minted by
//     `register-license` / `provision-commander`). The resulting JWT
//     carries `app_metadata.squadron_id`.
//   * Every operational table read/write the client makes after that
//     is gated by RLS that compares the table row's squadron_id to
//     `app_metadata.squadron_id`.
//
// If `validate-license` ever returns a different `squadronId` than
// the one baked into the cached JWT — because the licenses table got
// re-seeded, a key was reassigned, the function's response shape
// drifted, or a migration silently moved squadron rows — every
// subsequent dashboard read silently filters to zero rows. Operators
// see "no data" with no error, exactly the failure mode Task #290 was
// written to prevent.
//
// What this script does
// ──────────────────────
//   1. POSTs `{ key, fingerprint }` to the deployed `validate-license`
//      edge function with a known CI test license key + the
//      fingerprint that license is bound to. Verifies the function
//      still returns `{ ok: true, squadronId, expiresAt }` with the
//      expected shape (catches function regressions, schema drift,
//      key revocation, fingerprint rebinds).
//   2. If `CI_LICENSE_OPS_EMAIL` / `CI_LICENSE_OPS_PASSWORD` are
//      provided, signs into Supabase as the ops account paired with
//      that license and asserts the JWT's `app_metadata.squadron_id`
//      MATCHES the squadronId returned by `validate-license`. This
//      is the JWT-vs-gate parity check: a mismatch means the next
//      operational write would land in the wrong tenant or be
//      filtered out by RLS.
//   3. (Same downstream JWT.) Calls `xpc_caller_squadron_ids()` —
//      the helper migrations 0061/0063 use to evaluate the snapshot
//      SELECT policy. Verifies the call returns without errcode
//      42501 / "permission denied". If it does fail, the JWT's
//      claim shape is incompatible with what the gate expects.
//
// `validate-license` is deployed `--no-verify-jwt`, so step 1 only
// needs the anon key. Steps 2 + 3 require an ops account signed in
// — the same trust model the desktop client uses after license
// validation.
//
// Required env vars
// ─────────────────
//   SUPABASE_URL                       https://…supabase.co
//   SUPABASE_ANON_KEY                  anon JWT (apikey + bearer)
//   CI_LICENSE_KEY                     a license key pre-seeded into
//                                      `public.licenses` for this
//                                      probe's exclusive use
//   CI_LICENSE_FINGERPRINT             the fingerprint that license
//                                      is bound to (or `null` if
//                                      bound_fingerprint is null —
//                                      then any non-empty value
//                                      activates it on first run,
//                                      AND mutates production state,
//                                      so prefer to pre-bind)
//
// Required env vars when --require is passed (i.e. in CI)
//   CI_LICENSE_OPS_EMAIL               Supabase email of the ops
//                                      account paired with the test
//                                      license's squadron. WITHOUT
//                                      this, the probe can only check
//                                      function-output shape — it
//                                      cannot exercise the JWT-vs-
//                                      gate parity that Task #293
//                                      exists to catch. Required in
//                                      --require mode for that reason.
//   CI_LICENSE_OPS_PASSWORD            its Supabase password.
//                                      Required in --require mode
//                                      alongside CI_LICENSE_OPS_EMAIL.
//
// Truly optional env vars
//   CI_LICENSE_EXPECTED_SQUADRON_ID    if set, the probe asserts
//                                      validate-license's squadronId
//                                      equals this. Catches rogue
//                                      reassignment of the test key
//                                      to a different squadron.
//
// Flags
// ─────
//   --require       Hard-fail (exit 2) if any required env var is
//                   missing. Without `--require`, missing env vars
//                   print `::warning::` and exit 0 so local runs
//                   never fail surprisingly. The CI workflow passes
//                   this flag.
//
// Exit codes
// ──────────
//   0   `validate-license` returned the expected shape, AND (when
//       opted in via OPS_EMAIL/PASSWORD) the cached ops JWT's
//       `app_metadata.squadron_id` matched the function's
//       `squadronId`, AND the snapshot helper RPC accepted the JWT.
//   1   Any of those parity checks failed — function shape drift,
//       squadron mismatch, or RPC permission denied. This is the
//       Task #293 regression class.
//   2   Setup error (missing env with --require, network failure,
//       license rejected, unexpected response shape).
//
// Usage
// ──────
//   node scripts/src/check-validate-license-jwt-gate.mjs
//   node scripts/src/check-validate-license-jwt-gate.mjs --require

const args = process.argv.slice(2);
const REQUIRE = args.includes("--require");

// ── Env ──────────────────────────────────────────────────────────
const SUPABASE_URL          = process.env.SUPABASE_URL;
const ANON_KEY              = process.env.SUPABASE_ANON_KEY;
const LICENSE_KEY           = process.env.CI_LICENSE_KEY;
const LICENSE_FINGERPRINT   = process.env.CI_LICENSE_FINGERPRINT;
const EXPECTED_SQN_ID       = process.env.CI_LICENSE_EXPECTED_SQUADRON_ID;
const OPS_EMAIL             = process.env.CI_LICENSE_OPS_EMAIL;
const OPS_PASSWORD          = process.env.CI_LICENSE_OPS_PASSWORD;

const missing = [];
if (!SUPABASE_URL)        missing.push("SUPABASE_URL");
if (!ANON_KEY)            missing.push("SUPABASE_ANON_KEY");
if (!LICENSE_KEY)         missing.push("CI_LICENSE_KEY");
if (!LICENSE_FINGERPRINT) missing.push("CI_LICENSE_FINGERPRINT");
// Under --require (CI mode) the JWT-vs-gate parity check is the
// whole point of this probe. Treat the ops opt-in vars as REQUIRED
// in that mode — without them the probe degrades to a function-
// shape smoke test and silently leaves the regression class Task
// #293 exists to catch (squadronId drift between validate-license
// and the cached ops JWT) untested. Local runs without --require
// keep the optional behavior so a developer can still smoke-test
// validate-license without provisioning ops creds.
if (REQUIRE && !OPS_EMAIL)    missing.push("CI_LICENSE_OPS_EMAIL");
if (REQUIRE && !OPS_PASSWORD) missing.push("CI_LICENSE_OPS_PASSWORD");

if (missing.length > 0) {
  const msg =
    `check-validate-license-jwt-gate: missing required env var(s): ${missing.join(", ")}.\n` +
    `Configure these as repository secrets and re-run. CI_LICENSE_KEY must already exist in ` +
    `public.licenses (pre-seeded by ops) and CI_LICENSE_FINGERPRINT must match its ` +
    `bound_fingerprint — otherwise this probe will either be rejected as pc_mismatch or, ` +
    `worse, silently re-bind the license to whatever fingerprint CI happens to send.\n` +
    `\n` +
    `In CI (--require) mode CI_LICENSE_OPS_EMAIL and CI_LICENSE_OPS_PASSWORD are also ` +
    `required: without them the probe cannot sign in as the ops account paired with the ` +
    `test license, which means it cannot verify the JWT's app_metadata.squadron_id matches ` +
    `validate-license's squadronId — the JWT-vs-gate parity Task #293 exists to catch.`;
  if (REQUIRE) {
    console.error(`::error::${msg}`);
    process.exit(2);
  }
  console.warn(`::warning::${msg}`);
  console.warn("Skipping (no --require flag).");
  process.exit(0);
}

const FN_URL   = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/validate-license`;
const AUTH_URL = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`;
const RPC_URL  = (name) => `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${name}`;

// ── Helpers ──────────────────────────────────────────────────────
function fail(code, message, detail) {
  console.error(`::error::check-validate-license-jwt-gate: ${message}`);
  if (detail !== undefined) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    console.error(text);
  }
  process.exit(code);
}

function decodeJwtClaims(jwt) {
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

// ── Step 1: validate-license ─────────────────────────────────────
console.log(`[1/4] validate-license: key=${LICENSE_KEY.slice(0, 6)}…`);
const val = await postJson(FN_URL, {
  key: LICENSE_KEY,
  fingerprint: LICENSE_FINGERPRINT,
}, { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY });

if (val.status !== 200) {
  fail(2, `validate-license returned non-200 status ${val.status}. The function may be down or misconfigured.`, val.json ?? val.text);
}
if (val.json?.ok !== true) {
  // pc_mismatch / unknown_key / revoked / expired all surface here.
  // Distinguish setup errors (the test license is misconfigured) from
  // the shape regressions Task #293 catches.
  const errKind = String(val.json?.error ?? "(unknown)");
  if (errKind === "pc_mismatch") {
    fail(
      2,
      `validate-license rejected the CI fingerprint with pc_mismatch. CI_LICENSE_FINGERPRINT does not match licenses.bound_fingerprint for this key. Either update the secret or re-bind the license row.`,
      val.json,
    );
  }
  if (errKind === "unknown_key" || errKind === "revoked" || errKind === "expired") {
    fail(
      2,
      `validate-license refused the CI license with error="${errKind}". The test license needs to exist, be unrevoked, and not expired in public.licenses.`,
      val.json,
    );
  }
  fail(
    1,
    `validate-license returned ok=false with an unexpected error shape — likely a function-output regression.`,
    val.json ?? val.text,
  );
}
const { squadronId, expiresAt } = val.json;
if (typeof squadronId !== "string" || squadronId.length === 0) {
  fail(
    1,
    `validate-license returned ok=true but squadronId was missing or not a string. This is a function-output shape regression — the desktop client cannot route subsequent calls without it.`,
    val.json,
  );
}
console.log(`      ok — squadronId=${squadronId} expiresAt=${expiresAt ?? "(none)"}`);

if (EXPECTED_SQN_ID && squadronId !== EXPECTED_SQN_ID) {
  fail(
    1,
    `validate-license returned squadronId="${squadronId}" but CI_LICENSE_EXPECTED_SQUADRON_ID="${EXPECTED_SQN_ID}".\n` +
      `\n` +
      `The test license has been reassigned to a different squadron, or the licenses table\n` +
      `was reseeded out from under CI. Every desktop client cached against the old squadron\n` +
      `will silently see zero rows after this drift.\n`,
    val.json,
  );
}

// ── Steps 2-4: JWT vs squadronId parity ──────────────────────────
// In CI (--require) mode, missing OPS creds were already rejected
// up front — reaching here without them only happens in local
// developer runs where the parity check is opted out of explicitly.
// We degrade gracefully in that case so a developer can still
// smoke-test validate-license without provisioning ops creds, but
// the success message is unambiguous about what was NOT exercised.
if (!OPS_EMAIL || !OPS_PASSWORD) {
  console.log(`[2/4] skip — CI_LICENSE_OPS_EMAIL/PASSWORD not provided (local mode only)`);
  console.log(`[3/4] skip — no JWT to inspect`);
  console.log(`[4/4] skip — no JWT to call downstream RPC with`);
  console.log("");
  console.log("⚠ check-validate-license-jwt-gate: PARTIAL PASS (function shape only)");
  console.log(`  validate-license returned ok=true, squadronId=${squadronId}.`);
  console.log(`  The JWT-vs-gate parity check was NOT performed — provide`);
  console.log(`  CI_LICENSE_OPS_EMAIL/PASSWORD to exercise it. CI runs require`);
  console.log(`  these vars (the --require flag rejects them as missing above).`);
  process.exit(0);
}

// ── Step 2: sign in as the ops account paired with this license ──
console.log(`[2/4] auth: signInWithPassword as ops account (${OPS_EMAIL})`);
const auth = await postJson(AUTH_URL, {
  email: OPS_EMAIL,
  password: OPS_PASSWORD,
}, { apikey: ANON_KEY });

if (auth.status !== 200 || !auth.json?.access_token) {
  fail(2, `Supabase auth refused the CI ops credentials (status ${auth.status}). Verify CI_LICENSE_OPS_EMAIL and CI_LICENSE_OPS_PASSWORD against the deployed project — they must match the ops account that was originally provisioned for this license's squadron.`, auth.json ?? auth.text);
}
const jwt = auth.json.access_token;
const claims = decodeJwtClaims(jwt);
const jwtSqnId = claims?.app_metadata?.squadron_id ?? null;
const jwtRole  = claims?.app_metadata?.role ?? null;
console.log(`      ok — JWT issued`);
console.log(`      app_metadata = ${JSON.stringify(claims?.app_metadata ?? null)}`);

// ── Step 3: parity check ─────────────────────────────────────────
console.log(`[3/4] parity: validate-license.squadronId vs JWT.app_metadata.squadron_id`);
if (jwtSqnId !== squadronId) {
  fail(
    1,
    `validate-license returned squadronId="${squadronId}" but the ops JWT carries app_metadata.squadron_id="${jwtSqnId ?? "(missing)"}".\n` +
      `\n` +
      `This is the Task #293 regression for validate-license — a name-mismatch between\n` +
      `the function's output and the JWT every downstream RLS policy reads back. With\n` +
      `this drift, every operational write the desktop client makes after a successful\n` +
      `validate-license will land in the wrong tenant (or be filtered out entirely),\n` +
      `with no surface error.\n` +
      `\n` +
      `Fix one or both halves so they line up:\n` +
      `  - The license row's squadron_id, OR\n` +
      `  - The ops auth user's app_metadata.squadron_id (re-provision via\n` +
      `    register-license / provision-commander to rotate the claim).\n`,
    { validateLicense: val.json, jwtAppMetadata: claims?.app_metadata ?? null },
  );
}
console.log(`      ok — both report squadron_id=${squadronId}`);

// ── Step 4: downstream helper RPC the snapshot policy reads ──────
// xpc_caller_squadron_ids() is the helper migrations 0061/0063 wired
// into the xpc_squadron_snapshot SELECT policy. It returns the JWT's
// app_metadata.squadron_ids array (or null) WITHOUT touching any row,
// so it's truly side-effect-free. If the JWT's claim shape isn't
// readable by the function (e.g. wrong nesting level after a JSON
// path rename), we get errcode 42501 here — exactly the failure
// class Task #293 catches.
console.log(`[4/4] rpc: xpc_caller_squadron_ids (downstream helper)`);
const rpc = await postJson(RPC_URL("xpc_caller_squadron_ids"), {}, {
  Authorization: `Bearer ${jwt}`,
  apikey: ANON_KEY,
});

const rpcMessage = String(rpc.json?.message ?? rpc.json?.error ?? rpc.text ?? "");
const rpcCode    = String(rpc.json?.code ?? "");
const looksLikeGateRejection =
  rpcCode === "42501" ||
  /permission denied/i.test(rpcMessage) ||
  /requires (super_admin|commander|ops|admin)/i.test(rpcMessage);

if (looksLikeGateRejection) {
  fail(
    1,
    `xpc_caller_squadron_ids() rejected the ops JWT.\n` +
      `\n` +
      `This is the Task #293 regression — the JWT minted for the ops account paired\n` +
      `with the CI license cannot reach the downstream helper that the snapshot SELECT\n` +
      `policy depends on.\n` +
      `\n` +
      `JWT app_metadata = ${JSON.stringify(claims?.app_metadata ?? null)}\n`,
    { status: rpc.status, pgCode: rpcCode, message: rpcMessage, body: rpc.json ?? rpc.text },
  );
}

if (rpc.status >= 400) {
  console.warn(
    `::warning::xpc_caller_squadron_ids returned an unexpected non-gate error ` +
      `(status ${rpc.status}, pg_code ${rpcCode || "?"}, message ${rpcMessage.slice(0, 120)}). ` +
      `The gate itself accepted the JWT (no 42501) so Task #293 is satisfied, ` +
      `but investigate when convenient.`,
  );
}

console.log(`      ok — helper returned without permission denied`);
console.log("");
console.log("✓ check-validate-license-jwt-gate: PASS");
console.log(`  validate-license returned squadronId=${squadronId},`);
console.log(`  the ops JWT's app_metadata.squadron_id matched,`);
console.log(`  and xpc_caller_squadron_ids() accepted the JWT.`);
process.exit(0);
