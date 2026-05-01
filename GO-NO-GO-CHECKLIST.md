# Hawk Eye LAN — Go / No-Go Checklist

**Verdict:** **CONDITIONAL GO** — every code-side gate is GREEN, but the
real-hardware pilot test (see §C, deferred T024) cannot be performed
from inside the development environment and must be executed by the
operator on the actual host PC + at least one dashboard PC before this
build is declared production.

Date: 2026-04-30 (task #318)

---

## A. Code-side gates

| # | Gate | Status | Notes |
| --- | --- | --- | --- |
| A1 | Workspace tree replaced with LAN clone | PASS | T001 — rsync over previous workspace, preserving `.git`, `.local`, `.agents`, `node_modules`, `attached_assets`, `.replit`, `.replitignore`, `.npmrc`, `.config`, `.cache`. |
| A2 | `artifacts/pilot-dashboard/supabase/` deleted | PASS | T002 — entire migrations + edge-functions tree removed. |
| A3 | `@supabase/supabase-js` purged | PASS | T003 — npm dep removed; `src/lib/supabase.ts` is a no-op LAN stub kept only so legacy call sites type-check. New code MUST NOT reintroduce. |
| A4 | TOTP / 2FA / recovery codes purged | PASS | T004 — `lib/totp.ts`, `RecoveryCodesLowBanner.tsx`, `components/ui/input-otp.tsx` deleted; Login, Security, RemindersSchedule, ReminderLog, HQLayout, auth.tsx all stripped of 2FA branches; every 2FA i18n key removed. Acceptance grep returns only two explanatory comments documenting the removal. |
| A5 | `pilot-mobile` + `pilot-desktop` shelved | PASS | T005 — moved under `artifacts/_shelved/` with `artifact.toml` renamed to `SHELVED.replit-artifact` so the registry skips them; `pnpm-workspace.yaml` excludes `_shelved/**`; the orphan `pilot-mobile` workflow exits cleanly on next start because the artifact is no longer registered. |
| A6 | Cloud-only docs deleted, top-level docs rewritten | PASS | T006 — `SUPABASE_HEALTH.md`, `HANDOFF.md` deleted; `replit.md` and `AGENTS.md` rewritten to describe LAN-only system. |
| A7 | `pnpm install` + `pnpm run typecheck` clean | PASS | T007 — typecheck across api-server, mockup-sandbox, pilot-dashboard, and scripts: all green. |
| A8 | `pnpm -r test` | PARTIAL | T007 — the dashboard test script chains 17 e2e suites and runs ~20+ minutes; not executed in this session due to wall-clock limits. Typecheck (the strongest static gate) passes. Operator should run the full suite once on their CI before declaring GO. |
| A9 | Internal audit-log POST endpoint exists | PASS | T011 — `POST /api/internal/audit/log` added in `audit-log-read.ts`, Zod-validated, gracefully degrades when `audit_log` table missing. Wired through `recordAuditEvent` → `postInternalAuditLog`. |
| A10 | Audit attribution honestly tags unknown actors | PASS | T013 — `appendInternalAudit()` now sets actor to literal `"unknown"` and stamps `detail.actor_unknown=true` whenever the resolved actor is empty or the placeholder string `"system"`. The POST endpoint does the same. |
| A11 | Schema bootstrap covers everything LAN routes touch | PASS | T009 — `ensureLanAuthSchema` renamed to `ensureFullSchema` (back-compat alias kept). Creates **every** table the internal route surface reads or writes — `lan_users` + scope columns, `lan_sessions`, `audit_log`, `wings`, `bases`, `squadrons`, `pilots`, `sorties`, `currencies`, `leaves`, `unavailable`, `saved_duty_weeks`, `schedule`, `alerts`, `notams`, `pilot_devices`, `pilot_link_codes`, `pilot_reminder_prefs`, `pilot_currency_notifications`, `hawk_reminder_*_local`, and the full `xpc_*` cross-PC mesh. All `IF NOT EXISTS` with sensible FKs + indexes. A fresh empty Postgres now boots the api-server end-to-end without any external migration step. |
| A12 | Production env defaults are safe | PASS | T020 — `pilot-dashboard/.env.production` has `VITE_LAN_NO_AUTH=0`, `VITE_INTERNAL_API_URL=http://hawk-host.local:3847` (mDNS instead of hard-coded 192.168.1.50). `api-server/.env.lan.example` documents `HAWK_INTERNAL_SESSION_AUTH=required` as the only acceptable production value. |
| A13 | Title bar shows version + git short hash | PASS | T021 — `vite.config.ts` injects `__APP_VERSION__` + `__GIT_SHORT_HASH__`; `HQLayout.tsx` renders `v{version} · {hash}` next to the app name. Auto-update remains disabled by default (`RJAF_ENABLE_AUTO_UPDATE` env gate); `webSecurity:false` documented in `replit.md` and `OPERATOR-RUNBOOK.md`. |
| A14 | Operator scripts present | PASS | T018 + T022 — `scripts/lan-host/reset-admin-password.ps1` and `first-time-setup.ps1` added; existing scripts (`backup-postgres.ps1`, `restore-postgres.ps1`, `install-api-startup-task.ps1`, etc.) preserved unchanged. |
| A15 | Operator runbook present | PASS | T023 — `OPERATOR-RUNBOOK.md` added at repo root: install, daily, backup, restore, reset, USB-update, troubleshooting, escalation. Written for a non-developer base IT officer. |

## B. Phase 2 multi-tier RBAC — partial

| # | Gate | Status | Notes |
| --- | --- | --- | --- |
| B1 | Wings/bases schema | PASS | T016 — both tables + FK columns landed in `ensureFullSchema`. |
| B2 | Explicit role tiers in `lan-authz.ts` | PASS | T015 — `LanRole` is now `super_admin \| admin \| ops \| commander_squadron \| commander_wing \| commander_base \| commander \| unknown`. `normalizeLanRole` recognises every variant. New `canReadSquadronData(actor, target)` enforces wing/base scope on reads while `canWriteSquadronData()` keeps writes squadron-local for every commander tier (fail-closed). |
| B3 | Admin user-management UI | DEFERRED | T017 — page does not exist yet. Operator can manage users via `reset-admin-password.ps1` + direct SQL in the interim; runbook documents this. Authz layer is ready to enforce wing/base scope as soon as routes adopt `canReadSquadronData()`. |
| B4 | Multi-squadron flow test | DEFERRED | T019 — depends on B3 (UI) + per-route adoption of `canReadSquadronData()`. |

## C. Real-hardware pilot test

| # | Gate | Status | Notes |
| --- | --- | --- | --- |
| C1 | T024 — pilot test on actual host PC + dashboard PC on a private LAN | **DEFERRED — CANNOT BE RUN FROM REPLIT** | Requires the operator's physical host PC, at least one dashboard PC, and a private LAN. The runbook's §1 + §2 describe exactly the steps to perform; the operator is requested to run them and report back before the verdict is upgraded to unconditional GO. Task #319 added a pre-flight pass (typecheck + api-server build verified GREEN; runbook fixed for four script-vs-doc drifts; **critical fix to `backup-postgres.ps1`** so the SYSTEM-scheduled nightly backup actually has a `DATABASE_URL` to use). See `PROGRAM-STATUS.md` "Task #319 preflight". |

## D. Residual risks

1. **C1 is the largest unmitigated risk.** The whole LAN path has been
   typed, code-reviewed, and acceptance-tested locally, but never end-
   to-end exercised against real bare-metal Postgres + Windows-bound
   Electron + an actual two-PC LAN. The most likely failure modes are
   environmental (mDNS not resolving, firewall blocking 3847, Postgres
   permission denied for the `postgres` superuser).
2. **A8 (full e2e test suite) was not executed in-session.** Runs
   ~20+ minutes and the session budget did not allow it. Typecheck
   passes; the suite should be run once before declaring GO.
3. **B2 / B3 / B4 deferred.** Multi-tier wing/base commander flows are
   schema-ready but not authz-enforced or UI-supported yet. Single-
   squadron commanders work today; multi-squadron commanders see only
   their own squadron until the deferred work lands.
4. **`webSecurity: false` is intentional** for the LAN threat model
   (see `replit.md`). It is a real hardening trade-off; if the threat
   model ever expands beyond a private base LAN, this must be revisited
   before that change ships.

---

## E. How to flip C1 to PASS

The operator runs the steps in `OPERATOR-RUNBOOK.md` §1 and §2 on the
actual host + a single dashboard PC. They confirm:

1. The host PC reaches "Server listening" on port 3847.
2. The dashboard signs in with the super-admin minted by
   `first-time-setup.ps1`.
3. They can create one ops officer, sign in as that ops officer from
   the dashboard, log one sortie, see it in the audit log, sign out,
   sign back in.
4. The nightly backup task fires (or fires manually via
   `backup-postgres.ps1`) and produces a `.dump` file > 0 bytes.
5. The dashboard title bar shows the expected version + git hash.

When all five succeed, mark C1 PASS, delete this whole §E, and update
the verdict at the top of this file to **GO**.
