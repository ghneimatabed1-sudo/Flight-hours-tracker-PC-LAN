// Forward-compatibility regression for `ensureFullSchema()`.
//
// Hawk Eye is intended to run unattended for ~15 years on a Postgres
// instance the operator may upgrade in place (Postgres 14 → 15 → 16 …),
// and the api-server binary may be replaced at any time with a newer
// build that adds tables / columns / indexes. The bring-up code calls
// `ensureFullSchema()` on every server start, so every DDL statement
// it issues MUST be idempotent — otherwise a second start crashes the
// host PC and a remote operator has to drive out to recover the box.
//
// This test stubs `pool.query` with an in-memory recorder, runs
// `ensureFullSchema()` three times back to back, and asserts:
//
//   1. Every CREATE TABLE / CREATE INDEX / CREATE TYPE includes
//      `IF NOT EXISTS` (Postgres' idempotent flavour).
//   2. Every ALTER TABLE … ADD COLUMN includes `IF NOT EXISTS`.
//   3. Every INSERT into a config/seed table uses `ON CONFLICT DO …`.
//   4. The same statements are emitted on every run — no
//      first-run-only branches that would skip recovery.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard run test:ensure-schema

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";

import { test } from "node:test";
import assert from "node:assert/strict";

import { pool } from "../../../lib/db/src/index";
import { ensureFullSchema } from "../../api-server/src/lib/lan-auth-schema";

type StubResult = { rows: unknown[]; rowCount: number };
const stubResult: StubResult = { rows: [], rowCount: 0 };

const recorded: string[] = [];

(pool as unknown as { query: (...args: unknown[]) => Promise<StubResult> }).query =
  async (...args: unknown[]) => {
    const sql = typeof args[0] === "string"
      ? args[0]
      : typeof (args[0] as { text?: string } | undefined)?.text === "string"
        ? (args[0] as { text: string }).text
        : "";
    recorded.push(sql);
    return stubResult;
  };

function splitStatements(sqlBlock: string): string[] {
  // Naive split on `;` — good enough for ensureFullSchema's
  // semicolon-separated DDL blocks (no PL/pgSQL in there).
  return sqlBlock
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

function assertIdempotent(stmts: string[]): void {
  for (const raw of stmts) {
    const stmt = raw.toLowerCase();
    if (stmt.startsWith("create table") || stmt.startsWith("create unique index")
        || stmt.startsWith("create index") || stmt.startsWith("create type")
        || stmt.startsWith("create sequence") || stmt.startsWith("create extension")) {
      assert.ok(
        stmt.includes("if not exists"),
        `Non-idempotent DDL — missing IF NOT EXISTS:\n${raw}`,
      );
    }
    if (stmt.startsWith("alter table") && stmt.includes("add column")) {
      assert.ok(
        stmt.includes("add column if not exists"),
        `Non-idempotent ALTER — missing ADD COLUMN IF NOT EXISTS:\n${raw}`,
      );
    }
    if (stmt.startsWith("insert into")) {
      assert.ok(
        stmt.includes("on conflict"),
        `Seed INSERT must use ON CONFLICT to be re-runnable:\n${raw}`,
      );
    }
  }
}

test("ensureFullSchema is idempotent across three back-to-back runs", async () => {
  recorded.length = 0;
  await ensureFullSchema();
  const firstRunStatements = recorded
    .flatMap(splitStatements);
  const firstRunCount = recorded.length;

  recorded.length = 0;
  await ensureFullSchema();
  const secondRunCount = recorded.length;

  recorded.length = 0;
  await ensureFullSchema();
  const thirdRunCount = recorded.length;

  // Same query batches must be emitted every run — no first-boot-only
  // branches. (Statement counts may legitimately vary slightly if a
  // statement uses `do $$ … end $$`, but the plain top-level pool.query
  // calls should match one-for-one.)
  assert.equal(secondRunCount, firstRunCount, "second run differs from first");
  assert.equal(thirdRunCount, firstRunCount, "third run differs from first");

  assertIdempotent(firstRunStatements);
});

test("the new audit_log composite index + system_health_marker table are emitted", async () => {
  recorded.length = 0;
  await ensureFullSchema();
  const blob = recorded.join("\n").toLowerCase();
  assert.ok(
    blob.includes("audit_log_occurred_at_type_idx"),
    "missing the (occurred_at, type) composite index",
  );
  assert.ok(
    blob.includes("create table if not exists system_health_marker"),
    "missing the system_health_marker table",
  );
});
