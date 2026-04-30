# Internal LAN migration — program status

**Last updated:** 2026-04-28  
**Audience:** Operator + builders. Plain language.

**Where we are in the master plan (honest snapshot):** local Postgres + `api-server` + **LAN login** and **some** internal reads/writes are in motion; **most** screens still call Supabase until Steps 6–12 continue — tooling time (pnpm, Rollup, PowerShell) does not replace that plan; it unblocks **your** machine to keep executing it.

## In everyday words (what this means for you)

Think of the app as a **workshop** that needs two things: a **ledger** (who flew, how many hours) and a **padlock system** (who is allowed to open which drawer).

- **Today, while we are mid-move:** the workshop can talk to **two** ledgers — the old one on the **public internet** (that is what people mean when they say “Supabase” here), and the **new one on your base’s own wires** (your internal computer that holds the database). The screens you use are being taught to **check the internal ledger first** when it actually has data; if it is empty or not plugged in, they **quietly keep using the old path** so nobody sees a blank roster by accident. When you deliberately turn on **internal writes** for testing or cutover rehearsal, the **sortie log** also reads from the internal server first so new flights you save there still show up in the list instead of looking empty while the old internet copy stays unchanged.
- **“Nothing came back”** on a computer network usually means one of three things: the cable path is wrong, the address typed for the server is wrong, or the server has no rows yet. It is **not** your fault as the operator if you do not know JSON — that is just the machine’s filing format. What matters is: **does the roster show real pilots?** **Do hours save?** We prove what we can with **automated test runs** before any change is treated as safe.
- **What is not finished yet:** signing in, saving new sorties, messages between bases, guest pilot handoffs, and many other actions **still go through the old internet ledger** until the later steps of the plan (they are listed in the table below). Replacing **everything** is the goal; we are **doing it in slices** so the squadron never sits with a broken screen mid-week.
- **How we test without your laptop here:** before changes are trusted, a long automated run opens essentially every menu and clicks a large sweep of buttons in a simulated desktop inside the build computer — the same kind of **production build** step your Windows installer pipeline uses (it needs two fixed settings the installer already supplies: which port and which folder path). That is as close as we can get remotely to “a physical PC”; your real network address (IP or internal name) is then configured on top when you go live on base.

## Truth you should hear

The **end goal** is: Hawk Eye runs on **your base’s internal network** (private API + database), with **no public Supabase** for day-to-day flying data, and **parity** with today’s roles, chain, guest pilots, monthly report, and math.

That **whole** rebuild is **large engineering** — it is **not finished** in this repository state. What follows is **exactly what is done** vs **still to build**, so nothing is hidden.

## LAN keep/remove decisions (operator checklist)

- **Keep:** `Audit Log` (still required in LAN; transport/source is being moved).
- **Keep:** `Connections` and `Connection Map` (these are operational pairing tools for cross-PC routing, not cloud-only features).
- **Keep:** `Connection Diagnostic`, but in LAN mode it should focus on internal API health + local workstation identity, not cloud-first copy.
- **Remove later only when replaced:** any Supabase-specific wording, edge-function assumptions, and cloud setup/join entry paths in LAN mode.

## Step checklist (master plan A–Z)

| Step | Name | Status |
|------|------|--------|
| 1 | Baseline inventory | **Done** — `STEP-1-baseline-inventory.md` |
| 2 | Auth/security **spec** (install password, removals) | **Done** — design only, `STEP-2-auth-security-spec.md` |
| 3 | Internal API kickoff (health, proxy, diagnostic) | **Done** — `STEP-3-internal-api-kickoff.md` |
| 4 | Parity matrix & GO/NO-GO rows | **Done** — `STEP-4-parity-matrix.md` (living) |
| 5 | Golden fixtures & report certification | **Started** — `STEP-5-golden-fixtures.md` (scaffold; goldens to grow) |
| 6 | Internal API **data plane** (replace PostgREST for core tables) | **Started** — pilot-options, **full pilot roster read**, **sorties list read** (when internal-write mode is on), squadron defaults, Super Admin `squadrons` list, pilot/sortie **write** routes behind `VITE_INTERNAL_WRITES` + dashboard hooks with Supabase fallback |
| 7 | Postgres schema + RLS or server-side authz mirror | **Started** — internal LAN role/squadron authorization + audit is active on migrated write routes; full parity hardening remains |
| 8 | Cross-PC + schedule chain on internal stack | **Started** — internal routes and dashboard cutover for registry/messages/pairs/schedule shares/snapshots are in place |
| 9 | Guest pilot + pending flows on internal stack | **Started** — internal pending handoff routes + dashboard transport are in place |
| 10 | Auth **implementation** (per Step 2 spec) | **Not started** |
| 11 | Staged rollout + rollback rehearsal | **Started** — `STEP-11-rollout-rollback.md` scaffold (checkpoints + NO-GO + rollback; live rehearsal still pending) |
| 12 | Operator sign-off & production cut | **Not started** |

## Tests we run in CI / before merge (dashboard)

- **Every sidebar page, every role** — first render does not crash: `sidebar-smoke.test.ts`.
- **Button sweep** — click-through regression on role routes in jsdom: `button-sweep.test.ts` (includes ops/admin/most commander routes; two commander data-grid routes remain first-render covered by sidebar smoke due headless click limitations).
- **Guest pending page — Accept, Reject (with reason), Drop** — real button clicks in jsdom: `guest-pending-actions.test.ts`.
- **Add Sortie smart consistency checks** — pure logic unit tests (`add-sortie-smart.test.ts`) for impossible IF totals and mismatch warnings.
- **Add Sortie form availability guard** — `add-sortie-form-availability.test.ts` ensures sortie-entry inputs remain editable even when squadron aircraft defaults are not configured.
- **Schedule naming rule** — `schedule-names.test.ts` enforces crew naming as flight-name-first (no full-name fallback).
- **Monthly Report forms math anchors** — `monthly-report-forms.test.ts` checks Form 1 monthly totals/status blank rule, Form 3 IRT→IF bucket + derived percentages, Form 4 next-month defaults/suggested plan, and 6-month seat-attribution totals/flags.
- **Join lifecycle guardrails** — `join-lifecycle.test.ts` verifies join request local persistence (`persistPendingRequest` / `getPendingRequest` / `clearPendingRequest`) including malformed cached squadron-list fallback.
- **Fault-injection guardrails** — `fault-injection.test.ts` verifies fail-closed behaviour for disabled internal-write transport and misconfigured join-status transport.
- **Squadron defaults merge (internal vs Supabase row shape)** — `squadron-defaults-merge.test.ts`.
- **Super Admin squadron list row mapping** — `squadron-remote-rows.test.ts`.
- **Translations** — `translation-coverage.test.ts`.
- **Dash pilot adapter** — `dash-pilots-snapshot.test.ts`.

That is **strong** coverage for “opens clean” and **one critical workflow** (guest pending). It is **not** literally every control in the entire app yet; Step 4 matrix marks gaps.

## 2026-04-28 verification pass (current branch)

- Dashboard test matrix (`pnpm --filter @workspace/pilot-dashboard run test`) passes end-to-end.
- Workspace typecheck (`pnpm run typecheck`) passes across artifacts + scripts.
- API server build + typecheck pass (`pnpm --filter @workspace/api-server run build` and `typecheck`).
- Pilot mobile typecheck passes after adding Node test typings support (`@types/node` + `types: ["node"]` in mobile tsconfig).
- LAN Connection-Map safety fix: **Clear all registered PCs** now clears central LAN registry rows via internal API (`DELETE /api/internal/xpc/registry`) instead of local-only wipe in LAN mode.
- Added a practical **single-host Squadron Host Kit** (`docs/internal-migration/SQUADRON-HOST-KIT.md`) plus PowerShell helper scripts under `scripts/lan-host` for host API startup, LAN health probe, Postgres backup routine, and Windows scheduled-task install (auto-start + daily backup).
- Added recovery + client bootstrap helpers: `restore-postgres.ps1` for backup restore and `setup-dashboard-lan-env.ps1` for one-command client LAN env setup.
- Added helper-boundary LAN fail-closed guard in `src/lib/supabase.ts`: cloud helper wrappers now short-circuit in LAN session mode and shared `recordAuditEvent` skips cloud writes in LAN mode.
- Added API env bootstrap helper `scripts/lan-host/setup-api-lan-env.ps1` + root alias `lan:host:setup-env` so host LAN `.env` can be generated consistently from one command.
- Added host preflight helper `scripts/lan-host/verify-host-prereqs.ps1` + root alias `lan:host:preflight` to catch missing env/tool prerequisites before pilot rollout.
- Added pilot rollout control docs: `PILOT-EXECUTION-SPEC.md` and `GO-NO-GO-CHECKLIST.md`, plus one-command pre-pilot validation alias `lan:pilot:verify`.

## What “nothing left behind” means here

We document **gaps** instead of pretending they are tested. The matrix and this file are the **accountability list**. Expanding tests is ongoing work alongside Steps 6–12.
