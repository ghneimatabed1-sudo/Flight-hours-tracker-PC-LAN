# install-hub.ps1
#
# Shim invoked by the Inno Setup installer's [Run] section for the
# "Operation Pilot PC (Squadron Hub)" role. Translates the wizard's
# parameters into the form first-time-setup.ps1 expects, then pipes
# the captured passwords into the inner script via stdin so the
# operator never sees a console password prompt.
#
# Inputs (from Inno Setup):
#   -RepoRoot         absolute path the installer extracted the repo to ({app})
#   -SquadronName     1-15 chars, letters/digits/hyphen, validated by the wizard
#   -AdminUsername    first super_admin username (validated by the wizard)
#   -CredentialFile   absolute path to a UTF-8 file with two lines:
#                       line 1: Postgres superuser password
#                       line 2: first super_admin password
#                     The shim deletes the file after reading it (best-effort)
#                     so secrets do not linger in {tmp} after install. The
#                     installer also wipes {tmp} on exit.
#   -EnableMdns       optional switch — passed straight through
#   -LogFile          absolute path where stdout/stderr go ({app}\install-log.txt)
#
# We deliberately do NOT accept passwords on the command line: process
# command-lines are visible to other admin processes and can leak into
# Inno Setup's own setup log when SetupLogging=yes.
#
# Exit code propagates from first-time-setup.ps1. The Inno Setup [Run]
# entry uses Flags: waituntilterminated so the wizard waits for us.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string] $RepoRoot,
    [Parameter(Mandatory=$true)] [string] $SquadronName,
    [Parameter(Mandatory=$true)] [string] $AdminUsername,
    [Parameter(Mandatory=$true)] [string] $CredentialFile,
    [switch] $EnableMdns,
    [Parameter(Mandatory=$true)] [string] $LogFile
)

$ErrorActionPreference = "Stop"

# Make the bundled portable Node + pnpm visible to the inner script.
$nodeDir = Join-Path $RepoRoot ".runtime\node"
$pnpmDir = Join-Path $RepoRoot ".runtime\pnpm"
if (Test-Path $nodeDir) { $env:PATH = "$nodeDir;$pnpmDir;$env:PATH" }

# Append everything to the install log so a failed install leaves a
# breadcrumb the operator can copy/paste to support.
$started = "[$(Get-Date -Format o)] install-hub.ps1 starting (squadron='$SquadronName', mdns=$($EnableMdns.IsPresent))"
Add-Content -Path $LogFile -Value $started
Write-Host $started

if (-not (Test-Path $CredentialFile)) {
    $msg = "[FAIL] credential file not found at $CredentialFile"
    Add-Content -Path $LogFile -Value $msg
    Write-Error $msg
    exit 3
}

# Read the secrets file as UTF-8 then erase it from disk. The wizard
# placed it under {tmp} which Setup wipes on exit, but we wipe it
# proactively here so it is gone the moment we no longer need it.
$creds = Get-Content -Path $CredentialFile -Encoding UTF8
if ($creds.Count -lt 2) {
    Add-Content -Path $LogFile -Value "[FAIL] credential file at $CredentialFile is malformed (expected >=2 lines)"
    Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue
    exit 4
}
$pgPassword    = $creds[0]
$adminPassword = $creds[1]
# Best-effort overwrite-then-delete. NTFS may keep an old extent until
# the next defrag, but {tmp} is in the elevated admin's user-private
# %TEMP% directory and Setup also deletes the whole tree at exit.
try { Set-Content -Path $CredentialFile -Value '0000000000000000' -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue

$inner = Join-Path $RepoRoot "scripts\lan-host\first-time-setup.ps1"
if (-not (Test-Path $inner)) {
    $msg = "[FAIL] first-time-setup.ps1 not found at $inner"
    Add-Content -Path $LogFile -Value $msg
    Write-Error $msg
    exit 2
}

# first-time-setup.ps1 prompts (in order) for:
#   1. Postgres superuser password   (Read-Host -AsSecureString)
#   2. First super_admin username    (Read-Host)
#   3. Password for '<user>'         (Read-Host -AsSecureString)
# It does NOT ask for confirmation — the installer wizard already did.
#
# When stdin is redirected, PowerShell's Read-Host (including
# -AsSecureString) reads one line per call from the redirected stream.
# We append a trailing CRLF so the final Read-Host (admin password) sees
# a terminated line — without it the third Read-Host can hang waiting
# for EOL on the last unterminated record. Force UTF-8 on the outgoing
# stream so non-ASCII characters in either password (postgres allows
# them, and operators sometimes use them) survive the pipe instead of
# being silently mangled by the host's current code page.
$stdin = (@($pgPassword, $AdminUsername, $adminPassword) -join "`r`n") + "`r`n"
$prevOutputEncoding = [Console]::OutputEncoding
$prevPwshOutputEncoding = $OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$mdnsArg = if ($EnableMdns) { "-EnableMdns" } else { "" }

# Build the inner command-line carefully — single-quote SquadronName so
# PowerShell treats it as a literal. The wizard validated it against
# ^[A-Za-z0-9-]{1,15}$ already, so single-quoting is safe.
$cmd = "& '$inner' -SquadronName '$SquadronName' $mdnsArg"

# Run the inner script with stdin redirected. Tee output to the log file.
$tempOut = [System.IO.Path]::GetTempFileName()
try {
    $stdin | & powershell.exe -ExecutionPolicy Bypass -NoProfile -Command $cmd 2>&1 |
        Tee-Object -FilePath $tempOut -Append
    $code = $LASTEXITCODE
    Get-Content $tempOut | Add-Content -Path $LogFile
    if ($code -ne 0) {
        Add-Content -Path $LogFile -Value "[FAIL] first-time-setup.ps1 exited with code $code"
        exit $code
    }
} finally {
    Remove-Item -Path $tempOut -ErrorAction SilentlyContinue
    [Console]::OutputEncoding = $prevOutputEncoding
    $OutputEncoding = $prevPwshOutputEncoding
}

# Drop a tiny launcher next to the dashboard so the Start Menu shortcut
# can open it without hard-coding the port (which lives in the
# generated .env files).
$openCmd = Join-Path $RepoRoot "installer\open-dashboard.cmd"
$dashEnv = Join-Path $RepoRoot "artifacts\pilot-dashboard\.env.production.local"
$apiEnv  = Join-Path $RepoRoot "artifacts\api-server\.env"
$openBody = @"
@echo off
rem Auto-generated by Hawk Eye installer. Opens the dashboard in the default browser.
rem Reads VITE_INTERNAL_API_URL or PORT from the .env files.
setlocal
set DASH_PORT=5173
if exist "$dashEnv" (
    for /f "tokens=2 delims==" %%P in ('findstr /b /c:"VITE_DASHBOARD_PORT=" "$dashEnv"') do set DASH_PORT=%%P
)
start "" http://127.0.0.1:%DASH_PORT%/
endlocal
"@
Set-Content -Path $openCmd -Value $openBody -Encoding ASCII

Add-Content -Path $LogFile -Value "[$(Get-Date -Format o)] install-hub.ps1 finished OK"
exit 0
