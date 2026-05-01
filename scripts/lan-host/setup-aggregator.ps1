# setup-aggregator.ps1
#
# Hawk Eye — Wing / Base Commander PC first-time install wizard.
#
# A Wing Commander or Base Commander PC is an *aggregator*. It runs the
# api-server in `aggregator-wing` or `aggregator-base` mode. That mode
# does NOT host squadron data (no `/api/internal/*` routes, no XPC
# inbound) — instead it fans out reads to one or more squadron hub PCs
# over the LAN via `/api/aggregate/*`.
#
# This script handles the install side end-to-end: pick the role, mint
# the local super_admin, seed the squadron-hub address book, write the
# api-server `.env` with the right `INSTALL_PROFILE`, point the local
# dashboard at the local aggregator, register scheduled tasks for both
# services, and run a self-check against `/api/aggregate/peers/health`.
#
# The fan-out server-side code, the dashboard's status panel UI, and
# the hub-side install changes are separate parallel tasks.
#
# Steps performed:
#   1. Validate args (role must be `wing` or `base`).
#   2. Optional `-AutoDiscover`: scan the LAN for `_hawkeye-hub._tcp`
#      via Bonjour `dns-sd.exe` and offer a pick-list. For each detected
#      hub the operator confirms (Y/N) and pastes that hub's token.
#   3. Manual entry loop: ask for display name (e.g. "Tigers"), hostname
#      or IP, and the peer access token. Loop until the operator says
#      "done". The list collected here will be seeded into the
#      `peer_squadrons` address book.
#   4. Verify Postgres is installed and reachable; install via winget if
#      not (same pattern as `first-time-setup.ps1`). The aggregator
#      needs a small local DB for the address book, lan_users,
#      audit_log, and the per-peer response cache.
#   5. Create the local Postgres DB.
#   6. Write `artifacts/api-server/.env` with `INSTALL_PROFILE=
#      aggregator-wing` (or `aggregator-base`), `DATABASE_URL`, `PORT`,
#      a fresh bootstrap token, and `HAWK_INTERNAL_SESSION_AUTH=required`.
#   7. Write `artifacts/pilot-dashboard/.env.production.local` with
#      `VITE_INTERNAL_API_URL=http://<host>:<port>` pointing at the
#      local aggregator. The dashboard adaptation task (separate) will
#      teach the dashboard how to consume `/api/aggregate/*`; for now we
#      just pin the base URL.
#   8. Build the api-server once, then boot it briefly via
#      `start-api-host.ps1 -SkipBuild` so the same env-loading code path
#      runs and `ensureFullSchema()` creates `peer_squadrons`,
#      `peer_cache`, `install_profile_meta`, `lan_users`, etc.
#   9. Mint the first super_admin in `lan_users` (bcrypt'd).
#  10. Seed `peer_squadrons` from the answers collected in steps 2/3,
#      inside a single transaction so a half-failed seed leaves nothing
#      committed.
#  11. Build the dashboard once and register both api-server +
#      dashboard scheduled tasks so they auto-start on boot.
#  12. Smoke verify `/api/aggregate/peers/health` returns 200 + the
#      configured peer count.
#
# Re-running on a partially-configured PC is safe-ish: every step
# checks before acting (the DB create, the env writes, the schema
# bootstrap, the scheduled-task registration) and the address-book
# seed uses `on conflict do nothing` so the same hub list won't dup.
#
# Run from an elevated PowerShell prompt (right-click → Run as
# Administrator). All log output goes to STDOUT and is also appended
# to `.\setup-aggregator.log` next to this script.

[CmdletBinding()]
param(
    [ValidateSet("wing","base","")]
    [string]$Role         = "",
    [string]$DbName       = "hawkeye_aggregator",
    [string]$DbUser       = "postgres",
    [string]$DbHost       = "127.0.0.1",
    [int]   $DbPort       = 5432,
    [string]$ApiPort      = "3847",
    [int]   $DashboardPort = 5173,
    [string]$LanHostName  = "127.0.0.1",
    [string]$AdminUser    = "",
    [string]$PsqlPath     = "psql.exe",
    [switch]$AutoDiscover,
    [switch]$SkipScheduledTasks,
    [switch]$SkipDashboardBuild,
    [switch]$SkipApiBuild,
    # Magic LAN auto-discovery: announce this PC on `_hawkeye._tcp`
    # with role=aggregator-{wing|base} so a Hub super_admin can spot
    # it in their pairing inbox / dashboard. Off by default (parity
    # with first-time-setup.ps1); pass on sites that allow multicast.
    [switch]$EnableMdns
)

$ErrorActionPreference = "Stop"

# ── Logging helpers ───────────────────────────────────────────────────
$ScriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$LogFile   = Join-Path $ScriptDir "setup-aggregator.log"

function Step($n, $msg) {
    $line = "[STEP $n] $msg"
    Write-Host ""
    Write-Host $line -ForegroundColor Cyan
    Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  $line"
}
function Info($msg) { Write-Host "       $msg"; Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  $msg" }
function Warn($msg) { Write-Host "       [WARN] $msg" -ForegroundColor Yellow; Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  WARN $msg" }
function Fail($msg, $code) {
    Write-Host ""
    Write-Host "[FAIL] $msg" -ForegroundColor Red
    Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  FAIL $msg"
    exit $code
}

Add-Content -Path $LogFile -Value ""
Add-Content -Path $LogFile -Value "=========================================================="
Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  setup-aggregator.ps1 started"
Add-Content -Path $LogFile -Value "=========================================================="

Write-Host ""
Write-Host "Hawk Eye — aggregator install (Wing / Base Commander PC)" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

# ── Step 1 — Resolve role ─────────────────────────────────────────────
Step 1 "Resolve PC role (wing | base)"
if (-not $Role) {
    $Role = (Read-Host "       What is this PC's role? Enter 'wing' or 'base'").Trim().ToLower()
}
if ($Role -notin @("wing","base")) {
    Fail "Role must be 'wing' or 'base' (got '$Role')." 40
}
$installProfile = "aggregator-$Role"
Info "Role: $Role -> INSTALL_PROFILE=$installProfile"

# Validate identifiers that flow into raw SQL or paths.
foreach ($pair in @(
    @{ Name = "DbName"; Value = $DbName },
    @{ Name = "DbUser"; Value = $DbUser },
    @{ Name = "DbHost"; Value = $DbHost },
    @{ Name = "LanHostName"; Value = $LanHostName },
    @{ Name = "ApiPort"; Value = $ApiPort }
)) {
    if ($pair.Value -notmatch '^[A-Za-z0-9_.\-]{1,128}$') {
        Fail "Refusing to use $($pair.Name)='$($pair.Value)' — must match ^[A-Za-z0-9_.-]{1,128}$" 41
    }
}
if ($DashboardPort -lt 1 -or $DashboardPort -gt 65535) {
    Fail "Refusing to use DashboardPort='$DashboardPort' — out of range." 41
}

# ── Step 2 — Local admin account ──────────────────────────────────────
Step 2 "Local admin account (the super_admin who manages the address book)"
if (-not $AdminUser) {
    $AdminUser = (Read-Host "       Local super_admin username").Trim()
}
if ($AdminUser -notmatch '^[A-Za-z0-9_.\-]{1,64}$') {
    Fail "Refusing to use admin username '$AdminUser' — must match ^[A-Za-z0-9_.-]{1,64}$" 42
}
$adminPwSecure = Read-Host -AsSecureString "       Password for '$AdminUser' (>=8 chars)"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPwSecure)
$plainAdmin = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if ($null -eq $plainAdmin -or $plainAdmin.Length -lt 8) {
    Fail "Admin password must be at least 8 characters." 43
}
Info "Captured local super_admin '$AdminUser' (password not echoed)."

# ── Step 3 — Squadron hubs (mDNS auto-discover + manual loop) ─────────
Step 3 "Squadron hubs to fan out to"

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

function Read-Token {
    param([string]$Prompt)
    $sec = Read-Host -AsSecureString $Prompt
    $b   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $tok = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($b)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
    return $tok
}

function Invoke-MdnsHubDiscovery {
    # Same approach setup-viewer.ps1 uses: spawn `dns-sd.exe -B
    # _hawkeye-hub._tcp local.` for a few seconds, parse the "Add"
    # lines out of stdout to get instance names. Falls through to
    # manual entry if Bonjour isn't installed.
    param([int]$TimeoutSeconds = 4)
    $dnsSd = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($null -eq $dnsSd) {
        Warn "dns-sd.exe not found (Bonjour Print Services for Windows not installed). Skipping auto-discover."
        return @()
    }
    Info "Browsing _hawkeye-hub._tcp on the LAN for $TimeoutSeconds seconds..."
    $tmp = New-TemporaryFile
    $proc = Start-Process -FilePath $dnsSd.Source `
        -ArgumentList "-B","_hawkeye-hub._tcp","local." `
        -RedirectStandardOutput $tmp.FullName `
        -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds $TimeoutSeconds
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    $instances = @()
    if (Test-Path $tmp.FullName) {
        foreach ($line in (Get-Content $tmp.FullName -ErrorAction SilentlyContinue)) {
            if ($line -match '\bAdd\b\s+\d+\s+\d+\s+\S+\s+_hawkeye-hub\._tcp\.\s+(.+?)\s*$') {
                $name = $matches[1].Trim()
                if ($name -and ($instances -notcontains $name)) { $instances += $name }
            }
        }
        Remove-Item $tmp.FullName -ErrorAction SilentlyContinue
    }
    return ,$instances
}

function Resolve-MdnsInstance {
    param([string]$InstanceName, [int]$TimeoutSeconds = 4)
    $dnsSd = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($null -eq $dnsSd) { return $null }
    $tmp = New-TemporaryFile
    $proc = Start-Process -FilePath $dnsSd.Source `
        -ArgumentList "-L",$InstanceName,"_hawkeye-hub._tcp","local." `
        -RedirectStandardOutput $tmp.FullName `
        -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds $TimeoutSeconds
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    $hostName = $null
    $port     = $null
    if (Test-Path $tmp.FullName) {
        foreach ($line in (Get-Content $tmp.FullName -ErrorAction SilentlyContinue)) {
            if ($line -match 'can be reached at\s+(\S+?)\.?:(\d+)') {
                $hostName = $matches[1]
                $port     = [int]$matches[2]
            }
        }
        Remove-Item $tmp.FullName -ErrorAction SilentlyContinue
    }
    if (-not $hostName) { return $null }
    return [pscustomobject]@{ Host = $hostName; Port = $port }
}

# Each entry: @{ DisplayName; Address; Port; SquadronId; Token }
$peers = New-Object System.Collections.Generic.List[psobject]

if ($AutoDiscover) {
    $found = Invoke-MdnsHubDiscovery
    if ($found.Count -gt 0) {
        Write-Host "       Detected hubs on the LAN:"
        for ($i = 0; $i -lt $found.Count; $i++) {
            Write-Host ("         [{0}] {1}" -f ($i + 1), $found[$i])
        }
        foreach ($name in $found) {
            $yn = (Read-Host "       Add hub '$name' to the address book? (y/N)").Trim().ToLower()
            if ($yn -ne 'y' -and $yn -ne 'yes') {
                Info "Skipped $name."
                continue
            }
            $resolved = Resolve-MdnsInstance -InstanceName $name
            if (-not $resolved) {
                Warn "Could not resolve $name via Bonjour. Enter the address manually below."
                $addr = (Read-Host "       Hostname or IP for '$name'").Trim()
                $port = 3847
            } else {
                $addr = $resolved.Host
                $port = if ($resolved.Port) { [int]$resolved.Port } else { 3847 }
                Info "Resolved $name -> $addr`:$port"
            }
            if (-not (Test-HostnameOrIp $addr)) {
                Warn "Refusing to use address '$addr' — invalid. Skipped."
                continue
            }
            $displayDefault = $name
            $display = (Read-Host "       Display name [$displayDefault]").Trim()
            if (-not $display) { $display = $displayDefault }
            $tok = Read-Token "       Peer access token for '$display' (paste from the hub)"
            if ([string]::IsNullOrWhiteSpace($tok)) {
                Warn "No token entered. Skipped '$display' — re-add later via add-squadron-peer.ps1."
                continue
            }
            $peers.Add([pscustomobject]@{
                DisplayName = $display
                Address     = $addr
                Port        = $port
                SquadronId  = (Slugify $display)
                Token       = $tok
            }) | Out-Null
            Info "Queued '$display' ($addr`:$port)."
        }
    } else {
        Warn "No hubs advertised _hawkeye-hub._tcp on the LAN. Falling back to manual entry."
    }
}

# Manual entry loop — runs both as the only path (no -AutoDiscover) and
# as a top-up after the auto-discover loop above (operator may have
# extra hubs that didn't show up on mDNS).
while ($true) {
    $more = (Read-Host "       Add a squadron hub manually? (y/N — say N when finished)").Trim().ToLower()
    if ($more -ne 'y' -and $more -ne 'yes') { break }
    $display = (Read-Host "         Display name (e.g. Tigers)").Trim()
    if (-not $display) { Warn "Empty name — skipped."; continue }
    $addr = (Read-Host "         Hostname or IP (e.g. tigers-hub.local)").Trim()
    $port = 3847
    if ($addr -match '^(?<host>[^:]+):(?<port>\d+)$') {
        $addr = $matches['host']
        $port = [int]$matches['port']
    }
    if (-not (Test-HostnameOrIp $addr)) { Warn "Invalid address — skipped."; continue }
    $tok = Read-Token "         Peer access token from that hub"
    if ([string]::IsNullOrWhiteSpace($tok)) { Warn "Empty token — skipped."; continue }
    $peers.Add([pscustomobject]@{
        DisplayName = $display
        Address     = $addr
        Port        = $port
        SquadronId  = (Slugify $display)
        Token       = $tok
    }) | Out-Null
    Info "Queued '$display' ($addr`:$port)."
}

if ($peers.Count -eq 0) {
    Warn "No squadron hubs collected. The aggregator will boot but the dashboard will see an empty squadron list."
    Warn "You can add hubs later with add-squadron-peer.ps1."
} else {
    Info "$($peers.Count) hub(s) queued for the address book:"
    foreach ($p in $peers) { Info "  - $($p.DisplayName) ($($p.Address):$($p.Port))" }
}

# ── Step 4 — Postgres ─────────────────────────────────────────────────
Step 4 "Checking Postgres availability ($PsqlPath)"
$pgFound = $false
try {
    $version = & $PsqlPath --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Info "Found: $version"
        $pgFound = $true
    }
} catch {
    Info "psql not on PATH yet."
}

if (-not $pgFound) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        Fail "Postgres is not installed and 'winget' is not available. Install Postgres 14+ from https://www.postgresql.org/download/windows/ and re-run this script." 44
    }
    Info "Installing PostgreSQL via winget (PostgreSQL.PostgreSQL.16). May take a few minutes..."
    & winget install --id PostgreSQL.PostgreSQL.16 --accept-package-agreements --accept-source-agreements --silent --disable-interactivity 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) {
        Fail "winget install failed (exit $LASTEXITCODE). Install Postgres manually and re-run." 44
    }
    $candidates = @(
        "C:\Program Files\PostgreSQL\16\bin\psql.exe",
        "C:\Program Files\PostgreSQL\15\bin\psql.exe",
        "C:\Program Files\PostgreSQL\14\bin\psql.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $PsqlPath = $c
            $env:PATH = "$(Split-Path -Parent $c);$env:PATH"
            break
        }
    }
    try {
        $version = & $PsqlPath --version 2>&1
        if ($LASTEXITCODE -ne 0) { throw "psql exit $LASTEXITCODE" }
        Info "Installed: $version"
    } catch {
        Fail "Postgres install completed but psql is still not on PATH. Open a new shell and re-run." 44
    }
}

$pgPwSecure = Read-Host -AsSecureString "Enter password for Postgres superuser '$DbUser'"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPwSecure)
$plainPg = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$env:PGPASSWORD = $plainPg
# URL-encode the password before baking it into a postgres:// URL.
# Real passwords routinely contain `@`, `:`, `/`, `#`, `?`, `%` etc.
# which are reserved characters in URI userinfo and silently break
# the connection string when interpolated raw.
$encPg = [uri]::EscapeDataString($plainPg)
$superUrl = "postgresql://$DbUser`@$DbHost`:$DbPort/postgres"
$appUrl   = "postgresql://$DbUser`:$encPg`@$DbHost`:$DbPort/$DbName"

# ── Step 5 — Create DB ────────────────────────────────────────────────
Step 5 "Ensuring database '$DbName' exists"
$dbExists = & $PsqlPath $superUrl -A -t -c "select 1 from pg_database where datname='$DbName';" 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "Cannot connect to Postgres: $dbExists" 45
}
if ([string]::IsNullOrWhiteSpace(([string]$dbExists).Trim())) {
    Info "Creating database $DbName..."
    & $PsqlPath $superUrl -c "create database `"$DbName`";" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Failed to create database." 46 }
} else {
    Info "Already present."
}

# ── Step 6 — Write api-server .env ────────────────────────────────────
# `start-api-host.ps1` (the script the auto-start scheduled task runs)
# explicitly loads `artifacts/api-server/.env`. Keeping a single
# canonical filename means the bootstrap boot below, the scheduled
# task, and any manual operator restart all read the same
# DATABASE_URL/PORT/INSTALL_PROFILE/secrets.
Step 6 "Writing api-server .env (INSTALL_PROFILE=$installProfile)"
$apiEnv = Join-Path $RepoRoot "artifacts\api-server\.env"
if (Test-Path $apiEnv) {
    Warn "$apiEnv already exists; not overwriting. Edit by hand if INSTALL_PROFILE / DATABASE_URL need to change."
} else {
    $bootstrap = -join ((1..32) | ForEach-Object { [char[]]'abcdefghjkmnpqrstuvwxyz23456789' | Get-Random })
    @"
DATABASE_URL=postgresql://$DbUser`:$encPg`@$DbHost`:$DbPort/$DbName
HAWK_INTERNAL_SESSION_AUTH=required
HAWK_LAN_BOOTSTRAP_TOKEN=$bootstrap
HAWK_LAN_DEV_NO_AUTH=0
INSTALL_PROFILE=$installProfile
NODE_ENV=production
PORT=$ApiPort
"@ | Out-File -FilePath $apiEnv -Encoding ASCII
    Info "Wrote $apiEnv (bootstrap token: $bootstrap)"
    Info "STORE THE BOOTSTRAP TOKEN — needed once if you ever have to reset the local super_admin remotely."
}

# ── Step 7 — Write dashboard .env.production.local ────────────────────
# Pin VITE_INTERNAL_API_URL to this PC's local aggregator. The
# dashboard adaptation task (separate parallel task) will read the
# install profile and route reads through `/api/aggregate/*`; for
# now this just wires the base URL so the dashboard is at least
# pointed at the right backend.
Step 7 "Writing dashboard .env.production.local"
$dashEnv = Join-Path $RepoRoot "artifacts\pilot-dashboard\.env.production.local"
$baseUrl = "http://$LanHostName`:$ApiPort"
@"
# Generated by setup-aggregator.ps1 on $(Get-Date -Format o)
# Aggregator profile: $installProfile
# Local aggregator base URL — the dashboard talks to its own PC's api-server.
VITE_LAN_SESSION_LOGIN=1
VITE_INTERNAL_API_URL=$baseUrl
VITE_LAN_NO_AUTH=0
"@ | Out-File -FilePath $dashEnv -Encoding ASCII
Info "Wrote $dashEnv (base URL: $baseUrl)"

# ── Step 8a — Build api-server ────────────────────────────────────────
if ($SkipApiBuild) {
    Step 8 "Skipping api-server build (-SkipApiBuild)"
} else {
    Step 8 "Building api-server (one-time bundle)"
    Push-Location $RepoRoot
    try {
        & pnpm --filter @workspace/api-server run build 2>&1 | ForEach-Object { Info $_ }
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Fail "api-server build failed. Fix the error above and re-run setup-aggregator.ps1." 47
        }
    } finally {
        Pop-Location
    }
}

# ── Step 8b — Boot api-server briefly to run ensureFullSchema ─────────
# Routed through start-api-host.ps1 -SkipBuild so the same env-loading
# code path the scheduled task uses is exercised here.
Step 8 "Booting api-server briefly to run ensureFullSchema()"
$startScript = Join-Path $ScriptDir "start-api-host.ps1"
if (-not (Test-Path $startScript)) {
    Warn "start-api-host.ps1 not found; cannot bootstrap schema. Tables will be created on first manual boot."
} else {
    try {
        $proc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$startScript`"","-SkipBuild" `
            -PassThru -WindowStyle Hidden
        # Poll /api/healthz until ready instead of guessing 8s. On
        # aggregator PCs ensureFullSchema has more tables to create
        # (peer_squadrons, install_profile_meta, …) so a fixed sleep
        # races the DDL on slower hardware.
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if ($proc.HasExited) { break }
            try {
                $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($h.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
        }
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            if ($ready) {
                Info "Schema bootstrap completed (server stopped)."
            } else {
                Warn "api-server started but /api/healthz never returned 200. Schema may be partial; check the api-server console."
            }
        } else {
            Warn "api-server exited early (code $($proc.ExitCode)). Check logs and the .env path printed by start-api-host.ps1."
        }
    } catch {
        Warn "Could not auto-bootstrap schema: $_"
    }
}

# ── Step 9 — Mint local super_admin ───────────────────────────────────
Step 9 "Minting local super_admin '$AdminUser'"
$bcryptDir = Join-Path $RepoRoot "node_modules\bcryptjs"
if (-not (Test-Path $bcryptDir)) {
    Fail "bcryptjs is not installed at $bcryptDir. Run 'pnpm install' from the repo root and re-run this script." 48
}
$hash = & node -e "require('$($bcryptDir.Replace('\','/'))').hash(process.argv[1], 12).then(h => process.stdout.write(h));" $plainAdmin
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($hash)) {
    Fail "Could not compute bcrypt hash for the admin password." 49
}

$adminSqlFile = New-TemporaryFile
@"
begin;
insert into lan_users (id, username, display_name, role, password_hash)
values ('super-' || md5(random()::text || clock_timestamp()::text),
        '$AdminUser', '$AdminUser', 'super_admin', `$pw`$$hash`$pw`$)
on conflict do nothing;
insert into audit_log (occurred_at, actor, type, detail)
values (now(), 'setup_aggregator', 'lan_super_admin_created',
        jsonb_build_object('username', '$AdminUser',
                           'install_profile', '$installProfile',
                           'actor_unknown', true));
commit;
"@ | Out-File -FilePath $adminSqlFile.FullName -Encoding ASCII
& $PsqlPath $appUrl -v ON_ERROR_STOP=1 -f $adminSqlFile.FullName | Out-Null
$adminRc = $LASTEXITCODE
Remove-Item $adminSqlFile.FullName -ErrorAction SilentlyContinue
if ($adminRc -ne 0) { Fail "Failed to insert local super_admin." 50 }
Info "Created super_admin '$AdminUser'."

# ── Step 10 — Seed peer_squadrons ─────────────────────────────────────
Step 10 "Seeding peer_squadrons address book ($($peers.Count) hub(s))"
if ($peers.Count -eq 0) {
    Info "No hubs to seed."
} else {
    # SHA-256 hash mirrors the column the producer side compares against
    # (see peer-fanout.ts: hashPeerToken). Build the SQL in a single
    # transaction so a partial failure leaves nothing committed.
    $sqlLines = New-Object System.Collections.Generic.List[string]
    $sqlLines.Add("begin;") | Out-Null
    foreach ($p in $peers) {
        $tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($p.Token)
        $sha256     = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes  = $sha256.ComputeHash($tokenBytes)
        } finally {
            $sha256.Dispose()
        }
        $tokenHash = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
        # Escape single quotes for SQL literals. The token escaping is
        # the only spot where operator-supplied content reaches a SQL
        # text literal; everything else is identifier-validated above.
        $escName     = $p.DisplayName -replace "'", "''"
        $escSquadron = $p.SquadronId  -replace "'", "''"
        $escAddr     = $p.Address     -replace "'", "''"
        $escToken    = $p.Token       -replace "'", "''"
        $escTokenHash= $tokenHash     -replace "'", "''"
        $baseUrlPeer = "http://${escAddr}:$($p.Port)"
        $sqlLines.Add(@"
insert into peer_squadrons (squadron_id, squadron_name, base_url, auth_token, token_hash, added_by)
values ('$escSquadron', '$escName', '$baseUrlPeer', '$escToken', '$escTokenHash', 'setup_aggregator')
on conflict do nothing;
insert into audit_log (occurred_at, actor, type, detail)
values (now(), 'setup_aggregator', 'aggregate.peers.add',
        jsonb_build_object('squadron_id','$escSquadron','base_url','$baseUrlPeer','source','install','actor_unknown',true));
"@) | Out-Null
    }
    $sqlLines.Add("commit;") | Out-Null

    $peersSqlFile = New-TemporaryFile
    ($sqlLines -join [Environment]::NewLine) | Out-File -FilePath $peersSqlFile.FullName -Encoding ASCII
    & $PsqlPath $appUrl -v ON_ERROR_STOP=1 -f $peersSqlFile.FullName | Out-Null
    $peersRc = $LASTEXITCODE
    Remove-Item $peersSqlFile.FullName -ErrorAction SilentlyContinue
    if ($peersRc -ne 0) { Fail "Failed to seed peer_squadrons (transaction rolled back)." 51 }
    Info "Seeded $($peers.Count) row(s) into peer_squadrons."
}

# ── Step 11 — Build dashboard once ────────────────────────────────────
if ($SkipDashboardBuild) {
    Step 11 "Skipping dashboard build (-SkipDashboardBuild)"
} else {
    Step 11 "Building dashboard (one-time bundle)"
    Push-Location $RepoRoot
    try {
        $env:PORT      = "$DashboardPort"
        $env:BASE_PATH = "/"
        $env:NODE_ENV  = "production"
        & pnpm --filter @workspace/pilot-dashboard run build 2>&1 | ForEach-Object { Info $_ }
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Fail "dashboard build failed. Fix the error above and re-run." 52
        }
    } finally {
        Pop-Location
    }

    # Patch the bundled CSP so the dashboard's connect-src allows the
    # local aggregator API origin. setup-viewer.ps1 does the same patch
    # for viewer PCs; without it the browser blocks fetch() to anything
    # other than the Supabase / replit.app origins the source HTML
    # ships with, including the aggregator's own LAN host name.
    $aggDistIndex = Join-Path $RepoRoot "artifacts\pilot-dashboard\dist\public\index.html"
    if (Test-Path $aggDistIndex) {
        try {
            $html = Get-Content -Raw -Path $aggDistIndex
            if ($html -match 'http-equiv=["'']Content-Security-Policy["'']') {
                $wsOrigin = $baseUrl -replace '^http://','ws://' -replace '^https://','wss://'
                # The CSP meta tag contains exactly one connect-src
                # directive, so a single MatchEvaluator-style replace
                # is sufficient. Using the (string, string, MatchEvaluator)
                # overload — there is no static overload that takes a
                # count, so don't pass one.
                $patched = [regex]::Replace($html, "(connect-src)([^;]*);", {
                    param($m)
                    $tokens = $m.Groups[2].Value.Trim() -split '\s+' | Where-Object { $_ -ne "" }
                    $set = New-Object System.Collections.Generic.HashSet[string]
                    foreach ($t in $tokens) { [void]$set.Add($t) }
                    [void]$set.Add($baseUrl)
                    [void]$set.Add($wsOrigin)
                    return "connect-src " + ($set -join ' ') + ";"
                })
                if ($patched -ne $html) {
                    Set-Content -Path $aggDistIndex -Value $patched -Encoding UTF8 -NoNewline
                    Info "Patched dashboard CSP connect-src to include $baseUrl (+$wsOrigin)."
                } else {
                    Info "Dashboard CSP already includes $baseUrl — no patch needed."
                }
            } else {
                Warn "No CSP meta tag in $aggDistIndex; skipping patch (the bundle may not be ours)."
            }
        } catch {
            Warn "Could not patch dashboard CSP: $_. Dashboard may show connect-src errors in the browser console."
        }
    } else {
        Warn "$aggDistIndex not found; skipping CSP patch."
    }
}

# ── Step 12 — Scheduled tasks ─────────────────────────────────────────
if ($SkipScheduledTasks) {
    Step 12 "Skipping scheduled tasks (-SkipScheduledTasks)"
} else {
    Step 12 "Registering api-server + dashboard scheduled tasks"
    $apiTask = Join-Path $ScriptDir "install-api-startup-task.ps1"
    $apiTaskName = "HawkEye-ApiServer-OnStartup"
    if (Test-Path $apiTask) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $apiTask
        if ($LASTEXITCODE -ne 0) { Warn "install-api-startup-task.ps1 exited $LASTEXITCODE." }
        # Verify SYSTEM-context startup. node/pnpm installed per-user
        # only is the most common Windows-only failure here; this
        # surfaces it at install time rather than after the next reboot.
        Info "Triggering '$apiTaskName' once to verify SYSTEM-context startup..."
        & schtasks /Run /TN $apiTaskName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Warn "schtasks /Run exit $LASTEXITCODE — could not trigger the task. Boot will still fire it; check Task Scheduler manually."
        } else {
            $taskReady = $false
            for ($t = 0; $t -lt 45; $t++) {
                Start-Sleep -Seconds 1
                try {
                    $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                    if ($h.StatusCode -eq 200) { $taskReady = $true; break }
                } catch { }
            }
            if ($taskReady) {
                Info "OK — api-server is reachable on port $ApiPort under the scheduled task."
                & schtasks /End /TN $apiTaskName 2>&1 | Out-Null
            } else {
                Warn "Task '$apiTaskName' was triggered but /api/healthz never returned 200."
                Warn "Most likely cause: node or pnpm not on the SYSTEM PATH. Re-install Node 'for all users' and re-run."
            }
        }
    } else {
        Warn "install-api-startup-task.ps1 not found; api-server will not auto-start on boot."
    }
    $dashTask = Join-Path $ScriptDir "install-dashboard-startup-task.ps1"
    if (Test-Path $dashTask) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $dashTask -DashboardPort $DashboardPort
        if ($LASTEXITCODE -ne 0) { Warn "install-dashboard-startup-task.ps1 exited $LASTEXITCODE." }
    } else {
        Warn "install-dashboard-startup-task.ps1 not found; dashboard will not auto-start on boot."
    }
}

# ── Step 13 — Smoke verification ──────────────────────────────────────
Step 13 "Smoke verifying /api/aggregate/peers/health"
# Boot the api-server again so the route is reachable for the probe.
$probeProc = $null
$startScript = Join-Path $ScriptDir "start-api-host.ps1"
if (Test-Path $startScript) {
    try {
        $probeProc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$startScript`"","-SkipBuild" `
            -PassThru -WindowStyle Hidden
        # Poll healthz instead of guessing 6s.
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if ($probeProc.HasExited) { break }
            try {
                $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($h.StatusCode -eq 200) { break }
            } catch { }
        }
    } catch {
        Warn "Could not boot api-server for smoke check: $_"
    }
}
$smokeUrl = "http://127.0.0.1:$ApiPort/api/aggregate/peers/health"
try {
    # In bring-up mode (`HAWK_INTERNAL_SESSION_AUTH=required` but no
    # session yet) the endpoint requires auth. We pass the bootstrap
    # token via the HAWK_LAN_BOOTSTRAP_TOKEN code path — but for this
    # smoke check we only need to know the route is *registered*, not
    # that we can read the body. A 401 is also a success signal: it
    # means the route exists and the install profile mounted
    # `/api/aggregate/*` correctly.
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $smokeUrl -TimeoutSec 6 -Method GET -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
        Info "OK — $smokeUrl responded 200."
        try {
            $body = $resp.Content | ConvertFrom-Json -ErrorAction Stop
            $count = if ($body.peers) { @($body.peers).Count } else { 0 }
            Info "Reported $count peer(s) in the address book (configured $($peers.Count))."
        } catch { Info "Body was not JSON — route is alive but parse failed (non-fatal)." }
    } else {
        Warn "Unexpected status $($resp.StatusCode) from $smokeUrl"
    }
} catch {
    $we = $_.Exception.Response
    if ($we -and ($we.StatusCode.value__ -eq 401 -or $we.StatusCode.value__ -eq 403)) {
        Info "OK — $smokeUrl returned $($we.StatusCode.value__) (auth-gated route is mounted; sign in as super_admin to read it)."
    } else {
        Warn "Smoke check failed: $($_.Exception.Message). The aggregator is still installed; investigate via 'pnpm lan:host:health'."
    }
}
if ($probeProc -and -not $probeProc.HasExited) {
    Stop-Process -Id $probeProc.Id -Force -ErrorAction SilentlyContinue
}

# Wipe the postgres password from the environment.
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

Write-Host ""
# ── Step 14 — Optional magic-LAN announce (_hawkeye._tcp) ─────────────
if ($EnableMdns) {
    Step 14 "Registering magic-LAN announce (_hawkeye._tcp role=$installProfile)..."
    $mdnsScript = Join-Path $ScriptDir "register-mdns.ps1"
    if (-not (Test-Path $mdnsScript)) {
        Warn "register-mdns.ps1 not found; skipped. Re-run with -EnableMdns after restoring the file."
    } else {
        try {
            $instanceName = "$($env:COMPUTERNAME)"
            & powershell -NoProfile -ExecutionPolicy Bypass -File $mdnsScript `
                -SquadronName $instanceName -ApiPort $ApiPort `
                -ServiceType "_hawkeye._tcp" -Role $installProfile `
                -Hostname $env:COMPUTERNAME `
                -TaskName "HawkEye-Mdns-Magic-OnStartup"
            if ($LASTEXITCODE -ne 0) {
                Warn "register-mdns.ps1 exited with code $LASTEXITCODE. Re-run after rebooting if needed."
            } else {
                Info "OK — this PC now announces as role=$installProfile on _hawkeye._tcp."
            }
        } catch {
            Warn "mDNS registration failed: $_. Pairing will still work via manual hub-token paste."
        }
    }
} else {
    Step 14 "Skipping magic-LAN announce (-EnableMdns not passed). Pair manually via setup-aggregator -AutoDiscover or paste a hub token."
}

Write-Host "DONE. This PC is an aggregator ($installProfile)." -ForegroundColor Green
Write-Host "  - Local Postgres database  : $DbName"
Write-Host "  - Local super_admin        : $AdminUser"
Write-Host "  - Address book seeded with : $($peers.Count) hub(s)"
Write-Host "  - Local aggregator API     : $baseUrl"
Write-Host "  - Dashboard auto-start port: $DashboardPort"
Write-Host ""
Write-Host "Add another squadron later with:"
Write-Host "  .\scripts\lan-host\add-squadron-peer.ps1 -DisplayName ""Eagles"" -Address ""eagles-hub.local"" -Token ""<paste>"""
Write-Host ""
Write-Host "See OPERATOR-RUNBOOK.md → 'Install a Wing or Base Commander PC' for the full runbook."
Write-Host "Log: $LogFile" -ForegroundColor Green
exit 0
