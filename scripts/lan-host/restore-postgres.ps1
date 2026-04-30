param(
  [string]$DatabaseUrl = "",
  [string]$BackupFile = "",
  [switch]$DropAndRecreate
)

$ErrorActionPreference = "Stop"

if (-not $BackupFile -or $BackupFile.Trim() -eq "") {
  throw "BackupFile is required. Pass a .dump file path."
}

$resolvedBackup = (Resolve-Path $BackupFile).Path
if (-not (Test-Path $resolvedBackup)) {
  throw "Backup file not found: $BackupFile"
}

if (-not $DatabaseUrl -or $DatabaseUrl.Trim() -eq "") {
  $DatabaseUrl = [System.Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
}
if (-not $DatabaseUrl -or $DatabaseUrl.Trim() -eq "") {
  throw "Database URL missing. Pass -DatabaseUrl or set DATABASE_URL in environment."
}

if (-not (Get-Command pg_restore -ErrorAction SilentlyContinue)) {
  throw "pg_restore is not installed or not on PATH."
}

$args = @("--dbname", $DatabaseUrl, "--no-owner", "--no-privileges")
if ($DropAndRecreate) {
  $args += @("--clean", "--if-exists")
}
$args += $resolvedBackup

Write-Host "[hawk-eye] Restoring Postgres backup..."
Write-Host "[hawk-eye] Source: $resolvedBackup"
& pg_restore @args
if ($LASTEXITCODE -ne 0) {
  throw "pg_restore failed with exit code $LASTEXITCODE"
}

Write-Host "[hawk-eye] Restore completed."
exit 0
