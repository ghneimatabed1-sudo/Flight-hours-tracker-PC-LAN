// artifacts/pilot-dashboard/supabase/tests/test-squadron-rename-xpc-sync.mjs
//
// Task #202 — Regression test for the squadron-rename cross-PC sync trigger.
//
// Migrations 0050_squadron_rename_xpc_sync.sql and
// 0054_squadron_rename_xpc_sync_pending_shares.sql install
// `public._sync_xpc_denorm_on_squadron_rename`, an AFTER UPDATE OF name
// trigger on public.squadrons. (The pending-shares migration originally
// shipped as `0052_…` but Audit H / Task #249 renumbered it to `0054_…`
// after a duplicate `0052_` prefix collision caused the live ledger to
// silently skip the apply — see the file header for the full history.)
//
// The trigger propagates the new squadron name into FIVE denormalised
// tables that snapshot squadron-name text at write time:
//
//   * xpc_registry         (squadron_name)
//   * xpc_pair_links       (a_squadron, b_squadron)
//   * xpc_messages         (from_pc_name, to_pc_name)
//   * xpc_pending          (hosting_squadron_name, home_squadron_name)
//   * xpc_schedule_shares  (origin_squadron_name)
//
// Without this test, a future migration could silently miss one of
// those columns — or accidentally widen the equality match so rows
// carrying a different squadron name get clobbered too — and nobody
// would notice until an operator reported stale labels in the
// Connection Map / chat history / Guest Officer inbox / Schedule
// Chain page.
//
// What this test does:
//
//   1. Seeds two squadrons (one TARGET, one CONTROL) with unique
//      run-tagged names.
//   2. Inserts ONE row into each of the five denormalised tables that
//      snapshots the TARGET squadron's OLD name, and ONE additional
//      row that snapshots the CONTROL squadron's name. The control
//      rows let us prove the equality match doesn't over-reach.
//   3. Renames the TARGET squadron from OLD to NEW via a single
//      UPDATE on public.squadrons.name (which fires the trigger).
//   4. Asserts every snapshot column on the TARGET rows now reads NEW
//      and every snapshot column on the CONTROL rows still reads its
//      original CONTROL name (untouched).
//   5. Cleans up every test fixture — both on success and on failure.
//
// The whole test runs as a single DO block sent through the Supabase
// Management API. Because the Management API wraps each query in an
// implicit transaction:
//
//   * On success, the cleanup DELETEs run, the DO block completes,
//     and the transaction commits — fixtures are gone.
//   * On any assertion failure or unexpected error, the DO block
//     RAISEs and the entire transaction rolls back — fixtures are
//     also gone, even if the explicit cleanup didn't reach them.
//
// Either way, prod is left in exactly the state we found it.
//
// Required env (mirrors the apply-supabase-migrations.yml step):
//   SUPABASE_ACCESS_TOKEN — Supabase personal access token with DB
//                           write scope on PROJECT_REF.
//   PROJECT_REF           — Supabase project ref. REQUIRED (no default)
//                           so a local invocation cannot accidentally
//                           target prod just because a developer
//                           happened to have a long-lived access token
//                           in their shell. CI passes the prod ref
//                           explicitly via the workflow env block.
//
// Exit codes:
//   0  every snapshot column updated and every control row untouched.
//   1  one or more assertions failed (the failure list is printed).
//   2  setup/transport error (missing env, HTTP error, malformed
//      response). Wrapped DO-block rollback still cleans up.

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

// A run-tag that's globally unique for this invocation. Used as a
// prefix on every fixture id/name so two concurrent runs (and any
// pre-existing prod data) cannot collide. Length budgeted to fit
// inside the squadrons.name unique-on-canonical-form index.
const RUN = `T202-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SQL = `
do $body$
declare
  v_run text := ${quoteLiteral(RUN)};
  v_old text := v_run || '-OLD';
  v_new text := v_run || '-NEW';
  v_ctl text := v_run || '-CTL';
  v_target_sq_id uuid;
  v_control_sq_id uuid;
  v_count int;
  v_failures text[] := array[]::text[];
begin
  -- ─────────────────────────────────────────────────────────────────
  -- 1. Squadrons. Two of them: one we'll rename, one we won't.
  --    The CONTROL squadron exists so we can assert that snapshot
  --    rows referencing a different name are NOT touched by the
  --    rename trigger (i.e. the equality match is squadron-scoped,
  --    not a blanket update).
  -- ─────────────────────────────────────────────────────────────────
  insert into public.squadrons (number, name, base)
    values (v_run || '-T', v_old, 'TestBase')
    returning id into v_target_sq_id;
  insert into public.squadrons (number, name, base)
    values (v_run || '-C', v_ctl, 'TestBase')
    returning id into v_control_sq_id;

  -- ─────────────────────────────────────────────────────────────────
  -- 2. Seed one TARGET row + one CONTROL row in each of the five
  --    denormalised tables. Every fixture id is prefixed with v_run
  --    so the cleanup pass at the end can sweep them with LIKE.
  -- ─────────────────────────────────────────────────────────────────

  -- xpc_registry: PC entries. squadron_name is the column that should flip.
  insert into public.xpc_registry (id, squadron_name, tier)
    values (v_run || '-PCT', v_old, 'squadron');
  insert into public.xpc_registry (id, squadron_name, tier)
    values (v_run || '-PCC', v_ctl, 'squadron');

  -- xpc_pair_links: a_squadron and b_squadron both denormalise the
  -- snapshot. Use kind='in_squadron' so both sides reference the
  -- same squadron — this also exercises the matrix-validator bypass
  -- the rename trigger sets in 0050 (without the bypass, the BEFORE
  -- UPDATE enforcer would briefly observe an inconsistent state and
  -- abort the rename).
  -- a_pc_id < b_pc_id is required by the xpc_pair_links_canonical
  -- check constraint, so prefix with 'A_' / 'B_' to guarantee order.
  insert into public.xpc_pair_links
    (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron, kind)
  values
    ('A_' || v_run || '-T', 'B_' || v_run || '-T',
     'squadron', 'squadron', v_old, v_old, 'in_squadron');
  insert into public.xpc_pair_links
    (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron, kind)
  values
    ('A_' || v_run || '-C', 'B_' || v_run || '-C',
     'squadron', 'squadron', v_ctl, v_ctl, 'in_squadron');

  -- xpc_messages: from_pc_name and to_pc_name both snapshot the
  -- display name (= squadron name for squadron-tier PCs).
  insert into public.xpc_messages
    (id, thread_id, from_pc_id, from_pc_name, from_tier, from_user,
     to_pc_id, to_pc_name, to_tier, subject, body, priority)
  values
    (v_run || '-MSG-T', v_run || '-TH-T',
     v_run || '-FRM-T', v_old, 'squadron', 'tester',
     v_run || '-TO-T',  v_old, 'squadron',
     'rename test', 'rename test', 'normal');
  insert into public.xpc_messages
    (id, thread_id, from_pc_id, from_pc_name, from_tier, from_user,
     to_pc_id, to_pc_name, to_tier, subject, body, priority)
  values
    (v_run || '-MSG-C', v_run || '-TH-C',
     v_run || '-FRM-C', v_ctl, 'squadron', 'tester',
     v_run || '-TO-C',  v_ctl, 'squadron',
     'rename test', 'rename test', 'normal');

  -- xpc_pending: guest-officer pending submissions snapshot both the
  -- hosting and home squadron names. Use a self-host shape (hosting
  -- name = home name) for the TARGET row to verify the single
  -- UPDATE flips both columns atomically.
  insert into public.xpc_pending
    (id, hosting_squadron_id, hosting_squadron_name,
     home_squadron_id, home_squadron_name,
     guest_pilot_name, guest_seat, sortie, submitted_by)
  values
    (v_run || '-PND-T',
     v_run || '-HOST-T', v_old,
     v_run || '-HOME-T', v_old,
     'Test Guest', 'pilot', '{}'::jsonb, 'tester');
  insert into public.xpc_pending
    (id, hosting_squadron_id, hosting_squadron_name,
     home_squadron_id, home_squadron_name,
     guest_pilot_name, guest_seat, sortie, submitted_by)
  values
    (v_run || '-PND-C',
     v_run || '-HOST-C', v_ctl,
     v_run || '-HOME-C', v_ctl,
     'Test Guest', 'pilot', '{}'::jsonb, 'tester');

  -- xpc_schedule_shares: origin_squadron_name snapshots the originating
  -- squadron's display name at submit time. status is constrained, use
  -- 'submitted' as a non-terminal value.
  insert into public.xpc_schedule_shares
    (id, flight_date, origin_squadron_id, origin_squadron_name,
     current_tier, status)
  values
    (v_run || '-SCH-T', current_date,
     v_run || '-ORIG-T', v_old, 'squadron', 'submitted');
  insert into public.xpc_schedule_shares
    (id, flight_date, origin_squadron_id, origin_squadron_name,
     current_tier, status)
  values
    (v_run || '-SCH-C', current_date,
     v_run || '-ORIG-C', v_ctl, 'squadron', 'submitted');

  -- ─────────────────────────────────────────────────────────────────
  -- 3. Trigger the rename. This single UPDATE is what fires
  --    squadrons_rename_sync_xpc_trg → _sync_xpc_denorm_on_squadron_rename.
  -- ─────────────────────────────────────────────────────────────────
  update public.squadrons set name = v_new where id = v_target_sq_id;

  -- ─────────────────────────────────────────────────────────────────
  -- 4. Assertions. We collect ALL failures into v_failures rather
  --    than raising on the first one, so a single CI run reports
  --    every column that drifted instead of one-at-a-time whack-a-mole.
  -- ─────────────────────────────────────────────────────────────────

  -- xpc_registry: TARGET row picked up the new name.
  select count(*) into v_count
    from public.xpc_registry
   where id = v_run || '-PCT' and squadron_name = v_new;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('xpc_registry.squadron_name not updated to NEW (count=%s)', v_count));
  end if;
  -- xpc_registry: CONTROL row left alone.
  select count(*) into v_count
    from public.xpc_registry
   where id = v_run || '-PCC' and squadron_name = v_ctl;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      'xpc_registry control row was modified by the rename');
  end if;

  -- xpc_pair_links: TARGET row — both columns flipped to NEW.
  select count(*) into v_count
    from public.xpc_pair_links
   where a_pc_id = 'A_' || v_run || '-T'
     and b_pc_id = 'B_' || v_run || '-T'
     and a_squadron = v_new and b_squadron = v_new;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('xpc_pair_links a_squadron/b_squadron not both updated (count=%s)', v_count));
  end if;
  -- xpc_pair_links: CONTROL row left alone.
  select count(*) into v_count
    from public.xpc_pair_links
   where a_pc_id = 'A_' || v_run || '-C'
     and b_pc_id = 'B_' || v_run || '-C'
     and a_squadron = v_ctl and b_squadron = v_ctl;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      'xpc_pair_links control row was modified by the rename');
  end if;

  -- xpc_messages: TARGET row — both name columns flipped.
  select count(*) into v_count
    from public.xpc_messages
   where id = v_run || '-MSG-T'
     and from_pc_name = v_new and to_pc_name = v_new;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('xpc_messages from_pc_name/to_pc_name not both updated (count=%s)', v_count));
  end if;
  -- xpc_messages: CONTROL row left alone.
  select count(*) into v_count
    from public.xpc_messages
   where id = v_run || '-MSG-C'
     and from_pc_name = v_ctl and to_pc_name = v_ctl;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      'xpc_messages control row was modified by the rename');
  end if;

  -- xpc_pending: TARGET row — both name columns flipped.
  select count(*) into v_count
    from public.xpc_pending
   where id = v_run || '-PND-T'
     and hosting_squadron_name = v_new
     and home_squadron_name = v_new;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('xpc_pending hosting/home squadron_name not both updated (count=%s)', v_count));
  end if;
  -- xpc_pending: CONTROL row left alone.
  select count(*) into v_count
    from public.xpc_pending
   where id = v_run || '-PND-C'
     and hosting_squadron_name = v_ctl
     and home_squadron_name = v_ctl;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      'xpc_pending control row was modified by the rename');
  end if;

  -- xpc_schedule_shares: TARGET row — origin_squadron_name flipped.
  select count(*) into v_count
    from public.xpc_schedule_shares
   where id = v_run || '-SCH-T' and origin_squadron_name = v_new;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      format('xpc_schedule_shares.origin_squadron_name not updated (count=%s)', v_count));
  end if;
  -- xpc_schedule_shares: CONTROL row left alone.
  select count(*) into v_count
    from public.xpc_schedule_shares
   where id = v_run || '-SCH-C' and origin_squadron_name = v_ctl;
  if v_count <> 1 then
    v_failures := array_append(v_failures,
      'xpc_schedule_shares control row was modified by the rename');
  end if;

  -- ─────────────────────────────────────────────────────────────────
  -- 5. Cleanup. Run BEFORE raising so a green run leaves nothing
  --    behind. (On a red run the RAISE rolls the whole tx back, so
  --    these DELETEs being undone is harmless — the original INSERTs
  --    are undone too.)
  -- ─────────────────────────────────────────────────────────────────
  delete from public.xpc_pair_links
    where a_pc_id like 'A_' || v_run || '%';
  delete from public.xpc_messages
    where id like v_run || '%';
  delete from public.xpc_pending
    where id like v_run || '%';
  delete from public.xpc_schedule_shares
    where id like v_run || '%';
  delete from public.xpc_registry
    where id like v_run || '%';
  delete from public.squadrons
    where id in (v_target_sq_id, v_control_sq_id);

  if array_length(v_failures, 1) > 0 then
    raise exception 'squadron-rename xpc sync test FAILED: %',
      array_to_string(v_failures, ' | ');
  end if;

  raise notice 'squadron-rename xpc sync test PASSED (run=%)', v_run;
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
    // Try to surface the embedded "FAILED: <list>" so CI logs are
    // actionable without a separate query for pg_stat_activity.
    console.error(
      `[task-202] HTTP ${res.status} after ${elapsed}ms`,
    );
    console.error(text);
    // 200/201 means "DO block ran without raising". A 4xx/5xx body
    // typically carries `{ "message": "...FAILED: ..." }`.
    const m = /(squadron-rename xpc sync test FAILED:[^"\\]+)/i.exec(text);
    if (m) {
      console.error(`\nAssertion failure detail: ${m[1]}`);
      process.exit(1);
    }
    process.exit(2);
  }

  console.log(
    `[task-202] squadron-rename xpc sync test PASSED in ${elapsed}ms (run=${RUN})`,
  );
  // The Management API does not return RAISE NOTICE output; a clean
  // 2xx with no exception is the success signal.
}

main().catch((e) => {
  console.error("[task-202] unexpected error:", e?.stack ?? e);
  process.exit(2);
});
