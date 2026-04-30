# Internal LAN migration (Hawk Eye)

**VCS (2026-04-25, updated):** Using **GitHub** (push, PR, Actions, repo edits) is **allowed** when it helps the migration program. The operator rescinded the earlier “local only, no GitHub” rule; choose whatever fits the work (solo branch, PR review, or CI) without treating GitHub as off-limits.

---

This folder holds **Step-by-step** evidence and inventories for moving the app from public Supabase to an **internal Custom API + Postgres** stack, without breaking role behavior, calculations, or cross-PC flows.

| Document | Purpose |
|----------|---------|
| [STEP-1-baseline-inventory.md](./STEP-1-baseline-inventory.md) | **Done** — map of all Supabase/internet touchpoints, tables, edge functions, env vars, and pointers to the parity contract. |
| [STEP-2-auth-security-spec.md](./STEP-2-auth-security-spec.md) | **Done** — approved *design* for install-password-only auth, removals (2FA, lockout, role-lock, join-secret client gating), and what stays (audits, role visibility). **No code change in Step 2.** |
| [STEP-3-internal-api-kickoff.md](./STEP-3-internal-api-kickoff.md) | **Done** — `api-server` health path, Vite dev/preview proxy to `__hawk_eye_internal_api`, optional `VITE_INTERNAL_API_URL`, Connection Diagnostic card; CSP note for direct LAN URLs. |
| [STEP-4-parity-matrix.md](./STEP-4-parity-matrix.md) | **Done** — GO/NO-GO matrix: DOMAIN areas ↔ code ↔ automated gates (living). |
| [STEP-5-golden-fixtures.md](./STEP-5-golden-fixtures.md) | **Started** — fixture plan + links to existing calc/report tests; goldens grow with Step 6+. |
| [STEP-6-internal-api-data-plane.md](./STEP-6-internal-api-data-plane.md) | **Started** — internal reads: pilot-options, **full pilot roster**, squadron wizard defaults, Super Admin squadron list (+ dashboard fallbacks). |
| [STEP-11-rollout-rollback.md](./STEP-11-rollout-rollback.md) | **Started** — cutover checkpoints, NO-GO triggers, rollback actions (scaffold; expand with your network runbook). |
| [LAN-MULTI-PC-QUICKSTART.md](./LAN-MULTI-PC-QUICKSTART.md) | **Operator + IT checklist** — practical multi-PC install/connect steps once internal network is ready. |
| [SQUADRON-HOST-KIT.md](./SQUADRON-HOST-KIT.md) | **Operator + IT host profile** — single-host (cabin/Ops PC) rollout scripts, health checks, backup routine, and pilot checklist. |
| [PILOT-EXECUTION-SPEC.md](./PILOT-EXECUTION-SPEC.md) | **Exact pilot script** — one-squadron, 5-PC execution flow with pass criteria and sign-off output. |
| [GO-NO-GO-CHECKLIST.md](./GO-NO-GO-CHECKLIST.md) | **Expansion gate** — strict criteria for promotion from pilot squadron to wider rollout. |
| [PROGRAM-STATUS.md](./PROGRAM-STATUS.md) | **Living** — honest checklist: Steps 1–5 vs 6–12, what CI runs, what remains. |

The program order lives in the Cursor plan: *Internal-Only Migration Parity* (A–Z / Steps 1–12).

## Redesign, reshape, and recode (operator authorization)

The app **today** is built around **Supabase** (Auth, REST/RPC, RLS, Edge Functions). The **end state** in the plan is **not** public Supabase — it is an **internal** **Custom API + Postgres** (and the auth simplifications in [STEP-2](./STEP-2-auth-security-spec.md)).

**You have authorized the team to redesign, reshape, or recode** any part of the app where a **thin URL swap** would be the wrong move — as long as **operational parity** (roles, chain, calcs, monthly report, cross-PC, guest, portability) is **proven** with the program’s **GO/NO-GO** gates, not assumed.

- **Prefer** a clear **data + API** layer and **remove** deep `supabase-js` coupling over time, rather than imitating PostgREST ad hoc.
- **Do not** change DOMAIN-level meaning without updating [DOMAIN.md](../../DOMAIN.md) and [AGENTS.md](../../AGENTS.md) per project rules.

## Definition of done (operator view)

When the full program (Steps 1–12 + all GO/NO-GO gates) is **complete** and **signed off**:

- You can run the **backend** on a **server inside your base network** (private **IP** and/or **internal DNS** only; **not** exposed to the public internet in normal operation).
- **Desktop and mobile** apps are configured to talk **only** to that internal service for **all operational data** — not to public Supabase.
- **Each PC still behaves as the right role** (Ops vs commander vs admin) with the right **menu and data scope**.
- **“Nothing broken”** here means: **every** agreed test gate passed (per-role deep matrix, calculations, monthly report goldens, cross-PC chain, guest flow, new-squadron install) — and **roll back** was rehearsed. It does not mean “no bug will ever exist anywhere in the world”; it means **we do not ship the internal cut** until that bar is met.

**Separate from sortie data:** the Windows app may still **optionally** use the public internet for **auto-update** (GitHub) or fonts unless you **turn those off** or point them to an **internal** mirror. That is an explicit **policy** choice in the cutover plan, not a surprise.

