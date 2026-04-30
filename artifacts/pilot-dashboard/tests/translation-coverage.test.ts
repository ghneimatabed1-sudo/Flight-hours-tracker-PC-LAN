// Translation-coverage guard for the dashboard sidebar.
//
// Background: `nav_pilot_alerts` slipped into production rendered as a raw
// key because HQLayout / Layout used `as Key` casts that silenced the
// TypeScript safety net (audit task #235). This test makes sure that
// (a) every static `labelKey` / `k:` literal referenced by the sidebar
// components resolves in the EN dictionary, and (b) the EN and AR
// dictionaries stay in lock-step so an EN entry can't ship without its
// Arabic counterpart.
//
// The casts in the layout files have been replaced with `satisfies
// NavItem[]` so TypeScript already catches a missing EN key at compile
// time. This runtime test is the second tripwire — it also catches AR
// drift, which the type system can't see, and it covers any new sidebar
// entry that future devs add without re-checking i18n coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dict } from "../src/lib/i18n.tsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(__dirname, "..", "src", "components");

const enKeys = new Set(Object.keys(dict.en));
const arKeys = new Set(Object.keys(dict.ar));

function extractSidebarLiterals(file: string, propNames: string[]): string[] {
  const src = readFileSync(join(COMPONENTS_DIR, file), "utf8");
  const literals = new Set<string>();
  for (const prop of propNames) {
    // matches `labelKey: "foo"` and `k: "foo"` (single or double quotes)
    const re = new RegExp(`\\b${prop}\\s*:\\s*["']([A-Za-z0-9_]+)["']`, "g");
    for (const match of src.matchAll(re)) literals.add(match[1]);
  }
  return [...literals];
}

test("AR dictionary covers every EN key", () => {
  const missingInAr = [...enKeys].filter(k => !arKeys.has(k));
  assert.deepEqual(
    missingInAr,
    [],
    `AR dict is missing translations for: ${missingInAr.join(", ")}`,
  );
});

test("EN dictionary covers every AR key (no orphan AR entries)", () => {
  const missingInEn = [...arKeys].filter(k => !enKeys.has(k));
  assert.deepEqual(
    missingInEn,
    [],
    `EN dict is missing keys present in AR: ${missingInEn.join(", ")}`,
  );
});

test("HQLayout sidebar labelKeys all resolve in the EN dict", () => {
  const literals = extractSidebarLiterals("HQLayout.tsx", ["labelKey"]);
  assert.ok(literals.length > 0, "HQLayout.tsx had zero labelKey literals — parser regression?");
  const unknown = literals.filter(k => !enKeys.has(k));
  assert.deepEqual(
    unknown,
    [],
    `HQLayout references unknown i18n keys: ${unknown.join(", ")}`,
  );
});

test("Squadron Layout sidebar k entries all resolve in the EN dict", () => {
  const literals = extractSidebarLiterals("Layout.tsx", ["k"]);
  assert.ok(literals.length > 0, "Layout.tsx had zero `k:` literals — parser regression?");
  const unknown = literals.filter(k => !enKeys.has(k));
  assert.deepEqual(
    unknown,
    [],
    `Layout references unknown i18n keys: ${unknown.join(", ")}`,
  );
});

test("Dynamic scope keys built from CommanderScope all exist in dict", () => {
  // HQLayout.tsx renders the active commander's scope via
  //   t(("scope" + scope[0].toUpperCase() + scope.slice(1)) as Key)
  // The `as Key` is unavoidable because the key is computed at runtime,
  // so this test enumerates every CommanderScope value and asserts the
  // corresponding key is present in both languages. The AR check is
  // already covered by the EN/AR diff above, but listing them here
  // documents the contract and fails with a much clearer message if a
  // new scope is added (e.g. `regional`) without a matching entry.
  const scopes = ["squadron", "flight", "wing", "base", "hq"] as const;
  const expected = scopes.map(s => "scope" + s[0].toUpperCase() + s.slice(1));
  const missing = expected.filter(k => !enKeys.has(k));
  assert.deepEqual(
    missing,
    [],
    `Dynamic scope keys missing from EN dict: ${missing.join(", ")}`,
  );
});
