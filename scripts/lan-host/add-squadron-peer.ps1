# add-squadron-peer.ps1
#
# Hawk Eye — add a new squadron hub to the aggregator address book.
#
# Use on a Wing or Base Commander PC (one set up by setup-aggregator.ps1)
# when a new squadron stands up after the initial install. Wraps the
# same address-book CRUD setup-aggregator.ps1 uses, minus the rest of
# the install. Same validation. Same audit log entry.
#
# This script does NOT touch INSTALL_PROFILE, .env, lan_users, the
# api-server build, or the scheduled tasks. It only inserts one row
# into peer_squadrons + one row into audit_log, in a single transaction.
#
# Usage:
#   .\add-squadron-peer.ps1 -DisplayName "Eagles" -Address "eagles-hub.local"
#       -Token "<paste-from-hub>"
#
# All three -DisplayName / -Address / -Token are required and will be
# prompted for if omitted. -Address may include `:port`. -SquadronId
# defaults to a slug of the display name.

[CmdletBinding()]
param(
    [string]$DisplayName = "",
    [string]$Address     = "",
    [int]   $Port        = 3847,
    [string]$Token       = "",
    [string]$SquadronId  = "",
    [string]$DbName      = "hawkeye_aggregator",
    [string]$DbUser      = "postgres",
    [string]$DbHost      = "127.0.0.1",
    [int]   $DbPort      = 5432,
    [string]$DatabaseUrl = "",
    [string]$PsqlPath    = "psql.exe"
)

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "       $msg" }
function Warn($msg) { Write-Host "       [WARN] $msg" -ForegroundColor Yellow }
function Fail($msg, $code) {
    Write-Host ""
    Write-Host "[FAIL] $msg" -ForegroundColor Red
    exit $code
}

function Resolve-RepoRoot {
    $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
        $PSScriptRoot
    } else {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

function Test-HostnameOrIp {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return $Value -match '^[A-Za-z0-9._\-:]{1,253}$'
}

function Slugify {
    param([string]$Name)
    $s = ($Name.Trim().ToLower() -replace '[^a-z0-9]+','-').Trim('-')
    if (-not $s) { $s = "squadron-" + [Guid]::NewGuid().ToString("N").Substring(0,8) }
    return $s
}

# ── Read DATABASE_URL from .env if not provided ──────────────────────
# Prefer (a) -DatabaseUrl, (b) $env:DATABASE_URL, (c) parse from the
# canonical artifacts/api-server/.env. Falling back to .env keeps the
# helper one-line callable from the operator runbook ("just run the
# script").
$RepoRoot = Resolve-RepoRoot
if (-not $DatabaseUrl) { $DatabaseUrl = $env:DATABASE_URL }
if (-not $DatabaseUrl) {
    $apiEnv = Join-Path $RepoRoot "artifacts\api-server\.env"
    if (Test-Path $apiEnv) {
        foreach ($line in Get-Content $apiEnv) {
            $trim = $line.Trim()
            if ($trim -eq "" -or $trim.StartsWith("#")) { continue }
            $parts = $trim -split "=", 2
            if ($parts.Count -ne 2) { continue }
            if ($parts[0].Trim() -eq "DATABASE_URL") {
                $DatabaseUrl = $parts[1].Trim().Trim('"')
                break
            }
        }
    }
}
if (-not $DatabaseUrl) {
    # Last-ditch: build from the explicit DB params if the operator
    # passed them all. Otherwise abort so we don't connect to the wrong
    # database.
    if ($DbName -and $DbUser -and $DbHost -and $DbPort) {
        $pgPwSecure = Read-Host -AsSecureString "Postgres password for '$DbUser' (DATABASE_URL not found in .env)"
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPwSecure)
        $plainPg = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        # URL-encode the password — squadron-shared postgres passwords
        # routinely contain `@`, `:`, `#`, `?`, `%` etc. which are
        # reserved in URI userinfo and silently break the connection
        # when interpolated raw. Same fix as setup-aggregator.ps1.
        $encPg = [uri]::EscapeDataString($plainPg)
        $DatabaseUrl = "postgresql://$DbUser`:$encPg`@$DbHost`:$DbPort/$DbName"
    } else {
        Fail "DATABASE_URL not set, and artifacts/api-server/.env does not contain one. Pass -DatabaseUrl explicitly." 60
    }
}

Write-Host ""
Write-Host "Hawk Eye — add squadron peer to aggregator address book" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

# ── Collect inputs ────────────────────────────────────────────────────
if (-not $DisplayName) { $DisplayName = (Read-Host "Display name (e.g. Eagles)").Trim() }
if (-not $DisplayName) { Fail "Display name is required." 61 }

if (-not $Address) { $Address = (Read-Host "Hostname or IP (e.g. eagles-hub.local)").Trim() }
if ($Address -match '^(?<host>[^:]+):(?<port>\d+)$') {
    $Address = $matches['host']
    $Port    = [int]$matches['port']
}
if (-not (Test-HostnameOrIp $Address)) { Fail "Invalid address '$Address'." 62 }
if ($Port -lt 1 -or $Port -gt 65535) { Fail "Port '$Port' out of range." 62 }

if (-not $Token) {
    $sec = Read-Host -AsSecureString "Peer access token (paste from the hub)"
    $b   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
}
if ([string]::IsNullOrWhiteSpace($Token)) { Fail "Token is required." 63 }

if (-not $SquadronId) { $SquadronId = Slugify $DisplayName }

Info "Display name : $DisplayName"
Info "Address      : ${Address}:$Port"
Info "Squadron id  : $SquadronId"
Info "Database     : $($DatabaseUrl -replace '://[^@]+@','://*****@')"

# ── Compute SHA-256 token hash ───────────────────────────────────────
# Mirrors lib/peer-fanout.ts's hashPeerToken — the producer side
# (the squadron hub) compares against this hash. Keeping both columns
# in lock-step is what setup-aggregator.ps1 does, so we do the same
# here.
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($Token)
$sha256     = [System.Security.Cryptography.SHA256]::Create()
try {
    $hashBytes  = $sha256.ComputeHash($tokenBytes)
} finally {
    $sha256.Dispose()
}
$tokenHash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })

# ── Build SQL (escape single quotes for text literals) ───────────────
$escName       = $DisplayName -replace "'", "''"
$escSquadron   = $SquadronId  -replace "'", "''"
$escAddr       = $Address     -replace "'", "''"
$escToken      = $Token       -replace "'", "''"
$escTokenHash  = $tokenHash   -replace "'", "''"
$baseUrlPeer   = "http://${escAddr}:$Port"
$actor         = if ($env:USERNAME) { "add_squadron_peer:" + $env:USERNAME } else { "add_squadron_peer" }
$escActor      = $actor -replace "'", "''"

$sql = @"
begin;
insert into peer_squadrons (squadron_id, squadron_name, base_url, auth_token, token_hash, added_by)
values ('$escSquadron', '$escName', '$baseUrlPeer', '$escToken', '$escTokenHash', '$escActor')
returning id::text as id;
insert into audit_log (occurred_at, actor, type, detail)
values (now(), '$escActor', 'aggregate.peers.add',
        jsonb_build_object('squadron_id','$escSquadron','base_url','$baseUrlPeer','source','add_squadron_peer'));
commit;
"@

$sqlFile = New-TemporaryFile
$sql | Out-File -FilePath $sqlFile.FullName -Encoding ASCII

Write-Host ""
Write-Host "Inserting into peer_squadrons (transaction)..." -ForegroundColor Cyan
& $PsqlPath $DatabaseUrl -v ON_ERROR_STOP=1 -f $sqlFile.FullName
$rc = $LASTEXITCODE
Remove-Item $sqlFile.FullName -ErrorAction SilentlyContinue

if ($rc -ne 0) {
    # Most likely cause: the unique index on (squadron_id) where
    # removed_at is null — that means a hub with this slug already
    # exists. Tell the operator how to recover.
    Fail "psql exit $rc. If this is a duplicate squadron_id, either pass -SquadronId <unique> or use the address-book API (PATCH /api/aggregate/peers/:id) to update the existing entry." 64
}

Write-Host ""
Write-Host "DONE. '$DisplayName' is now in the address book." -ForegroundColor Green
Write-Host "  squadron_id : $SquadronId"
Write-Host "  base_url    : $baseUrlPeer"
Write-Host ""
Write-Host "Verify it's reachable:"
Write-Host "  Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3847/api/aggregate/peers/health'"
exit 0
