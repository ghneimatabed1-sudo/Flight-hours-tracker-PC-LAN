# install-dashboard-startup-task.ps1
#
# Register a Windows scheduled task that auto-starts the pilot-dashboard
# on this PC at boot. Used on aggregator (Wing / Base Commander) PCs
# where the dashboard lives next to the api-server on the same machine.
#
# Mirrors install-api-startup-task.ps1 — same schtasks pattern, same
# `-RU SYSTEM /SC ONSTART` configuration, same -SkipBuild handoff,
# and (Task #399) the same wrapping under a watchdog supervisor so a
# vite-preview crash auto-restarts within ~5s instead of leaving
# operators with a blank page until the next reboot.
#
# The supervisor (`dashboard-supervisor.ps1`) writes a heartbeat to
# %PROGRAMDATA%\HawkEye\dashboard-supervisor.heartbeat and a rolling
# text log to %PROGRAMDATA%\HawkEye\dashboard-supervisor.log; both are
# surfaced by check-host-health.ps1 and by the AboutThisPc dashboard
# panel.

param(
  [string]$TaskName = "HawkEye-Dashboard-OnStartup",
  [string]$RepoRoot = "",
  [int]$DashboardPort = 5173
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  param([string]$InputRoot)
  if ($InputRoot -and $InputRoot.Trim() -ne "") {
    return (Resolve-Path $InputRoot).Path
  }
  $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
    $PSScriptRoot
  } else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

$root = Resolve-RepoRoot -InputRoot $RepoRoot
$supervisorScript = Join-Path $root "scripts\lan-host\dashboard-supervisor.ps1"
$startScript      = Join-Path $root "scripts\lan-host\start-dashboard-host.ps1"

# We point the scheduled task at dashboard-supervisor.ps1, not
# start-dashboard-host.ps1 directly. The supervisor wraps
# start-dashboard-host.ps1 (with -SkipBuild) in a watchdog loop so
# that if vite-preview crashes — port collision, dropped TCP socket,
# OOM kill — it respawns within ~5s (capped at 60s on rapid failures)
# without operator intervention. Mirrors the api-server supervisor
# pattern from install-api-startup-task.ps1.
if (-not (Test-Path $supervisorScript)) {
  throw "Missing script: $supervisorScript"
}
if (-not (Test-Path $startScript)) {
  throw "Missing script: $startScript"
}
if ($DashboardPort -lt 1 -or $DashboardPort -gt 65535) {
  throw "DashboardPort '$DashboardPort' is out of range."
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$supervisorScript`" -RepoRoot `"$root`" -DashboardPort $DashboardPort"

Write-Host "[hawk-eye] Creating dashboard startup task: $TaskName (port $DashboardPort)"
Write-Host "[hawk-eye] Command: $taskCommand"

# Stop any prior supervisor instance so a re-install picks up the
# new task definition immediately rather than at next boot.
schtasks /End /TN "$TaskName" 2>&1 | Out-Null

schtasks /Create /F /RU SYSTEM /SC ONSTART /TN "$TaskName" /TR "$taskCommand" | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Failed to create dashboard startup task."
}

Write-Host "[hawk-eye] Dashboard startup task installed (supervised — auto-restarts on dashboard host death)."
Write-Host "[hawk-eye] Task name:        $TaskName"
Write-Host "[hawk-eye] Verify alive:     scripts\lan-host\check-host-health.ps1"
Write-Host "[hawk-eye] Supervisor logs:  %PROGRAMDATA%\HawkEye\dashboard-supervisor.log"
exit 0
