// artifacts/pilot-dashboard/supabase/audit/audit-mobile.mjs
//
// Mobile-pilot RLS audit, focused on the lockdown introduced in
// migration 0051_pilot_rls_lockdown.sql (task #177).
//
// Run locally:
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
//     node artifacts/pilot-dashboard/supabase/audit/audit-mobile.mjs
//
// Exits 0 when every assertion passes, 1 when any RLS check fails,
// 2 when setup itself errors (e.g. missing env vars). Suitable for
// wiring into CI after the migration apply step.
//
// Provisions two ad-hoc pilot rows in a single squadron, signs each
// one in via real Supabase auth (the same way the link-pilot-device
// edge function does — service-role create_user with
// `app_metadata.{pilot_id, squadron_id, role: 'pilot'}` then a
// password sign-in), and probes whether pilot A's session can mutate
// pilot B's rows across every table in scope:
//
//   pilots, sorties, notams, alerts, pilot_link_codes, pilot_devices
//
// Also re-runs the original audit's read probe (rls_other_pilot_blocked)
// and verifies the alerts_pilot_read scoping (the prior `using (true)`
// version leaked alerts across squadrons; the fix scopes them to the
// pilot's own squadron).
//
// All test fixtures are tagged with a unique audit run id and torn
// down at the end whether the audit passes or fails. The audit exits
// non-zero on any failure so it can be wired into CI.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const URL  = process.env.SUPABASE_URL;
const SRV  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
if (!URL || !SRV || !ANON) {
  console.error(
    "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY",
  );
  process.exit(2);
}

const admin = createClient(URL, SRV, { auth: { persistSession: false } });

const RUN_ID = `audit-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const tag    = (s) => `${RUN_ID}-${s}`;

const fixtures = {
  squadronId: null,
  squadronTag: tag("sq"),
  // pilots
  pilotA: { id: tag("PA"), authUserId: null, email: null, password: null, session: null },
  pilotB: { id: tag("PB"), authUserId: null },
  // a synthetic ops account in the same squadron so the positive
  // path (ops/admin can still UPDATE/DELETE in their squadron) is
  // exercised by a real RLS-bound JWT — not just service-role.
  ops:    { authUserId: null, email: null, password: null, session: null },
  // other rows in pilot B's name
  sortieB:    { id: null },
  notamB:     { id: null },
  alertB:     { id: null },
  linkCodeB:  { id: null },
  deviceB:    { id: null },
  // a 2nd squadron for cross-squadron alert-leak check
  otherSquadronId: null,
  otherAlertId:    null,
};

const results = [];
const record = (name, expected, got, pass, extra = {}) =>
  results.push({ name, expected, got, pass, ...extra });

async function setup() {
  // 1. Two squadrons (the run's own, and a second one for alert isolation).
  const { data: sqA, error: sqAerr } = await admin.from("squadrons").insert({
    number: fixtures.squadronTag,
    name:   "Audit Run Squadron",
    base:   "Audit",
  }).select("id").single();
  if (sqAerr) throw new Error(`squadron insert: ${sqAerr.message}`);
  fixtures.squadronId = sqA.id;

  const { data: sqB, error: sqBerr } = await admin.from("squadrons").insert({
    number: tag("sq2"),
    name:   "Audit Other Squadron",
    base:   "Audit",
  }).select("id").single();
  if (sqBerr) throw new Error(`other squadron insert: ${sqBerr.message}`);
  fixtures.otherSquadronId = sqB.id;

  // 2. Two pilots in the audit squadron.
  for (const key of ["pilotA", "pilotB"]) {
    const p = fixtures[key];
    const { error } = await admin.from("pilots").insert({
      id: p.id,
      squadron_id: fixtures.squadronId,
      rank: "Capt",
      name: `Audit ${key}`,
    });
    if (error) throw new Error(`pilot ${key} insert: ${error.message}`);
  }

  // 3. Auth users for each pilot, mirroring link-pilot-device's claim shape.
  for (const key of ["pilotA", "pilotB"]) {
    const p = fixtures[key];
    p.email = `${p.id.toLowerCase()}@audit.invalid`;
    p.password = randomUUID();
    const { data, error } = await admin.auth.admin.createUser({
      email: p.email,
      password: p.password,
      email_confirm: true,
      app_metadata: {
        pilot_id: p.id,
        squadron_id: fixtures.squadronId,
        role: "pilot",
      },
    });
    if (error) throw new Error(`auth create ${key}: ${error.message}`);
    p.authUserId = data.user.id;
    // Bind pilots.auth_user_id, same way link-pilot-device does.
    const { error: bindErr } = await admin.from("pilots")
      .update({ auth_user_id: p.authUserId })
      .eq("id", p.id);
    if (bindErr) throw new Error(`auth bind ${key}: ${bindErr.message}`);
  }

  // 4. Owned rows for pilot B that pilot A will try to overwrite.
  const { data: sortie, error: sortieErr } = await admin.from("sorties")
    .insert({
      squadron_id: fixtures.squadronId,
      pilot_id: fixtures.pilotB.id,
      date: new Date().toISOString().slice(0, 10),
      data: { audit: RUN_ID, owner: "B" },
    }).select("id").single();
  if (sortieErr) throw new Error(`sortie insert: ${sortieErr.message}`);
  fixtures.sortieB.id = sortie.id;

  const { data: notam, error: notamErr } = await admin.from("notams").insert({
    squadron_id: fixtures.squadronId,
    notam_no: tag("NTM"),
    body: "audit notam",
  }).select("id").single();
  if (notamErr) throw new Error(`notam insert: ${notamErr.message}`);
  fixtures.notamB.id = notam.id;

  const { data: alert, error: alertErr } = await admin.from("alerts").insert({
    squadron_id: fixtures.squadronId,
    body: `audit alert ${RUN_ID}`,
  }).select("id").single();
  if (alertErr) throw new Error(`alert insert: ${alertErr.message}`);
  fixtures.alertB.id = alert.id;

  // Alert in the *other* squadron — should NOT be visible to pilot A.
  const { data: alertOther, error: alertOtherErr } = await admin
    .from("alerts").insert({
      squadron_id: fixtures.otherSquadronId,
      body: `audit other-squadron alert ${RUN_ID}`,
    }).select("id").single();
  if (alertOtherErr) throw new Error(`other alert insert: ${alertOtherErr.message}`);
  fixtures.otherAlertId = alertOther.id;

  // Link code for pilot B (issued via the SECURITY DEFINER ops RPC would
  // require an ops session; insert directly with service role for
  // fixture purposes — RLS still applies to the audit's pilot session,
  // which is the side under test).
  const { data: code, error: codeErr } = await admin.from("pilot_link_codes")
    .insert({
      squadron_id: fixtures.squadronId,
      pilot_id: fixtures.pilotB.id,
      code_hash: "sha256-fixture",
    }).select("id").single();
  if (codeErr) throw new Error(`link code insert: ${codeErr.message}`);
  fixtures.linkCodeB.id = code.id;

  // Device row for pilot B (linked to B's auth user).
  const { data: dev, error: devErr } = await admin.from("pilot_devices")
    .insert({
      squadron_id: fixtures.squadronId,
      pilot_id: fixtures.pilotB.id,
      user_id: fixtures.pilotB.authUserId,
    }).select("id").single();
  if (devErr) throw new Error(`device insert: ${devErr.message}`);
  fixtures.deviceB.id = dev.id;

  // 5. Sign in pilot A as their phone would.
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({
    email: fixtures.pilotA.email,
    password: fixtures.pilotA.password,
  });
  if (signErr || !signIn?.session) {
    throw new Error(`pilot A sign-in: ${signErr?.message ?? "no session"}`);
  }
  fixtures.pilotA.session = signIn.session;

  // 6. Provision an ops auth user in the same squadron and sign in.
  // app_metadata mirrors what register-license / the ops admin path
  // writes for non-pilot squadron members: a squadron_id and a role
  // like 'ops' with NO pilot_id claim. This is the exact JWT shape
  // pilot_id() returns NULL for, so it should pass the new
  // "pilot_id() is null" branch in every locked-down _rw policy.
  fixtures.ops.email = `${tag("ops").toLowerCase()}@audit.invalid`;
  fixtures.ops.password = randomUUID();
  const { data: opsUser, error: opsErr } = await admin.auth.admin.createUser({
    email: fixtures.ops.email,
    password: fixtures.ops.password,
    email_confirm: true,
    app_metadata: {
      squadron_id: fixtures.squadronId,
      role: "ops",
    },
  });
  if (opsErr) throw new Error(`ops auth create: ${opsErr.message}`);
  fixtures.ops.authUserId = opsUser.user.id;
  // Mirror into public.users so any FK or join the policies might
  // rely on resolves; matches the shape register-license writes.
  await admin.from("users").upsert({
    id: fixtures.ops.authUserId,
    squadron_id: fixtures.squadronId,
    username: tag("ops").toLowerCase(),
    display_name: "Audit Ops",
    role: "ops",
  }, { onConflict: "id" });

  const opsAnon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: opsSignIn, error: opsSignErr } =
    await opsAnon.auth.signInWithPassword({
      email: fixtures.ops.email,
      password: fixtures.ops.password,
    });
  if (opsSignErr || !opsSignIn?.session) {
    throw new Error(`ops sign-in: ${opsSignErr?.message ?? "no session"}`);
  }
  fixtures.ops.session = opsSignIn.session;
}

function opsSupabase() {
  return createClient(URL, ANON, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${fixtures.ops.session.access_token}`,
      },
    },
  });
}

function pilotASupabase() {
  return createClient(URL, ANON, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${fixtures.pilotA.session.access_token}`,
      },
    },
  });
}

// A mutation is "blocked" when the result rejects — either a thrown
// error (RLS denied) OR a successful query with zero affected rows
// (PostgREST returns 200 + [] when the WHERE clause matches no rows
// the policy allows). Either outcome means the row pilot A targeted
// did not actually change.
async function expectMutationBlocked(label, builder, verify) {
  const { data, error } = await builder;
  const noRowsAffected = !error && Array.isArray(data) && data.length === 0;
  const denied = !!error;
  const blocked = denied || noRowsAffected;
  let confirmed = blocked;
  if (verify) {
    const { ok } = await verify();
    confirmed = blocked && ok;
  }
  record(
    label,
    "blocked or zero-row no-op",
    error
      ? `error: ${error.message}`
      : noRowsAffected
        ? "0 rows affected"
        : `mutated ${data?.length ?? 0} row(s)`,
    confirmed,
    { errorCode: error?.code ?? null },
  );
}

async function runProbes() {
  const sb = pilotASupabase();

  // Sanity: pilot A can read their own row.
  {
    const { data, error } = await sb.from("pilots")
      .select("id").eq("id", fixtures.pilotA.id).maybeSingle();
    record(
      "pilot A reads own pilot row",
      "row returned",
      error ? `error: ${error.message}` : (data ? "row" : "null"),
      !error && !!data,
    );
  }

  // Read of another pilot in the same squadron is intentionally
  // allowed (roster display) — see the audit's "Read leakage is
  // probably intentional" note. Migration 0051 preserves this with
  // the new `pilots_pilot_squadron_read` policy. The bug being
  // fixed is the WRITE side, asserted further down.
  {
    const { data, error } = await sb.from("pilots")
      .select("id").eq("id", fixtures.pilotB.id).maybeSingle();
    const otherVisible = !error && !!data;
    record(
      "pilot A reads pilot B row (squadron roster, intentional)",
      "row visible",
      error ? `error: ${error.message}` : (otherVisible ? "B visible" : "B hidden"),
      otherVisible,
    );
  }

  // ── Writes that MUST be blocked ──────────────────────────────────
  await expectMutationBlocked(
    "pilot A cannot UPDATE pilot B row",
    sb.from("pilots").update({ name: "HIJACKED" })
      .eq("id", fixtures.pilotB.id).select("id"),
    async () => {
      const { data } = await admin.from("pilots")
        .select("name").eq("id", fixtures.pilotB.id).single();
      return { ok: data?.name === "Audit pilotB" };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot DELETE pilot B row",
    sb.from("pilots").delete().eq("id", fixtures.pilotB.id).select("id"),
    async () => {
      const { data } = await admin.from("pilots")
        .select("id").eq("id", fixtures.pilotB.id).maybeSingle();
      return { ok: !!data };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot UPDATE pilot B sortie",
    sb.from("sorties").update({ data: { hijacked: true } })
      .eq("id", fixtures.sortieB.id).select("id"),
    async () => {
      const { data } = await admin.from("sorties")
        .select("data").eq("id", fixtures.sortieB.id).single();
      return { ok: data?.data?.owner === "B" };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot DELETE pilot B sortie",
    sb.from("sorties").delete().eq("id", fixtures.sortieB.id).select("id"),
    async () => {
      const { data } = await admin.from("sorties")
        .select("id").eq("id", fixtures.sortieB.id).maybeSingle();
      return { ok: !!data };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot UPDATE squadron NOTAM",
    sb.from("notams").update({ body: "HIJACKED" })
      .eq("id", fixtures.notamB.id).select("id"),
    async () => {
      const { data } = await admin.from("notams")
        .select("body").eq("id", fixtures.notamB.id).single();
      return { ok: data?.body === "audit notam" };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot DELETE squadron NOTAM",
    sb.from("notams").delete().eq("id", fixtures.notamB.id).select("id"),
    async () => {
      const { data } = await admin.from("notams")
        .select("id").eq("id", fixtures.notamB.id).maybeSingle();
      return { ok: !!data };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot UPDATE squadron ALERT",
    sb.from("alerts").update({ body: "HIJACKED" })
      .eq("id", fixtures.alertB.id).select("id"),
    async () => {
      const { data } = await admin.from("alerts")
        .select("body").eq("id", fixtures.alertB.id).single();
      return { ok: data?.body === `audit alert ${RUN_ID}` };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot DELETE squadron ALERT",
    sb.from("alerts").delete().eq("id", fixtures.alertB.id).select("id"),
    async () => {
      const { data } = await admin.from("alerts")
        .select("id").eq("id", fixtures.alertB.id).maybeSingle();
      return { ok: !!data };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot UPDATE pilot B link code",
    sb.from("pilot_link_codes").update({ consumed_at: new Date().toISOString() })
      .eq("id", fixtures.linkCodeB.id).select("id"),
    async () => {
      const { data } = await admin.from("pilot_link_codes")
        .select("consumed_at").eq("id", fixtures.linkCodeB.id).single();
      return { ok: data?.consumed_at === null };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot DELETE pilot B link code",
    sb.from("pilot_link_codes").delete()
      .eq("id", fixtures.linkCodeB.id).select("id"),
    async () => {
      const { data } = await admin.from("pilot_link_codes")
        .select("id").eq("id", fixtures.linkCodeB.id).maybeSingle();
      return { ok: !!data };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot UPDATE pilot B device row",
    sb.from("pilot_devices").update({ revoked_at: new Date().toISOString() })
      .eq("id", fixtures.deviceB.id).select("id"),
    async () => {
      const { data } = await admin.from("pilot_devices")
        .select("revoked_at").eq("id", fixtures.deviceB.id).single();
      return { ok: data?.revoked_at === null };
    },
  );

  await expectMutationBlocked(
    "pilot A cannot DELETE pilot B device row",
    sb.from("pilot_devices").delete()
      .eq("id", fixtures.deviceB.id).select("id"),
    async () => {
      const { data } = await admin.from("pilot_devices")
        .select("id").eq("id", fixtures.deviceB.id).maybeSingle();
      return { ok: !!data };
    },
  );

  // ── Positive ops path: real ops JWT, real RLS, real writes ─────
  // Provision an ops account in the same squadron (done in setup),
  // sign in, and confirm that ops UPDATE/DELETE against the same
  // pilot B-owned rows succeeds — proving the lockdown only narrowed
  // pilot sessions, not ops sessions. This is the direct positive
  // mirror of the negative cases above and runs entirely under RLS.
  const ops = opsSupabase();

  // UPDATE on a pilot row (no DELETE — pilot rows are squadron
  // bookkeeping; deleting them would break the rest of the audit).
  {
    const { data, error } = await ops.from("pilots")
      .update({ rank: "Maj" })
      .eq("id", fixtures.pilotB.id)
      .select("id");
    const ok = !error && Array.isArray(data) && data.length === 1;
    record(
      "ops session CAN UPDATE pilot row in own squadron",
      "1 row updated",
      error ? `error: ${error.message}`
        : Array.isArray(data) ? `${data.length} rows updated`
        : "no rows",
      ok,
    );
  }

  // UPDATE then DELETE on a sortie row.
  {
    const { data: upd, error: updErr } = await ops.from("sorties")
      .update({ data: { audit: RUN_ID, owner: "B", touched_by: "ops" } })
      .eq("id", fixtures.sortieB.id)
      .select("id");
    const updOk = !updErr && Array.isArray(upd) && upd.length === 1;
    record(
      "ops session CAN UPDATE sortie in own squadron",
      "1 row updated",
      updErr ? `error: ${updErr.message}`
        : Array.isArray(upd) ? `${upd.length} rows updated`
        : "no rows",
      updOk,
    );

    const { data: del, error: delErr } = await ops.from("sorties")
      .delete().eq("id", fixtures.sortieB.id).select("id");
    const delOk = !delErr && Array.isArray(del) && del.length === 1;
    record(
      "ops session CAN DELETE sortie in own squadron",
      "1 row deleted",
      delErr ? `error: ${delErr.message}`
        : Array.isArray(del) ? `${del.length} rows deleted`
        : "no rows",
      delOk,
    );
    if (delOk) fixtures.sortieB.id = null; // already gone, skip teardown
  }

  // UPDATE on the alert (and confirm it's still visible to ops).
  {
    const { data, error } = await ops.from("alerts")
      .update({ body: `audit alert ${RUN_ID} (touched by ops)` })
      .eq("id", fixtures.alertB.id)
      .select("id");
    const ok = !error && Array.isArray(data) && data.length === 1;
    record(
      "ops session CAN UPDATE alert in own squadron",
      "1 row updated",
      error ? `error: ${error.message}`
        : Array.isArray(data) ? `${data.length} rows updated`
        : "no rows",
      ok,
    );
  }

  // ── alerts_pilot_read scoping ────────────────────────────────────
  // Pilot A must NOT see alerts from a different squadron. The
  // previous policy was `using (true)` and would have leaked it.
  {
    const { data, error } = await sb.from("alerts")
      .select("id, body").eq("id", fixtures.otherAlertId).maybeSingle();
    const leaked = !error && !!data;
    record(
      "alerts_pilot_read does not leak across squadrons",
      "no row visible",
      leaked ? `LEAK: ${data.body}` : "hidden",
      !leaked,
    );
  }
  // ...but pilot A SHOULD see alerts in their own squadron.
  {
    const { data, error } = await sb.from("alerts")
      .select("id").eq("id", fixtures.alertB.id).maybeSingle();
    record(
      "alerts_pilot_read still serves own-squadron alerts",
      "own-squadron alert visible",
      error ? `error: ${error.message}` : (data ? "visible" : "hidden"),
      !error && !!data,
    );
  }
}

async function teardown() {
  // Delete in dependency order. Use service role; ignore errors.
  for (const table of ["pilot_devices", "pilot_link_codes", "alerts", "notams", "sorties"]) {
    if (table === "alerts") {
      await admin.from(table).delete().in("squadron_id", [
        fixtures.squadronId, fixtures.otherSquadronId,
      ]);
    } else if (fixtures.squadronId) {
      await admin.from(table).delete().eq("squadron_id", fixtures.squadronId);
    }
  }
  // Unbind first so the pilot row delete cascades cleanly.
  await admin.from("pilots").update({ auth_user_id: null })
    .in("id", [fixtures.pilotA.id, fixtures.pilotB.id]);
  await admin.from("pilots").delete()
    .in("id", [fixtures.pilotA.id, fixtures.pilotB.id]);
  for (const key of ["pilotA", "pilotB"]) {
    const id = fixtures[key].authUserId;
    if (id) await admin.auth.admin.deleteUser(id);
  }
  // Ops user + its public.users mirror.
  if (fixtures.ops.authUserId) {
    await admin.from("users").delete().eq("id", fixtures.ops.authUserId);
    await admin.auth.admin.deleteUser(fixtures.ops.authUserId);
  }
  for (const sq of [fixtures.squadronId, fixtures.otherSquadronId]) {
    if (sq) await admin.from("squadrons").delete().eq("id", sq);
  }
}

let exitCode = 0;
try {
  await setup();
  await runProbes();
} catch (e) {
  console.error("audit-mobile setup/run failed:", e?.message ?? e);
  exitCode = 2;
} finally {
  try { await teardown(); } catch { /* best-effort */ }
}

const failed = results.filter((r) => !r.pass);
const summary = {
  runId: RUN_ID,
  url: URL,
  finishedAt: new Date().toISOString(),
  totalChecks: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (failed.length > 0 && exitCode === 0) exitCode = 1;
process.exit(exitCode);
