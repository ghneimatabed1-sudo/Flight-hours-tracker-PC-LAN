param(
  [string]$RepoRoot = "",
  [string]$EnvFile = "",
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

function Resolve-EnvFile {
  param(
    [string]$InputEnvFile,
    [string]$Root
  )
  if ($InputEnvFile -and $InputEnvFile.Trim() -ne "") {
    return (Resolve-Path $InputEnvFile).Path
  }
  $defaultEnv = Join-Path $Root "artifacts\api-server\.env"
  if (Test-Path $defaultEnv) { return $defaultEnv }
  $exampleEnv = Join-Path $Root "artifacts\api-server\.env.lan.example"
  if (Test-Path $exampleEnv) {
    throw "Missing artifacts/api-server/.env. Copy .env.lan.example to .env and fill DATABASE_URL first."
  }
  throw "Missing env file. Expected artifacts/api-server/.env."
}

function Import-EnvFile {
  param([string]$Path)
  Get-Content -Path $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { return }
    $key = $parts[0].Trim()
    if ($key -eq "") { return }
    $value = $parts[1].Trim()
    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

$root = Resolve-RepoRoot -InputRoot $RepoRoot
$envPath = Resolve-EnvFile -InputEnvFile $EnvFile -Root $root

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is not installed or not on PATH."
}

Write-Host "[hawk-eye] Repo root: $root"
Write-Host "[hawk-eye] Loading API env: $envPath"
Import-EnvFile -Path $envPath

$dbUrl = [System.Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
if (-not $dbUrl -or $dbUrl.Trim() -eq "") {
  throw "DATABASE_URL is empty in API env file."
}

Set-Location $root

if (-not $SkipBuild) {
  Write-Host "[hawk-eye] Building api-server..."
  & pnpm --filter @workspace/api-server run build
  if ($LASTEXITCODE -ne 0) { throw "api-server build failed." }
}

Write-Host "[hawk-eye] Starting api-server..."
& pnpm --filter @workspace/api-server run start
exit $LASTEXITCODE
