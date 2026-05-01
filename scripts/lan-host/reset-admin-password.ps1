# reset-admin-password.ps1
#
# Hawk Eye — LAN admin password reset.
#
# Run on the host PC (the one running api-server + Postgres) when an
# operator forgets a password. Writes a fresh bcrypt hash directly into
# `lan_users` via psql. Never sends anything over the network.
#
# Requires:
#   - Postgres `psql.exe` on PATH (or pass -PsqlPath).
#   - Node.js installed (used to compute the bcrypt hash).
#   - DATABASE_URL exported in the current PowerShell session, OR pass
#     -DatabaseUrl explicitly.
#
# Usage:
#   .\reset-admin-password.ps1 -Username "ops1"
#   .\reset-admin-password.ps1 -Username "ops1" -DatabaseUrl "postgresql://..."

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$Username,

    [string]$DatabaseUrl = $env:DATABASE_URL,

    [string]$PsqlPath = "psql.exe"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    Write-Error "DATABASE_URL not set. Export it or pass -DatabaseUrl."
    exit 2
}

# Validate the username up-front. We only ever interpolate it after this
# regex check; bind params would be safer but psql --command does not
# support them, so the input is restricted to a strict character set
# instead of doubling single-quotes (which is brittle in PowerShell).
if ($Username -notmatch '^[A-Za-z0-9_.\-]{1,64}$') {
    Write-Error "Refusing to use username '$Username' — must match ^[A-Za-z0-9_.-]{1,64}$ (no spaces, no quotes, no SQL metacharacters)."
    exit 2
}

# Locate the project root (this script lives in scripts/lan-host/).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")

# Confirm the user actually exists before prompting for a new password.
$checkSql = "select count(*) from lan_users where lower(username) = lower('$Username');"
$exists = & $PsqlPath $DatabaseUrl -A -t -c $checkSql 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "psql query failed: $exists"
    exit 3
}
if ([int]$exists.Trim() -eq 0) {
    Write-Error "No lan_users row with username '$Username'. Aborting."
    exit 4
}

# Prompt for the new password (silently). Re-prompt to confirm.
$pwd1 = Read-Host -AsSecureString "Enter new password for $Username"
$pwd2 = Read-Host -AsSecureString "Confirm new password"

$bstr1 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwd1)
$plain1 = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr1)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr1)

$bstr2 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwd2)
$plain2 = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr2)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr2)

if ($plain1 -ne $plain2) {
    Write-Error "Passwords do not match. Aborting."
    exit 5
}
if ($plain1.Length -lt 8) {
    Write-Error "Password must be at least 8 characters. Aborting."
    exit 6
}

# Use the api-server's bcrypt module via a tiny inline node script so we
# don't have to install bcryptjs globally.
$nodeProg = @"
const bcrypt = require(process.argv[2]);
const pw = process.argv[3];
bcrypt.hash(pw, 12).then(h => { process.stdout.write(h); }).catch(e => { console.error(e); process.exit(1); });
"@

# Resolve bcryptjs from the api-server workspace.
$bcryptModule = Join-Path $RepoRoot "node_modules\bcryptjs"
if (-not (Test-Path $bcryptModule)) {
    Write-Error "bcryptjs not found at $bcryptModule. Run 'pnpm install' first."
    exit 7
}

$tempJs = New-TemporaryFile
Rename-Item $tempJs.FullName ($tempJs.FullName + ".js") -Force
$tempJs = Get-Item ($tempJs.FullName + ".js")
$nodeProg | Out-File -FilePath $tempJs.FullName -Encoding ASCII

try {
    $hash = & node $tempJs.FullName $bcryptModule $plain1
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($hash)) {
        Write-Error "Failed to compute bcrypt hash."
        exit 8
    }
} finally {
    Remove-Item $tempJs.FullName -ErrorAction SilentlyContinue
}

# Update the row. Quote-escape via dollar-quoted literal to avoid any
# bcrypt-character collision with single-quote.
$updateSql = "update lan_users set password_hash = `$pwd_reset_tag`$$hash`$pwd_reset_tag`$ where lower(username) = lower('$Username');"
$updateSql = $updateSql.Replace('$pwd_reset_tag', '$pwd_reset_tag')

# Safer: write SQL to a temp file and feed via -f.
$sqlFile = New-TemporaryFile
@"
update lan_users
set password_hash = `$pwd`$$hash`$pwd`$
where lower(username) = lower('$Username');

insert into audit_log (occurred_at, actor, type, detail)
values (now(), 'host_script', 'lan_password_reset',
        jsonb_build_object('username', '$Username', 'method', 'reset-admin-password.ps1', 'actor_unknown', true));
"@ | Out-File -FilePath $sqlFile.FullName -Encoding ASCII

try {
    $result = & $PsqlPath $DatabaseUrl -f $sqlFile.FullName 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "psql update failed: $result"
        exit 9
    }
} finally {
    Remove-Item $sqlFile.FullName -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "OK. Password for '$Username' has been reset." -ForegroundColor Green
Write-Host "An audit_log row was written under actor='host_script'." -ForegroundColor Green
Write-Host "The user should sign in with the new password and pick a personal one inside the app." -ForegroundColor Yellow
