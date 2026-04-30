// artifacts/pilot-dashboard/supabase/tests/test-xpc-pending-rls-realignment.mjs
//
// Round 4 AA3 — Regression test for the realigned SELECT policy on
// public.xpc_pending installed by 0064_xpc_pending_rls_realignment.sql.
//
// Why this test exists
// ────────────────────
// Audit P phase 4 (defect P-3, ticket #271) caught that the original
// xpc_pending SELECT policy compared squadron-id columns against
// xpc_my_pc_ids() — a PC-id namespace. For the squadron-tier ops PC
// the two namespaces happen to coincide (the canonical Ops PC's id IS
// the squadron code), but for wing/base/HQ commanders the predicate
// returns zero rows and the pending guest-sortie tray looks empty on
// every commander console.
//
// 0064 keeps the squadron-tier branch and ADDS a multi-squadron
// commander branch via xpc_caller_squadron_ids() (the JWT
// app_metadata.squadron_ids allow-list). Without this regression test
// the next refactor that drops one of the branches would silently
// regress the same defect.
//
// What this test asserts (one DO block, four shapes)
// ──────────────────────────────────────────────────
//   1. A wing commander whose JWT carries squadron_ids=[Alpha,Bravo]
//      sees the pending row whose hosting/home is Alpha (positive),
//      and ZERO pending rows for Charlie (the regression assertion
//      for #271).
//   2. A user with no PC claim and no squadron_ids JWT claim sees
//      ZERO rows (no permissive fallback re-introduced).
//   3. The squadron-tier ops PC path still works: a user with one
//      xpc_user_pcs row for Alpha sees the Alpha pending row.
//   4. super_admin sees every row.
//
// Required env (mirrors test-snapshot-rls-scoped-select.mjs):
//   SUPABASE_ACCESS_TOKEN — Supabase personal access token with DB
//                           write scope on PROJECT_REF.
//   PROJECT_REF           — Supabase project ref. REQUIRED.
//
// Exit codes:
//   0  every assertion passed.
//   1  the DO block raised — at least one assertion failed.
//   2  setup/transport error.

const PROJECT_REF = process.env.PROJECT_REF;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN env var.");
  process.exit(2);
}
if (!PROJECT_REF) {
  console.error("Missing PROJECT_REF env var.");
  process.exit(2);
}

const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const RUN = `T280-pending-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SQL = `
do $body$
declare
  v_run        text := ${quoteLiteral(RUN)};
  v_sq_a       text := v_run || '-A';
  v_sq_b       text := v_run || '-B';
  v_sq_c       text := v_run || '-C';
  v_user       uuid := gen_random_uuid();
  v_super      uuid := gen_random_uuid();
  v_pend_a     text := v_run || '-pend-A';
  v_pend_b     text := v_run || '-pend-B';
  v_pend_c     text := v_run || '-pend-C';
  v_count      int;
  v_alpha_seen int;
  v_charlie_seen int;
  v_failures   text[] := array[]::text[];
begin
  -- ─────────────────────────────────────────────────────────────────
  -- Fixtures.
  -- ─────────────────────────────────────────────────────────────────
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

  -- Three pending rows, one per squadron. We seed ALPHA and CHARLIE
  -- with hosting=home=squadron (the simplest topology). BRAVO tests
  -- the host/home cross-product: hosting_squadron_id is BRAVO and
  -- home_squadron_id is ALPHA — a wing commander with squadron_ids=
  -- [ALPHA,BRAVO] should see this row whichever side of the OR
  -- matches.
  insert into public.xpc_pending
    (id, hosting_squadron_id, hosting_squadron_name,
     home_squadron_id, home_squadron_name,
     guest_pilot_name, guest_seat, sortie, submitted_by, status)
  values
    (v_pend_a, v_sq_a, 'Alpha-Sqn', v_sq_a, 'Alpha-Sqn',
     'Pilot-A', 'pilot', '{"id":"sortie-A"}'::jsonb,
     v_run || '-submitter', 'pending'),
    (v_pend_b, v_sq_b, 'Bravo-Sqn', v_sq_a, 'Alpha-Sqn',
     'Pilot-B', 'pilot', '{"id":"sortie-B"}'::jsonb,
     v_run || '-submitter', 'pending'),
    (v_pend_c, v_sq_c, 'Charlie-Sqn', v_sq_c, 'Charlie-Sqn',
     'Pilot-C', 'pilot', '{"id":"sortie-C"}'::jsonb,
     v_run || '-submitter', 'pending');

  -- ─────────────────────────────────────────────────────────────────
  -- Test 1 — wing commander with squadron_ids=[Alpha,Bravo].
  --   Expectation: sees A and B (B because BRAVO matches host OR
  --   ALPHA matches home), does NOT see Charlie.
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
        'squadron_ids', json_build_array(v_sq_a, v_sq_b)
      )
    )::text,
    true);

  select count(*) into v_count
    from public.xpc_pending
   where id in (v_pend_a, v_pend_b, v_pend_c);
  if v_count <> 2 then
    v_failures := array_append(v_failures,
      format('test 1 (#271 fix): wing commander with squadron_ids=[Alpha,Bravo] should see exactly 2 of our 3 pending rows, saw %s',
             v_count));
  end if;

  select count(*) into v_charlie_seen
    from public.xpc_pending
   where id = v_pend_c;
  if v_charlie_seen <> 0 then
    v_failures := array_append(v_failures,
      format('test 1 (#271 fix): Charlie pending must NOT be visible to wing commander with squadron_ids=[Alpha,Bravo], saw %s rows',
             v_charlie_seen));
  end if;

  select count(*) into v_alpha_seen
    from public.xpc_pending
   where id = v_pend_a;
  if v_alpha_seen <> 1 then
    v_failures := array_append(v_failures,
      format('test 1 (#271 fix): Alpha pending must be visible (positive case), saw %s rows',
             v_alpha_seen));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- Test 2 — bare authenticated user, no PC claim, no squadron_ids.
  --   Expectation: ZERO of our 3 rows. Proves no permissive fallback
  --   sneaked back in.
  -- ─────────────────────────────────────────────────────────────────
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated'
    )::text,
    true);

  select count(*) into v_count
    from public.xpc_pending
   where id in (v_pend_a, v_pend_b, v_pend_c);
  if v_count <> 0 then
    v_failures := array_append(v_failures,
      format('test 2: bare authenticated user with no claims must see 0 of our pending rows, saw %s',
             v_count));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- Test 3 — squadron-tier ops PC path. xpc_user_pcs claim on Alpha.
  --   Expectation: sees BOTH A (host=ALPHA) AND B (home=ALPHA),
  --   does NOT see Charlie.
  -- ─────────────────────────────────────────────────────────────────
  insert into public.xpc_user_pcs (user_id, pc_id) values (v_user, v_sq_a);

  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user::text,
      'role', 'authenticated'
    )::text,
    true);

  select count(*) into v_count
    from public.xpc_pending
   where id in (v_pend_a, v_pend_b, v_pend_c);
  if v_count <> 2 then
    v_failures := array_append(v_failures,
      format('test 3: ops-PC path (xpc_user_pcs[Alpha]) should see A (host=Alpha) and B (home=Alpha), saw %s',
             v_count));
  end if;

  select count(*) into v_charlie_seen
    from public.xpc_pending
   where id = v_pend_c;
  if v_charlie_seen <> 0 then
    v_failures := array_append(v_failures,
      format('test 3: ops-PC path must NOT see Charlie, saw %s rows',
             v_charlie_seen));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ─────────────────────────────────────────────────────────────────
  -- Test 4 — super_admin sees every row.
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
    from public.xpc_pending
   where id in (v_pend_a, v_pend_b, v_pend_c);
  if v_count <> 3 then
    v_failures := array_append(v_failures,
      format('test 4: super_admin should see all 3 of our test pending rows, saw %s',
             v_count));
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- Cleanup.
  delete from public.xpc_pending
   where id in (v_pend_a, v_pend_b, v_pend_c);
  delete from public.xpc_user_pcs where user_id = v_user;
  delete from auth.users where id in (v_user, v_super);

  if array_length(v_failures, 1) > 0 then
    raise exception 'xpc_pending RLS realignment test FAILED: %',
      array_to_string(v_failures, ' | ');
  end if;

  raise notice 'xpc_pending RLS realignment test PASSED (run=%)', v_run;
end
$body$;
`;

function quoteLiteral(s) {
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
    console.error(`[task-280 / #271] HTTP ${res.status} after ${elapsed}ms`);
    console.error(text);
    const m = /(xpc_pending RLS realignment test FAILED:[^"\\]+)/i.exec(text);
    if (m) {
      console.error(`\nAssertion failure detail: ${m[1]}`);
      process.exit(1);
    }
    process.exit(2);
  }

  console.log(
    `[task-280 / #271] xpc_pending RLS realignment test PASSED in ${elapsed}ms (run=${RUN})`,
  );
}

main().catch((e) => {
  console.error("[task-280 / #271] unexpected error:", e?.stack ?? e);
  process.exit(2);
});
