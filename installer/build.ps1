# build.ps1
#
# Hawk Eye installer build orchestrator. Run this on a Windows builder
# machine that has Inno Setup 6 installed (iscc.exe on PATH or at the
# default location).

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
$ProgressPreference    = "SilentlyContinue"

$InstallerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot     = Resolve-Path (Join-Path $InstallerDir "..")
$CacheDir     = Join-Path $InstallerDir "build-cache"
$RepoStage    = Join-Path $CacheDir "repo"
$NodeStage    = Join-Path $CacheDir "node"
$PnpmStage    = Join-Path $CacheDir "pnpm"
$DistDir      = Join-Path $InstallerDir "dist"

$script:T0 = [DateTime]::UtcNow
function Stamp { ("{0:hh\:mm\:ss}" -f ([DateTime]::UtcNow - $script:T0)) }
function Step([string]$msg) {
    Write-Host ""
    Write-Host "[BUILD $(Stamp)] === $msg ===" -ForegroundColor Cyan
}
function Info([string]$msg) { Write-Host "[BUILD $(Stamp)]   $msg" }
function Warn([string]$msg) { Write-Host "[BUILD $(Stamp)]   [WARN] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "[BUILD $(Stamp)]   [FAIL] $msg" -ForegroundColor Red; exit 1 }

Info "Build script starting. RepoRoot=$RepoRoot CacheDir=$CacheDir"

# Step 1: prerequisites
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
    Fail "iscc.exe not found."
}
Info "iscc OK: $IsccPath"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail "pnpm not found." }
Info "pnpm OK: $((Get-Command pnpm).Source)"

# Step 2: build artifacts
if (-not $SkipBuild) {
    Step "Building api-server"
    Push-Location $RepoRoot
    try {
        & pnpm --filter @workspace/api-server run build 2>&1 | ForEach-Object { Write-Host "[api] $_" }
        if ($LASTEXITCODE -ne 0) { Fail "api-server build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    Info "api-server build complete"

    Step "Building pilot-dashboard"
    Push-Location $RepoRoot
    try {
        & pnpm --filter @workspace/pilot-dashboard run build 2>&1 | ForEach-Object { Write-Host "[dash] $_" }
        if ($LASTEXITCODE -ne 0) { Fail "pilot-dashboard build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    Info "pilot-dashboard build complete"
}

# Step 3: stage repo
if (-not $SkipStageRepo) {
    Step "Staging repo into $RepoStage"
    if (Test-Path $RepoStage) {
        Info "Removing previous stage..."
        Remove-Item -Recurse -Force $RepoStage
    }
    New-Item -ItemType Directory -Path $RepoStage -Force | Out-Null

    $excludeDirs = @(
        ".git", ".local", ".cache",
        "attached_assets", "dist-binaries", "downloads",
        "exports", "screenshots",
        "installer\build-cache", "installer\dist"
    )
    $excludeFiles = @("*.log", "legacy-export-*.json")
    # /NP = no per-file progress percent (CRITICAL — without this, robocopy
    #        emits a 0%/100% line for every file copied, which with 100k+
    #        node_modules files generates millions of log lines and looks
    #        like a hang).
    # /NFL /NDL /NJH /NJS = no file/dir/job-header/job-summary lines.
    # /MT:8 = 8 threads.
    $rcArgs = @(
        "$RepoRoot", "$RepoStage",
        "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1", "/MT:8"
    ) + @("/XD") + ($excludeDirs | ForEach-Object { Join-Path $RepoRoot $_ }) + @("/XF") + $excludeFiles

    Info "Running robocopy (silent, will print summary on completion)..."
    $rcLog = Join-Path $env:RUNNER_TEMP "robocopy.log"
    if (-not $rcLog) { $rcLog = Join-Path $InstallerDir "robocopy.log" }
    $rcStart = [DateTime]::UtcNow
    # Send robocopy output to a log file so we never accumulate millions of
    # in-memory pipeline objects, but still keep evidence on disk.
    # /LOG redirects all robocopy output to file; no /TEE so console stays silent.
    & robocopy @rcArgs /LOG:"$rcLog" *>$null
    $rc = $LASTEXITCODE
    $rcDur = [DateTime]::UtcNow - $rcStart
    Info "robocopy exit=$rc duration=$([Math]::Round($rcDur.TotalSeconds,1))s"
    if ($rc -gt 7) {
        Info "--- robocopy log tail ---"
        Get-Content $rcLog -Tail 50 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "[rc] $_" }
        Fail "robocopy failed with exit $rc"
    }

    $stagedFiles = (Get-ChildItem -Recurse -File $RepoStage -ErrorAction SilentlyContinue | Measure-Object).Count
    Info "Repo staged: $stagedFiles files"
} else {
    Info "Skipping repo staging per -SkipStageRepo"
}

# Step 4: bundle Node
if (-not $SkipNodeBundle) {
    Step "Bundling Node.js $NodeVersion"
    if ((Test-Path $NodeStage) -and (Get-ChildItem $NodeStage -ErrorAction SilentlyContinue).Count -gt 0) {
        Info "Already cached at $NodeStage."
    } else {
        if ($OfflineCache) { Fail "Node bundle missing and -OfflineCache was specified." }
        New-Item -ItemType Directory -Path $NodeStage -Force | Out-Null
        $zipName = "node-v$NodeVersion-win-x64.zip"
        $zipUrl  = "https://nodejs.org/dist/v$NodeVersion/$zipName"
        $zipPath = Join-Path $CacheDir $zipName
        Info "Downloading $zipUrl via curl.exe ..."
        & curl.exe -fL --retry 3 --max-time 300 -o $zipPath $zipUrl
        if ($LASTEXITCODE -ne 0) { Fail "curl Node download failed (exit $LASTEXITCODE)" }
        $zipSize = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)
        Info "Downloaded Node zip: $zipSize MB. Expanding..."
        Expand-Archive -Path $zipPath -DestinationPath $CacheDir -Force
        $extracted = Join-Path $CacheDir "node-v$NodeVersion-win-x64"
        Get-ChildItem -Path $extracted -Force | Move-Item -Destination $NodeStage -Force
        Remove-Item -Path $extracted -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $zipPath  -Force -ErrorAction SilentlyContinue
        Info "Node unpacked."
    }
}

# Step 5: bundle pnpm
if (-not $SkipPnpmBundle) {
    Step "Bundling pnpm portable"
    $pnpmExe = Join-Path $PnpmStage "pnpm.exe"
    if (Test-Path $pnpmExe) {
        Info "Already cached at $pnpmExe."
    } else {
        if ($OfflineCache) { Fail "pnpm bundle missing and -OfflineCache was specified." }
        New-Item -ItemType Directory -Path $PnpmStage -Force | Out-Null
        $url = "https://github.com/pnpm/pnpm/releases/download/v9.15.9/pnpm-win-x64.exe"
        Info "Downloading pnpm via curl.exe -> $pnpmExe"
        & curl.exe -fL --retry 3 --max-time 300 -o $pnpmExe $url
        if ($LASTEXITCODE -ne 0) { Fail "curl pnpm download failed (exit $LASTEXITCODE)" }
        $pnpmSize = [Math]::Round((Get-Item $pnpmExe).Length / 1MB, 1)
        Info "pnpm.exe downloaded: $pnpmSize MB"
    }
}

# Pre-iscc diagnostic: list what iscc will compress
Step "Pre-iscc inventory"
$repoFiles  = (Get-ChildItem -Recurse -File $RepoStage -ErrorAction SilentlyContinue | Measure-Object).Count
$nodeFiles  = (Get-ChildItem -Recurse -File $NodeStage -ErrorAction SilentlyContinue | Measure-Object).Count
$repoBytes  = (Get-ChildItem -Recurse -File $RepoStage -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
$nodeBytes  = (Get-ChildItem -Recurse -File $NodeStage -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Info "repo stage: $repoFiles files, $([Math]::Round($repoBytes/1MB,1)) MB"
Info "node stage: $nodeFiles files, $([Math]::Round($nodeBytes/1MB,1)) MB"
Info "pnpm.exe present: $((Test-Path (Join-Path $PnpmStage 'pnpm.exe'))) "
$bonjourDir = Join-Path $InstallerDir "bonjour-portable"
if (Test-Path $bonjourDir) {
    $bjFiles = (Get-ChildItem -Recurse -File $bonjourDir -ErrorAction SilentlyContinue | Measure-Object).Count
    Info "bonjour-portable: $bjFiles files"
} else {
    Info "bonjour-portable: NOT PRESENT (skipifsourcedoesntexist will handle)"
}

# Step 6: iscc with streamed output
Step "Running iscc"
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }
$issPath = Join-Path $InstallerDir "HawkEye.iss"
Info "iscc target: $issPath"
$iscStart = [DateTime]::UtcNow
& "$IsccPath" "$issPath" 2>&1 | ForEach-Object { Write-Host "[iscc] $_" }
$iscExit = $LASTEXITCODE
$iscDur = [DateTime]::UtcNow - $iscStart
Info "iscc exit=$iscExit duration=$($iscDur.TotalSeconds)s"
if ($iscExit -ne 0) { Fail "iscc failed with exit $iscExit" }

$out = Join-Path $DistDir "HawkEye-Setup.exe"
if (-not (Test-Path $out)) { Fail "iscc reported success but $out is missing." }
$sizeMb = [Math]::Round((Get-Item $out).Length / 1MB, 1)
Info "Built $out ($sizeMb MB)"

Write-Host ""
Write-Host "[BUILD $(Stamp)] === DONE === HawkEye-Setup.exe is in $DistDir" -ForegroundColor Green
exit 0
