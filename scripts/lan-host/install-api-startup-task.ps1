param(
  [string]$TaskName = "HawkEye-ApiServer-OnStartup",
  [string]$RepoRoot = ""
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
$startScript = Join-Path $root "scripts\lan-host\start-api-host.ps1"

if (-not (Test-Path $startScript)) {
  throw "Missing script: $startScript"
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -SkipBuild"

Write-Host "[hawk-eye] Creating startup task: $TaskName"
schtasks /Create /F /RU SYSTEM /SC ONSTART /TN "$TaskName" /TR "$taskCommand" | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Failed to create startup task."
}

Write-Host "[hawk-eye] Startup task installed."
Write-Host "[hawk-eye] Task name: $TaskName"
exit 0
