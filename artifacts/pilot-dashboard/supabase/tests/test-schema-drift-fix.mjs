// artifacts/pilot-dashboard/supabase/tests/test-schema-drift-fix.mjs
//
// Round 4 AA3 — Regression test for the schema-drift restoration
// installed by 0065_schema_drift_restoration.sql.
//
// What this test asserts (one DO block, three restorations)
// ─────────────────────────────────────────────────────────
//   1. public.audit_log.action — column exists, is TEXT, and a
//      round-trip insert/select carrying a non-null `action` works.
//   2. public.reminder_schedules — table exists with the documented
//      columns, the unique-name index is enforced, and a service-role
//      insert/select round-trip works (the test runs as the management-
//      API role which bypasses RLS, mirroring how the
//      manage-reminder-schedule edge function calls in).
//   3. public.reminder_schedules RLS negative case — an authenticated
//      caller carrying a NON-admin JWT (role=ops, no super_admin claim)
//      must see zero rows AND must be rejected on insert. Catches the
//      regression where a developer accidentally widens the policy to
//      `to authenticated using (true)` while testing.
//
// Required env: SUPABASE_ACCESS_TOKEN, PROJECT_REF.
// Exit codes: 0 PASS, 1 assertion FAIL, 2 transport error.

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

const RUN = `T280-drift-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const SQL = `
do $body$
declare
  v_run         text := ${quoteLiteral(RUN)};
  v_audit_id    bigint;
  v_audit_back  text;
  v_sched_id    uuid;
  v_sched_back  text;
  v_action_type text;
  v_failures    text[] := array[]::text[];
begin
  -- ─────────────────────────────────────────────────────────────────
  -- Test 1 — audit_log.action column exists and is TEXT.
  -- ─────────────────────────────────────────────────────────────────
  select data_type into v_action_type
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'audit_log'
     and column_name = 'action';

  if v_action_type is null then
    v_failures := array_append(v_failures,
      'test 1: audit_log.action column does not exist after migration 0065');
  elsif v_action_type <> 'text' then
    v_failures := array_append(v_failures,
      format('test 1: audit_log.action expected TEXT, got %s', v_action_type));
  end if;

  -- ─────────────────────────────────────────────────────────────────
  -- Test 2 — write/read round trip carrying a non-null action.
  -- ─────────────────────────────────────────────────────────────────
  insert into public.audit_log (type, actor, detail, action)
  values ('round4.aa3.test', v_run, '{}'::jsonb, 'verb-' || v_run)
  returning id into v_audit_id;

  select action into v_audit_back
    from public.audit_log
   where id = v_audit_id;

  if v_audit_back is null or v_audit_back <> 'verb-' || v_run then
    v_failures := array_append(v_failures,
      format('test 2: audit_log.action round-trip mismatch, wrote "verb-%s" read "%s"',
             v_run, coalesce(v_audit_back, '<null>')));
  end if;

  -- Cleanup the test audit row immediately so the audit log isn't polluted.
  delete from public.audit_log where id = v_audit_id;

  -- ─────────────────────────────────────────────────────────────────
  -- Test 3 — reminder_schedules table exists with documented columns.
  -- ─────────────────────────────────────────────────────────────────
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'reminder_schedules'
  ) then
    v_failures := array_append(v_failures,
      'test 3: reminder_schedules table does not exist after migration 0065');
  end if;

  -- Required columns, by name + type. Loop and append a failure per
  -- missing column so the operator sees the full diff in one run.
  for v_action_type in
    select required.column_name
      from (values
        ('id', 'uuid'),
        ('name', 'text'),
        ('cron', 'text'),
        ('target_url', 'text'),
        ('enabled', 'boolean'),
        ('squadron_id', 'uuid'),
        ('created_at', 'timestamp with time zone'),
        ('updated_at', 'timestamp with time zone'),
        ('created_by', 'text')
      ) as required(column_name, data_type)
      left join information_schema.columns c
        on c.table_schema = 'public'
       and c.table_name = 'reminder_schedules'
       and c.column_name = required.column_name
       and c.data_type = required.data_type
     where c.column_name is null
  loop
    v_failures := array_append(v_failures,
      format('test 3: reminder_schedules missing required column %s', v_action_type));
  end loop;

  -- ─────────────────────────────────────────────────────────────────
  -- Test 4 — write/read round trip on reminder_schedules.
  -- ─────────────────────────────────────────────────────────────────
  insert into public.reminder_schedules (name, cron, target_url, created_by)
  values (v_run || '-sched', '0 6 * * *', 'https://example.test/notify', v_run)
  returning id into v_sched_id;

  select cron into v_sched_back
    from public.reminder_schedules
   where id = v_sched_id;

  if v_sched_back is null or v_sched_back <> '0 6 * * *' then
    v_failures := array_append(v_failures,
      format('test 4: reminder_schedules round-trip mismatch, expected "0 6 * * *" got "%s"',
             coalesce(v_sched_back, '<null>')));
  end if;

  -- Verify the unique-name index is enforced.
  begin
    insert into public.reminder_schedules (name, cron)
    values (v_run || '-sched', '0 7 * * *');
    -- Should not reach here.
    v_failures := array_append(v_failures,
      'test 4: reminder_schedules name uniqueness NOT enforced');
  exception when unique_violation then
    -- expected
    null;
  end;

  -- ─────────────────────────────────────────────────────────────────
  -- Test 5 — RLS negative case: an authenticated NON-admin caller
  -- must see zero rows AND must be rejected on insert. We seed a
  -- second row first so there's something to NOT see, then impersonate
  -- an authenticated user with role=ops (no super_admin claim).
  -- ─────────────────────────────────────────────────────────────────
  insert into public.reminder_schedules (name, cron, target_url, created_by)
  values (v_run || '-rls-bait', '0 8 * * *', 'https://example.test/bait', v_run)
  returning id into v_sched_id;

  declare
    v_seen_count int;
    v_insert_blocked boolean := false;
  begin
    set local role authenticated;
    perform set_config(
      'request.jwt.claims',
      json_build_object(
        'sub', '00000000-0000-0000-0000-000000000280',
        'role', 'authenticated',
        'app_metadata', json_build_object(
          'role', 'ops',
          'tier', 'squadron'
        )
      )::text,
      true);

    select count(*) into v_seen_count
      from public.reminder_schedules
     where id = v_sched_id;
    if v_seen_count <> 0 then
      v_failures := array_append(v_failures,
        format('test 5 (RLS): non-admin authenticated caller saw %s rows of reminder_schedules, expected 0',
               v_seen_count));
    end if;

    begin
      insert into public.reminder_schedules (name, cron)
      values (v_run || '-rls-attempt', '0 9 * * *');
      -- Should not reach here.
      v_failures := array_append(v_failures,
        'test 5 (RLS): non-admin INSERT into reminder_schedules was NOT blocked');
    exception when insufficient_privilege or others then
      v_insert_blocked := true;
    end;

    if not v_insert_blocked then
      v_failures := array_append(v_failures,
        'test 5 (RLS): non-admin INSERT did not raise an RLS rejection');
    end if;

    reset role;
    perform set_config('request.jwt.claims', '', true);
  end;

  delete from public.reminder_schedules where id = v_sched_id;

  if array_length(v_failures, 1) > 0 then
    raise exception 'schema-drift restoration test FAILED: %',
      array_to_string(v_failures, ' | ');
  end if;

  raise notice 'schema-drift restoration test PASSED (run=%)', v_run;
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
    console.error(`[task-280 / drift] HTTP ${res.status} after ${elapsed}ms`);
    console.error(text);
    const m = /(schema-drift restoration test FAILED:[^"\\]+)/i.exec(text);
    if (m) {
      console.error(`\nAssertion failure detail: ${m[1]}`);
      process.exit(1);
    }
    process.exit(2);
  }

  console.log(
    `[task-280 / drift] schema-drift restoration test PASSED in ${elapsed}ms (run=${RUN})`,
  );
}

main().catch((e) => {
  console.error("[task-280 / drift] unexpected error:", e?.stack ?? e);
  process.exit(2);
});
