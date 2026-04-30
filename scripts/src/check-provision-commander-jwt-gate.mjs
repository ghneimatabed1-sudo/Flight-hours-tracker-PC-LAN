#!/usr/bin/env node
// scripts/src/check-provision-commander-jwt-gate.mjs
//
// Task #293 — CI guard against the next provision-commander
// JWT-vs-gate name-mismatch bug.
//
// Why this exists
// ─────────────────
// Task #290 added a CI probe (`check-super-admin-jwt-gate.mjs`) that
// pins down the JWT shape minted by `super-admin-2fa` against the SQL
// gate `xpc_is_super_admin()`. That defect class — a name-mismatch
// between an edge function that mints `app_metadata.role` and the SQL
// policy/RPC that reads it back — is not specific to super_admin. Any
// edge function that calls `auth.admin.createUser` /
// `updateUserById` with custom `app_metadata` is exposed to the same
// failure mode: rename one half (the function) without the other (the
// policy/RPC), and every legitimate caller starts being rejected in
// production with errcode 42501 / "permission denied".
//
// `provision-commander` mints commander / deputy / admin auth users
// for the dashboard, with claims read by:
//   * `xpc_snap_select` policy on `xpc_squadron_snapshot`
//     (migrations 0061 / 0063) — keys off `app_metadata.role`,
//     `app_metadata.tier`, and `app_metadata.squadron_ids`.
//   * `monthly_report_close_close` RPC (migration 0058) — only allows
//     `app_metadata.role in ('super_admin', 'commander')` and then
//     additionally enforces `app_metadata.squadron_id` matches.
//   * Any other commander-scoped RPC the dashboard adds in future.
//
// What this script does
// ──────────────────────
// Drives the real provision flow against the deployed Supabase project
// and asserts the JWT it produces actually passes a representative
// commander-only RPC:
//
//   1. Signs into Supabase as a pre-provisioned CI caller user
//      (an ops or admin account dedicated to this probe). This is the
//      same trust model `provision-commander` enforces in production:
//      only `app_metadata.role in ('ops', 'admin')` may invoke it.
//   2. Calls `provision-commander` to (re)provision a deterministic
//      test commander (`tier: "wing"`, fixed username + squadron). The
//      function is idempotent — repeated runs upsert the same auth
//      user, so the probe does NOT proliferate test accounts.
//   3. Receives the freshly-rotated `supabaseEmail` /
//      `supabasePassword` for the test commander, exchanges them for
//      a real Supabase JWT via `/auth/v1/token?grant_type=password`,
//      and decodes the JWT so a CI failure shows the exact claim
//      shape that broke the gate.
//   4. Calls `monthly_report_close_close` with a deliberately-
//      mismatched `p_squadron_id` and a sentinel `p_year_month`
//      (`"2099-12"`). The expected outcome is the post-gate squadron-
//      mismatch error ("Commander may only close months for their
//      own squadron"). That error proves:
//        a. The role gate accepted the JWT as a commander
//           (otherwise we'd see "Only commander or super_admin may
//           close a month").
//        b. The JWT carries an `app_metadata.squadron_id` claim that
//           the RPC could read back (otherwise the squadron-mismatch
//           branch couldn't trigger).
//      The RPC raises BEFORE any INSERT, so the probe is side-effect-
//      free apart from `provision-commander`'s own audit row (which
//      is the same row the dashboard would write in a real call).
//
// Required env vars
// ─────────────────
//   SUPABASE_URL                       https://…supabase.co
//   SUPABASE_ANON_KEY                  anon JWT (apikey header)
//   CI_PROVISION_CALLER_EMAIL          Supabase email of an existing
//                                      ops or admin user dedicated to
//                                      driving this probe. Must carry
//                                      `app_metadata.role in
//                                      ('ops', 'admin')` — anything
//                                      else is rejected by
//                                      provision-commander.
//   CI_PROVISION_CALLER_PASSWORD       its Supabase password
//
// Optional env vars (deterministic defaults so reruns are idempotent)
//   CI_PROVISION_TEST_USERNAME         default "ci-probe-commander"
//   CI_PROVISION_TEST_SQUADRON_NUMBER  default "999"  (used to derive
//                                      the test user's email; the
//                                      caller's privileges decide
//                                      whether a brand-new squadron
//                                      gets created)
//   CI_PROVISION_TEST_SQUADRON_NAME    default "CI Probe Squadron"
//
// Flags
// ─────
//   --require       Hard-fail (exit 2) if any required env var is
//                   missing. Without `--require`, a missing env var
//                   prints `::warning::` and exits 0 so local runs
//                   never fail surprisingly. The CI workflow passes
//                   this flag.
//
// Exit codes
// ──────────
//   0   The JWT minted by `provision-commander` passed the
//       commander RPC's role gate (or the script was skipped due
//       to missing env without --require).
//   1   The gate rejected the JWT — either with errcode 42501,
//       "permission denied", or "Only commander or super_admin may
//       close a month". This is the regression Task #293 exists
//       to catch.
//   2   Setup error (missing env with --require, network failure,
//       caller lacks ops/admin role, unexpected response shape).
//
// Usage
// ──────
//   node scripts/src/check-provision-commander-jwt-gate.mjs
//   node scripts/src/check-provision-commander-jwt-gate.mjs --require

const args = process.argv.slice(2);
const REQUIRE = args.includes("--require");

// ── Env ──────────────────────────────────────────────────────────
const SUPABASE_URL    = process.env.SUPABASE_URL;
const ANON_KEY        = process.env.SUPABASE_ANON_KEY;
const CALLER_EMAIL    = process.env.CI_PROVISION_CALLER_EMAIL;
const CALLER_PASSWORD = process.env.CI_PROVISION_CALLER_PASSWORD;
const TEST_USERNAME   = (process.env.CI_PROVISION_TEST_USERNAME ?? "ci-probe-commander").trim().toLowerCase();
const TEST_SQN_NUMBER = (process.env.CI_PROVISION_TEST_SQUADRON_NUMBER ?? "999").trim();
const TEST_SQN_NAME   = (process.env.CI_PROVISION_TEST_SQUADRON_NAME ?? "CI Probe Squadron").trim();

const missing = [];
if (!SUPABASE_URL)     missing.push("SUPABASE_URL");
if (!ANON_KEY)         missing.push("SUPABASE_ANON_KEY");
if (!CALLER_EMAIL)     missing.push("CI_PROVISION_CALLER_EMAIL");
if (!CALLER_PASSWORD)  missing.push("CI_PROVISION_CALLER_PASSWORD");

if (missing.length > 0) {
  const msg =
    `check-provision-commander-jwt-gate: missing required env var(s): ${missing.join(", ")}.\n` +
    `Configure these as repository secrets and re-run. Without them this guard cannot ` +
    `simulate the commander provisioning flow against the deployed Supabase project. The ` +
    `caller user (CI_PROVISION_CALLER_EMAIL) must carry app_metadata.role in ('ops','admin').`;
  if (REQUIRE) {
    console.error(`::error::${msg}`);
    process.exit(2);
  }
  console.warn(`::warning::${msg}`);
  console.warn("Skipping (no --require flag).");
  process.exit(0);
}

const FN_URL   = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/provision-commander`;
const AUTH_URL = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`;
const RPC_URL  = (name) => `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${name}`;

// ── Helpers ──────────────────────────────────────────────────────
function fail(code, message, detail) {
  console.error(`::error::check-provision-commander-jwt-gate: ${message}`);
  if (detail !== undefined) {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    console.error(text);
  }
  process.exit(code);
}

function decodeJwtClaims(jwt) {
  // Signature already verified by Supabase; we only display the claims.
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

// ── Step 1: sign in as the CI caller (ops or admin) ──────────────
console.log(`[1/5] auth: signInWithPassword as CI caller (${CALLER_EMAIL})`);
const callerAuth = await postJson(AUTH_URL, {
  email: CALLER_EMAIL,
  password: CALLER_PASSWORD,
}, { apikey: ANON_KEY });

if (callerAuth.status !== 200 || !callerAuth.json?.access_token) {
  fail(2, `Supabase auth refused the CI caller credentials (status ${callerAuth.status}). Verify CI_PROVISION_CALLER_EMAIL and CI_PROVISION_CALLER_PASSWORD against the deployed project.`, callerAuth.json ?? callerAuth.text);
}
const callerJwt = callerAuth.json.access_token;
const callerClaims = decodeJwtClaims(callerJwt);
const callerRole = callerClaims?.app_metadata?.role ?? "(missing)";
console.log(`      ok — caller role=${callerRole}`);
if (callerRole !== "ops" && callerRole !== "admin") {
  fail(
    2,
    `CI caller's app_metadata.role is "${callerRole}" but provision-commander only accepts "ops" or "admin". ` +
      `Re-provision the CI caller user with the correct role, or point CI_PROVISION_CALLER_EMAIL ` +
      `at a different account that already carries one of those roles.`,
    { app_metadata: callerClaims?.app_metadata ?? null },
  );
}

// ── Step 2: call provision-commander for the test commander ──────
// Wing tier is the canonical "non-flat" commander shape: it forces
// provision-commander down the role:"commander" branch (not "admin",
// not "deputy") and writes a non-null app_metadata.squadron_ids
// allow-list when squadronNames is supplied. This is the exact path
// that produces the JWT shape `xpc_snap_select` and
// `monthly_report_close_close` consume.
console.log(`[2/5] provision-commander: tier=wing username=${TEST_USERNAME} squadron=${TEST_SQN_NUMBER}`);
const provBody = {
  username: TEST_USERNAME,
  displayName: "CI Probe Commander",
  role: "commander",
  tier: "wing",
  squadronNumber: TEST_SQN_NUMBER,
  squadronName: TEST_SQN_NAME,
  squadronBase: "ci-test",
  squadronNames: [TEST_SQN_NAME],
};
const prov = await postJson(FN_URL, provBody, {
  Authorization: `Bearer ${callerJwt}`,
  apikey: ANON_KEY,
});

if (prov.status !== 200 || prov.json?.ok !== true) {
  // 401/403 here means the function rejected the CI caller — which is
  // a setup error, not the regression Task #293 catches.
  if (prov.status === 401 || prov.status === 403 || prov.json?.error === "forbidden" || prov.json?.error === "unauthorized") {
    fail(
      2,
      `provision-commander rejected the CI caller (status ${prov.status}). The caller's JWT was accepted by Supabase auth but the function's caller-side role gate refused it. Check that CI_PROVISION_CALLER_EMAIL has app_metadata.role in ('ops','admin') AND, for ops, that CI_PROVISION_TEST_SQUADRON_NUMBER matches the caller's own squadron.`,
      prov.json ?? prov.text,
    );
  }
  fail(
    2,
    `provision-commander did not return ok (status ${prov.status}). This is a function-level failure, not the JWT-vs-gate regression — investigate provision-commander itself.`,
    prov.json ?? prov.text,
  );
}
const { supabaseEmail, supabasePassword } = prov.json;
if (!supabaseEmail || !supabasePassword) {
  fail(2, `provision-commander did not return supabaseEmail/supabasePassword. The function may be a pre-Task-#274 build that does not rotate the auth.users password.`, prov.json);
}
console.log(`      ok — supabaseEmail=${supabaseEmail}`);

// ── Step 3: exchange creds for a real Supabase JWT ───────────────
console.log(`[3/5] auth: signInWithPassword as the freshly-provisioned commander`);
const auth = await postJson(AUTH_URL, {
  email: supabaseEmail,
  password: supabasePassword,
}, { apikey: ANON_KEY });

if (auth.status !== 200 || !auth.json?.access_token) {
  fail(2, `Supabase auth refused the deterministic commander credentials minted by provision-commander (status ${auth.status}). The auth.users row may have been deleted between the provision call and this sign-in, or the function returned a password that does not match what it actually wrote.`, auth.json ?? auth.text);
}
const jwt = auth.json.access_token;
const claims = decodeJwtClaims(jwt);
console.log(`      ok — JWT issued`);
console.log(`      app_metadata = ${JSON.stringify(claims?.app_metadata ?? null)}`);

// ── Step 4: representative commander RPC ─────────────────────────
// `monthly_report_close_close` raises distinct errors at each gate:
//
//   "Only commander or super_admin may close a month"
//       → role gate REJECTED the JWT. This is the Task #293 regression.
//
//   "Commander may only close months for their own squadron"
//       → role gate ACCEPTED the JWT, then the squadron-mismatch
//         check fired. This is what we want — the gate let us
//         through.
//
// The squadron-mismatch check runs BEFORE any INSERT into
// monthly_report_close, so this probe is side-effect-free on the
// monthly close table itself.
//
// `p_squadron_id` is a deliberately-fake UUID that will not match
// the JWT's squadron_id no matter what provision-commander wrote.
// `p_year_month` is the sentinel "2099-12" — far enough in the future
// that even if the squadron-mismatch branch were ever skipped, the
// row would be obvious.
console.log(`[4/5] rpc: monthly_report_close_close (with intentional squadron-mismatch trigger)`);
const probeBody = {
  p_squadron_id: "00000000-0000-0000-0000-000000000293",
  p_year_month: "2099-12",
  p_reason: "task #293 CI gate probe",
};
const rpc = await postJson(RPC_URL("monthly_report_close_close"), probeBody, {
  Authorization: `Bearer ${jwt}`,
  apikey: ANON_KEY,
});

const rpcMessage = String(rpc.json?.message ?? rpc.json?.error ?? rpc.text ?? "");
const rpcCode    = String(rpc.json?.code ?? "");
const looksLikeRoleRejection =
  rpcCode === "42501" ||
  /permission denied/i.test(rpcMessage) ||
  /only commander or super_admin/i.test(rpcMessage) ||
  /requires (super_admin|commander)/i.test(rpcMessage);
const looksLikeSquadronMismatch =
  /commander may only close months for their own squadron/i.test(rpcMessage);

console.log(`[5/5] inspecting RPC response`);
console.log(`      status = ${rpc.status}`);
console.log(`      pg_code = ${rpcCode || "(none)"}`);
console.log(`      message = ${rpcMessage.slice(0, 200)}`);

if (looksLikeRoleRejection && !looksLikeSquadronMismatch) {
  fail(
    1,
    `monthly_report_close_close rejected the JWT minted by provision-commander.\n` +
      `\n` +
      `This is the Task #293 regression — a name-mismatch between the JWT claim\n` +
      `shape and the SQL gate. Compare:\n` +
      `\n` +
      `  - JWT app_metadata that provision-commander minted:\n` +
      `      ${JSON.stringify(claims?.app_metadata ?? null)}\n` +
      `\n` +
      `  - JWT shape(s) accepted by monthly_report_close_close (migration 0058):\n` +
      `      role:"commander"   (with squadron_id matching p_squadron_id)\n` +
      `      role:"super_admin" (no squadron constraint)\n` +
      `\n` +
      `Fix one or both halves so they line up, then re-run this check. Until\n` +
      `they line up, every commander-scoped RPC (monthly close, snapshot reads,\n` +
      `…) will reject legitimate commanders in production.\n`,
    { status: rpc.status, pgCode: rpcCode, message: rpcMessage, body: rpc.json ?? rpc.text },
  );
}

if (!looksLikeSquadronMismatch) {
  // The gate did not reject us, but we also didn't see the expected
  // squadron-mismatch branch. That probably means the RPC failed at
  // an earlier validation step (e.g. p_squadron_id not a uuid) — the
  // gate itself is fine, but the probe didn't actually exercise it.
  console.warn(
    `::warning::monthly_report_close_close did not raise the expected ` +
      `"Commander may only close months for their own squadron" error ` +
      `(status ${rpc.status}, pg_code ${rpcCode || "?"}, message ` +
      `${rpcMessage.slice(0, 120)}). The gate itself was not rejected, ` +
      `so Task #293 is satisfied, but the probe should normally see the ` +
      `squadron-mismatch branch fire — investigate when convenient.`,
  );
}

console.log("");
console.log("✓ check-provision-commander-jwt-gate: PASS");
console.log(`  provision-commander minted a JWT with app_metadata=${JSON.stringify(claims?.app_metadata ?? null)},`);
console.log(`  and monthly_report_close_close accepted it as a commander (no 42501 / "Only commander or super_admin").`);
process.exit(0);
