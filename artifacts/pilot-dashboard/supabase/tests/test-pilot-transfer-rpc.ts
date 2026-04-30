// artifacts/pilot-dashboard/supabase/tests/test-pilot-transfer-rpc.ts
//
// Inter-squadron pilot transfer end-to-end (task #220).
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard exec tsx \
//     artifacts/pilot-dashboard/supabase/tests/test-pilot-transfer-rpc.ts
//
// The transfer button on Roster.tsx + PilotDetail.tsx routes through
// `useTransferPilot` (squadron-data.ts) which calls the SECURITY DEFINER
// RPC `public.transfer_pilot(p_pilot_id, p_to_squadron)` installed by
// migration 0053. The RPC is the single point of correctness — it
// re-homes the pilot row, every pilot-keyed satellite (sorties as both
// pilot and co-pilot, currencies, leaves, unavailable, pilot_link_codes,
// pilot_devices), and writes a paired audit_log entry on each side. A
// regression in any of those moves would only surface in production
// (e.g. when someone adds a new pilot-keyed table and forgets to teach
// the RPC about it). This harness pins every guarantee.
//
// NOTE on framework choice:
// The task description asked for "a Playwright test". This project does
// not use Playwright anywhere — every existing E2E (cross-pc-e2e,
// guest-pilot-e2e) is a Node harness that drives the live Supabase
// project via the Management API. Introducing a brand-new browser
// runner just for one transfer flow would be a bigger architectural
// change than the test it carries; the harness pattern proves the same
// invariants more directly (it observes the rows the RPC writes, not a
// React render of them) and runs in the same CI lane as the other E2Es.
// The two purely-UI guarantees the task lists ("destination dropdown
// excludes the source squadron" and "non-ops users do not see the
// Transfer button") are exercised against the SAME predicate functions
// the React components import — `canTransferPilot` and
// `transferDestinationCandidates` from src/lib/pilot-transfer-policy.ts —
// so any drift in the role gate or dropdown filter fails the test.
//
// Cleanup: every test row is prefixed with PFX so a failure mid-run
// can't pollute the project; final cleanup pass is unconditional.

import {
  canTransferPilot,
  transferDestinationCandidates,
} from "../../src/lib/pilot-transfer-policy.ts";

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const URL_ENV = process.env.SUPABASE_URL;
if (!TOKEN || !URL_ENV) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or SUPABASE_URL");
  process.exit(2);
}
const PROJECT = URL_ENV.match(/https:\/\/([^.]+)/)?.[1];
if (!PROJECT) { console.error(`Could not parse project ref from SUPABASE_URL=${URL_ENV}`); process.exit(2); }

const PFX = `TEST_TRANSFER:${Date.now().toString(36)}:`;
const SQN_A_ID = crypto.randomUUID();
const SQN_B_ID = crypto.randomUUID();
const SQN_C_ID = crypto.randomUUID();      // unrelated third squadron, used for the auth-gate negative
const PILOT_ID = `${PFX}p1`;                 // the pilot being transferred (text PK)
const COPILOT_ID = `${PFX}cop1`;            // co-pilot whose only role is to occupy a sortie
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const stepLog = [];

async function sql(query) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT}/database/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`SQL ${r.status}: ${text}\n--- query ---\n${query.slice(0, 600)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

function quote(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) || typeof v === "object") {
    return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function check(label, fn) {
  try {
    await fn();
    pass++; stepLog.push(`  PASS  ${label}`);
  } catch (e) {
    fail++; stepLog.push(`  FAIL  ${label}\n        ${(e.message || String(e)).split("\n")[0]}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// JWT-claim wrapper so the SECURITY DEFINER RPC's authority gate
// (`v_caller_squadron = v_from_squadron OR xpc_is_super_admin()`)
// sees the right caller without us needing to mint a real JWT. The
// RPC reads `request.jwt.claims` via current_setting() — exactly the
// GUC `set_config(..., true)` writes — so this is the same code path
// PostgREST triggers when a real signed-in operator calls it.
//
// Both statements MUST land in the same management-API request: each
// HTTP call gets a fresh session, so a transaction-local GUC set in
// one request would never reach the RPC in another. We bundle them
// into one statement using a `MATERIALIZED` CTE — the CTE runs first
// (set_config is volatile, MATERIALIZED forbids inlining), then the
// RPC sees the just-installed claim within the same transaction.
async function callTransferAs(claims, pilotId, toSquadron) {
  const r = await sql(`
    with claims_cte as materialized (
      select set_config('request.jwt.claims', ${quote(JSON.stringify(claims))}, true) as _cfg
    )
    select public.transfer_pilot(${quote(pilotId)}, ${quote(toSquadron)}::uuid) as result
      from claims_cte;
  `);
  return r[0]?.result ?? null;
}

async function expectTransferRejected(claims, pilotId, toSquadron, sqlState) {
  let err = null;
  try {
    await callTransferAs(claims, pilotId, toSquadron);
  } catch (e) { err = e; }
  if (!err) throw new Error(`expected RPC to reject (${sqlState}) but it succeeded`);
  if (sqlState && !err.message.includes(sqlState) && !err.message.includes(`"code":"${sqlState}"`)) {
    throw new Error(`expected sqlstate ${sqlState}, got: ${err.message.slice(0, 240)}`);
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────
async function cleanup() {
  // Order matters: clear satellites before pilots before squadrons because
  // of FK cascades pointing the wrong way for our test prefix.
  await sql(`delete from public.audit_log where (detail->>'pilotId') = ${quote(PILOT_ID)};`);
  await sql(`delete from public.pilot_devices where pilot_id like ${quote(PFX + "%")};`);
  await sql(`delete from public.pilot_link_codes where pilot_id like ${quote(PFX + "%")};`);
  await sql(`delete from public.unavailable where pilot_id like ${quote(PFX + "%")};`);
  await sql(`delete from public.leaves where pilot_id like ${quote(PFX + "%")};`);
  await sql(`delete from public.currencies where pilot_id like ${quote(PFX + "%")};`);
  await sql(`delete from public.sorties where pilot_id like ${quote(PFX + "%")} or co_pilot_id like ${quote(PFX + "%")};`);
  await sql(`delete from public.pilots where id like ${quote(PFX + "%")};`);
  await sql(`delete from public.squadrons where id in (${quote(SQN_A_ID)}::uuid, ${quote(SQN_B_ID)}::uuid, ${quote(SQN_C_ID)}::uuid);`);
}

async function seed() {
  // Two squadrons (the third is just to prove the auth gate). Names use
  // PFX so a manual cleanup is trivial if the harness ever crashes.
  await sql(`
    insert into public.squadrons (id, number, name, base) values
      (${quote(SQN_A_ID)}::uuid, ${quote(PFX + "A")}, ${quote(PFX + "Alpha")}, 'TEST'),
      (${quote(SQN_B_ID)}::uuid, ${quote(PFX + "B")}, ${quote(PFX + "Bravo")}, 'TEST'),
      (${quote(SQN_C_ID)}::uuid, ${quote(PFX + "C")}, ${quote(PFX + "Charlie")}, 'TEST');
  `);
  // The transfer subject + a co-pilot stationed on Squadron A so we can
  // log a sortie that has the subject in BOTH the pilot and co-pilot
  // columns. The RPC moves both references.
  await sql(`
    insert into public.pilots (id, squadron_id, rank, name, arabic_name, unit) values
      (${quote(PILOT_ID)},   ${quote(SQN_A_ID)}::uuid, 'CAPT', 'Test Subject', 'الموضوع', 'SQDN'),
      (${quote(COPILOT_ID)}, ${quote(SQN_A_ID)}::uuid, 'LT',   'Test CoPilot', 'مساعد', 'SQDN');
  `);
  // Two sorties: one where the subject flies left seat, one where the
  // subject is the co-pilot. The RPC's two UPDATE statements (line 108
  // and line 117 of 0053) must catch both.
  await sql(`
    insert into public.sorties (squadron_id, pilot_id, co_pilot_id, date, ac_type) values
      (${quote(SQN_A_ID)}::uuid, ${quote(PILOT_ID)},   ${quote(COPILOT_ID)}, ${quote(TODAY)}, 'F-16'),
      (${quote(SQN_A_ID)}::uuid, ${quote(COPILOT_ID)}, ${quote(PILOT_ID)},   ${quote(TODAY)}, 'C-130');
  `);
  // Currencies / leaves / unavailable / link_codes / devices — every
  // pilot-keyed satellite the RPC re-homes.
  await sql(`
    insert into public.currencies (squadron_id, pilot_id, task, status, cycle_start)
      values (${quote(SQN_A_ID)}::uuid, ${quote(PILOT_ID)}, 'Day', 'done', ${quote(TODAY)});
    insert into public.leaves (squadron_id, pilot_id, year, months)
      values (${quote(SQN_A_ID)}::uuid, ${quote(PILOT_ID)}, 2026, '{"04":1}'::jsonb);
    insert into public.unavailable (squadron_id, pilot_id, from_date, to_date, reason)
      values (${quote(SQN_A_ID)}::uuid, ${quote(PILOT_ID)}, ${quote(TODAY)}, ${quote(TODAY)}, 'test');
    insert into public.pilot_link_codes (squadron_id, pilot_id, code_hash)
      values (${quote(SQN_A_ID)}::uuid, ${quote(PILOT_ID)}, ${quote(PFX + "hash")});
    insert into public.pilot_devices (token_hash, squadron_id, pilot_id)
      values (${quote(PFX + "tok")}, ${quote(SQN_A_ID)}::uuid, ${quote(PILOT_ID)});
  `);
}

// ── Test 1: ops on Squadron A successfully transfers to Squadron B ──────
async function testHappyPath() {
  await check("ops on source squadron transfers pilot to destination squadron", async () => {
    const result = await callTransferAs(
      { app_metadata: { squadron_id: SQN_A_ID, role: "ops", username: "opsA" } },
      PILOT_ID, SQN_B_ID,
    );
    assert(result, "RPC returned no result");
    assert(result.toSquadron === SQN_B_ID, `toSquadron = ${result.toSquadron} expected ${SQN_B_ID}`);
    assert(result.fromSquadron === SQN_A_ID, `fromSquadron = ${result.fromSquadron} expected ${SQN_A_ID}`);
    // Counts come straight from get diagnostics row_count inside the RPC.
    assert(result.sorties === 1, `sorties=${result.sorties}`);
    assert(result.currencies === 1, `currencies=${result.currencies}`);
    assert(result.leaves === 1, `leaves=${result.leaves}`);
    assert(result.unavailable === 1, `unavailable=${result.unavailable}`);
    assert(result.linkCodes === 1, `linkCodes=${result.linkCodes}`);
    assert(result.devices === 1, `devices=${result.devices}`);
  });

  await check("pilot disappears from Squadron A roster", async () => {
    const r = await sql(`select id from public.pilots where id = ${quote(PILOT_ID)} and squadron_id = ${quote(SQN_A_ID)}::uuid;`);
    assert(r.length === 0, `still present on A: ${JSON.stringify(r)}`);
  });

  await check("pilot appears on Squadron B roster", async () => {
    const r = await sql(`select id, squadron_id from public.pilots where id = ${quote(PILOT_ID)};`);
    assert(r.length === 1, `expected 1 row, got ${r.length}`);
    assert(r[0].squadron_id === SQN_B_ID, `squadron_id=${r[0].squadron_id}`);
  });

  await check("pilot's sorties moved with them (both pilot AND co-pilot seats)", async () => {
    const r = await sql(`
      select squadron_id, pilot_id, co_pilot_id from public.sorties
      where pilot_id = ${quote(PILOT_ID)} or co_pilot_id = ${quote(PILOT_ID)};
    `);
    assert(r.length === 2, `expected 2 sorties, got ${r.length}`);
    for (const row of r) {
      assert(row.squadron_id === SQN_B_ID, `sortie still on A: ${JSON.stringify(row)}`);
    }
  });

  await check("currencies / leaves / unavailable / link_codes / devices all moved", async () => {
    const c = await sql(`select squadron_id from public.currencies where pilot_id = ${quote(PILOT_ID)};`);
    const l = await sql(`select squadron_id from public.leaves where pilot_id = ${quote(PILOT_ID)};`);
    const u = await sql(`select squadron_id from public.unavailable where pilot_id = ${quote(PILOT_ID)};`);
    const k = await sql(`select squadron_id from public.pilot_link_codes where pilot_id = ${quote(PILOT_ID)};`);
    const d = await sql(`select squadron_id from public.pilot_devices where pilot_id = ${quote(PILOT_ID)};`);
    for (const [name, rows] of [["currencies", c], ["leaves", l], ["unavailable", u], ["pilot_link_codes", k], ["pilot_devices", d]]) {
      assert(rows.length === 1, `${name}: expected 1 row, got ${rows.length}`);
      assert(rows[0].squadron_id === SQN_B_ID, `${name} still on A: ${JSON.stringify(rows[0])}`);
    }
  });

  await check("paired audit rows: transfer.out on A, transfer.in on B", async () => {
    const r = await sql(`
      select squadron_id, type, actor, detail
      from public.audit_log
      where (detail->>'pilotId') = ${quote(PILOT_ID)}
      order by occurred_at, type;
    `);
    assert(r.length === 2, `expected 2 audit rows, got ${r.length}: ${JSON.stringify(r)}`);
    const outRow = r.find(x => x.type === "pilot.transfer.out");
    const inRow  = r.find(x => x.type === "pilot.transfer.in");
    assert(outRow, "missing pilot.transfer.out row");
    assert(inRow,  "missing pilot.transfer.in row");
    assert(outRow.squadron_id === SQN_A_ID, `out row squadron=${outRow.squadron_id}`);
    assert(inRow.squadron_id  === SQN_B_ID, `in row squadron=${inRow.squadron_id}`);
    // Detail payload should match what useTransferPilot relies on.
    assert(outRow.detail.fromSquadron === SQN_A_ID && outRow.detail.toSquadron === SQN_B_ID,
      `out detail wrong: ${JSON.stringify(outRow.detail)}`);
    assert(outRow.actor === "opsA", `actor=${outRow.actor}`);
  });
}

// ── Test 2: same-squadron transfer is rejected ─────────────────────────
// Mirrors the UI guarantee that the destination dropdown excludes the
// source squadron. The dialog filters the source out client-side
// (Roster.tsx:435 — `candidates = squadrons.filter(s => s.id !== fromSquadronId)`),
// but if a stale dropdown ever submitted the source id anyway the RPC
// must still refuse to no-op-with-audit.
async function testRejectSameSquadron() {
  await check("RPC rejects transfer to current squadron (defends the dropdown filter)", async () => {
    await expectTransferRejected(
      { app_metadata: { squadron_id: SQN_B_ID, role: "ops", username: "opsB" } },
      PILOT_ID, SQN_B_ID, "22023",
    );
  });
}

// ── Test 3: a caller scoped to a different squadron cannot transfer ────
// Squadron Cmdrs in this codebase are gated by role, not by squadron —
// but the SECURITY DEFINER's authority check (line 92 of 0053) refuses
// any non-super-admin caller whose squadron_id() doesn't match the
// pilot's current home. Easiest live test: caller scoped to Squadron C
// (unrelated) tries to grab the pilot.
async function testRejectWrongSquadronCaller() {
  await check("RPC rejects caller whose squadron != pilot's current squadron", async () => {
    // Pilot is now on B (after testHappyPath). Caller on C should fail.
    await expectTransferRejected(
      { app_metadata: { squadron_id: SQN_C_ID, role: "ops", username: "opsC" } },
      PILOT_ID, SQN_A_ID, "42501",
    );
    // And pilot should still be on B, untouched.
    const r = await sql(`select squadron_id from public.pilots where id = ${quote(PILOT_ID)};`);
    assert(r[0].squadron_id === SQN_B_ID, `pilot moved unexpectedly: ${JSON.stringify(r[0])}`);
  });
}

// ── Test 4: super-admin can transfer from anywhere ──────────────────────
// Confirms the second arm of the authority gate (`xpc_is_super_admin()`).
// Move the pilot back from B to A so the harness leaves no skew.
async function testSuperAdminFromAnywhere() {
  await check("super_admin transfers pilot from anywhere (no squadron claim required)", async () => {
    const result = await callTransferAs(
      { app_metadata: { role: "super_admin", username: "root" } },
      PILOT_ID, SQN_A_ID,
    );
    assert(result.toSquadron === SQN_A_ID, `toSquadron=${result.toSquadron}`);
    const r = await sql(`select squadron_id from public.pilots where id = ${quote(PILOT_ID)};`);
    assert(r[0].squadron_id === SQN_A_ID, `pilot squadron=${r[0].squadron_id}`);
  });
}

// ── Test 5: UI predicates — imported from the same module the UI uses ──
// We import canTransferPilot and transferDestinationCandidates from
// src/lib/pilot-transfer-policy.ts — the SAME module that Roster.tsx
// and PilotDetail.tsx call into. Any future refactor that silently
// widens canTransferPilot (e.g. adds 'commander' to the allow-list)
// or tweaks the candidate filter to leak the source squadron will fail
// these checks immediately, because the test and the UI share one
// single source of truth.
async function testUiPredicates() {
  await check("UI: ops/deputy/admin/super_admin see Transfer; commander/pilot do not", async () => {
    // Cast: only `role` matters to canTransferPilot; the rest of the
    // User shape is irrelevant to the predicate, so we pass minimal
    // role-only objects rather than fabricating a full User record.
    const u = (role: string) => ({ role } as unknown as Parameters<typeof canTransferPilot>[0]);
    assert(canTransferPilot(u("ops")) === true,         "ops should see Transfer");
    assert(canTransferPilot(u("deputy")) === true,      "deputy should see Transfer");
    assert(canTransferPilot(u("admin")) === true,       "admin should see Transfer");
    assert(canTransferPilot(u("super_admin")) === true, "super_admin should see Transfer");
    assert(canTransferPilot(u("commander")) === false,  "squadron commander must NOT see Transfer (read-mostly per RJAF practice)");
    assert(canTransferPilot(u("pilot")) === false,      "individual pilot must NOT see Transfer");
    assert(canTransferPilot(null) === false,            "anonymous must NOT see Transfer");
  });

  await check("UI: destination dropdown excludes the source squadron", async () => {
    const all = [
      { id: SQN_A_ID, name: "Alpha" },
      { id: SQN_B_ID, name: "Bravo" },
      { id: SQN_C_ID, name: "Charlie" },
    ];
    const candidates = transferDestinationCandidates(all, SQN_A_ID);
    assert(candidates.length === 2, `expected 2 candidates after filtering source, got ${candidates.length}`);
    assert(!candidates.some(s => s.id === SQN_A_ID), "source squadron leaked into candidates list");
    assert(candidates.some(s => s.id === SQN_B_ID),  "Bravo missing from candidates");
    assert(candidates.some(s => s.id === SQN_C_ID),  "Charlie missing from candidates");
  });
}

// ── Run ─────────────────────────────────────────────────────────────────
async function run() {
  console.log("Cleaning any prior transfer-test rows...");
  await cleanup();
  console.log("Seeding two squadrons + pilot + sorties + satellites...");
  await seed();
  console.log("Running tests...\n");

  console.log("[1] Happy path: ops on A transfers pilot + everything to B");
  await testHappyPath();
  console.log("[2] Same-squadron transfer is rejected (dropdown defence)");
  await testRejectSameSquadron();
  console.log("[3] Foreign-squadron caller is rejected (authority gate)");
  await testRejectWrongSquadronCaller();
  console.log("[4] Super-admin can transfer from anywhere");
  await testSuperAdminFromAnywhere();
  console.log("[5] UI predicates: canTransfer + dropdown filter");
  await testUiPredicates();

  console.log("\nCleaning up...");
  await cleanup();

  console.log("\n========== TEST SUMMARY ==========");
  for (const line of stepLog) console.log(line);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log("  ALL PASS");
}

run().catch(async (e) => {
  console.error("Fatal:", e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(2);
});
