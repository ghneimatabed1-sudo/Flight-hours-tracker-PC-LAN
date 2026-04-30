# Step 11 — Staged rollout and rollback rehearsal

**Status:** Started (operator-facing runbook scaffold).  
**Date:** 2026-04-25

This document is the **living** cutover companion for when Steps 6–10 land and you move production traffic from public Supabase to **internal Custom API + Postgres**. It is **not** a promise that cutover is ready today — see [PROGRAM-STATUS.md](./PROGRAM-STATUS.md).

## Preconditions (NO-GO if any fail)

- All **GO** rows your deployment relies on in [STEP-4-parity-matrix.md](./STEP-4-parity-matrix.md) are green (or explicitly waived by the operator with date + risk).
- **RLS / schema** changes: `node .local/tests/rls-policy-audit.mjs` exit 0 when the stack still uses Supabase RLS.
- **Internal API** health from a real Ops PC: Connection Diagnostic passes against the LAN base URL you will use in production (CSP `connect-src` included if not same-origin).
- **Backup:** verified Postgres dump or provider snapshot of the internal DB **before** first production write through the new API.

## Staged rollout (suggested checkpoints)

1. **Shadow reads only** — internal endpoints enabled; dashboard prefers internal only where wired, with Supabase fallback (today’s pattern). No writes through internal API yet for operational tables.
2. **Dual-write rehearsal (optional)** — if you introduce internal writes, run on a **clone** squadron or maintenance window; compare row counts and checksums vs Supabase.
3. **Read cutover** — point read-heavy paths exclusively at internal API; keep Supabase as read replica or fallback for one release cycle.
4. **Write cutover** — freeze Supabase writes for operational data; internal API is sole writer.
5. **Auth cutover (Step 10)** — install/application password model live; retire Supabase Auth paths per [STEP-2-auth-security-spec.md](./STEP-2-auth-security-spec.md).

## Rollback triggers (stop and revert)

- Unexpected **42501**, mass **403**, or **data loss** on any tier PC during chain, guest pending, or sortie log.
- **Monthly report** totals disagree with pre-cutover goldens beyond agreed tolerance.
- **Internal API** unreachable from >50% of squadron PCs after network change.

## Rollback actions (plain language)

- Flip clients back to **Supabase** URLs and keys via installer config or env push you tested **before** cutover.
- Restore Postgres from the **pre-cutover** snapshot if internal DB was corrupted.
- Communicate **“operational data frozen at time T”** to commanders so nobody double-enters sorties against two masters.

## After cutover

- Re-run cross-PC e2e and guest e2e against the **internal** endpoints when those harnesses exist.
- Append lessons to [AGENTS.md](../../AGENTS.md) and [.local/memory/internal-migration.md](../../.local/memory/internal-migration.md).
