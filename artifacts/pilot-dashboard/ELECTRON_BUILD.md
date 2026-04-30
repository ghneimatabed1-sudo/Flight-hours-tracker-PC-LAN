# Building the Hawk Eye Windows .exe Installer

This document explains how to package the Hawk Eye React app into a real
Windows `.exe` installer (NSIS) with a master install password and silent
auto-update support.

> **Why this is built on a Windows machine, not on Replit:** producing a
> signed Windows `.exe` installer requires `electron-builder` running with
> Wine or on a Windows host. The Replit Linux container can build and run the
> renderer (the React UI you see in the preview), but the final Windows
> installer must be produced on a Windows PC (or a Windows CI runner — e.g.
> GitHub Actions `windows-latest`). The repository is fully prepared for that
> step.

## What's included in this repo
| Path | Purpose |
|---|---|
| `electron/main.ts` | Electron main process (creates the BrowserWindow, hardware fingerprint, auto-updater hook) |
| `electron/preload.ts` | Secure bridge exposed to the renderer (`window.rjaf.fingerprint()` etc.) |
| `electron/tsconfig.json` | TypeScript config for the main process |
| `electron-builder.json` | NSIS installer config (one-click off, password gate, shortcuts, app icon, auto-update channel) |
| `build/installer.nsh` | NSIS macros that prompt for the master install password before any files are written |
| `public/brand/emblem.png` | RJAF eagle emblem used as app icon and login screen logo |
| `public/brand/wings.png` | Pilot wings used in headers |

## One-time prerequisites on the build PC
1. Install Node.js 20 LTS or newer.
2. Install pnpm: `npm i -g pnpm`.
3. Install the Electron toolchain in this artifact (a single command, see below).

## Install Electron + builder
```
cd artifacts/pilot-dashboard
pnpm add -D electron@^32 electron-builder@^25 electron-updater@^6
```
These three packages are intentionally **not** committed to `package.json` so
that the Replit Linux preview never tries to download platform-specific
Electron binaries during normal `pnpm install`. They are only needed on the
Windows build machine.

## Build the Windows installer
```
# From repo root
pnpm install

# Bundle the renderer (React app)
pnpm --filter @workspace/pilot-dashboard run build

# Compile the Electron main + preload, then run electron-builder
$env:INSTALL_PASSWORD="YourMasterPasswordHere"   # PowerShell
pnpm --filter @workspace/pilot-dashboard run electron:build
```
The signed installer is written to:
```
artifacts/pilot-dashboard/release/HawkEye-Setup-1.0.0.exe
```
Distribute that single file to ops officers — when they run it, NSIS will
prompt for the master install password before any files land on disk.

## Code signing (optional but recommended)
Set these environment variables before running `electron:build`:
```
$env:CSC_LINK="path\to\rjaf.pfx"
$env:CSC_KEY_PASSWORD="..."
```
`electron-builder` will sign both the `.exe` and the installer.

## Auto-update server
The installer is configured to check `https://updates.rjaf.local/squadron-ops/`
on startup (see `publish` block in `electron-builder.json`). To roll a new
version:
1. Bump `version` in `package.json` (e.g. `1.0.1`).
2. Run `electron:build` on a Windows machine.
3. Upload `release/latest.yml` and the new `HawkEye-Setup-1.0.1.exe`
   to that URL.
Existing installations will silently download and install the update on next
launch.

## License key validation (server-side)
`src/lib/auth.tsx` currently runs a permissive client-side check so the demo
preview works without Supabase. To switch on real validation:
1. Create a Supabase Edge Function `validate-license` that takes
   `{ key, fingerprint }` and:
   - looks up the key in the `licenses` table,
   - checks `revoked = false`,
   - if `bound_fingerprint` is null, sets it to the supplied fingerprint,
   - rejects if `bound_fingerprint` differs.
2. Replace the body of `activateLicense()` with a `fetch` to that function.

## Row Level Security (RLS) sketch
```sql
-- enabled on every table
alter table sorties enable row level security;
create policy sorties_squadron_isolation on sorties
  for all using (squadron_id = (auth.jwt() ->> 'squadron_id')::int);
-- repeat for pilots, leaves, currencies, audit_log, etc.
```

## Offline mode
The preload exposes `window.rjaf.offlineQueuePath()` — a writable folder under
the user's `AppData`. Renderer code (Supabase wrapper) should append failed
mutations to a JSONL file there and replay them when `navigator.onLine`
returns true.
