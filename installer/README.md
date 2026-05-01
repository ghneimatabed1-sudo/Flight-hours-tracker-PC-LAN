# Hawk Eye one-click installer

Builds `HawkEye-Setup.exe` — a single double-click installer that
replaces the "open PowerShell as Administrator and run a script"
experience with a 3-step wizard:

1. **Welcome.**
2. **Pick a role** for this PC:
   - Operation Pilot PC (Squadron Hub)
   - Wing Commander PC (Aggregator)
   - Base Commander PC (Aggregator)
   - Squadron / Flight Commander Laptop (Viewer only)
3. **Per-role prompts** (squadron name, super-admin credentials, hub
   address, …). Validated client-side. The installer then runs the
   matching PowerShell script silently and writes a full transcript
   to `install-log.txt` next to the installed app.

After a Hub install, the wizard parses the printed peer access token
out of the install log and shows it in a green panel on the finished
page with a **Copy** button so the operator never has to open a
terminal.

## Build it

On a Windows machine with [Inno Setup 6](https://jrsoftware.org/isdl.php)
and `pnpm` installed:

```powershell
# From the repo root:
pnpm --filter @workspace/installer run build

# Or directly:
cd installer
.\build.ps1
```

Output lands in `installer/dist/HawkEye-Setup.exe` (~150-300 MB; it
bundles a portable Node.js LTS, portable pnpm, and the prebuilt
api-server + dashboard).

The cross-platform wrapper `build.mjs` makes
`pnpm --filter @workspace/installer run build` safe to call from
Linux/macOS too — it prints a notice and exits 0 so workspace-wide
builds (`pnpm -r build`) keep working.

### Useful flags

| Flag | What it does |
| --- | --- |
| `-SkipBuild`        | Reuse the existing `artifacts/*/dist/` bundles. |
| `-OfflineCache`     | Refuse to download Node/pnpm; only use what's already cached. |
| `-IsccPath <path>`  | Override iscc auto-detection. |
| `-NodeVersion`      | Pin a specific Node.js LTS (default 20.18.1). |

## Layout

```
installer/
├── HawkEye.iss              # Inno Setup script (wizard + [Files] + [Run] + [Code])
├── build.ps1                # Windows build orchestrator
├── build.mjs                # Cross-platform pnpm entrypoint
├── package.json             # @workspace/installer
├── README.md                # this file
├── .gitignore               # build-cache/ + dist/
├── script-shims/
│   ├── install-hub.ps1      # → scripts/lan-host/first-time-setup.ps1
│   ├── install-aggregator.ps1   # → scripts/lan-host/aggregator-first-time-setup.ps1
│   ├── install-viewer.ps1   # → scripts/lan-host/setup-viewer.ps1
│   └── uninstall-prep.ps1   # stops scheduled tasks, takes final backup, optional DB drop
├── build-cache/             # staged repo + downloaded portable Node/pnpm (gitignored)
└── dist/                    # HawkEye-Setup.exe lands here (gitignored)
```

## What stays the same

The original `scripts/lan-host/*.ps1` scripts remain the canonical
implementation. The installer is a thin wrapper that collects the
prompts ahead of time and pipes them into those scripts via stdin.
Operators who prefer the old flow can still run them directly — they
are documented in `OPERATOR-RUNBOOK.md` § 8 (Troubleshooting →
Advanced manual install).

## Out of scope (explicit)

- **Code signing.** Production EV cert signing is not wired in.
  Operators will see SmartScreen "Unknown publisher" warnings. Track
  this as a follow-up.
- **Auto-update.** The installer does not self-update. Push a new
  `HawkEye-Setup.exe` via USB; running it overwrites the previous
  install in place.
