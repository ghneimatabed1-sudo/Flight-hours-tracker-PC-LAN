# install-aggregator.ps1
#
# Shim invoked by the Inno Setup installer's [Run] section for both
# Wing Commander and Base Commander PCs. Translates the wizard's
# parameters into the form aggregator-first-time-setup.ps1 expects
# and pipes captured passwords in via stdin.
#
# Inputs (from Inno Setup):
#   -RepoRoot         absolute path of the extracted repo ({app})
#   -Role             "wing" or "base"
#   -AggregatorName   1-15 chars, letters/digits/hyphen — becomes the
#                     Windows computer name and the LAN hostname
#                     (passed straight through as -AggregatorName so the
#                     inner script never falls back to its interactive
#                     hostname prompt)
#   -AdminUsername    first super_admin username
#   -CredentialFile   absolute path to a UTF-8 file with two lines:
#                       line 1: Postgres superuser password
#                       line 2: first super_admin password
#                     Wiped immediately after the shim reads it.
#   -LogFile          absolute path to install-log.txt
#
# We deliberately do NOT accept passwords on the command line. Inno
# Setup's SetupLogging=yes can capture process command lines.
#
# After the inner script finishes, the operator can add squadron
# hubs from the dashboard's Address Book or via add-squadron-peer.ps1
# (the existing scripts/lan-host helper). Discovery is intentionally
# skipped here so the installer does not block on multicast traffic.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string] $RepoRoot,
    [Parameter(Mandatory=$true)] [ValidateSet("wing","base")] [string] $Role,
    [Parameter(Mandatory=$true)] [string] $AggregatorName,
    [Parameter(Mandatory=$true)] [string] $AdminUsername,
    [Parameter(Mandatory=$true)] [string] $CredentialFile,
    [Parameter(Mandatory=$true)] [string] $LogFile
)

$ErrorActionPreference = "Stop"

$nodeDir = Join-Path $RepoRoot ".runtime\node"
$pnpmDir = Join-Path $RepoRoot ".runtime\pnpm"
if (Test-Path $nodeDir) { $env:PATH = "$nodeDir;$pnpmDir;$env:PATH" }

$started = "[$(Get-Date -Format o)] install-aggregator.ps1 starting (role='$Role', aggregator='$AggregatorName')"
Add-Content -Path $LogFile -Value $started
Write-Host $started

if (-not (Test-Path $CredentialFile)) {
    $msg = "[FAIL] credential file not found at $CredentialFile"
    Add-Content -Path $LogFile -Value $msg
    Write-Error $msg
    exit 3
}

$creds = Get-Content -Path $CredentialFile -Encoding UTF8
if ($creds.Count -lt 2) {
    Add-Content -Path $LogFile -Value "[FAIL] credential file at $CredentialFile is malformed (expected >=2 lines)"
    Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue
    exit 4
}
$pgPassword    = $creds[0]
$adminPassword = $creds[1]
try { Set-Content -Path $CredentialFile -Value '0000000000000000' -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
Remove-Item -Path $CredentialFile -Force -ErrorAction SilentlyContinue

$inner = Join-Path $RepoRoot "scripts\lan-host\aggregator-first-time-setup.ps1"
if (-not (Test-Path $inner)) {
    $msg = "[FAIL] aggregator-first-time-setup.ps1 not found at $inner"
    Add-Content -Path $LogFile -Value $msg
    Write-Error $msg
    exit 2
}

# aggregator-first-time-setup.ps1 prompt order WITH -Role and
# -AggregatorName supplied (so the role + hostname interactive
# prompts are skipped):
#   1. Postgres superuser password (Read-Host -AsSecureString)
#   2. First super_admin username  (Read-Host)
#   3. Password for '<user>'       (Read-Host -AsSecureString)
# Trailing CRLF terminates the third Read-Host line; UTF-8 stream
# encoding stops non-ASCII passwords from being garbled across the
# pipe. Same hardening as install-hub.ps1.
$stdin = (@($pgPassword, $AdminUsername, $adminPassword) -join "`r`n") + "`r`n"
$prevOutputEncoding = [Console]::OutputEncoding
$prevPwshOutputEncoding = $OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# -SkipDiscovery: the installer is non-interactive; let the operator
# add peers from the dashboard or with add-squadron-peer.ps1 afterwards.
# AggregatorName was wizard-validated against the same allow-list the
# inner script enforces, so single-quoting is safe.
$cmd = "& '$inner' -Role '$Role' -AggregatorName '$AggregatorName' -SkipDiscovery"

$tempOut = [System.IO.Path]::GetTempFileName()
try {
    $stdin | & powershell.exe -ExecutionPolicy Bypass -NoProfile -Command $cmd 2>&1 |
        Tee-Object -FilePath $tempOut -Append
    $code = $LASTEXITCODE
    Get-Content $tempOut | Add-Content -Path $LogFile
    if ($code -ne 0) {
        Add-Content -Path $LogFile -Value "[FAIL] aggregator-first-time-setup.ps1 exited with code $code"
        exit $code
    }
} finally {
    Remove-Item -Path $tempOut -ErrorAction SilentlyContinue
    [Console]::OutputEncoding = $prevOutputEncoding
    $OutputEncoding = $prevPwshOutputEncoding
}

$openCmd = Join-Path $RepoRoot "installer\open-dashboard.cmd"
$openBody = @"
@echo off
rem Auto-generated by Hawk Eye installer. Opens the aggregator dashboard.
start "" http://127.0.0.1:5173/
"@
Set-Content -Path $openCmd -Value $openBody -Encoding ASCII

Add-Content -Path $LogFile -Value "[$(Get-Date -Format o)] install-aggregator.ps1 finished OK"
exit 0
