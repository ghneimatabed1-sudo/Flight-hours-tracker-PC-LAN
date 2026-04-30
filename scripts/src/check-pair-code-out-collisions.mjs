#!/usr/bin/env node
// scripts/src/check-pair-code-out-collisions.mjs
//
// Task #252 — defect-class sweep for the 42702 ambiguous-column bug
// fixed in migrations 0046 (xpc_admin_create_pair) and 0048
// (xpc_redeem_pair_code).
//
// What this script does
// ─────────────────────
// Enumerates every `public.*` SECURITY DEFINER PL/pgSQL function in the
// live Supabase project, derives its OUT/INOUT/TABLE column names from
// `pg_proc.proargmodes`, regex-finds the tables its body INSERTs/
// UPDATEs/DELETEs into, cross-references against the live column
// catalog, and exits 1 if any function has a name collision AND its
// body is missing `#variable_conflict use_column`. Exits 2 if the
// sweep itself fails (e.g. missing management token).
//
// Why a CI script AND a migration assertion
// ──────────────────────────────────────────
// Migration 0055_assert_pair_code_out_collision_class.sql carries the
// same enumeration in pure SQL and `RAISE EXCEPTION`s at apply time —
// that is the authoritative production guard. This Node script runs
// the same query from CI as a defence-in-depth so a vulnerable
// function that somehow lands in prod (e.g. via a manual SQL change
// outside the migration workflow) still trips the alarm on the next
// migration job.
//
// Required env (CI-friendly: all secrets already configured for the
// migrations workflow):
//   SUPABASE_ACCESS_TOKEN   — Supabase personal access token (or
//                             SUPABASE_MANAGEMENT_TOKEN locally)
//   SUPABASE_PROJECT_REF    — e.g. nklrdhfsbevckovqqkah (or derived
//                             from SUPABASE_URL)
//
// Usage
// ──────
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=nklrdhfsbevckovqqkah \
//     node scripts/src/check-pair-code-out-collisions.mjs
//
// Self-test (no network, no env vars required):
//   node scripts/src/check-pair-code-out-collisions.mjs --self-test
//
// Sweep version. When the SQL in 0055 and the JS sweep below are
// edited together, bump this string in BOTH files so a `git grep`
// for the version tag confirms they are still in lockstep. This is
// the convention the reviewer asked for to prevent drift between
// the migration-time assertion and the CI guard.
//   SWEEP_VERSION = "task-252.v2 (oid+regex+normalize)"

const SWEEP_VERSION = "task-252.v2 (oid+regex+normalize)";

// ── Helpers (defined first so --self-test can exercise them without
//    needing the Supabase Management API). ────────────────────────────

// Normalize a Postgres `text[]` / `"char"[]` column from the management
// API into a JS array of strings. The API has been observed returning
// either a real JS array OR the Postgres array-literal text form
// (e.g. '{a_pc_id,b_pc_id,kind}' or '{NULL,foo,bar}'). Treat 'NULL'
// (case-insensitive) and the empty token as a missing element. Without
// this normalization an array-literal string would silently degrade to
// per-character access in the loops below and under-report collisions.
export function normalizePgArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(x => (x == null ? null : String(x)));
  const s = String(v).trim();
  if (s === "" || s === "{}" || s === "NULL") return [];
  const inner = s.replace(/^\{/, "").replace(/\}$/, "");
  if (inner === "") return [];
  // Handles quoted and unquoted comma-separated elements.
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const raw = m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2].trim();
    if (raw === "" || raw.toUpperCase() === "NULL") out.push(null);
    else out.push(raw);
  }
  return out;
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [["a", "b", "c"], ["a", "b", "c"]],
    [[null, "x"], [null, "x"]],
    ["{a,b,c}", ["a", "b", "c"]],
    ["{a_pc_id,b_pc_id,kind}", ["a_pc_id", "b_pc_id", "kind"]],
    ["{NULL,foo,bar}", [null, "foo", "bar"]],
    ['{"with space",plain}', ["with space", "plain"]],
    [null, []],
    ["{}", []],
    ["NULL", []],
    ["{o,b,t}", ["o", "b", "t"]],
  ];
  let ok = true;
  for (const [input, want] of cases) {
    const got = normalizePgArray(input);
    const pass = JSON.stringify(got) === JSON.stringify(want);
    if (!pass) ok = false;
    console.log(pass ? "PASS" : "FAIL", JSON.stringify(input), "=>", JSON.stringify(got));
  }
  console.log(ok ? `OK ${cases.length}/${cases.length} (${SWEEP_VERSION})` : "FAIL");
  process.exit(ok ? 0 : 1);
}

const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_MANAGEMENT_TOKEN;
const url   = process.env.SUPABASE_URL || "";
const ref   = process.env.SUPABASE_PROJECT_REF
           || (url.match(/https:\/\/([^.]+)\.supabase\.co/) || [])[1];

if (!token) {
  console.error("ERROR: SUPABASE_ACCESS_TOKEN (or SUPABASE_MANAGEMENT_TOKEN) is required.");
  process.exit(2);
}
if (!ref) {
  console.error("ERROR: could not resolve SUPABASE_PROJECT_REF (set it directly or supply SUPABASE_URL).");
  process.exit(2);
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = { _raw: txt }; }
  if (!r.ok || (body && !Array.isArray(body) && body.message)) {
    throw new Error(`management SQL ${r.status}: ${body.message || body._raw || "?"}`);
  }
  return body;
}

let funcs, cols;
try {
  funcs = await sql(`
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args,
           p.proargnames,
           p.proargmodes,
           p.proretset,
           pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l  on l.oid = p.prolang
     where n.nspname = 'public'
       and p.prosecdef = true
       and l.lanname = 'plpgsql'
     order by p.proname;
  `);
  cols = await sql(`
    -- relkind 'r' = ordinary table, 'p' = partitioned table.
    -- Both are valid INSERT/UPDATE/DELETE targets and both can have
    -- columns whose names collide with OUT params, so the sweep
    -- must consider them. The SQL assertion in 0055 uses
    -- information_schema.columns, which already covers both kinds;
    -- this query mirrors that behaviour.
    select c.relname as table_name, a.attname as col_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'public'
       and c.relkind in ('r','p')
       and a.attnum > 0
       and not a.attisdropped;
  `);
} catch (e) {
  console.error(JSON.stringify({ status: "ERROR", error: e.message }, null, 2));
  process.exit(2);
}

const tableCols = new Map();
for (const r of cols) {
  if (!tableCols.has(r.table_name)) tableCols.set(r.table_name, new Set());
  tableCols.get(r.table_name).add(r.col_name);
}

const findings = [];
let withOutOrTable = 0;
for (const f of funcs) {
  // proargmodes: 'i' IN, 'o' OUT, 'b' INOUT, 'v' VARIADIC, 't' TABLE column.
  const modes = normalizePgArray(f.proargmodes);
  const names = normalizePgArray(f.proargnames);
  const outNames = [];
  if (modes) {
    for (let i = 0; i < modes.length; i++) {
      if (modes[i] === "o" || modes[i] === "b" || modes[i] === "t") {
        if (names[i]) outNames.push(names[i]);
      }
    }
  }
  if (outNames.length === 0) continue;
  withOutOrTable++;

  const def = String(f.def || "");
  const targets = new Set();
  const re = /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(def)) !== null) {
    const t = m[1].toLowerCase();
    if (tableCols.has(t)) targets.add(t);
  }

  const collisions = [];
  for (const t of targets) {
    const tc = tableCols.get(t);
    for (const o of outNames) if (tc.has(o)) collisions.push({ table: t, column: o });
  }
  if (collisions.length === 0) continue;

  const hasDirective = /#variable_conflict\s+use_column/i.test(def);
  findings.push({
    proname: f.proname,
    args: f.args,
    proretset: f.proretset,
    outNames,
    targets: [...targets].sort(),
    collisions,
    hasDirective,
    vulnerable: !hasDirective,
  });
}

const vulnerable = findings.filter(f => f.vulnerable);
if (vulnerable.length > 0) {
  console.error(JSON.stringify({
    status: "FAIL",
    reason:
      "SECURITY DEFINER PL/pgSQL function(s) have RETURNS TABLE(...)/OUT names " +
      "colliding with target table columns and are missing " +
      "`#variable_conflict use_column`. This is the defect class fixed in " +
      "migrations 0046 (xpc_admin_create_pair) and 0048 (xpc_redeem_pair_code). " +
      "Add the directive at the top of each function body or rename the OUT " +
      "parameters so they no longer shadow target table columns.",
    vulnerable,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "OK",
  scannedFunctions: funcs.length,
  withOutOrTableParams: withOutOrTable,
  protectedFindings: findings.length,
  findings,
}, null, 2));
process.exit(0);
