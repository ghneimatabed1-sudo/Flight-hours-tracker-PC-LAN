# build.ps1
#
# Hawk Eye installer build orchestrator. Run this on a Windows builder
# machine that has Inno Setup 6 installed (iscc.exe on PATH or at the
# default location). It does, in order:
#
#   1. Verifies prerequisites (iscc, pnpm, internet for first-time
#      cache fill — skip with -OfflineCache if build-cache\ already
#      has the bundled Node + pnpm).
#   2. Builds the api-server and the pilot-dashboard from the repo
#      root via pnpm.
#   3. Stages the repo into installer\build-cache\repo\ excluding
#      heavy or developer-only paths (.git, node_modules from the
#      root only — keeps the per-package node_modules so the api
#      server can run, attached_assets, dist-binaries, downloads,
#      .local, .cache, exports, audit-evidence raw blobs).
#   4. Downloads the Node.js LTS Windows zip and unzips it to
#      installer\build-cache\node\ (skipped if already present).
#   5. Downloads the pnpm Windows binary to
#      installer\build-cache\pnpm\pnpm.exe (skipped if already present).
#   6. Invokes iscc on installer\HawkEye.iss, producing
#      installer\dist\HawkEye-Setup.exe.
#
# Usage:
#   .\build.ps1
#   .\build.ps1 -OfflineCache
#   .\build.ps1 -SkipBuild      # if artifacts/*/dist is already current
#   .\build.ps1 -IsccPath "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
#
# This script is intentionally Windows-only. The cross-platform
# wrapper installer/build.mjs detects non-Windows hosts and exits
# gracefully so `pnpm -r build` from Linux/macOS still succeeds.

[CmdletBinding()]
param(
    [string] $NodeVersion   = "20.18.1",
    [string] $IsccPath      = "",
    [switch] $SkipBuild,
    [switch] $OfflineCache,
    [switch] $SkipStageRepo,
    [switch] $SkipNodeBundle,
    [switch] $SkipPnpmBundle
)

$ErrorActionPreference = "Stop"

$InstallerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot     = Resolve-Path (Join-Path $InstallerDir "..")
$CacheDir     = Join-Path $InstallerDir "build-cache"
$RepoStage    = Join-Path $CacheDir "repo"
$NodeStage    = Join-Path $CacheDir "node"
$PnpmStage    = Join-Path $CacheDir "pnpm"
$DistDir      = Join-Path $InstallerDir "dist"

function Step([string]$msg) {
    Write-Host ""
    Write-Host "[BUILD] $msg" -ForegroundColor Cyan
}
function Info([string]$msg) { Write-Host "        $msg" }
function Warn([string]$msg) { Write-Host "        [WARN] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "        [FAIL] $msg" -ForegroundColor Red; exit 1 }

# ── Step 1: prerequisites ────────────────────────────────────────────
Step "Checking prerequisites"
if ([string]::IsNullOrWhiteSpace($IsccPath)) {
    $candidates = @(
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
        "iscc.exe"
    )
    foreach ($c in $candidates) {
        $resolved = Get-Command $c -ErrorAction SilentlyContinue
        if ($null -ne $resolved) { $IsccPath = $resolved.Source; break }
        if (Test-Path $c)         { $IsccPath = $c; break }
    }
}
if ([string]::IsNullOrWhiteSpace($IsccPath) -or -not (Test-Path $IsccPath)) {
    Fail "iscc.exe not found. Install Inno Setup 6 from https://jrsoftware.org/isdl.php and re-run, or pass -IsccPath."
}
Info "Using iscc at $IsccPath"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Fail "pnpm not found on PATH. Install pnpm (https://pnpm.io/installation) and re-run."
}

# ── Step 2: build the artifacts ──────────────────────────────────────
if (-not $SkipBuild) {
    Step "Building api-server"
    Push-Location $RepoRoot
    try {
        & pnpm --filter @workspace/api-server run build
        if ($LASTEXITCODE -ne 0) { Fail "api-server build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }

    Step "Building pilot-dashboard"
    Push-Location $RepoRoot
    try {
        & pnpm --filter @workspace/pilot-dashboard run build
        if ($LASTEXITCODE -ne 0) { Fail "pilot-dashboard build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
} else {
    Info "Skipping api-server / pilot-dashboard build per -SkipBuild"
}

# ── Step 3: stage the repo ───────────────────────────────────────────
if ($SkipStageRepo) {
    Info "Skipping repo staging per -SkipStageRepo"
} else {
    Step "Staging repo into $RepoStage"
    if (Test-Path $RepoStage) { Remove-Item -Recurse -Force $RepoStage }
    New-Item -ItemType Directory -Path $RepoStage -Force | Out-Null

    # robocopy is the most efficient way to mirror with excludes on Windows.
    # Exit codes 0-7 are non-fatal for robocopy.
    $excludeDirs = @(
        ".git",
        ".local",
        ".cache",
        "attached_assets",
        "dist-binaries",
        "downloads",
        "exports",
        "screenshots",
        "installer\build-cache",
        "installer\dist"
    )
    $excludeFiles = @(
        "*.log",
        "legacy-export-*.json"
    )
    $rcArgs = @(
        "$RepoRoot",
        "$RepoStage",
        "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
        "/XD"
    ) + ($excludeDirs | ForEach-Object { Join-Path $RepoRoot $_ }) + @("/XF") + $excludeFiles

    & robocopy @rcArgs | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -gt 7) { Fail "robocopy failed with exit $rc" }
    Info "Repo staged."

    # Sanity check: prebuilt bundles really are present.
    $apiDist  = Join-Path $RepoStage "artifacts\api-server\dist"
    $dashDist = Join-Path $RepoStage "artifacts\pilot-dashboard\dist"
    if (-not (Test-Path $apiDist))  { Warn "artifacts\api-server\dist missing in stage — installer will need to build api-server on the target." }
    if (-not (Test-Path $dashDist)) { Warn "artifacts\pilot-dashboard\dist missing in stage — installer will need to build dashboard on the target." }
}

# ── Step 4: bundle Node.js portable ──────────────────────────────────
if (-not $SkipNodeBundle) {
    Step "Bundling Node.js $NodeVersion"
    if ((Test-Path $NodeStage) -and (Get-ChildItem $NodeStage -ErrorAction SilentlyContinue).Count -gt 0) {
        Info "Already cached at $NodeStage — skipping download."
    } else {
        if ($OfflineCache) { Fail "Node bundle missing and -OfflineCache was specified." }
        New-Item -ItemType Directory -Path $NodeStage -Force | Out-Null
        $zipName = "node-v$NodeVersion-win-x64.zip"
        $zipUrl  = "https://nodejs.org/dist/v$NodeVersion/$zipName"
        $zipPath = Join-Path $CacheDir $zipName
        Info "Downloading $zipUrl"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        Info "Unpacking..."
        Expand-Archive -Path $zipPath -DestinationPath $CacheDir -Force
        $extracted = Join-Path $CacheDir "node-v$NodeVersion-win-x64"
        # Move contents up so .runtime\node\node.exe ends up at the top.
        Get-ChildItem -Path $extracted -Force | Move-Item -Destination $NodeStage -Force
        Remove-Item -Path $extracted -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $zipPath  -Force -ErrorAction SilentlyContinue
    }
}

# ── Step 5: bundle pnpm portable ────────────────────────────────────
if (-not $SkipPnpmBundle) {
    Step "Bundling pnpm portable"
    $pnpmExe = Join-Path $PnpmStage "pnpm.exe"
    if (Test-Path $pnpmExe) {
        Info "Already cached at $pnpmExe — skipping download."
    } else {
        if ($OfflineCache) { Fail "pnpm bundle missing and -OfflineCache was specified." }
        New-Item -ItemType Directory -Path $PnpmStage -Force | Out-Null
        $url = "https://github.com/pnpm/pnpm/releases/latest/download/pnpm-win-x64.exe"
        Info "Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $pnpmExe -UseBasicParsing
    }
}

# ── Step 6: run iscc ─────────────────────────────────────────────────
Step "Running iscc"
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }
& "$IsccPath" (Join-Path $InstallerDir "HawkEye.iss")
if ($LASTEXITCODE -ne 0) { Fail "iscc failed with exit $LASTEXITCODE" }

$out = Join-Path $DistDir "HawkEye-Setup.exe"
if (-not (Test-Path $out)) { Fail "iscc reported success but $out is missing." }
$sizeMb = [Math]::Round((Get-Item $out).Length / 1MB, 1)
Info "Built $out ($sizeMb MB)"

Write-Host ""
Write-Host "[BUILD] Done. HawkEye-Setup.exe is in $DistDir" -ForegroundColor Green
exit 0
