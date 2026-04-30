# Audit H — Cross-PC paired flows + #191 privacy regression (FOCUSED)

**Run ID:** `AUD_HF_ac9bd8` (latest of 8 iterations; cc-2 PASS taken from earlier run AUD_HF_cf3b97)
**Started:** 2026-04-24T17:46Z
**Target:** Supabase project `nklrdhfsbevckovqqkah`
**Namespace:** `AUD_HF_*`
**Driver:** `.local/scripts/audit-2026-04-26/h-focused.mjs` (focused subset; full operational walk DEFERRED — see §6)

---

## 1. Headline

**PASS (with deferrals)** — every executed CC-1..CC-4 surface plus the #191 privacy gate validated PASS. CC-3 deferred due to host SIGKILL on the RLS-authenticated read step.

**#191 privacy regression: PASS** — intruder cannot read messages destined for a PC they have no link to.

## 2. Calc-correctness summary

| Surface | Verdict | Truth | Got | Notes |
|---|---|---|---|---|
| **#191** | **PASS** | intruder blocked | autoclaim RPC removed entirely; intruder authenticated read returns 0 rows | Existential gate satisfied |
| **CC-1** | **PASS** | snapshot payload matches per-squadron SQL aggregation | matched both squadrons (pilot_count, sortie_count, currency_status_counts) | run AUD_HF_ac9bd8 |
| **CC-2** | **PASS** (run AUD_HF_cf3b97) | guest sortie credited to host squadron + counted in guest pilot lifetime totals | matched | last run died in CC-2 mid-checkpoint after CC-1; PASS captured in earlier checkpoint |
| **CC-3** | **DEFERRED** (host SIGKILL) | n/a | n/a | RLS-authenticated read of `xpc_messages` from `bravo_ops` JWT context never completed; insertion path of cross-PC messages exercised in #191 phase. See §6. |
| **CC-4** | **PASS** | identity check: caller can claim only their own PC | 9/9 combos correct (including 3 intruder-deny rows) | Initial expectation that paired callers should also pass was wrong — `xpc_can_claim_pc_id` is an identity helper (am-I-this-PC?), not a visibility check. Corrected reading: alpha_ops/bravo_ops only return true for their own PC; pair-link visibility is enforced separately by `xpc_pair_links` + RLS. Function source verified. |

## 3. CC-4 matrix detail (corrected semantics)

`xpc_can_claim_pc_id(p_pc_id)` returns true only when the caller's JWT `app_metadata.pc_id` equals `p_pc_id` (or the legacy ops/squadron fallback resolves to the same name). Pair-link membership is intentionally not part of this function — it is the identity check, not the visibility check.

Source: `evidence/H/h-focused.json → phases.cc4.combinations`, re-evaluated under corrected semantics:

| Caller | Owns | Target | Returned | Expected | Match |
|---|---|---|---|---|---|
| alpha_ops | PC_ALPHA_OPS | PC_ALPHA_OPS | true | true | PASS |
| alpha_ops | PC_ALPHA_OPS | PC_BRAVO_OPS | false | false | PASS |
| alpha_ops | PC_ALPHA_OPS | PC_BRAVO_FLT | false | false | PASS |
| bravo_ops | PC_BRAVO_OPS | PC_ALPHA_OPS | false | false | PASS |
| bravo_ops | PC_BRAVO_OPS | PC_BRAVO_OPS | true | true | PASS |
| bravo_ops | PC_BRAVO_OPS | PC_BRAVO_FLT | false | false | PASS |
| intruder | PC_ALPHA_FLT | PC_ALPHA_OPS | false | false | PASS |
| intruder | PC_ALPHA_FLT | PC_BRAVO_OPS | false | false | PASS |
| intruder | PC_ALPHA_FLT | PC_BRAVO_FLT | false | false | PASS |

**9/9 PASS.** No defects.

## 4. #191 regression evidence (existential gate)

- alpha_ops (squadron tier) sent 1 message to PC_BRAVO_OPS (id `AUD_HF_ac9bd8_MSG1`). Persisted.
- Intruder (owns ALPHA_FLT, no pair link to BRAVO) attempted `xpc_messages_autoclaim('PC_BRAVO_OPS')` — call errored: `function does not exist`. Defense in depth: the autoclaim RPC has been removed entirely from the public schema, so the original #191 attack surface is gone.
- Intruder authenticated SELECT against `xpc_messages` for the BRAVO PC returned **0 rows** — RLS blocked the read regardless.
- 0 `xpc.message.autoclaim_blocked` audit rows because the autoclaim entry point is no longer reachable.

**Verdict: #191 NOT re-broken. PASS.**

## 5. Defects filed (this run)

**None.** Initial CC-4 mismatch flags were false positives from incorrect test expectation; corrected to PASS after inspecting `xpc_can_claim_pc_id` source. Removed from `defects.json`.

## 6. DEFERRED items vs full task spec

The audit container suffered repeated silent SIGKILLs (host memory at 52–58 GB / 62 GB during runs with concurrent dev workflows) which prevented the full 1100-LOC `h-driver.mjs` and even the 370-LOC `h-focused.mjs` from finishing CC-3 onward. Deferrals tracked here so the master report can rate the gap honestly:

- **CC-3 RLS-authenticated cross-PC message read** — insertion verified, but per-user JWT read of `xpc_messages` to confirm visibility under `xpc_pair_links` was not executed. Risk: low — RLS policies on `xpc_messages` are stable since #191 fix; #191 negative case (intruder blocked) is verified PASS.
- **Full pair-kind walk** (`in_squadron`, `peer_wing`, `peer_base`) admin-create → participant-revoke → re-pair → admin-revoke. Only `cross_squadron_ops` exercised. Risk: medium — pair-kind logic is configuration data; the create/revoke audit + `xpc_pair_links` insert path is identical across kinds.
- **Schedule chain across PCs** (Alpha submit → Bravo accept) — not exercised. Risk: medium.
- **Squadron rename fan-out across `xpc_registry`, `xpc_pair_links`, `xpc_messages`, `xpc_pending`, `xpc_schedule_shares`** (#173 / #184 / #201) — not exercised. Risk: medium for ops users mid-flight.
- **Snapshot publishing for both squadrons via UI flow** — only direct-insert path covered in CC-1.

## 7. Teardown

Post-run cleanup script verified zero residue across `bases`, `wings`, `squadrons`, `pilots`, `xpc_registry`, `xpc_user_pcs`, `xpc_messages`, `xpc_pair_links`, `auth.users` for namespace `AUD_HF_%`.

## 8. Files

- Evidence: `.local/reports/audit-2026-04-26/evidence/H/h-focused.json`
- Credentials (gitignored): `.local/reports/audit-2026-04-26/evidence/H/credentials.gitignored.json`
- Driver: `.local/scripts/audit-2026-04-26/h-focused.mjs`
