param(
  [string]$TaskName = "HawkEye-Backup-Verify-Quarterly",
  [string]$RunAt = "03:30",
  [string]$DayOfMonth = "15",
  [string]$RepoRoot = ""
)

# Hawk Eye — register the quarterly backup-verification task.
#
# The verify script runs on the 15th of January, April, July and
# October (months 1, 4, 7, 10). It restores the latest .dump into a
# scratch DB, runs sanity SELECTs, then writes its outcome into
# `system_health_marker.last_backup_verify` so the System Health page
# can warn the operator if the result is stale (>120 days) or failed.
#
# The 15th was chosen so the verify never collides with the daily
# 02:30 backup (`install-backup-task.ps1`).

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

if ($RunAt -notmatch "^\d{2}:\d{2}$") {
  throw "RunAt must be HH:mm (24-hour), e.g. 03:30"
}
if ($DayOfMonth -notmatch "^\d{1,2}$" -or [int]$DayOfMonth -lt 1 -or [int]$DayOfMonth -gt 28) {
  throw "DayOfMonth must be 1-28."
}

$root = Resolve-RepoRoot -InputRoot $RepoRoot
$verifyScript = Join-Path $root "scripts\lan-host\verify-backup.ps1"
if (-not (Test-Path $verifyScript)) {
  throw "Missing script: $verifyScript"
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$verifyScript`""

Write-Host "[hawk-eye] Creating quarterly backup-verify task: $TaskName at $RunAt on the ${DayOfMonth}th of Jan/Apr/Jul/Oct"

# /SC MONTHLY /M JAN,APR,JUL,OCT /D <day> runs the task on the chosen
# day of the listed months only.
schtasks /Create /F /RU SYSTEM /SC MONTHLY /M JAN,APR,JUL,OCT /D $DayOfMonth `
  /ST "$RunAt" /TN "$TaskName" /TR "$taskCommand" | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Failed to create backup-verify task."
}

Write-Host "[hawk-eye] Quarterly backup-verify task installed."
Write-Host "[hawk-eye] Task name: $TaskName"
exit 0
