param(
  [string]$DatabaseUrl,
  [string]$BootstrapToken,
  [string]$ApiEnvPath = "",
  [switch]$EnableNoAuth
)

$ErrorActionPreference = "Stop"

if (-not $DatabaseUrl -or $DatabaseUrl.Trim() -eq "") {
  throw "DatabaseUrl is required."
}
if (-not $BootstrapToken -or $BootstrapToken.Trim() -eq "") {
  throw "BootstrapToken is required."
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
if (-not $ApiEnvPath -or $ApiEnvPath.Trim() -eq "") {
  $ApiEnvPath = Join-Path $root "artifacts\api-server\.env"
}

$noAuth = if ($EnableNoAuth) { "1" } else { "0" }
$lines = @(
  "DATABASE_URL=$DatabaseUrl",
  "HAWK_INTERNAL_SESSION_AUTH=required",
  "HAWK_LAN_BOOTSTRAP_TOKEN=$BootstrapToken",
  "HAWK_LAN_DEV_NO_AUTH=$noAuth"
)

Set-Content -Path $ApiEnvPath -Value ($lines -join [Environment]::NewLine) -Encoding UTF8

Write-Host "[hawk-eye] Wrote API LAN env:"
Write-Host "  $ApiEnvPath"
Write-Host "[hawk-eye] Values:"
Write-Host "  HAWK_INTERNAL_SESSION_AUTH=required"
Write-Host "  HAWK_LAN_DEV_NO_AUTH=$noAuth"
exit 0
