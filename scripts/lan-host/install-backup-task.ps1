param(
  [string]$TaskName = "HawkEye-Postgres-Backup-Daily",
  [string]$RunAt = "02:30",
  [string]$RepoRoot = "",
  [int]$RetentionDays = 14
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

if ($RunAt -notmatch "^\d{2}:\d{2}$") {
  throw "RunAt must be HH:mm (24-hour), e.g. 02:30"
}

$root = Resolve-RepoRoot -InputRoot $RepoRoot
$backupScript = Join-Path $root "scripts\lan-host\backup-postgres.ps1"

if (-not (Test-Path $backupScript)) {
  throw "Missing script: $backupScript"
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -RetentionDays $RetentionDays"

Write-Host "[hawk-eye] Creating daily backup task: $TaskName at $RunAt"
schtasks /Create /F /RU SYSTEM /SC DAILY /ST "$RunAt" /TN "$TaskName" /TR "$taskCommand" | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Failed to create backup task."
}

Write-Host "[hawk-eye] Backup task installed."
Write-Host "[hawk-eye] Task name: $TaskName"
exit 0
