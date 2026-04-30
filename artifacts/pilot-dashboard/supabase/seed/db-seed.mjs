#!/usr/bin/env node
// One-shot reset + reseed helper for a Supabase project.
//
//   SUPABASE_DB_URL=postgresql://postgres:PWD@db.<proj>.supabase.co:5432/postgres \
//     pnpm --filter @workspace/pilot-dashboard run db:seed
//
// What it does, in order:
//   1. Validates SUPABASE_DB_URL is set and does NOT look like a production
//      database (refuses unless I_KNOW_WHAT_IM_DOING=1 is also set).
//   2. Re-generates seed.sql from src/lib/mock.ts via generate-seed.mjs.
//   3. Truncates the operational tables (idempotent baseline).
//   4. Applies every migration in supabase/migrations in lexical order.
//   5. Applies the freshly generated seed.sql.
//   6. Prints a sanity-check row count.
//
// Requires the `psql` CLI to be on PATH. Pass `--yes` (or set CI=1) to skip
// the interactive confirmation prompt.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
// Task #137: dev/preview reseed loads the demo squadrons from
// seed.demo.sql; production seed.sql is intentionally empty.
const SEED_SQL = join(HERE, "seed.demo.sql");
const GENERATOR = join(HERE, "generate-seed.mjs");

function die(msg, code = 1) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(code);
}
function step(msg) { console.log(`\n==> ${msg}`); }

// ── 1. Validate SUPABASE_DB_URL ───────────────────────────────────────────
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  die(
    "SUPABASE_DB_URL is not set.\n" +
    "  Set it to the *direct* Postgres connection string for a non-production\n" +
    "  Supabase project (service-role / postgres user). Example:\n\n" +
    "    SUPABASE_DB_URL=postgresql://postgres:PWD@db.<project>.supabase.co:5432/postgres \\\n" +
    "      pnpm --filter @workspace/pilot-dashboard run db:seed\n\n" +
    "  See artifacts/pilot-dashboard/supabase/seed/README.md for the safe way\n" +
    "  to source this value (do not commit it to git)."
  );
}

// Refuse anything that smells like prod unless explicitly overridden. This is
// a best-effort heuristic — there is no foolproof way to tell from a URL
// whether the operator actually intends to wipe a live database.
const PROD_MARKERS = ["prod", "live", "production"];
const lcUrl = url.toLowerCase();
const looksLikeProd = PROD_MARKERS.some(m => lcUrl.includes(m));
if (looksLikeProd && process.env.I_KNOW_WHAT_IM_DOING !== "1") {
  die(
    "SUPABASE_DB_URL contains a production-like keyword (prod/live/production).\n" +
    "  Refusing to wipe and re-seed. If you really mean to do this, re-run with\n" +
    "  I_KNOW_WHAT_IM_DOING=1 in the environment."
  );
}

// Friendly, redacted preview so the operator can confirm the host without
// pasting credentials anywhere.
function maskUrl(u) {
  try {
    const parsed = new URL(u);
    const userPart = parsed.username ? `${parsed.username}:***@` : "";
    return `${parsed.protocol}//${userPart}${parsed.host}${parsed.pathname}`;
  } catch { return "(unparseable)"; }
}

// Interactive confirmation. CI runs and `--yes` skip the prompt.
async function confirm(target) {
  if (process.env.CI || process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = (s) => new Promise(r => rl.question(s, r));
  const ans = await q(`This will DROP and RECREATE the entire \`public\` schema\n  (every table, function, and policy under it) and then re-seed against\n  ${target}\n  Supabase's auth/storage/extensions schemas are untouched.\n  Continue? [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error && res.error.code === "ENOENT") {
    die(`Required command not found on PATH: ${cmd}`);
  }
  if (res.status !== 0) {
    die(`${cmd} exited with status ${res.status}`);
  }
}

function runPsql(extraArgs) {
  run("psql", [url, "-v", "ON_ERROR_STOP=1", ...extraArgs]);
}

// ── 2. Generate seed.sql ──────────────────────────────────────────────────
async function main() {
  step(`Target: ${maskUrl(url)}`);
  if (!await confirm(maskUrl(url))) {
    console.log("Aborted.");
    process.exit(0);
  }

  step("Re-generating seed.sql from mock data");
  run(process.execPath, [GENERATOR]);
  if (!existsSync(SEED_SQL)) die(`seed.sql was not produced at ${SEED_SQL}`);

  // Reset to a true clean slate before migrations. The migrations in this
  // project (0001_init, 0002_mobile_link) are not all rerun-safe — they
  // contain bare `create policy ...` statements that fail on a database
  // where the policy already exists. Dropping and recreating the `public`
  // schema gives every migration a fresh canvas, and works equally well
  // on a brand-new Supabase project where nothing exists yet. Supabase
  // system tables live in `auth`, `storage`, and `extensions`, so this
  // does not touch them.
  step("Resetting public schema (clean slate)");
  runPsql(["-c", "drop schema if exists public cascade; create schema public; grant all on schema public to postgres; grant usage on schema public to anon, authenticated, service_role;"]);

  step("Applying migrations");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();
  if (migrations.length === 0) die(`No migrations found in ${MIGRATIONS_DIR}`);
  for (const m of migrations) {
    console.log(`  - ${m}`);
    runPsql(["-f", join(MIGRATIONS_DIR, m)]);
  }

  step("Applying seed.sql");
  runPsql(["-f", SEED_SQL]);

  step("Sanity check");
  run("psql", [url, "-c",
    "select 'squadrons' as t, count(*) from squadrons " +
    "union all select 'pilots', count(*) from pilots " +
    "union all select 'sorties', count(*) from sorties;",
  ]);

  console.log("\n✓ Done. Demo squadron is ready.");
}

main().catch(e => die(e instanceof Error ? e.message : String(e)));
