param(
  [string]$RepoRoot = "",
  [string]$ApiEnvPath = "",
  [int]$ApiPort = 3847
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

function Parse-EnvFile {
  param([string]$Path)
  $map = @{}
  Get-Content -Path $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { return }
    $k = $parts[0].Trim()
    if ($k -eq "") { return }
    $v = $parts[1].Trim()
    if ($v.StartsWith('"') -and $v.EndsWith('"')) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $map[$k] = $v
  }
  return $map
}

function Check-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

$root = Resolve-RepoRoot -InputRoot $RepoRoot
if (-not $ApiEnvPath -or $ApiEnvPath.Trim() -eq "") {
  $ApiEnvPath = Join-Path $root "artifacts\api-server\.env"
}

$errors = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

if (-not (Test-Path $ApiEnvPath)) {
  $errors.Add("Missing API env file: $ApiEnvPath")
} else {
  $envMap = Parse-EnvFile -Path $ApiEnvPath
  foreach ($required in @("DATABASE_URL", "HAWK_INTERNAL_SESSION_AUTH", "HAWK_LAN_BOOTSTRAP_TOKEN")) {
    if (-not $envMap.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$envMap[$required])) {
      $errors.Add("Missing or empty env key: $required")
    }
  }
  if ($envMap.ContainsKey("HAWK_INTERNAL_SESSION_AUTH")) {
    $mode = [string]$envMap["HAWK_INTERNAL_SESSION_AUTH"]
    if ($mode -ne "required") {
      $warnings.Add("HAWK_INTERNAL_SESSION_AUTH is '$mode' (recommended: required)")
    }
  }
  if ($envMap.ContainsKey("HAWK_LAN_DEV_NO_AUTH")) {
    $noAuth = [string]$envMap["HAWK_LAN_DEV_NO_AUTH"]
    if ($noAuth -eq "1" -or $noAuth.ToLower() -eq "true") {
      $warnings.Add("HAWK_LAN_DEV_NO_AUTH is enabled (use only for temporary migration tests)")
    }
  }
}

if (-not (Check-CommandExists -Name "pnpm")) { $errors.Add("pnpm not found on PATH") }
if (-not (Check-CommandExists -Name "pg_dump")) { $warnings.Add("pg_dump not found (backup script will fail)") }
if (-not (Check-CommandExists -Name "pg_restore")) { $warnings.Add("pg_restore not found (restore script will fail)") }

try {
  $busy = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction Stop
  if ($busy) {
    $warnings.Add("Port $ApiPort already has a listening process. Confirm this is the intended Hawk Eye API host.")
  }
} catch {
  # No listener is normal before startup
}

Write-Host "[hawk-eye] Host preflight report"
Write-Host "  Repo root: $root"
Write-Host "  API env:   $ApiEnvPath"
Write-Host "  API port:  $ApiPort"

if ($warnings.Count -gt 0) {
  Write-Host ""
  Write-Host "[warnings]"
  foreach ($w in $warnings) { Write-Host "  - $w" }
}

if ($errors.Count -gt 0) {
  Write-Host ""
  Write-Host "[errors]"
  foreach ($e in $errors) { Write-Host "  - $e" }
  exit 1
}

Write-Host ""
Write-Host "[hawk-eye] Preflight passed."
exit 0
