# Build-host setup — how to compile `HawkEye-Setup.exe`

The `.exe` referenced everywhere in `OPERATOR-RUNBOOK.md` is
produced by Inno Setup compiling `installer/HawkEye.iss`. **The
Replit container that authored the project is Linux-only, so the
.exe has not yet been compiled by the project's CI.** This
document is what you, the next operator with Windows access,
need to build the installer the first time and to keep that
build reproducible.

If you only want to run an already-built .exe, skip ahead to
`installer/test-vm/README.md` and `OPERATOR-RUNBOOK.md` § 1.

---

## 1. Build-host requirements

You need a single Windows 10/11 PC (a VM is fine; clean
snapshots are required for the **dry-run** described in the
playbook, but they're optional for the build itself):

| Component         | Pinned version       | Notes |
|-------------------|----------------------|-------|
| Windows           | 10 22H2 or 11 22H2+  | Build-host requirements are looser than dryrun-host requirements; older builds work but please record what you used. |
| Inno Setup        | **6.2.2 (Unicode)**  | https://jrsoftware.org/isdl.php — pick the file labelled `innosetup-6.2.2.exe`, install with defaults. The `.iss` uses Inno-6 features (`WizardStyle=modern`, `[Code]` section APIs). Do NOT use Inno 5. |
| PowerShell        | 5.1 (built-in) OR 7.4+ | The `installer/build.ps1` wrapper works on either. We pin our scripts to 5.1 idioms for max compatibility — if you only have PS 7, please verify the build also works on a stock 5.1 box before signing off. |
| Node.js           | 20.11.x LTS          | Required by `installer/build.mjs` to stage the api-server + dashboard bundles into `installer/payload/`. |
| pnpm              | 9.x                  | `npm i -g pnpm@9` |
| git               | any recent           | To clone the repo. |
| Disk              | 20 GB free           | The staged payload runs ~5 GB during build; the .exe itself is 150-300 MB. |
| Network           | Optional             | Build pulls Node + pnpm tarballs ONCE into `installer/cache/` to embed them in the .exe. After the first run the build is offline-capable. |

Record the **exact version** of each tool in the dryrun evidence
folder under `build-environment.txt`:

```
PS> winver
PS> & 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' /?  | Select-String 'Inno Setup'
PS> $PSVersionTable | Out-String
PS> node --version
PS> pnpm --version
PS> git rev-parse HEAD
```

That file goes in `installer/test-vm/dryrun-evidence/<date>/build-environment.txt`.

## 2. One-time setup on the build host

```powershell
# Clone the repo (LF endings — the .iss + .ps1 files are CRLF-tolerant).
git clone <REPO_URL> hawk-eye
cd hawk-eye

# Restore the Node + pnpm portable runtimes into installer/cache/
# (skip if already restored).
pnpm install --frozen-lockfile

# Verify Inno Setup is on PATH or note its location:
$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
& $iscc /?  | Select-String 'Inno Setup'
# Expected: "Inno Setup 6 Command-Line Compiler"
```

If `iscc` is not on PATH, set it for the build only:

```powershell
$env:PATH = "C:\Program Files (x86)\Inno Setup 6;$env:PATH"
```

## 3. Build the installer

```powershell
.\installer\build.ps1
```

What that script does, in order:

1. Runs `node installer/build.mjs` which stages
   `installer/payload/` with the prebuilt api-server, dashboard
   `dist/`, the portable Node + pnpm runtimes from
   `installer/cache/`, and the `scripts/lan-host/*.ps1` files.
2. Runs `iscc installer/HawkEye.iss` which compiles the
   installer into `installer/output/HawkEye-Setup.exe`.
3. Prints the SHA-256 of the resulting .exe.

Capture the entire console output as
`dryrun-evidence/<date>/build-host/iscc-output.log` and the SHA-256
as `iscc-output.sha256`. Both go into evidence, even on success —
they pin the artifact you about to dry-run.

If the build fails, the most common causes (in order of
frequency) are:

- **`installer/payload/` is empty** — `pnpm install` was skipped
  or `installer/build.mjs` crashed earlier. Run
  `node installer/build.mjs` directly and read its error.
- **`Inno Setup` is older than 6.2.0** — `[CustomMessages]`
  formatting differs between versions. Upgrade.
- **`File not found: scripts\lan-host\…ps1`** — git clone used a
  `core.autocrlf` setting that filtered some files. Run
  `git config --global core.autocrlf input` and re-clone.

## 4. AppId trace (do NOT "fix" the macro)

`installer/HawkEye.iss` line 48 reads:
```
AppId={{#MyAppId}
```
with `#define MyAppId "{6E4F4D0A-2A2C-4F8B-8B6A-2C8B4F1A9A0E}"`.

That looks unbalanced but it's correct. Inno's preprocessor
substitutes `{#MyAppId}` (consuming the inner `{` and the
trailing `}`), giving `AppId={` + `{6E4F…-9A0E}` =
`AppId={{6E4F…-9A0E}`. At runtime Inno unescapes the leading
`{{` to `{`, producing the canonical AppId value
`{6E4F…-9A0E}`. If you "fix" it, you'll change the AppId and
break uninstall on every existing install.

## 5. Code-signing decision

We ship the .exe **unsigned** for the LAN / air-gapped use case.
See `installer/CODE-SIGNING-DECISION.md` for the rationale and
the operator-side SmartScreen-dismissal text. If your customer
requires a signed binary, that document also describes how to
add signing without touching `HawkEye.iss`.

## 6. Hand-off

Once the build is verified locally on the build host (just run
the resulting .exe and click Cancel — confirms it loads), copy
`HawkEye-Setup.exe` plus `iscc-output.log` and `iscc-output.sha256`
to a clean Windows VM and follow `installer/test-vm/README.md`
to dry-run all four roles.
