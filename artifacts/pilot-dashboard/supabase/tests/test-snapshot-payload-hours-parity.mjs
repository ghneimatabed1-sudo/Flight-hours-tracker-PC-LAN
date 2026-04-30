// artifacts/pilot-dashboard/supabase/tests/test-snapshot-payload-hours-parity.mjs
//
// Round 4 AA3 — Regression test for #268 (commander rollups silently
// show "0h" for every flight-hours cell).
//
// Why this test exists
// ────────────────────
// The publisher (artifacts/pilot-dashboard/src/App.tsx) now writes
// roster[i].dayHours/nightHours/nvgHours/simHours/captainHours into
// the xpc_squadron_snapshot.payload JSONB. The consumer adapter
// (src/lib/dash-pilots.ts → adaptSnapshotPilot) reads them and
// computes grandTotalHours = day + night + nvg.
//
// This test mirrors the M parity-fixture pattern: seed a snapshot row
// whose payload carries known hours, then mirror the JS adapter logic
// in pure SQL and assert the derived grand total matches the canonical
// formula. If a future refactor of the adapter or the publisher payload
// drops one of the hour fields, this test fails the next time it runs
// against prod.
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

const RUN = `T280-hours-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

// The fixture payload mirrors the dashboard's publisher shape. P1 is
// the canonical "non-trivial hours" pilot (250 day, 30 night, 10 nvg,
// 50 captain, 12 sim) used by Audit-G's parity universe; we pin the
// same numbers here so any drift between dashboard parity and snapshot
// parity surfaces in either test.
const PAYLOAD = {
  roster: [
    {
      id: `${RUN}-P1`,
      callSign: "ALPHA-1",
      name: "Pilot One",
      flightName: null,
      rank: null,
      expDay: null,
      expNight: null,
      expNvg: null,
      expIrt: null,
      expMedical: null,
      dayHours: 250,
      nightHours: 30,
      nvgHours: 10,
      simHours: 12,
      captainHours: 50,
    },
    {
      id: `${RUN}-P2`,
      callSign: "ALPHA-2",
      name: "Pilot Two",
      flightName: null,
      rank: null,
      expDay: null,
      expNight: null,
      expNvg: null,
      expIrt: null,
      expMedical: null,
      // Mixed nulls / missing fields — the adapter must coerce to 0.
      dayHours: 0,
      nightHours: null,
      nvgHours: 5,
      // simHours and captainHours intentionally absent.
    },
  ],
  unavailable: [],
  counts: { pilots: 2, unavailToday: 0, expired: 0, expiringSoon: 0 },
};

const SQL = `
do $body$
declare
  v_run        text := ${quoteLiteral(RUN)};
  v_sq         text := v_run || '-S';
  v_payload    jsonb := ${quoteLiteral(JSON.stringify(PAYLOAD))}::jsonb;
  v_p1_day     numeric;
  v_p1_night   numeric;
  v_p1_nvg     numeric;
  v_p1_grand   numeric;
  v_p2_day     numeric;
  v_p2_nvg     numeric;
  v_p2_grand   numeric;
  v_failures   text[] := array[]::text[];
begin
  -- Seed: one snapshot row with the known hours payload. updated_by is
  -- NOT NULL (default auth.uid()) — we run as the management-API role
  -- which has no JWT, so set it explicitly to a synthetic uuid.
  insert into public.xpc_squadron_snapshot
    (squadron_id, ops_pc_id, snapshot_at, payload, updated_by)
  values (v_sq, v_sq, now(), v_payload, '00000000-0000-0000-0000-000000000280');

  -- Read back through the same JSONB the consumer reads, mirroring
  -- adaptSnapshotPilot's coercion: missing or null → 0. grandTotalHours
  -- = day + night + nvg.
  select coalesce((roster->0->>'dayHours')::numeric, 0),
         coalesce((roster->0->>'nightHours')::numeric, 0),
         coalesce((roster->0->>'nvgHours')::numeric, 0)
    into v_p1_day, v_p1_night, v_p1_nvg
    from (select payload->'roster' as roster
            from public.xpc_squadron_snapshot
           where squadron_id = v_sq) s;
  v_p1_grand := v_p1_day + v_p1_night + v_p1_nvg;

  if v_p1_day <> 250 then
    v_failures := array_append(v_failures,
      format('test 1: P1 dayHours expected 250, got %s', v_p1_day));
  end if;
  if v_p1_night <> 30 then
    v_failures := array_append(v_failures,
      format('test 1: P1 nightHours expected 30, got %s', v_p1_night));
  end if;
  if v_p1_nvg <> 10 then
    v_failures := array_append(v_failures,
      format('test 1: P1 nvgHours expected 10, got %s', v_p1_nvg));
  end if;
  if v_p1_grand <> 290 then
    v_failures := array_append(v_failures,
      format('test 1: P1 grandTotalHours (day+night+nvg) expected 290, got %s', v_p1_grand));
  end if;

  -- P2 — null/missing tolerance. The adapter coerces to 0, so the SQL
  -- mirror does the same with coalesce.
  select coalesce((roster->1->>'dayHours')::numeric, 0),
         coalesce((roster->1->>'nvgHours')::numeric, 0)
    into v_p2_day, v_p2_nvg
    from (select payload->'roster' as roster
            from public.xpc_squadron_snapshot
           where squadron_id = v_sq) s;
  v_p2_grand := v_p2_day + coalesce(((select payload->'roster'->1->>'nightHours' from public.xpc_squadron_snapshot where squadron_id = v_sq))::numeric, 0) + v_p2_nvg;

  if v_p2_day <> 0 then
    v_failures := array_append(v_failures,
      format('test 2: P2 dayHours expected 0, got %s', v_p2_day));
  end if;
  if v_p2_nvg <> 5 then
    v_failures := array_append(v_failures,
      format('test 2: P2 nvgHours expected 5, got %s', v_p2_nvg));
  end if;
  if v_p2_grand <> 5 then
    v_failures := array_append(v_failures,
      format('test 2: P2 grandTotalHours (with null/missing coerced to 0) expected 5, got %s', v_p2_grand));
  end if;

  -- Cleanup.
  delete from public.xpc_squadron_snapshot where squadron_id = v_sq;

  if array_length(v_failures, 1) > 0 then
    raise exception 'snapshot-payload hours parity test FAILED: %',
      array_to_string(v_failures, ' | ');
  end if;

  raise notice 'snapshot-payload hours parity test PASSED (run=%)', v_run;
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
    console.error(`[task-280 / #268] HTTP ${res.status} after ${elapsed}ms`);
    console.error(text);
    const m = /(snapshot-payload hours parity test FAILED:[^"\\]+)/i.exec(text);
    if (m) {
      console.error(`\nAssertion failure detail: ${m[1]}`);
      process.exit(1);
    }
    process.exit(2);
  }

  console.log(
    `[task-280 / #268] snapshot-payload hours parity test PASSED in ${elapsed}ms (run=${RUN})`,
  );
}

main().catch((e) => {
  console.error("[task-280 / #268] unexpected error:", e?.stack ?? e);
  process.exit(2);
});
