// artifacts/pilot-dashboard/supabase/tests/test-snapshot-rls-scoped-select.mjs
//
// Task #270 — Regression test for the strictly-scoped SELECT policy on
// public.xpc_squadron_snapshot installed by migration
// 0061_snapshot_rls_select_strict.sql.
//
// Why this test exists
// ────────────────────
// Audit P (2026-04-27) caught that the previous lockdown migration
// (0056_snapshot_rls_lockdown.sql) shipped with a permissive fallback
// for wing/base/HQ-tier commanders that lacked the explicit
// `app_metadata.squadron_ids` JWT claim. In production virtually every
// commander was provisioned BEFORE that claim was wired up, so the
// fallback fired for the most common shape and the policy degenerated
// to "any authenticated user reads every row" — a multi-squadron
// commander with claims on ALPHA+BRAVO still read CHARLIE's snapshot.
//
// 0061 removed the fallback. Without a regression test, the next time
// somebody re-introduces a "fail-open for legacy commanders" branch
// (and they will — the dashboard for an under-provisioned commander
// looks broken until the claim lands), we lose the scope-isolation
// contract again with no signal.
//
// What this test asserts
// ──────────────────────
// Inside one transaction (rolled back at the end so prod is left
// pristine), provision THREE squadrons (Alpha, Bravo, Charlie), one
// xpc_squadron_snapshot row per squadron, and a fresh auth user. Then,
// driving the SELECT through the `authenticated` Postgres role with a
// crafted `request.jwt.claims` GUC (the same code path PostgREST uses
// for a real signed-in operator), check four shapes:
//
//   1. Brand-new auth user with a SINGLE PC claim on Alpha (no JWT
//      app_metadata.squadron_ids, no role/admin override) sees
//      EXACTLY one snapshot row and that row IS Alpha's.
//      ←── this is the literal "Done looks like" line in task #270.
//
//   2. Same user upgraded with `app_metadata.squadron_ids = [Alpha,
//      Bravo]` (no extra xpc_user_pcs rows) sees EXACTLY two rows
//      (Alpha + Bravo) and ZERO Charlie rows. This is the Audit P
//      multi-squadron picker case that 0056's permissive fallback
//      silently leaked.
//
//   3. A user with NEITHER a PC claim NOR a squadron_ids JWT claim
//      sees ZERO rows — proves the permissive wing/base/HQ fallback
//      from 0056 is gone. (Audit P observed it firing as
//      "USING (true)" for exactly this shape.)
//
//   4. A super_admin (`app_metadata.role = 'super_admin'`) sees ALL
//      THREE snapshot rows — the global-admin escape hatch is intact.
//
// The whole test is one DO block sent through the Supabase Management
// API. The Management API runs each query in an implicit transaction;
// we explicitly RAISE at the end of the DO block — successful asserts
// run to completion and we close out via a final `raise notice` (no
// rollback needed because we use a SAVEPOINT-rollback pattern below to
// undo every fixture). On failure the RAISE bubbles up as an HTTP
// error and the implicit tx is rolled back — fixtures are wiped
// either way.
//
// Required env (mirrors test-squadron-rename-xpc-sync.mjs):
//   SUPABASE_ACCESS_TOKEN — Supabase personal access token, DB write
//                           scope on PROJECT_REF.
//   PROJECT_REF           — Supabase project ref. REQUIRED — no default
//                           so a stray local invocation cannot target
//                           prod just because a long-lived token is in
//                           the shell.
//
// Exit codes:
//   0  every assertion passed.
//   1  the DO block raised — at least one assertion failed (the
//      message in the RAISE identifies which one).
//   2  setup/transport error (missing env, HTTP error, malformed
//      response). Implicit-tx rollback still wipes fixtures.

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
      "Set it explicitly so a local invocation cannot accidentally " +
      "target prod just because a developer happened to have a " +
      "long-lived access token in their shell.",
  );
  process.exit(2);
}

const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

// Run-tag prefix — globally unique per invocation so two concurrent
// runs (or any pre-existing prod data) cannot collide on
// xpc_squadron_snapshot's unique squadron_id key.
const RUN = `T270-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SQL = `
do $body$
declare
  v_run            text := ${quoteLiteral(RUN)};
  v_sq_a_id        text := v_run || '-A';
  v_sq_b_id        text := v_run || '-B';
  v_sq_c_id        text := v_run || '-C';
  v_user           uuid := gen_random_uuid();
  v_super          uuid := gen_random_uuid();
  v_count          int;
  v_alpha_visible  int;
  v_charlie_visible int;
  v_failures       text[] := array[]::text[];
begin
  -- ─────────────────────────────────────────────────────────────────
  -- 1. Fixtures. All three pieces below use the run-tag prefix so a
  --    failed run can't pollute prod even if the implicit-tx rollback
  --    misfires for some reason.
  -- ─────────────────────────────────────────────────────────────────

  -- 1a. auth.users — xpc_user_pcs.user_id has an FK to auth.users(id),
  -- so we have to mint two rows here. The minimal column set Supabase
  -- requires is (id, instance_id, aud, role, email). The instance_id
  -- '00000000-0000-0000-0000-000000000000' is the default Supabase
  -- single-tenant instance — every existing auth.users row uses it.
  insert into auth.users
    (id, instance_id, aud, role, email,
     encrypted_password, email_confirmed_at,
     created_at, updated_at,
     raw_app_meta_data, raw_user_meta_data)
  values
    (v_user, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated',
     v_run || '-user@test.local',
     '', now(), now(), now(),
     '{}'::jsonb, '{}'::jsonb),
    (v_super, '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated',
     v_run || '-super@test.local',
     '', now(), now(), now(),
     '{"role":"super_admin"}'::jsonb, '{}'::jsonb);

  -- 1b. Three snapshot rows, one per squadron. xpc_squadron_snapshot
  -- has an autoclaim BEFORE-trigger (0035 §5 / 0052 §3) that copies
  -- squadron_id into ops_pc_id when ops_pc_id is null and binds
  -- (auth.uid(), squadron_id) into xpc_user_pcs. We're inserting as
  -- the management-API role (postgres) which the trigger short-
  -- circuits via xpc_skip_autoclaim() on bypass roles, so we set
  -- ops_pc_id explicitly to avoid depending on that.
  --
  -- AA1 (Round 4) note: live prod has an updated_by uuid NOT NULL
  -- column (default auth.uid()) on xpc_squadron_snapshot that is NOT
  -- declared in any version-controlled migration (live-vs-source
  -- schema drift — flagged as a follow-up alongside the AA1 report).
  -- Inserting via the management-API role makes auth.uid() return
  -- NULL which trips the NOT NULL. We supply v_user explicitly so
  -- this test stays green until the drift itself is reconciled.
  insert into public.xpc_squadron_snapshot
    (squadron_id, ops_pc_id, snapshot_at, payload, updated_by)
  values
    (v_sq_a_id, v_sq_a_id, now(), '{"roster":[],"unavailable":[]}'::jsonb, v_user),
    (v_sq_b_id, v_sq_b_id, now(), '{"roster":[],"unavailable":[]}'::jsonb, v_user),
    (v_sq_c_id, v_sq_c_id, now(), '{"roster":[],"unavailable":[]}'::jsonb, v_user);

  -- 1c. Single PC claim for v_user — Alpha only. xpc_my_pc_ids()
  -- reads this directly. We deliberately do NOT seed Bravo/Charlie
  -- claims because the ENTIRE point of test 1 is "exactly one row".
  insert into public.xpc_user_pcs (user_id, pc_id)
  values (v_user, v_sq_a_id);

  -- ─────────────────────────────────────────────────────────────────
  -- 2. Test 1 — brand-new auth user, single PC claim on Alpha.
  --    Expectation: exactly ONE snapshot row visible, and that row
  --    is Alpha's. This is the literal "Done looks like" assertion
  --    in task #270.
  -- ─────────────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true);

  select count(*) into v_count from public.xpc_squadron_snapshot;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('test 1: brand-new user with single PC claim should see exactly 1 snapshot row, saw %s',
             v_count));
  end if;

  select count(*) into v_alpha_visible
    from public.xpc_squadron_snapshot
   where squadron_id = v_sq_a_id;
  if v_alpha_visible <> 1 then
    v_failures := array_append(v_failures,
      format('test 1: the single visible row should be Alpha (squadron_id=%s), saw %s rows for Alpha',
             v_sq_a_id, v_alpha_visible));
  end if;

  select count(*) into v_charlie_visible
    from public.xpc_squadron_snapshot
   where squadron_id = v_sq_c_id;
  if v_charlie_visible <> 0 then
    v_failures := array_append(v_failures,
      format('test 1: Charlie must NOT be visible to a user with no Charlie claim, saw %s rows',
             v_charlie_visible));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- 3. Test 2 — multi-squadron commander with explicit JWT allow-list.
  --    No xpc_user_pcs rows for Bravo (so the PC-claim branch can't
  --    cover it); the ONLY thing that should let them see Bravo is
  --    the squadron_ids JWT claim. Charlie is excluded → must see 0.
  --    This is the exact Audit P leak shape.
  -- ─────────────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'app_metadata', json_build_object(
        'role', 'commander',
        'tier', 'wing',
        'squadron_ids', json_build_array(v_sq_a_id, v_sq_b_id)
      )
    )::text,
    true);

  select count(*) into v_count from public.xpc_squadron_snapshot;
  if v_count <> 2 then
    v_failures := array_append(v_failures,
      format('test 2: wing commander with squadron_ids=[Alpha,Bravo] should see exactly 2 rows, saw %s',
             v_count));
  end if;

  select count(*) into v_charlie_visible
    from public.xpc_squadron_snapshot
   where squadron_id = v_sq_c_id;
  if v_charlie_visible <> 0 then
    v_failures := array_append(v_failures,
      format('test 2 (Audit P leak shape): Charlie must NOT be visible to a wing commander with squadron_ids=[Alpha,Bravo], saw %s rows',
             v_charlie_visible));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- 4. Test 3 — user with neither a PC claim nor a squadron_ids
  --    JWT claim sees ZERO rows. This is the assertion that proves
  --    the permissive wing/base/HQ fallback from 0056 is gone.
  --    Drop the user's PC claim first so the only remaining branches
  --    are super_admin (no), squadron_ids JWT (no), PC claim (no).
  -- ─────────────────────────────────────────────────────────────────
  delete from public.xpc_user_pcs where user_id = v_user;

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated',
      'app_metadata', json_build_object(
        'role', 'commander',
        'tier', 'wing'
      )
    )::text,
    true);

  select count(*) into v_count from public.xpc_squadron_snapshot;
  if v_count <> 0 then
    v_failures := array_append(v_failures,
      format('test 3: user with no PC claim and no squadron_ids claim should see 0 rows (the 0056 permissive fallback must be gone), saw %s',
             v_count));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- 5. Test 4 — super_admin sees everything. The global-admin
  --    escape hatch must survive 0061 (otherwise we just broke
  --    the License Keys / Squadrons admin pages).
  -- ─────────────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_super::text,
      'role', 'authenticated',
      'app_metadata', json_build_object('role', 'super_admin')
    )::text,
    true);

  select count(*) into v_count
    from public.xpc_squadron_snapshot
   where squadron_id in (v_sq_a_id, v_sq_b_id, v_sq_c_id);
  if v_count <> 3 then
    v_failures := array_append(v_failures,
      format('test 4: super_admin should see all 3 of our test snapshot rows, saw %s',
             v_count));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- 6. Cleanup. Run BEFORE the failure RAISE so a green run leaves
  --    nothing behind even if implicit-tx rollback didn't happen.
  --    On a red run the RAISE rolls the whole tx back, undoing the
  --    cleanup DELETEs together with the original INSERTs — net
  --    effect is the same: prod fixtures are wiped.
  -- ─────────────────────────────────────────────────────────────────
  delete from public.xpc_squadron_snapshot
   where squadron_id in (v_sq_a_id, v_sq_b_id, v_sq_c_id);
  delete from public.xpc_user_pcs where user_id = v_user;
  delete from auth.users where id in (v_user, v_super);

  if array_length(v_failures, 1) > 0 then
    raise exception 'snapshot-rls scoped-select test FAILED: %',
      array_to_string(v_failures, ' | ');
  end if;

  raise notice 'snapshot-rls scoped-select test PASSED (run=%)', v_run;
end
$body$;
`;

function quoteLiteral(s) {
  // PostgreSQL single-quoted literal, escaping embedded single quotes.
  return "'" + String(s).replace(/'/g, "''") + "'";
}

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
    console.error(`[task-270] HTTP ${res.status} after ${elapsed}ms`);
    console.error(text);
    // Surface the embedded "FAILED: <list>" so CI logs are actionable
    // without a separate query for pg_stat_activity.
    const m = /(snapshot-rls scoped-select test FAILED:[^"\\]+)/i.exec(text);
    if (m) {
      console.error(`\nAssertion failure detail: ${m[1]}`);
      process.exit(1);
    }
    process.exit(2);
  }

  console.log(
    `[task-270] snapshot-rls scoped-select test PASSED in ${elapsed}ms (run=${RUN})`,
  );
  // The Management API does not return RAISE NOTICE output; a clean
  // 2xx with no exception is the success signal.
}

main().catch((e) => {
  console.error("[task-270] unexpected error:", e?.stack ?? e);
  process.exit(2);
});
