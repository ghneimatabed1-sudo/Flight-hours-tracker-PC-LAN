param(
  [string]$DatabaseUrl = "",
  [string]$BackupDir = "",
  [int]$RetentionDays = 14
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
    $PSScriptRoot
  } else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
  }
  return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

$root = Resolve-RepoRoot
if (-not $BackupDir -or $BackupDir.Trim() -eq "") {
  $BackupDir = Join-Path $root "artifacts\api-server\backups"
}

if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

if (-not $DatabaseUrl -or $DatabaseUrl.Trim() -eq "") {
  $DatabaseUrl = [System.Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
}

if (-not $DatabaseUrl -or $DatabaseUrl.Trim() -eq "") {
  throw "Database URL missing. Pass -DatabaseUrl or set DATABASE_URL in environment."
}

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  throw "pg_dump is not installed or not on PATH."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$file = Join-Path $BackupDir ("hawk-eye-lan-" + $stamp + ".dump")

Write-Host "[hawk-eye] Creating Postgres backup..."
& pg_dump --dbname "$DatabaseUrl" --format=custom --file "$file" --no-owner --no-privileges
if ($LASTEXITCODE -ne 0) {
  throw "pg_dump failed with exit code $LASTEXITCODE"
}

Write-Host "[hawk-eye] Backup created: $file"

if ($RetentionDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-1 * $RetentionDays)
  $old = Get-ChildItem -Path $BackupDir -Filter "*.dump" -File | Where-Object { $_.LastWriteTime -lt $cutoff }
  foreach ($item in $old) {
    Remove-Item -Path $item.FullName -Force
    Write-Host "[hawk-eye] Pruned old backup: $($item.Name)"
  }
}

exit 0
