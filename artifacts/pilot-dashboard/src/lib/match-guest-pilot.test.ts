import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGuestPilot, type GuestMatchCandidate } from "./match-guest-pilot.ts";

const ahmadA: GuestMatchCandidate = { id: "p1", name: "Ahmad Khalil", rank: "Capt", militaryNumber: "12345" };
const ahmadB: GuestMatchCandidate = { id: "p2", name: "Ahmad Khalil", rank: "Maj",  militaryNumber: "67890" };
const omar:   GuestMatchCandidate = { id: "p3", name: "Omar Farah",   rank: "Lt",   militaryNumber: "55555" };
const noNum:  GuestMatchCandidate = { id: "p4", name: "Yousef Aziz",  rank: "Capt" };
const roster = [ahmadA, ahmadB, omar, noNum];

test("disambiguates same-name pilots by military number", () => {
  assert.equal(matchGuestPilot(roster, { name: "Ahmad Khalil", militaryNumber: "12345" })?.id, "p1");
  assert.equal(matchGuestPilot(roster, { name: "Ahmad Khalil", militaryNumber: "67890" })?.id, "p2");
});

test("military number wins even when the name is wrong/typo'd", () => {
  assert.equal(matchGuestPilot(roster, { name: "Ahmd Khallil", militaryNumber: "67890" })?.id, "p2");
});

test("ignores leading zeros and surrounding whitespace on military numbers", () => {
  assert.equal(matchGuestPilot(roster, { name: "Omar Farah", militaryNumber: " 0055555 " })?.id, "p3");
});

test("returns undefined when military number is supplied but no roster pilot matches it", () => {
  // Critical safety: don't silently fall back to a name guess when the
  // hosting squadron supplied a number that doesn't exist locally.
  assert.equal(matchGuestPilot(roster, { name: "Ahmad Khalil", militaryNumber: "99999" }), undefined);
});

test("falls back to name match only when no military number is supplied", () => {
  assert.equal(matchGuestPilot(roster, { name: "Yousef Aziz" })?.id, "p4");
  // Both Ahmad Khalils tie on name; without a number we just pick the first.
  assert.equal(matchGuestPilot(roster, { name: "Ahmad Khalil" })?.id, "p1");
});

test("returns undefined when roster is empty or guest has no identifying info", () => {
  assert.equal(matchGuestPilot([], { name: "Ahmad", militaryNumber: "1" }), undefined);
  assert.equal(matchGuestPilot(roster, { name: "" }), undefined);
});
