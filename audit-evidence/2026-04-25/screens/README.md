# Audit 2026-04-25 — Mobile preview proof

This folder holds proof-of-life screenshots captured after fixing
Task #178 ("Get the mobile app preview working in the Replit
workspace again"). A copy lives under
`.local/reports/audit-2026-04-25/screens/` per the original task
spec; this duplicate exists at a tracked path because `.local/` is
gitignored at the system level (`/etc/.gitignore`) so files there
never appear in commits.

## Files

- `home.jpg` — Phone-viewport (400 × 720) screenshot of the Hawk Eye
  home / splash screen, captured against the live Expo dev server at
  `https://$REPLIT_EXPO_DEV_DOMAIN/` after the workflow recovered.
  Shows the RJAF eagle emblem and "HAWK EYE" wordmark.

## Runtime validation captured during Task #178

Workflow restart at ~12:05 UTC, 2026-04-24:

- `artifacts/pilot-mobile: expo` workflow reached and stayed in
  RUNNING state for 10+ minutes (verified at +1m, +6m, +8m, +10m —
  process alive throughout, no respawns).
- `http://localhost:18428/status` → HTTP 200
  (body: `packager-status:running`).
- `https://$REPLIT_EXPO_DEV_DOMAIN/status` → HTTP 200.
- `https://$REPLIT_EXPO_DEV_DOMAIN/` → HTTP 200; Expo HTML shell
  served; web bundle compiled in 12.1s; app rendered in browser.
- `https://$REPLIT_DEV_DOMAIN/pilot-mobile/` → HTTP 200 via path
  proxy.

## Root cause / fix

The artifact's `[[services]]` block had
`ensurePreviewReachable = "/status"`. Metro for this app takes ~25s
before it serves HTTP, which raced the workflow runner's preview
health probe; the runner SIGKILL'd Metro before it ever became
reachable. Removing that one line lets the workflow stay up while
Metro warms.
