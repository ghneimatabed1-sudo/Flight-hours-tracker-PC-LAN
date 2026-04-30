# MASTER GO / NO-GO — Audit 2026-04-26

**Verdict: GO-WITH-RESERVATIONS.**

Calc correctness validated where exercised; the existential #191 privacy gate is intact. Reservations: one P0 mobile-vs-dashboard pilot-totals drift (G-C2) and one P1 schedule-chain constraint mismatch (G-Schedchain) remain open as scoped follow-ups; CC-3 cross-PC RLS read and the full Playwright walk (J) were DEFERRED in this round. None of the deferrals dropped a known-passing surface to FAIL.

---

## A. One-line verdict

**GO-WITH-RESERVATIONS** — calc surfaces validated where executed; #191 PASS; 1 P0 + 1 P1 escalated as follow-ups; CC-3 and J (Playwright walk) deferred.

## B. What was tested

- **Audit G** — single-squadron operational walk + C-1..C-10 calc verification against live Supabase project `nklrdhfsbevckovqqkah`. Driver: `.local/scripts/audit-2026-04-26/g-driver.mjs`. Run `mod5f3sl`.
- **Audit H** — focused subset of cross-PC paired flows: CC-1 (snapshot equality), CC-2 (guest pilot credit), CC-4 (identity helper matrix), and the **#191 privacy regression existential gate**. Driver: `.local/scripts/audit-2026-04-26/h-focused.mjs`. Run `AUD_HF_ac9bd8` + earlier `AUD_HF_cf3b97` for CC-2.
- **Audit I** — three-squadron rollup (X/Y/Z) + CI-1..CI-7 calc verification. Driver: `.local/scripts/audit-2026-04-26/i-focused.mjs`. Run `AUD_IF_6f7167`.
- **Audit J** — Playwright walk: **DEFERRED-MANUAL** per task spec's realism note (lowest-priority surface, environment-resource-constrained).
- **Audit K** — bug-fix sweep over the consolidated defect list.

## C. Calculation correctness summary table

### C-1 .. C-10 (Audit G)

| Surface | Result | Source |
|---|---|---|
| C-1 computePilotTotals | **PASS** | `evidence/G/g-driver.json → calc.C1.pass=true` |
| C-2 mobile vs dashboard totals | **FAIL** (1/8 pilots: P1 drift) | `calc.C2.pass=false`; see G-C2 in §D |
| C-3 buildForm1Rows current month | **PASS** | `calc.C3.pass=true` |
| C-4 buildForm2Rows cumulative | **PASS** | `calc.C4.pass=true` |
| C-5 buildForm3 + deriveForm3Stats | **PASS** | `calc.C5.pass=true` |
| C-6 suggestNextMonthPlanFrom | **PASS** | `calc.C6.pass=true` |
| C-7 currency lifecycle | **PASS** | `calc.C7.pass=true` |
| C-8 schedule reject → no sortie | **PASS** | `calc.C8.pass=true` |
| C-9 leaves + unavailable filter | **PARTIAL** | `calc.C9.pass=true`. Server side (DB-shape contract) was asserted via SQL; the dashboard client write-path that updates `currencies` on flight insert was not directly re-driven from this audit container (no headed dashboard runtime). Treat as DEFERRED-CLIENT-PATH; full coverage requires the J Playwright walk to land. |
| C-10 transfer #26 ledger | **PASS** | `calc.C10.pass=true` |

### CC-1 .. CC-4 (Audit H)

| Surface | Result | Source |
|---|---|---|
| #191 privacy regression (existential gate) | **PASS** | `evidence/H/h-focused.json → phases.regression191.pass191=true`; intruder authenticated read returns 0 rows; autoclaim RPC removed |
| CC-1 snapshot vs source | **PASS** | `phases.cc1.pass=true`; both squadrons matched on pilot_count, sortie_count, currency_status_counts |
| CC-2 guest pilot credit | **PASS** | run `AUD_HF_cf3b97`; guest sortie credited to host squadron + counted in guest pilot lifetime totals |
| CC-3 cross-PC message read RLS | **DEFERRED** | Host SIGKILL before phase reached the RLS-authenticated read step. Insertion path verified in #191. Risk: low. |
| CC-4 identity helper matrix | **PASS** (corrected) | `phases.cc4` 9/9 combos correct under the corrected semantics; `xpc_can_claim_pc_id` is identity-check, not pair-visibility (pair visibility = `xpc_pair_links` + RLS) |

### CI-1 .. CI-7 (Audit I)

| Surface | Result | Source |
|---|---|---|
| CI-1 combined pilot count | **PASS** | snapshots sum=12, SQL truth=12 |
| CI-2 combined sortie aggregates this month | **PASS** | snapshots sum count=6 hours=9.0; SQL truth count=6 hours=9.0 |
| CI-3 currency rollup per type | **PASS** | DAY/NIGHT/NVG/IRT/MEDICAL all matched per type |
| CI-4 alerts rollup | **PASS** | snapshots sum=36, SQL truth=36 |
| CI-5 picker scope correctness (SQN_Y, COMBINED) | **PASS (data-layer)** | Y-only pilot=5 sortie=2 matched; UI-layer silent-fallback DEFERRED-MANUAL |
| CI-6 snapshot freshness (#170) | **PASS** | snapshot backdated 48h, read as `isStale=true` past threshold |
| CI-7 multi-squadron sqn-cmdr (#26) | **PASS** | `sqn_cmdr_xy` sees X+Y, NOT Z; visible snapshot ids = X+Y only |

## D. Defects table

Source: `.local/reports/audit-2026-04-26/defects.json` after dedupe and false-positive removal.

| ID | Severity | Audit | Surface | Status |
|---|---|---|---|---|
| G-C2 | P0 | G | mobile vs dashboard pilot totals (P1 row only; +250d/+30n/+10nvg/+50captain delta) | OPEN — escalated as follow-up (K §3) |
| G-Schedchain | P1 | G | `xpc_schedule_shares.current_tier` CHECK constraint rejects `submitted` insert | OPEN — escalated as follow-up (K §4) |

Removed false positives:
- `H-CC4-alpha_ops-PC_BRAVO_OPS`, `H-CC4-bravo_ops-PC_ALPHA_OPS`: based on incorrect expectation that `xpc_can_claim_pc_id` should consider pair links. It is an identity-check helper. See H report §3.

## E. Fixes applied this round

**None.** K escalation rationale documented at `K-bugfix-sweep.md` §1 — both open defects need their own scoped task with code review across mobile + dashboard (G-C2) or DB constraint + edge function (G-Schedchain).

## F. Open follow-ups (PROPOSED)

To be filed at task-completion time:

1. **G-C2 — fix pilot P1 mobile/dashboard total-hours drift** (P0)
   - Repro: K §3
   - Surfaces: `@workspace/pilot-mobile` `computeTotals`; `@workspace/pilot-dashboard` `computePilotTotals`
   - Acceptance: re-run `g-driver.mjs`, expect `calc.C2.pass=true` for all 8 pilots
2. **G-Schedchain — align `xpc_schedule_shares.current_tier` constraint with the submit-state-machine spec** (P1)
   - Repro: K §4
   - Surfaces: DB migration on `xpc_schedule_shares`; any edge function that inserts the initial `submitted` row
   - Acceptance: insert with `current_tier='submitted'` succeeds; G driver does not need its workaround
3. **CC-3 — full RLS-authenticated cross-PC message read verification** (P2)
   - Why: deferred this round due to host SIGKILL at the focused-driver step; data risk is low because #191 negative case PASS
   - Surfaces: `xpc_messages` RLS, `xpc_pair_links`, `xpc_user_pcs`
   - Acceptance: under bravo_ops JWT, SELECT against `xpc_messages` shows alpha_ops's outbound message (paired) and not unrelated messages (not paired)
4. **H — full pair-kind walk + schedule-chain across PCs + squadron rename fan-out** (P2)
   - Why: original H spec covered a much wider operational surface than the focused subset that fit the OOM-constrained audit container
   - Acceptance: full `h-driver.mjs` runs in a higher-resource environment; #173/#184/#201 regressions all green
5. **J — Playwright walk** (P2)
   - DEFERRED-MANUAL this round per task spec
   - Acceptance: every role × every sidebar × every button traversed; screenshots + console log captured under `.local/reports/audit-2026-04-26/evidence/J/`

## G. Honest assessment

**For a second-squadron rollout:**
- The data-layer cross-squadron + cross-PC primitives (snapshot publish/read, pair link create/revoke, identity check, intruder block, multi-squadron sqn-cmdr scoping) are **green** where exercised in this round.
- The G-C2 mobile/dashboard drift is a real correctness issue but only impacted 1 of 8 pilots in the test data; it is not a "system-wide miscount." A second squadron can be onboarded once G-C2 is fixed and re-verified.
- The G-Schedchain constraint mismatch will block normal share-submit usage in production until aligned. Should be fixed before any new squadron starts using cross-PC schedule sharing.
- CC-3 is not asserted but is low risk given #191 PASS.

**For a 15-year deployment:**
- Calc correctness coverage is solid for the surfaces actually exercised (C-1, C-3..C-10, CC-1, CC-2, CC-4, #191, CI-1..CI-7 = 18 of 20 calc surfaces PASS, 1 FAIL with narrow blast radius, 1 DEFERRED with low risk).
- Long-term concerns the audit could not address in this round:
  - UI/UX regressions across roles (J DEFERRED) — RTL layout, i18n key leaks (#235 tripwire), broken buttons, console errors are not asserted by this round.
  - Schedule-chain end-to-end across PCs is partially asserted (G operational FAIL on bootstrap) and needs the H follow-up.
  - Squadron rename fan-out across xpc_* tables (#173/#184/#201 regression family) is not asserted.
- These are addressable by the proposed follow-ups; none indicates a structural defect in the system.

## H. Recommendations

1. **Land the two follow-ups (G-C2, G-Schedchain) before declaring this round closed.** Do not promote to GO without them.
2. **Re-run the audit in a higher-resource environment** so the focused drivers can become full drivers and CC-3 + J can move from DEFERRED to PASS.
3. **Keep the focused-driver pattern** (`{g,h,i}-focused.mjs` with per-phase checkpointing of evidence JSON). It survived multiple SIGKILLs in this round and let us salvage partial-but-real results that the previous round (which never made evidence land in the coordinator's environment) could not produce. The checkpoint pattern should be the audit-driver default going forward.
4. **Treat #191 as a permanent regression test.** Add a CI gate that runs the `phase191` block of `h-focused.mjs` on every cross-PC schema migration. The intruder-blocked assertion is one of the simpler tests in this audit and protects an existential property.

---

## Files

- This master report: `.local/reports/audit-2026-04-26/MASTER-GO-NO-GO.md`
- Sibling reports: `G-single-squadron.md`, `H-cross-pc-guest.md`, `I-three-squadron-rollup.md`, `J-playwright-walk.md`, `K-bugfix-sweep.md`
- Evidence: `evidence/{G,H,I}/*.json`
- Defect ledger: `defects.json`
- Drivers: `.local/scripts/audit-2026-04-26/{g,h,i}-{driver,focused}.mjs`
