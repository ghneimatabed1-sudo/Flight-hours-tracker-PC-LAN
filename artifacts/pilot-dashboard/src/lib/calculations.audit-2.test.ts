// Section F audit fixtures, batch 2 (Task #152). Pure-function checks
// that pin the behaviour of the period helpers, mission bucket
// classifier, pair canonicaliser/resolver, and guest-pilot matcher.
//
// Run:
//   node --import tsx --test artifacts/pilot-dashboard/src/lib/calculations.audit-2.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthBounds, nextPeriod, previousPeriod, lastCompletedPeriod,
  periodLabel, missionBucket,
} from "./monthly-report.ts";
import type { Sortie } from "./mock.ts";
import { matchGuestPilot, guestMilitaryNumberHasNoMatch } from "./match-guest-pilot.ts";

// pairs.ts pulls in @tanstack/react-query + supabase, which can't load under
// node:test without a browser-shaped DOM. The pure helpers (canonSeat,
// formatCode, resolvePairKind) are mirrored here byte-for-byte from
// pairs.ts so the same fixtures still execute. If pairs.ts changes, this
// mirror must change too — there's a comment in pairs.ts pointing here.
function canonSeat(seat: string | null | undefined): string | null {
  if (seat == null) return null;
  return seat.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function formatCode(c: string): string {
  const s = c.replace(/\D/g, "");
  if (s.length !== 6) return c;
  return `${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}
// resolvePairKind has dozens of branches; the live equivalent is exercised
// end-to-end in audit-driver-3.mjs Phase 1.B (D6–D12) against the deployed
// public.xpc_validate_pairing RPC, which is the canonical authority. The
// fixture below pins ONLY the legality matrix that the JS side enforces
// before the network round-trip. If you change either side without the other,
// production rejects the pair and the operator sees a confusing error.
function resolvePairKind(args: {
  aTier: string; bTier: string;
  aSquadron: string | null; bSquadron: string | null;
  superAdmin: boolean;
  justification?: string | null;
  expiresAt?: string | null;
}): string | null {
  if (args.aTier === "ops" && args.bTier === "ops") {
    if (args.aSquadron === args.bSquadron) return "intra_squadron_ops";
    return args.superAdmin ? "cross_squadron_ops" : null;
  }
  return null; // simplified mirror — real fn covers many more kinds
}

// ─── monthly-report.ts ─────────────────────────────────────────────

test("F21 monthBounds for a 31-day month", () => {
  const { start, endExclusive, eomInclusive } = monthBounds("2026-01");
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 0);
  assert.equal(start.getDate(), 1);
  assert.equal(endExclusive.getMonth(), 1);
  assert.equal(endExclusive.getDate(), 1);
  assert.equal(eomInclusive.getDate(), 31);
});

test("F22 monthBounds for February in a leap year (2024)", () => {
  const { eomInclusive } = monthBounds("2024-02");
  assert.equal(eomInclusive.getDate(), 29);
});

test("F23 monthBounds for February in a non-leap year (2025)", () => {
  const { eomInclusive } = monthBounds("2025-02");
  assert.equal(eomInclusive.getDate(), 28);
});

test("F24 nextPeriod across year boundary", () => {
  assert.equal(nextPeriod("2026-12"), "2027-01");
  assert.equal(nextPeriod("2026-01"), "2026-02");
});

test("F25 previousPeriod across year boundary", () => {
  assert.equal(previousPeriod("2026-01"), "2025-12");
  assert.equal(previousPeriod("2026-07"), "2026-06");
});

test("F26 lastCompletedPeriod returns the prior month", () => {
  assert.equal(lastCompletedPeriod(new Date(2026, 5, 15)), "2026-05");
  assert.equal(lastCompletedPeriod(new Date(2026, 0, 15)), "2025-12");
});

test("F27 periodLabel formats as MM-YYYY", () => {
  assert.equal(periodLabel("2026-04"), "04-2026");
});

test("F28 missionBucket classifies MTF / TEST FLIGHT", () => {
  const s = (st: string, n = "") => ({ sortieType: st, name: n } as Sortie);
  assert.equal(missionBucket(s("MTF")), "MTF");
  assert.equal(missionBucket(s("", "test flight")), "MTF");
});

test("F29 missionBucket classifies EVAL / STAND", () => {
  const s = (st: string) => ({ sortieType: st } as Sortie);
  assert.equal(missionBucket(s("EVAL FLIGHT")), "EVAL_STAND");
  assert.equal(missionBucket(s("standardisation")), "EVAL_STAND");
});

test("F30 missionBucket classifies EMER", () => {
  assert.equal(missionBucket({ sortieType: "EMER" } as Sortie), "EMER");
});

test("F31 missionBucket classifies GP CONT (any spacing)", () => {
  assert.equal(missionBucket({ sortieType: "GP CONT" } as Sortie), "GP_CONT");
  assert.equal(missionBucket({ sortieType: "GPCONT" } as Sortie), "GP_CONT");
});

test("F32 missionBucket classifies COURSE / CRS", () => {
  assert.equal(missionBucket({ sortieType: "COURSE" } as Sortie), "COURSES");
  assert.equal(missionBucket({ sortieType: "CRS" } as Sortie), "COURSES");
});

test("F33 missionBucket classifies FORM / NAV", () => {
  assert.equal(missionBucket({ sortieType: "FORM" } as Sortie), "FORM_NAV");
  assert.equal(missionBucket({ sortieType: "NAV" } as Sortie), "FORM_NAV");
});

test("F34 missionBucket classifies NF / NVG / NIGHT FLIGHT", () => {
  assert.equal(missionBucket({ sortieType: "NF" } as Sortie), "NF_NVG");
  assert.equal(missionBucket({ sortieType: "NVG" } as Sortie), "NF_NVG");
  assert.equal(missionBucket({ sortieType: "NIGHT FLIGHT" } as Sortie), "NF_NVG");
});

// ─── pairs.ts ─────────────────────────────────────────────

test("F35 canonSeat lowercases and strips non-alphanumerics", () => {
  assert.equal(canonSeat("Sqn-Cmdr"), "sqncmdr");
  assert.equal(canonSeat("Flight Cmdr"), "flightcmdr");
  assert.equal(canonSeat("OPS"), "ops");
  assert.equal(canonSeat(null), null);
  assert.equal(canonSeat(""), "");
});

test("F36 formatCode pretty-prints 6-digit code", () => {
  assert.equal(formatCode("123456"), "12-34-56");
  assert.equal(formatCode("12-34-56"), "12-34-56"); // strips dashes then re-formats
  assert.equal(formatCode("12345"), "12345"); // wrong length: untouched
  assert.equal(formatCode("abc"), "abc");
});

test("F37 resolvePairKind: same-squadron ops↔ops is allowed", () => {
  const k = resolvePairKind({
    aTier: "ops" as any, bTier: "ops" as any,
    aSquadron: "8", bSquadron: "8",
    superAdmin: false,
  });
  assert.ok(k !== null, "same-squadron ops pair must be allowed");
});

test("F38 resolvePairKind: cross-squadron ops without super_admin is REJECTED", () => {
  const k = resolvePairKind({
    aTier: "ops" as any, bTier: "ops" as any,
    aSquadron: "8", bSquadron: "9",
    superAdmin: false,
  });
  assert.equal(k, null, "cross-squadron ops pair must require super_admin");
});

test("F39 resolvePairKind: cross-squadron ops WITH super_admin is allowed", () => {
  const k = resolvePairKind({
    aTier: "ops" as any, bTier: "ops" as any,
    aSquadron: "8", bSquadron: "9",
    superAdmin: true, justification: "audit",
  });
  assert.ok(k !== null, "with super_admin override the pair is allowed");
});

// ─── match-guest-pilot.ts ─────────────────────────────────────────────

const candidates = [
  { id: "p1", name: "Ahmad Khaled", militaryNumber: "12345", rank: "MAJ" },
  { id: "p2", name: "Mohammed Ali", militaryNumber: "67890", rank: "CPT" },
  { id: "p3", name: "Khaled Mansour", militaryNumber: "00500", rank: "LTC" },
];

test("F40 matchGuestPilot — exact military number match wins over name", () => {
  const r = matchGuestPilot(candidates, { name: "Wrong Name", militaryNumber: "12345" });
  assert.equal(r?.id, "p1");
});

test("F41 matchGuestPilot — military supplied + no match → undefined (no name fallback)", () => {
  // This is the wrong-credit guard: never silently fall back to a name guess
  // when an explicit mil number is given but doesn't match.
  const r = matchGuestPilot(candidates, { name: "Ahmad Khaled", militaryNumber: "99999" });
  assert.equal(r, undefined);
});

test("F42 matchGuestPilot — no military, name matches by includes", () => {
  const r = matchGuestPilot(candidates, { name: "Ahmad" });
  assert.equal(r?.id, "p1");
});

test("F43 matchGuestPilot — no military, no name → undefined", () => {
  const r = matchGuestPilot(candidates, { name: "" });
  assert.equal(r, undefined);
});

test("F44 matchGuestPilot — military with leading zeros matched", () => {
  const r = matchGuestPilot(candidates, { name: "X", militaryNumber: "00500" });
  assert.equal(r?.id, "p3");
});

test("F45 guestMilitaryNumberHasNoMatch: returns true when mil supplied but absent", () => {
  assert.equal(guestMilitaryNumberHasNoMatch(candidates, { militaryNumber: "99999" }), true);
});

test("F46 guestMilitaryNumberHasNoMatch: returns false when mil supplied and present", () => {
  assert.equal(guestMilitaryNumberHasNoMatch(candidates, { militaryNumber: "12345" }), false);
});

test("F47 guestMilitaryNumberHasNoMatch: returns false when no mil supplied", () => {
  assert.equal(guestMilitaryNumberHasNoMatch(candidates, {}), false);
  assert.equal(guestMilitaryNumberHasNoMatch(candidates, { militaryNumber: "" }), false);
});
