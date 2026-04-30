import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchInternalSortieTableRows,
  internalPilotDeleteFetch,
  internalPilotUpsertFetch,
  internalSortieInsertFetch,
} from "../src/lib/internal-migration";
import { getRequestStatus, requestJoin } from "../src/lib/unit-join";

test("fault injection: requestJoin rejects too-short password locally", async () => {
  const out = await requestJoin({
    role: "ops",
    squadronNames: ["NO.8 SQDN"],
    username: "ops.user",
    displayName: "Capt. Ops",
    password: "short",
    fingerprint: "FP-X",
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.error, "password_too_short");
});

test("fault injection: request status returns unknown shape on misconfigured transport", async () => {
  const st = await getRequestStatus("REQ-404");
  assert.equal(st.status, "unknown");
  assert.equal(st.claim_consumed, false);
});

test("fault injection: internal write helpers fail closed when API is disabled", async () => {
  await assert.rejects(
    () => internalPilotUpsertFetch({ id: "P1", squadron_id: "SQ" }),
    /internal_api_disabled/i,
  );
  await assert.rejects(
    () => internalPilotDeleteFetch("P1"),
    /internal_api_disabled/i,
  );
  await assert.rejects(
    () => internalSortieInsertFetch({ squadron_id: "SQ", pilot_id: "P1", date: "2026-04-26" }),
    /internal_api_disabled/i,
  );
});

test("fault injection: internal sortie rows fetch returns null on disabled transport", async () => {
  const rows = await fetchInternalSortieTableRows(100);
  assert.equal(rows, null);
});
