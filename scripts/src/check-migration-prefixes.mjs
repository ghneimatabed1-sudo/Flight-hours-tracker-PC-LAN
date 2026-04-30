#!/usr/bin/env node
// scripts/src/check-migration-prefixes.mjs
//
// Task #249 — CI / pre-commit guard against duplicate Supabase
// migration numeric prefixes.
//
// Why this exists
// ─────────────────
// Audit H proved that when two unrelated migration files share the
// same `NNNN_` numeric prefix (e.g. both shipped on `0052_…`), the
// live `_migration_ledger` records ONE of them as applied while the
// other silently never reaches production. The author of the
// second migration thinks it shipped because the apply workflow
// reports success, but operators keep seeing the bug the migration
// was meant to fix.
//
// This script walks `artifacts/pilot-dashboard/supabase/migrations/`,
// groups every `*.sql` file by its leading 4-digit prefix, and
// fails with a clear error if any prefix is shared by files that
// are NOT both already on the legacy-duplicates allowlist below.
//
// Why an allowlist (and not "always fail")
// ──────────────────────────────────────────
// Several pre-existing duplicate prefixes (0051, 0052, 0053) are
// already applied in production. Renumbering them on disk would
// orphan their `_migration_ledger` rows AND trigger the apply
// workflow to re-run them under the new filename. Some of those
// migrations are not strictly idempotent — re-applying them risks
// data corruption. The safer option is to freeze the historical
// collisions in this allowlist and prevent any NEW collisions from
// here on out.
//
// Adding to the allowlist requires acknowledging in writing that
// you've checked the live ledger and confirmed BOTH duplicate
// files are recorded there with matching sha256 digests. Otherwise
// you have a Task-#249-class drift bug on your hands.
//
// Usage
// ──────
//   node scripts/src/check-migration-prefixes.mjs
//   node scripts/src/check-migration-prefixes.mjs --dir <path>
//
// Exit codes:
//   0  no NEW duplicate prefixes (legacy duplicates ignored).
//   1  at least one NEW duplicate prefix; offending files printed.
//   2  setup error (missing migrations directory, etc).

import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ── Args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let migrationsDir = resolve(
  REPO_ROOT,
  "artifacts/pilot-dashboard/supabase/migrations",
);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && args[i + 1]) {
    migrationsDir = resolve(args[i + 1]);
    i++;
  }
}

// ── Legacy duplicates allowlist ───────────────────────────────────
// These prefix collisions were already applied to the live Supabase
// project (`nklrdhfsbevckovqqkah`) before the Task #249 guard was
// installed. Each entry is the FULL set of files sharing that
// prefix; the guard is satisfied only when the on-disk set for the
// prefix matches this set exactly. Adding a new file to one of
// these prefixes (or removing one) re-trips the guard.
//
// DO NOT add new entries here without verifying every file in the
// group is recorded in `public._migration_ledger` with a matching
// sha256. The whole point of this script is to catch the silent
// drift that this list represents.
const LEGACY_DUPLICATES = {
  "0051": new Set([
    "0051_pilot_rls_lockdown.sql",
    "0051_reconcile_ghost_ledger.sql",
    "0051_xpc_messages_retention_backstop.sql",
    "0051_xpc_pair_links_sweep_internal.sql",
  ]),
  "0052": new Set([
    "0052_backfill_ledger_sha256.sql",
    "0052_xpc_messages_autoclaim_no_recipient_grant.sql",
  ]),
  "0053": new Set([
    "0053_backfill_xpc_squadron_name_snapshots.sql",
    "0053_pilot_transfer.sql",
  ]),
};

// ── Walk the migrations directory ─────────────────────────────────
let entries;
try {
  entries = readdirSync(migrationsDir);
} catch (err) {
  console.error(
    `check-migration-prefixes: cannot read migrations dir ${migrationsDir}: ${err.message}`,
  );
  process.exit(2);
}

const sqlFiles = entries
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => {
    try {
      return statSync(resolve(migrationsDir, f)).isFile();
    } catch {
      return false;
    }
  })
  .sort();

if (sqlFiles.length === 0) {
  console.error(
    `check-migration-prefixes: no .sql files found under ${migrationsDir}`,
  );
  process.exit(2);
}

// Group by leading 4-digit numeric prefix. A filename that does not
// start with NNNN_ is itself an error — every migration must carry
// a sortable numeric prefix or the lex-ordered apply workflow can't
// reason about it.
const PREFIX_RE = /^(\d{4})_/;
const byPrefix = new Map();
const malformed = [];
for (const f of sqlFiles) {
  const m = f.match(PREFIX_RE);
  if (!m) {
    malformed.push(f);
    continue;
  }
  const p = m[1];
  if (!byPrefix.has(p)) byPrefix.set(p, []);
  byPrefix.get(p).push(f);
}

const errors = [];
if (malformed.length > 0) {
  errors.push(
    `Migrations missing the required NNNN_ numeric prefix:\n  - ${malformed.join("\n  - ")}`,
  );
}

for (const [prefix, files] of byPrefix) {
  if (files.length === 1) continue; // unique → fine

  const allowed = LEGACY_DUPLICATES[prefix];
  if (!allowed) {
    errors.push(
      `Duplicate numeric prefix \`${prefix}_\` is shared by ${files.length} migration files:\n  - ${files.join("\n  - ")}\n` +
        `Renumber the new file to the next free numeric prefix (highest existing + 1) ` +
        `and update its self-insert into \`public._migration_ledger\` to match.`,
    );
    continue;
  }

  // Allowlisted prefix — set must match exactly.
  const onDisk = new Set(files);
  const expected = allowed;
  const extra = [...onDisk].filter((f) => !expected.has(f));
  const missing = [...expected].filter((f) => !onDisk.has(f));
  if (extra.length > 0) {
    errors.push(
      `New file added to legacy-duplicate prefix \`${prefix}_\`: ${extra.join(", ")}\n` +
        `That prefix is already recorded in production for the existing files; ` +
        `renumber the new file to the next free numeric prefix instead of piling onto a known-collision group.`,
    );
  }
  if (missing.length > 0) {
    errors.push(
      `Legacy-duplicate prefix \`${prefix}_\` is missing expected file(s): ${missing.join(", ")}\n` +
        `Removing or renaming an already-applied migration orphans its \`_migration_ledger\` row. ` +
        `If you really need to do this, update the LEGACY_DUPLICATES map in this script and document why in the commit.`,
    );
  }
}

if (errors.length > 0) {
  console.error("✗ check-migration-prefixes: FAILED\n");
  for (const e of errors) {
    console.error(e + "\n");
  }
  console.error(
    "Why this matters: when two migrations share a numeric prefix, the live\n" +
      "`_migration_ledger` can record one as applied while the other silently\n" +
      "never reaches production (Audit H / Task #249). Renumber the new file\n" +
      "to a unique prefix so the apply-supabase-migrations workflow keys it\n" +
      "under its own ledger row.\n",
  );
  process.exit(1);
}

console.log(
  `✓ check-migration-prefixes: ${sqlFiles.length} migration file(s) scanned, no new duplicate prefixes.`,
);
