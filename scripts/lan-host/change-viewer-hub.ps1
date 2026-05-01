# change-viewer-hub.ps1
#
# Hawk Eye — re-point an existing viewer install at a different hub.
#
# Use when a Squadron / Flight Commander laptop is reassigned (e.g.
# from Tigers to Eagles) and the viewer needs to start talking to the
# new squadron's hub PC, without uninstalling and reinstalling the
# whole viewer bundle.
#
# What this script does:
#   1. Reads the existing .viewer-config.json so the operator can see
#      what hub the laptop is currently pointing at.
#   2. Asks (or accepts via -HubAddress) for the NEW hub address.
#      Optional -AutoDiscover scans the LAN exactly like setup-viewer
#      does.
#   3. Validates the new hub via /api/healthz (must report
#      installProfile=hub).
#   4. Rewrites artifacts/pilot-dashboard/.env.production.local with
#      the new VITE_INTERNAL_API_URL.
#   5. Rebuilds the dashboard so the bundle bakes in the new URL.
#      (Vite inlines VITE_* at build time — without a rebuild the old
#      hub URL would still be hard-coded in dist/public/assets/*.js.)
#   6. Updates .viewer-config.json so launch-viewer.ps1 picks up the
#      new hub on its next run.
#   7. Refreshes the existing desktop + Start Menu shortcuts so the
#      shortcut Description (and label, when -SquadronName is given)
#      reflects the new hub.
#
# Re-running is safe; every step overwrites in place. The script does
# NOT touch Postgres, the api-server, or any local data — viewer PCs
# don't have any of those.

[CmdletBinding()]
param(
    [string]$HubAddress    = "",
    [int]   $HubPort       = 0,
    [switch]$AutoDiscover,
    [string]$SquadronName  = "",
    [int]   $LocalPort     = 0,
    [switch]$SkipBuild,
    [string]$PrebuiltDist  = "",
    [switch]$SkipShortcuts
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
        $PSScriptRoot
    } else {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

$RepoRoot       = Resolve-RepoRoot
$DashRoot       = Join-Path $RepoRoot "artifacts\pilot-dashboard"
$ViewerConfFile = Join-Path $DashRoot ".viewer-config.json"

# Read existing config (if any) so we can show what was previously set
# and inherit fields the operator didn't override.
$prev = $null
if (Test-Path $ViewerConfFile) {
    try { $prev = Get-Content -Raw -Path $ViewerConfFile | ConvertFrom-Json } catch { $prev = $null }
}

Write-Host ""
Write-Host "Hawk Eye — change viewer hub" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
if ($prev) {
    Write-Host "Currently pointed at:"
    Write-Host "  Hub URL : $($prev.hubBaseUrl)"
    if ($prev.squadronName) { Write-Host "  Squadron: $($prev.squadronName)" }
    Write-Host "  Configured: $($prev.configuredAt)"
} else {
    Write-Host "(No existing viewer config found — this will create one. Consider running setup-viewer.ps1 instead.)"
}

# Inherit defaults from previous config when the operator doesn't pass them.
if ($prev) {
    if (-not $SquadronName -and $prev.squadronName) { $SquadronName = [string]$prev.squadronName }
    if ($LocalPort -le 0 -and $prev.localPort)      { $LocalPort    = [int]$prev.localPort }
    if ($HubPort   -le 0 -and $prev.hubPort)        { $HubPort      = [int]$prev.hubPort }
}
if ($HubPort   -le 0) { $HubPort   = 3847 }
if ($LocalPort -le 0) { $LocalPort = 5500 }

# Hand off to setup-viewer.ps1 — it owns all the validation, env
# rewrite, build, config write, and shortcut refresh logic. Re-running
# setup-viewer.ps1 is the documented "safe to re-run" path; this
# wrapper exists so the operator-facing command name matches the
# action ("I'm changing the hub, not reinstalling").
$setupScript = Join-Path $PSScriptRoot "setup-viewer.ps1"
if (-not (Test-Path $setupScript)) {
    Write-Host "[FAIL] setup-viewer.ps1 not found at $setupScript" -ForegroundColor Red
    exit 30
}

# -SkipBuild on a hub-change is a footgun: Vite bakes
# VITE_INTERNAL_API_URL into the JS at build time, so reusing the
# existing bundle would keep calling the OLD hub no matter what env
# file or .viewer-config.json we write. setup-viewer.ps1's bundle
# verification will catch this with a clear error, but warn here so
# the operator sees the explanation up front.
if ($SkipBuild -and -not $PrebuiltDist) {
    Write-Host ""
    Write-Host "[WARN] -SkipBuild on a hub change reuses the existing bundle, which" -ForegroundColor Yellow
    Write-Host "       was built against the previous hub URL. The install will only" -ForegroundColor Yellow
    Write-Host "       succeed if that bundle was already built for the NEW hub" -ForegroundColor Yellow
    Write-Host "       (which is rare). Otherwise re-run without -SkipBuild." -ForegroundColor Yellow
}

$forwardArgs = @()
if ($HubAddress)        { $forwardArgs += @("-HubAddress", $HubAddress) }
$forwardArgs += @("-HubPort", $HubPort)
if ($AutoDiscover)      { $forwardArgs += "-AutoDiscover" }
if ($SquadronName)      { $forwardArgs += @("-SquadronName", $SquadronName) }
$forwardArgs += @("-LocalPort", $LocalPort)
if ($PrebuiltDist)      { $forwardArgs += @("-PrebuiltDist", $PrebuiltDist) }
if ($SkipBuild)         { $forwardArgs += "-SkipBuild" }
if ($SkipShortcuts)     { $forwardArgs += "-SkipShortcuts" }

Write-Host ""
Write-Host "Re-running validation + env rewrite + rebuild via setup-viewer.ps1..." -ForegroundColor Cyan
& $setupScript @forwardArgs
$rc = $LASTEXITCODE
if ($rc -ne 0) {
    Write-Host ""
    Write-Host "[FAIL] change-viewer-hub did NOT update the viewer (setup-viewer exit $rc)." -ForegroundColor Red
    Write-Host "       The previous hub configuration is unchanged."
    exit $rc
}

Write-Host ""
Write-Host "DONE. Viewer is now pointed at the new hub. Launch the dashboard from the existing desktop shortcut." -ForegroundColor Green
exit 0
