param(
  [string]$ApiBaseUrl,
  [string]$DashboardEnvPath = "",
  [switch]$EnableNoAuth
)

$ErrorActionPreference = "Stop"

if (-not $ApiBaseUrl -or $ApiBaseUrl.Trim() -eq "") {
  throw "ApiBaseUrl is required, e.g. -ApiBaseUrl http://192.168.1.20:3847"
}

function Resolve-RepoRoot {
  $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
    $PSScriptRoot
  } else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

$root = Resolve-RepoRoot
if (-not $DashboardEnvPath -or $DashboardEnvPath.Trim() -eq "") {
  $DashboardEnvPath = Join-Path $root "artifacts\pilot-dashboard\.env"
}

$normalizedUrl = $ApiBaseUrl.Trim().TrimEnd("/")
$noAuth = if ($EnableNoAuth) { "1" } else { "0" }

$lines = @(
  "VITE_LAN_SESSION_LOGIN=1",
  "VITE_INTERNAL_API_URL=$normalizedUrl",
  "VITE_LAN_NO_AUTH=$noAuth"
)

Set-Content -Path $DashboardEnvPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8

Write-Host "[hawk-eye] Wrote dashboard LAN env:"
Write-Host "  $DashboardEnvPath"
Write-Host "[hawk-eye] Values:"
Write-Host "  VITE_LAN_SESSION_LOGIN=1"
Write-Host "  VITE_INTERNAL_API_URL=$normalizedUrl"
Write-Host "  VITE_LAN_NO_AUTH=$noAuth"
exit 0
