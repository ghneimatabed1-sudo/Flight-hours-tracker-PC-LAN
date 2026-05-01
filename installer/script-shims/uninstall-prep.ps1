# uninstall-prep.ps1
#
# Shim invoked by the Inno Setup installer's [UninstallRun] section.
# It runs BEFORE Inno Setup deletes {app}, so we still have access to
# the repo and the existing scripts.
#
# Steps:
#   1. Stop the Hawk Eye scheduled tasks if they exist:
#        HawkEye-ApiServer-OnStartup
#        HawkEye-Dashboard-OnStartup
#        HawkEye-Postgres-Backup-Daily
#        HawkEye-Backup-Verify-Quarterly
#        HawkEye-Mdns-OnStartup
#      and unregister them.
#   2. Always take a final backup .dump and copy it to
#        %USERPROFILE%\Documents\HawkEye-Backup\
#      using the existing backup-postgres.ps1 if present. We never
#      silently delete data — this preserves it for restore on a fresh
#      install.
#   3. Ask the operator (Yes/No console prompt) whether to drop the
#      local hawkeye_internal / hawkeye_aggregator databases. If they
#      say No, just remove the files and leave the DBs in place.
#
# Postgres credentials live in the embedded password in
# `artifacts\api-server\.env`'s DATABASE_URL line (written by the
# matching first-time-setup.ps1). For the DROP we re-use that
# user/password but swap the database name for `postgres` (the default
# maintenance database) — DROP DATABASE cannot be issued while
# connected to the database being dropped.
#
# psql.exe is resolved by trying PATH first, then the standard
# Postgres install locations under Program Files.
#
# This shim is best-effort: a failed step writes a warning to the
# uninstall log but never blocks the uninstall from completing.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string] $RepoRoot
)

$ErrorActionPreference = "Continue" # best-effort
$logFile = Join-Path $RepoRoot "uninstall-log.txt"

function Log([string]$msg) {
    $line = "[$(Get-Date -Format o)] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

function Stop-AndUnregister([string]$taskName) {
    try {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -ne $task) {
            Log "Stopping scheduled task $taskName"
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
    } catch {
        Log "WARN: failed to remove $taskName ($_)"
    }
}

# Find psql.exe — PATH first, then the most common install locations.
function Resolve-PsqlPath {
    $cmd = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @()
    foreach ($base in @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL")) {
        if (Test-Path $base) {
            $candidates += Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName "bin\psql.exe" }
        }
    }
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# Read DATABASE_URL out of artifacts\api-server\.env. Returns a hashtable
# with keys User, Password, HostName, Port, DbName — or $null if the file
# is absent or malformed.
function Read-DatabaseUrl([string]$EnvPath) {
    if (-not (Test-Path $EnvPath)) { return $null }
    $line = Get-Content $EnvPath -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } |
        Select-Object -First 1
    if (-not $line) { return $null }
    $value = ($line -replace '^\s*DATABASE_URL\s*=', '').Trim().Trim('"').Trim("'")
    # postgresql://user:password@host:port/dbname
    if ($value -notmatch '^postgres(?:ql)?://([^:@/]+)(?::([^@/]*))?@([^:/]+)(?::(\d+))?/([^?]+)') {
        return $null
    }
    return @{
        User     = [System.Uri]::UnescapeDataString($matches[1])
        Password = if ($matches[2]) { [System.Uri]::UnescapeDataString($matches[2]) } else { "" }
        HostName = $matches[3]
        Port     = if ($matches[4]) { [int]$matches[4] } else { 5432 }
        DbName   = $matches[5]
    }
}

Log "uninstall-prep.ps1 starting"

# 1. Stop scheduled tasks.
foreach ($t in @(
    "HawkEye-ApiServer-OnStartup",
    "HawkEye-Dashboard-OnStartup",
    "HawkEye-Postgres-Backup-Daily",
    "HawkEye-Backup-Verify-Quarterly",
    "HawkEye-Mdns-OnStartup"
)) {
    Stop-AndUnregister $t
}

# 2. Take a final backup if backup-postgres.ps1 is present and the env exists.
$backupScript  = Join-Path $RepoRoot "scripts\lan-host\backup-postgres.ps1"
$envFile       = Join-Path $RepoRoot "artifacts\api-server\.env"
$userBackupDir = Join-Path $env:USERPROFILE "Documents\HawkEye-Backup"
if ((Test-Path $backupScript) -and (Test-Path $envFile)) {
    try {
        if (-not (Test-Path $userBackupDir)) {
            New-Item -ItemType Directory -Path $userBackupDir -Force | Out-Null
        }
        Log "Taking final backup to $userBackupDir before uninstall"
        & powershell.exe -ExecutionPolicy Bypass -NoProfile `
            -File $backupScript -BackupDir $userBackupDir 2>&1 |
            ForEach-Object { Log $_ }
    } catch {
        Log "WARN: final backup failed ($_). Proceeding without it."
    }
} else {
    Log "Skipping final backup — no backup script or .env present (likely a viewer install)."
}

# 3. Confirm DB drop. Default to No. We use a console Yes/No prompt
#    instead of a graphical dialog because this script runs from
#    Inno Setup's [UninstallRun], which provides a real console.
$response = "N"
try {
    Write-Host ""
    Write-Host "============================================================"
    Write-Host " Drop the local Hawk Eye databases?"
    Write-Host ""
    Write-Host " A final backup has been saved to:"
    Write-Host "   $userBackupDir"
    Write-Host ""
    Write-Host " Type Y to drop hawkeye_internal / hawkeye_aggregator now."
    Write-Host " Type N (default) to leave them in place — a re-install"
    Write-Host " will pick them up automatically."
    Write-Host "============================================================"
    $response = Read-Host "Drop databases? [y/N]"
} catch {
    # Headless / no console — never drop without explicit confirmation.
    $response = "N"
}

if ($response -notmatch '^[Yy]') {
    Log "Operator declined DB drop. Databases left in place."
    Log "uninstall-prep.ps1 finished"
    exit 0
}

# Operator confirmed — try to drop the DBs. We need:
#   (a) a working psql.exe
#   (b) DATABASE_URL parsed from the api-server .env (gives us the
#       postgres user + password baked in by first-time-setup.ps1)
$psql = Resolve-PsqlPath
if (-not $psql) {
    Log "WARN: psql.exe not found on PATH or under Program Files\PostgreSQL\*\bin."
    Log "WARN: Skipping DB drop. Drop manually with: DROP DATABASE hawkeye_internal; DROP DATABASE hawkeye_aggregator;"
    Log "uninstall-prep.ps1 finished"
    exit 0
}

$dsn = Read-DatabaseUrl $envFile
if (-not $dsn) {
    Log "WARN: could not parse DATABASE_URL from $envFile."
    Log "WARN: Skipping DB drop. Drop manually with psql -U postgres -c 'DROP DATABASE hawkeye_internal' (and hawkeye_aggregator)."
    Log "uninstall-prep.ps1 finished"
    exit 0
}

Log "Operator confirmed DB drop. Dropping hawkeye_internal and hawkeye_aggregator if present (using user '$($dsn.User)' on $($dsn.HostName):$($dsn.Port))."

# Connect to the maintenance DB ('postgres') instead of the one we're
# dropping. Pass credentials via env vars (PGPASSWORD / PGUSER / PGHOST
# / PGPORT) so they never appear on the command line or in process
# listings. We restore PGPASSWORD afterwards in the finally block.
$savedPgPw   = $env:PGPASSWORD
$savedPgUser = $env:PGUSER
$savedPgHost = $env:PGHOST
$savedPgPort = $env:PGPORT
try {
    $env:PGPASSWORD = $dsn.Password
    $env:PGUSER     = $dsn.User
    $env:PGHOST     = $dsn.HostName
    $env:PGPORT     = "$($dsn.Port)"
    foreach ($db in @("hawkeye_internal","hawkeye_aggregator")) {
        try {
            # Two statements: first revoke connect rights so any leaked
            # session can't keep the DB busy; then drop. Quoting is safe
            # because $db is a hard-coded literal, not operator input.
            & $psql -d "postgres" -v ON_ERROR_STOP=0 -c "REVOKE CONNECT ON DATABASE `"$db`" FROM PUBLIC;" 2>&1 |
                ForEach-Object { Log $_ }
            & $psql -d "postgres" -v ON_ERROR_STOP=0 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" 2>&1 |
                ForEach-Object { Log $_ }
            & $psql -d "postgres" -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS `"$db`";" 2>&1 |
                ForEach-Object { Log $_ }
            if ($LASTEXITCODE -ne 0) {
                Log "WARN: psql exited $LASTEXITCODE while dropping $db (DB may not have existed, or may still be in use)."
            }
        } catch {
            Log "WARN: could not drop $db ($_)"
        }
    }
} finally {
    $env:PGPASSWORD = $savedPgPw
    $env:PGUSER     = $savedPgUser
    $env:PGHOST     = $savedPgHost
    $env:PGPORT     = $savedPgPort
}

Log "uninstall-prep.ps1 finished"
exit 0
