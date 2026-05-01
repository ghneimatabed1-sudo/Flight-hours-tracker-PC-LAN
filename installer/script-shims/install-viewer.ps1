# install-viewer.ps1
#
# Shim invoked by the Inno Setup installer's [Run] section for the
# Squadron / Flight Commander Laptop role. The viewer install does not
# need any Postgres password (no DB on a viewer), so this shim simply
# forwards the hub address to setup-viewer.ps1.
#
# Inputs (from Inno Setup):
#   -RepoRoot     extracted repo root ({app})
#   -HubAddress   hostname (tigers-hub.local) or IP, validated by the wizard
#   -HubPort      port (default 3847), validated by the wizard
#   -LogFile      absolute path to install-log.txt
#
# setup-viewer.ps1 takes -HubAddress and -HubPort as parameters
# directly, so no stdin redirection is needed here.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string] $RepoRoot,
    [Parameter(Mandatory=$true)] [string] $HubAddress,
    [Parameter(Mandatory=$true)] [string] $HubPort,
    [Parameter(Mandatory=$true)] [string] $LogFile
)

$ErrorActionPreference = "Stop"

$nodeDir = Join-Path $RepoRoot ".runtime\node"
$pnpmDir = Join-Path $RepoRoot ".runtime\pnpm"
if (Test-Path $nodeDir) { $env:PATH = "$nodeDir;$pnpmDir;$env:PATH" }

$started = "[$(Get-Date -Format o)] install-viewer.ps1 starting (hub='$HubAddress`:$HubPort')"
Add-Content -Path $LogFile -Value $started
Write-Host $started

$inner = Join-Path $RepoRoot "scripts\lan-host\setup-viewer.ps1"
if (-not (Test-Path $inner)) {
    $msg = "[FAIL] setup-viewer.ps1 not found at $inner"
    Add-Content -Path $LogFile -Value $msg
    Write-Error $msg
    exit 2
}

$portInt = [int]$HubPort

$tempOut = [System.IO.Path]::GetTempFileName()
try {
    & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $inner `
        -HubAddress $HubAddress -HubPort $portInt 2>&1 |
        Tee-Object -FilePath $tempOut -Append
    $code = $LASTEXITCODE
    Get-Content $tempOut | Add-Content -Path $LogFile
    if ($code -ne 0) {
        Add-Content -Path $LogFile -Value "[FAIL] setup-viewer.ps1 exited with code $code"
        exit $code
    }
} finally {
    Remove-Item -Path $tempOut -ErrorAction SilentlyContinue
}

Add-Content -Path $LogFile -Value "[$(Get-Date -Format o)] install-viewer.ps1 finished OK"
exit 0
