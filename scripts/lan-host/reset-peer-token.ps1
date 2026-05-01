# reset-peer-token.ps1
#
# Hawk Eye — re-issue the squadron hub's peer access token.
#
# Mirrors `reset-admin-password.ps1`: run on the host PC when the
# initial peer token (printed once by `first-time-setup.ps1`) has been
# lost, or when the operator wants to rotate the token without going
# through the dashboard. Mints a fresh peer access token via the
# api-server's internal CRUD endpoint, prints it once with copy-paste
# instructions, and rewrites the secured token file under
# `%PROGRAMDATA%\HawkEye\peer-token-initial.txt`.
#
# This is a thin wrapper around the same /api/internal/peer-tokens
# endpoint the dashboard uses; it just authenticates as a super_admin
# from a PowerShell prompt instead of from a browser.
#
# The api-server must already be running (the auto-start scheduled
# task installed by first-time-setup.ps1 takes care of this on boot).
# DATABASE_URL is not consulted here — this script talks HTTP to the
# api-server, not directly to Postgres.
#
# Usage:
#   .\reset-peer-token.ps1 -Username "superadmin"
#   .\reset-peer-token.ps1 -Username "superadmin" -ApiBaseUrl http://127.0.0.1:3847
#   .\reset-peer-token.ps1 -Username "superadmin" -Label "tigers-hub regenerated"

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Username,

    [string]$ApiBaseUrl = "",
    [string]$Label = "",
    [string]$Scope = "squadron-read"
)

$ErrorActionPreference = "Stop"

if ($Username -notmatch '^[A-Za-z0-9_.\-]{1,64}$') {
    Write-Error "Refusing to use username '$Username' — must match ^[A-Za-z0-9_.-]{1,64}$ (no spaces, no quotes, no SQL metacharacters)."
    exit 2
}
if ($Scope -notmatch '^[A-Za-z0-9_.\-:]{1,64}$') {
    Write-Error "Refusing to use scope '$Scope' — must match ^[A-Za-z0-9_.-:]{1,64}$."
    exit 2
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")

# Resolve the api-server base URL from the .env file when not passed
# explicitly so this script picks up whatever PORT first-time-setup.ps1
# wrote (default 3847).
$apiPortFromEnv = "3847"
$squadronFromEnv = ""
$envPath = Join-Path $RepoRoot "artifacts\api-server\.env"
if (Test-Path $envPath) {
    Get-Content -Path $envPath | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $parts = $line -split "=", 2
        if ($parts.Count -ne 2) { return }
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($key -eq "PORT")          { $apiPortFromEnv = $value }
        if ($key -eq "SQUADRON_NAME") { $squadronFromEnv = $value }
    }
}

if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
    $ApiBaseUrl = "http://127.0.0.1:$apiPortFromEnv"
}
$ApiBaseUrl = $ApiBaseUrl.TrimEnd("/")

if ([string]::IsNullOrWhiteSpace($Label)) {
    if ([string]::IsNullOrWhiteSpace($squadronFromEnv)) {
        $Label = "regenerated peer token $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    } else {
        $Label = "$squadronFromEnv regenerated peer token $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    }
}
if ($Label.Length -gt 200) {
    Write-Error "Label too long (max 200 chars)."
    exit 2
}

# Confirm the api-server is reachable before prompting for a password.
try {
    $h = Invoke-WebRequest -Uri "$ApiBaseUrl/api/healthz" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    if ($h.StatusCode -ne 200) {
        Write-Error "api-server health check at $ApiBaseUrl/api/healthz returned $($h.StatusCode)."
        exit 3
    }
} catch {
    Write-Error "Cannot reach api-server at $ApiBaseUrl. Is it running? Try: schtasks /Run /TN HawkEye-ApiServer-OnStartup"
    exit 3
}

$pwd1 = Read-Host -AsSecureString "Password for super_admin '$Username'"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwd1)
$plainPw = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

if ([string]::IsNullOrWhiteSpace($plainPw) -or $plainPw.Length -lt 8) {
    Write-Error "Password must be at least 8 characters."
    exit 4
}

$loginBody = @{ username = $Username; password = $plainPw } | ConvertTo-Json -Compress
$loginResp = $null
try {
    $loginResp = Invoke-RestMethod -Method Post `
        -Uri "$ApiBaseUrl/api/internal/auth/lan/login" `
        -ContentType "application/json" `
        -Body $loginBody `
        -TimeoutSec 10
} catch {
    Write-Error "Login as '$Username' failed: $_"
    exit 5
}
$plainPw = $null

if (-not $loginResp -or -not $loginResp.token) {
    Write-Error "Login response did not include a session token."
    exit 5
}
$sessionTok = [string]$loginResp.token
$role = if ($loginResp.user -and $loginResp.user.role) { [string]$loginResp.user.role } else { "" }
if ($role -ne "super_admin") {
    Write-Error "User '$Username' is not a super_admin (role='$role'). Only super_admin may issue peer tokens."
    # Best-effort logout.
    try {
        Invoke-RestMethod -Method Post `
            -Uri "$ApiBaseUrl/api/internal/auth/lan/logout" `
            -Headers @{ "x-hawk-lan-session" = $sessionTok } `
            -ContentType "application/json" `
            -Body "{}" `
            -TimeoutSec 5 | Out-Null
    } catch { }
    exit 6
}

$createBody = @{ name = $Label; scope = $Scope } | ConvertTo-Json -Compress
$createResp = $null
try {
    $createResp = Invoke-RestMethod -Method Post `
        -Uri "$ApiBaseUrl/api/internal/peer-tokens" `
        -ContentType "application/json" `
        -Headers @{ "x-hawk-lan-session" = $sessionTok } `
        -Body $createBody `
        -TimeoutSec 10
} catch {
    Write-Error "Peer token create failed: $_"
    exit 7
} finally {
    # Always tear down the session, even on success.
    try {
        Invoke-RestMethod -Method Post `
            -Uri "$ApiBaseUrl/api/internal/auth/lan/logout" `
            -Headers @{ "x-hawk-lan-session" = $sessionTok } `
            -ContentType "application/json" `
            -Body "{}" `
            -TimeoutSec 5 | Out-Null
    } catch { }
}

if (-not $createResp -or -not $createResp.token) {
    Write-Error "Peer token create response did not include a token."
    exit 7
}

$plainPeer = [string]$createResp.token
$tokenId = if ($createResp.row -and $createResp.row.id) { [string]$createResp.row.id } else { "" }

$tokenDir = Join-Path $env:ProgramData "HawkEye"
if (-not (Test-Path $tokenDir)) {
    New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null
}
$tokenFile = Join-Path $tokenDir "peer-token-initial.txt"
$stamp = Get-Date -Format o
$squadronLabel = if ([string]::IsNullOrWhiteSpace($squadronFromEnv)) { "(squadron name unknown)" } else { $squadronFromEnv }
@"
# Hawk Eye — peer access token for squadron '$squadronLabel'.
# Issued: $stamp
# Issued by: $Username (super_admin) via reset-peer-token.ps1
# Token id: $tokenId
# Label: $Label
# Scope: $Scope
#
# Paste the line below on the Wing Commander PC when adding squadron
# '$squadronLabel'. Treat it like a password — anyone with this token
# can read this hub's data over the LAN.
#
# Any earlier peer tokens remain valid until you revoke them from the
# dashboard (Admin → Peer Tokens once that page exists, or by deleting
# the row directly through /api/internal/peer-tokens DELETE).

$plainPeer
"@ | Out-File -FilePath $tokenFile -Encoding ASCII

try {
    & icacls $tokenFile /inheritance:r 2>&1 | Out-Null
    & icacls $tokenFile /grant:r "BUILTIN\Administrators:(F)" "NT AUTHORITY\SYSTEM:(F)" 2>&1 | Out-Null
} catch {
    Write-Warning "Could not tighten ACL on $tokenFile : $_. Verify permissions manually."
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  NEW PEER ACCESS TOKEN for squadron '$squadronLabel'" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  $plainPeer" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Copy this token now. On the Wing Commander PC, paste it" -ForegroundColor Green
Write-Host "  when adding squadron '$squadronLabel'." -ForegroundColor Green
Write-Host ""
Write-Host "  This token is shown ONCE. A copy has been written to:" -ForegroundColor Green
Write-Host "    $tokenFile" -ForegroundColor Green
Write-Host "  (Local Administrators only.)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

exit 0
