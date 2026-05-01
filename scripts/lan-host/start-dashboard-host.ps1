# start-dashboard-host.ps1
#
# Hawk Eye — start the pilot-dashboard as a long-running local service.
#
# Used on Wing / Base Commander PCs (aggregator installs) where the
# dashboard runs on the same PC as the api-server. The dashboard's
# `serve` script (`vite preview`) needs PORT + BASE_PATH set in the
# environment because vite.config.ts throws if PORT is unset. This
# wrapper sets those and then runs `pnpm --filter @workspace/pilot-dashboard run serve`.
#
# Behaviour:
#   - On boot the install scheduled task calls this with -SkipBuild;
#     `setup-aggregator.ps1` already produced a build during install.
#   - Re-runnable from an interactive shell — useful for debugging the
#     dashboard locally without messing with the scheduled task.
#
# This script is the dashboard counterpart to start-api-host.ps1; the
# api-server install scheduled task pattern is unchanged.

param(
  [string]$RepoRoot = "",
  [int]$DashboardPort = 5173,
  [switch]$SkipBuild
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

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is not installed or not on PATH."
}
if ($DashboardPort -lt 1 -or $DashboardPort -gt 65535) {
  throw "DashboardPort '$DashboardPort' is out of range."
}

Write-Host "[hawk-eye] Repo root: $root"
Write-Host "[hawk-eye] Dashboard port: $DashboardPort"

Set-Location $root

# vite.config.ts requires PORT + BASE_PATH at config time. NODE_ENV
# stays "production" so the CSP plugin runs in its production code
# path (hash inline scripts, keep meta tag) instead of the dev path
# that strips the CSP for HMR.
$env:PORT      = "$DashboardPort"
$env:BASE_PATH = "/"
$env:NODE_ENV  = "production"

if (-not $SkipBuild) {
  Write-Host "[hawk-eye] Building dashboard..."
  & pnpm --filter @workspace/pilot-dashboard run build
  if ($LASTEXITCODE -ne 0) { throw "dashboard build failed." }
}

Write-Host "[hawk-eye] Starting dashboard (vite preview) on port $DashboardPort..."
& pnpm --filter @workspace/pilot-dashboard run serve
exit $LASTEXITCODE
