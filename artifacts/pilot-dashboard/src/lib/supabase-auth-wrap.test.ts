// Task #234 — verify the centralised stale-JWT 401 handler:
//   • `isAuthError` recognises the family of stale-JWT shapes that
//     supabase-js / PostgREST return (PGRST301, status 401, "JWT
//     expired" message text, …).
//   • `withFreshSession` returns ok=true when the wrapped call
//     succeeds, reason="other" for non-auth errors, and reason="auth"
//     when an auth error survives the refresh attempt.
//
// Run with:
//   pnpm --filter @workspace/pilot-dashboard exec tsx --test src/lib/supabase-auth-wrap.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthError, withFreshSession } from "./supabase.ts";

test("isAuthError recognises PostgREST 401 / JWT-expired shapes", () => {
  assert.equal(isAuthError({ code: "PGRST301", message: "JWT expired" }), true);
  assert.equal(isAuthError({ code: 401 }), true);
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(isAuthError({ statusCode: 401 }), true);
  assert.equal(isAuthError(new Error("JWT expired")), true);
  assert.equal(isAuthError(new Error("Auth session missing!")), true);
  assert.equal(isAuthError(new Error("Invalid JWT")), true);
  assert.equal(isAuthError({ message: "Unauthorized" }), true);
});

test("isAuthError ignores unrelated errors", () => {
  assert.equal(isAuthError(null), false);
  assert.equal(isAuthError(undefined), false);
  assert.equal(isAuthError({ code: "PGRST205", message: "Could not find the table" }), false);
  assert.equal(isAuthError(new Error("Network error")), false);
  assert.equal(isAuthError({ code: "42P01" }), false);
  assert.equal(isAuthError({ status: 500 }), false);
});

test("withFreshSession returns ok=true on success", async () => {
  const result = await withFreshSession(async () => 42);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, 42);
});

test("withFreshSession returns reason='other' for non-auth errors", async () => {
  const err = new Error("Network down");
  const result = await withFreshSession(async () => { throw err; });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "other");
    assert.equal(result.error, err);
  }
});

test("withFreshSession returns reason='auth' when auth error survives refresh", async () => {
  // In the test env supabase is null (no VITE_SUPABASE_URL), so
  // refreshSessionOnce returns false and the helper short-circuits to
  // reason='auth' on the first auth error WITHOUT a retry.
  let calls = 0;
  const result = await withFreshSession(async () => {
    calls += 1;
    throw { code: "PGRST301", message: "JWT expired" };
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "auth");
  // Refresh failed (no client) → no retry, only the initial call.
  assert.equal(calls, 1);
});
