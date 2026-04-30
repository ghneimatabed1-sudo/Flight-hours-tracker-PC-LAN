# Full-role reliability hardening memory

## 2026-04-25 — Plan execution checkpoint

- Executed the full-role reliability hardening sequence in staged order: role matrix, wiring drift scan, targeted runtime checks, staged code hardening, and regression validation.
- Added a durable role-flow matrix artifact at:
  - `audit-evidence/2026-04-25/full-role-reliability/ROLE_FLOW_MATRIX.md`
- Confirmed and fixed one high-impact local/mock drift:
  - `src/pages/admin/Overview.tsx` previously read `pilots` from `mockData` and mixed mock/live assumptions.
  - It now reads pilots from the operational data hook (`usePilots`) so super-admin overview counts use the same live data source as the rest of the app.
- Validation run included:
  - dashboard smoke + translation + dash-pilots tests,
  - pilot transfer RPC integration test,
  - dashboard typecheck.
- Supabase advisor re-check completed to confirm current security/performance lint state after hardening pass.

## Operator-facing lesson captured

- Super-admin overview widgets must never rely on static mock arrays when Supabase is configured; this creates false readiness signals for org-wide command visibility and masks real cross-PC drift.

## 2026-04-25 — Pending-device approval hardening (user_create_failed)

- Field issue: Super Admin `Pending Devices` approval could fail with `Approve failed: user_create_failed` while the request had already been reserved, causing operator confusion and join retries.
- Root reliability fix in `supabase/functions/unit-approve-device/index.ts`:
  - Placeholder password generation now guarantees mixed-character policy compliance (upper/lower/digit/symbol) instead of raw hex-only output.
  - `auth.admin.createUser` failure now falls back idempotently when the email already exists by re-finding the auth user and applying metadata/password update.
- Operational result: approval remains stable across stricter GoTrue password policy settings and duplicate-email race windows, reducing back-and-forth failures during device onboarding.
