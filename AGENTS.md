# AGENTS.md — READ THIS FIRST

> You are an AI agent working on **Hawk Eye**, the LAN-only flight-hours
> management system for the Royal Jordanian Air Force. This file is the
> 60-second briefing. Read it in full before changing any code.

---

## What this project is

**Hawk Eye** (Arabic: عين الصقر) — flight-hours tracking for the RJAF.

- **LAN-only.** No Supabase, no internet, no JWT, no TOTP, no recovery
  codes, no auto-update by default. Every piece of data and every
  authentication step lives on a single host PC inside the squadron's
  base network.
- **pnpm monorepo, three live artifacts:**
  - `artifacts/pilot-dashboard/` — React + Vite + Electron Windows
    desktop app. The whole user experience.
  - `artifacts/api-server/` — Express + Postgres backend. The whole
    backend.
  - `artifacts/mockup-sandbox/` — design preview, not deployed.
- **Shelved (don't touch unless asked):** `artifacts/_shelved/`
  contains `pilot-mobile` and `pilot-desktop` from the previous build.
  Their `artifact.toml` files were renamed to `SHELVED.replit-artifact`
  so the artifact registry skips them, and `pnpm-workspace.yaml`
  excludes `_shelved/**`.

## The one true backend

The dashboard talks to **only** the api-server, over HTTP, on the LAN.

- `VITE_INTERNAL_API_URL` defaults to `http://hawk-host.local:3847` in
  production (mDNS so re-IPing the host PC doesn't brick installed
  dashboards).
- `HAWK_INTERNAL_SESSION_AUTH=required` is the only acceptable
  production setting on the api-server.
- `HAWK_LAN_DEV_NO_AUTH=1` and `VITE_LAN_NO_AUTH=1` are dev-only and
  must remain `0` in `.env.production`.

## Mandatory reading before any change

1. **`replit.md`** — full project overview, architecture, what was
   removed in the LAN migration.
2. **`OPERATOR-RUNBOOK.md`** — the non-technical operator guide; tells
   you what the user sees on the host PC.
3. **`GO-NO-GO-CHECKLIST.md`** + **`PROGRAM-STATUS.md`** — current
   readiness, what's done, what's deferred, what's risk.
4. **`scripts/lan-host/*.ps1`** — the host-side surface. If your change
   affects how the host PC is provisioned/updated/recovered, the script
   that owns that step must be updated in the same patch.

## Absolute do-nots

1. **Do not re-introduce `@supabase/supabase-js`.** It is intentionally
   removed from `pilot-dashboard/package.json`. The only file that may
   reference Supabase by name is `src/lib/supabase.ts`, which is a no-op
   stub kept so legacy call sites type-check.
2. **Do not add cloud HTTP calls.** No `fetch("https://*")`, no
   `electron-updater` polling unless `RJAF_ENABLE_AUTO_UPDATE=1` is
   explicitly set. The audit history of broken-network installs is long.
3. **Do not add 2FA / TOTP / recovery codes.** `lib/totp.ts`,
   `RecoveryCodesLowBanner.tsx`, `input-otp.tsx`, and all 2FA i18n keys
   are deliberately deleted.
4. **Do not edit `.replit` or `replit.nix`.** Use the workflows + skills
   surface.
5. **Do not unshelve `pilot-mobile` / `pilot-desktop`** without an
   explicit task asking for it. Re-registering them will create
   workflows and confuse the rollout.
6. **Do not change audit-attribution behavior** in
   `appendInternalAudit()` / `postInternalAuditLog()` /
   `recordAuditEvent()` without preserving the `actor_unknown:true`
   flag for un-attributed writes. The flag is the only way operators
   can grep for who-did-what when dev-no-auth was on.

## Where to add things

- **New server route:** `artifacts/api-server/src/routes/<name>.ts`,
  Zod-validate via the same `safeParse` pattern as
  `audit-log-read.ts`, mount in `routes/index.ts` under the `internal`
  router (which already enforces session auth).
- **New schema column / table:** add to `ensureFullSchema()` in
  `artifacts/api-server/src/lib/lan-auth-schema.ts`. Use
  `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` so the
  bootstrap stays idempotent. Domain tables (pilots, sorties, etc.)
  still go through the legacy migration runner — only LAN-refactor
  tables live in `ensureFullSchema`.
- **New host-side action:** new `*.ps1` under `scripts/lan-host/`,
  documented in `OPERATOR-RUNBOOK.md`.
- **New dashboard helper that previously called Supabase:** add an
  internal route + a `postInternal*` / `fetchInternal*` helper in
  `artifacts/pilot-dashboard/src/lib/internal-migration.ts`.

## Verification before merge

```sh
pnpm install
pnpm run typecheck         # must pass
pnpm -r test               # best-effort; long suite
```

The dashboard's `pnpm run test` chains 17 e2e suites and is slow; if
your change is small and isolated, run only the directly relevant
sub-suite (e.g. `npm run test:translations`).

## Honesty rule

If you cannot finish a step, do not pretend you did. Document the
deviation in your commit message and in `GO-NO-GO-CHECKLIST.md` /
`PROGRAM-STATUS.md`. The current `T024` (real-hardware pilot test) is
the standing example: it cannot be performed from inside Replit and is
flagged as deferred everywhere a reader might look.
