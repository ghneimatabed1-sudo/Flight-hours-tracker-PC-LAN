// artifacts/pilot-dashboard/supabase/tests/test-schedchain-submit.mjs
//
// Audit N (Round 3) — Regression test for the schedule-chain
// submit-state-machine on xpc_schedule_shares.
//
// Migration 0056_schedchain_align_current_tier.sql widens the live
// CHECK constraint xpc_schedule_shares_current_tier_check to accept
// the lifecycle vocabulary (the same set the sibling status_check
// constraint already enumerates), so the canonical first state of
// the chain — `current_tier='submitted'` — finally inserts cleanly
// against production.
//
// Audit G (.local/reports/audit-2026-04-26-G-single-squadron.md,
// evidence audit-evidence/2026-04-26/evidence/G/g-driver.json,
// calc.scheduleChain6State) tried that exact insert and failed with
// `xpc_schedule_shares_current_tier_check`. Without an automated
// regression, a future migration could quietly tighten the
// constraint back to tier-only and the same insert would silently
// start failing for the next audit / DB-side state-machine driver.
//
// What this test does
// ───────────────────
// 1. Provisions an `AUD_FIX_N_<run>-…` cross-PC pair (xpc_registry
//    rows for the originating Squadron PC and the receiving Flight PC).
// 2. Inserts ONE schedule share with the canonical initial state:
//      current_tier = 'submitted'   ← the row Audit G could not write
//      status       = 'submitted'
//    Asserts the insert lands.
// 3. Walks the chain through every spec transition and asserts each
//    step succeeds:
//      submitted → reviewed   (Flight Cmdr forwards back up to Sqn)
//      reviewed  → edited     (Sqn returns edits)
//      edited    → submitted  (Originator resubmits revised rows)
//      submitted → held       (Sqn holds for clarification)
//      held      → rejected   (partial reject)
//      rejected  → submitted  (originator resubmits after fix)
//      submitted → reviewed   (re-forward up the chain)
//      reviewed  → approved   (final approve at the Wing tier)
//      approved  → draft      (terminal: dismissed back to a draft
//                              archive snapshot — proves the full
//                              lifecycle vocabulary is accepted)
// 4. Cleans up every `AUD_FIX_N_<run>-…` row — both on the happy
//    path and on assertion failure (the whole test runs as a single
//    DO block so RAISE rolls the entire transaction back).
//
// Required env (mirrors apply-supabase-migrations.yml):
//   SUPABASE_ACCESS_TOKEN — Supabase personal access token with DB
//                           write scope on PROJECT_REF.
//   PROJECT_REF           — Supabase project ref. REQUIRED so a local
//                           invocation cannot accidentally target prod
//                           just because a developer happens to have
//                           a long-lived access token in their shell.
//                           CI passes the prod ref explicitly via the
//                           workflow env block.
//
// Exit codes:
//   0  every transition succeeded.
//   1  one or more assertions failed (the failure list is printed).
//   2  setup/transport error (missing env, HTTP error, malformed body).
//      The wrapping DO block rolls back so prod is left clean.

const PROJECT_REF = process.env.PROJECT_REF;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error(
    "Missing SUPABASE_ACCESS_TOKEN env var (Supabase personal access token).",
  );
  process.exit(2);
}
if (!PROJECT_REF) {
  console.error(
    "Missing PROJECT_REF env var (Supabase project ref). " +
      "Set it explicitly to avoid targeting prod by accident; CI " +
      "supplies it via the workflow env block.",
  );
  process.exit(2);
}

const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

// Run-tag scopes every fixture id under AUD_FIX_N_<run>-… so two
// concurrent runs (and any pre-existing prod data) cannot collide.
const RUN = `AUD_FIX_N_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

function quoteLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

const SQL = `
do $body$
declare
  v_run        text := ${quoteLiteral(RUN)};
  v_share_id   text := v_run || '-SHARE';
  v_origin_id  text := v_run || '-ORIG';
  v_flight_id  text := 'FLIGHT:' || v_run || '-FLT';
  v_wing_id    text := 'WING:' || v_run || '-WING';
  v_failures   text[] := array[]::text[];
  v_count      int;
  -- Walk plan: (current_tier, status) pairs covering every lifecycle
  -- vocabulary value the widened constraint must accept. Each step
  -- runs as an UPDATE on the same row; the tier value rotates through
  -- the whole canonical set so a future tightening of the CHECK is
  -- guaranteed to trip a step.
  v_steps text[][] := array[
    array['reviewed','reviewed'],     -- Flight forwards back up to Sqn
    array['edited','edited'],         -- Sqn returns edits
    array['submitted','submitted'],   -- Originator resubmits
    array['held','held'],             -- Sqn holds for clarification
    array['rejected','rejected'],     -- Partial reject
    array['submitted','submitted'],   -- Originator resubmits after fix
    array['reviewed','reviewed'],     -- Re-forward up the chain
    array['approved','approved'],     -- Wing approves
    array['draft','draft']            -- Dismissed → archived as draft
  ];
  v_step text[];
  v_idx  int;
begin
  -- ─────────────────────────────────────────────────────────────────
  -- 1. Provision the cross-PC pair. xpc_registry rows are enough —
  --    the schedule share row carries its own origin/current ids and
  --    the autoclaim trigger is a no-op when auth.uid() is NULL
  --    (Management API context, not a logged-in browser).
  -- ─────────────────────────────────────────────────────────────────
  insert into public.xpc_registry (id, squadron_name, tier)
    values (v_origin_id, v_run || '-OriginSqn', 'squadron');
  insert into public.xpc_registry (id, squadron_name, tier)
    values (v_flight_id, v_run || '-OriginSqn', 'flight');
  insert into public.xpc_registry (id, squadron_name, tier)
    values (v_wing_id,   v_run || '-WingHQ',    'wing');

  -- ─────────────────────────────────────────────────────────────────
  -- 2. The Audit G failing assertion: insert a share with the
  --    canonical initial state current_tier='submitted'. This was the
  --    row Postgres rejected before migration 0056.
  -- ─────────────────────────────────────────────────────────────────
  begin
    insert into public.xpc_schedule_shares
      (id, flight_date, origin_squadron_id, origin_squadron_name,
       current_tier, current_pc_id, current_pc_name, status,
       rows, baseline_rows, history, chain_pc_ids)
    values
      (v_share_id, current_date,
       v_origin_id, v_run || '-OriginSqn',
       'submitted', v_flight_id, 'FlightCmdr',
       'submitted',
       '[]'::jsonb, '[]'::jsonb,
       jsonb_build_array(jsonb_build_object(
         'at',     now(),
         'by',     'audit-n',
         'tier',   'squadron',
         'action', 'submitted'
       )),
       array[v_origin_id, v_flight_id]);
  exception when check_violation then
    v_failures := array_append(v_failures,
      'INITIAL insert with current_tier=''submitted'' rejected by ' ||
      'CHECK constraint — migration 0056 not applied?');
  end;

  -- Confirm the row landed exactly as written.
  select count(*) into v_count
    from public.xpc_schedule_shares
   where id = v_share_id
     and current_tier = 'submitted'
     and status = 'submitted';
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('post-insert read-back found %s rows with current_tier=''submitted'' (expected 1)', v_count));
  end if;

  -- ─────────────────────────────────────────────────────────────────
  -- 3. Walk every transition. Each step UPDATEs current_tier and
  --    status together; on a CHECK failure we capture which step
  --    failed and keep walking so a single CI run lists every gap.
  -- ─────────────────────────────────────────────────────────────────
  v_idx := 0;
  foreach v_step slice 1 in array v_steps loop
    v_idx := v_idx + 1;
    begin
      update public.xpc_schedule_shares
         set current_tier = v_step[1],
             status       = v_step[2],
             updated_at   = now()
       where id = v_share_id;
    exception when check_violation then
      v_failures := array_append(v_failures,
        format('step %s update to current_tier=%L status=%L rejected by CHECK',
               v_idx, v_step[1], v_step[2]));
    end;

    -- Confirm the value actually persisted (an UPDATE that matched 0
    -- rows would silently succeed otherwise).
    select count(*) into v_count
      from public.xpc_schedule_shares
     where id = v_share_id
       and current_tier = v_step[1]
       and status       = v_step[2];
    if v_count <> 1 then
      v_failures := array_append(v_failures,
        format('step %s did not persist (current_tier=%L status=%L count=%s)',
               v_idx, v_step[1], v_step[2], v_count));
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────
  -- 4. Cleanup runs BEFORE the failure raise so a green run leaves
  --    nothing behind. On a red run the RAISE rolls the whole tx
  --    back, so the cleanup being undone is harmless — the seed
  --    inserts get rolled back too.
  -- ─────────────────────────────────────────────────────────────────
  delete from public.xpc_schedule_shares where id like v_run || '%';
  delete from public.xpc_registry        where id like v_run || '%'
                                            or id = v_flight_id
                                            or id = v_wing_id;

  if array_length(v_failures, 1) > 0 then
    raise exception 'schedule-chain submit walk FAILED: %',
      array_to_string(v_failures, ' | ');
  end if;

  raise notice 'schedule-chain submit walk PASSED (run=%)', v_run;
end
$body$;
`;

async function main() {
  const started = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: SQL }),
  });
  const elapsed = Date.now() - started;
  const text = await res.text();

  if (!res.ok) {
    console.error(
      `[task-262] HTTP ${res.status} after ${elapsed}ms`,
    );
    console.error(text);
    const m = /(schedule-chain submit walk FAILED:[^"\\]+)/i.exec(text);
    if (m) {
      console.error(`\nAssertion failure detail: ${m[1]}`);
      process.exit(1);
    }
    process.exit(2);
  }

  console.log(
    `[task-262] schedule-chain submit walk PASSED in ${elapsed}ms (run=${RUN})`,
  );
  // Belt-and-braces residue check: re-query for any AUD_FIX_N_* rows
  // that survived the cleanup. Any leftover means the test happy-path
  // didn't reach its DELETEs (e.g. an unexpected non-CHECK error
  // bubbled past the BEGIN/EXCEPTION blocks).
  const probe = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query:
        "select " +
        "  (select count(*) from public.xpc_schedule_shares where id like 'AUD_FIX_N_%') as shares, " +
        "  (select count(*) from public.xpc_registry        where id like 'AUD_FIX_N_%' or id like 'FLIGHT:AUD_FIX_N_%' or id like 'WING:AUD_FIX_N_%') as registry",
    }),
  });
  const probeBody = await probe.json().catch(() => null);
  const row = Array.isArray(probeBody) && probeBody[0] ? probeBody[0] : null;
  if (!row || Number(row.shares) !== 0 || Number(row.registry) !== 0) {
    console.error(
      `[task-262] residue check FAILED: ${JSON.stringify(probeBody)}`,
    );
    process.exit(1);
  }
  console.log(`[task-262] residue check PASSED (no AUD_FIX_N_* rows left)`);
}

main().catch((e) => {
  console.error("[task-262] unexpected error:", e?.stack ?? e);
  process.exit(2);
});
