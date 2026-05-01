# aggregator-first-time-setup.ps1
#
# Hawk Eye — Wing / Base Commander PC first-time setup wizard.
#
# Walks the operator (a normal IT person, not a developer) through the
# one-time install on an aggregator PC. An aggregator does not own
# squadron data — it pulls it from one or more squadron hub PCs over
# the LAN. Idempotent: safe to re-run; every step checks first and
# skips if already done.
#
# Steps performed:
#   1. Pick the aggregator role (`aggregator-wing` or `aggregator-base`),
#      a friendly hostname, and (re)name the Windows computer so the
#      PC is reachable on the LAN as `<name>.local`.
#   2. Verify Postgres is installed and reachable; offer to install via
#      winget if missing.
#   3. Create the local `hawkeye_aggregator` database + role if missing.
#      The aggregator needs its own DB for the address book
#      (`peer_squadrons`), session store, and audit trail.
#   4. Write artifacts/api-server/.env with INSTALL_PROFILE pinned to
#      the chosen aggregator role, plus DATABASE_URL, bootstrap token,
#      and PORT. start-api-host.ps1 reads this exact path.
#   5. Build the api-server once (so the boot scheduled task can run
#      with -SkipBuild) then boot it briefly via start-api-host.ps1 so
#      ensureFullSchema() lays out every table the aggregator needs
#      (lan_users, lan_sessions, audit_log, peer_squadrons,
#       peer_cache, install_profile_meta).
#   6. Mint the first super_admin account interactively. The aggregator
#      address-book endpoints (`/api/aggregate/peers`) are super_admin
#      only.
#   7. Auto-discover squadron hubs that opted in to mDNS by browsing
#      `_hawkeye-hub._tcp.local` via `dns-sd.exe -B`. Present a
#      numbered picker of the detected hubs (instance name + resolved
#      host + port). For each one the operator picks, prompt for the
#      peer access token printed by the squadron's first-time-setup.ps1
#      (or read from `%PROGRAMDATA%\HawkEye\peer-token-initial.txt` on
#      that hub), validate the hub responds with `installProfile=hub`,
#      then POST to `/api/aggregate/peers` to add it to the address
#      book. The token never leaves the aggregator's local DB after
#      this (auth_token column, super_admin-only).
#   8. Manual fallback: operators on sites that block multicast can
#      type each squadron's `<name>.local` + port + peer token by
#      hand. Same validate-then-POST flow.
#   9. Register the api-server scheduled task so it auto-starts on boot.
#  10. Register the nightly Postgres backup task (the aggregator has its
#      own DB worth backing up — at minimum it holds the peer address
#      book + cached snapshots).
#
# Run from an elevated PowerShell prompt (right-click -> Run as
# Administrator). All log output goes to STDOUT and is also appended
# to .\aggregator-first-time-setup.log next to this script.

[CmdletBinding()]
param(
    [ValidateSet("wing","base")]
    [string]$Role             = "",
    [string]$AggregatorName   = "",
    [string]$DbName           = "hawkeye_aggregator",
    [string]$DbUser           = "postgres",
    [string]$DbHost           = "127.0.0.1",
    [int]   $DbPort           = 5432,
    [string]$ApiPort          = "3847",
    [string]$PsqlPath         = "psql.exe",
    [int]   $MdnsBrowseSeconds = 6,
    [switch]$SkipDiscovery,
    [switch]$SkipScheduledTasks,
    # Magic LAN auto-discovery: also announce this aggregator on
    # `_hawkeye._tcp` with role=aggregator-{wing|base}. Off by default;
    # pass on sites that allow multicast.
    [switch]$EnableMdns
)

$ErrorActionPreference = "Stop"

# ── Identifier validation ─────────────────────────────────────────────
# Anything that flows into raw SQL or shell-quoted dns-sd arguments is
# rejected if it doesn't match a strict allow-list. psql --command does
# not accept bind params, and dns-sd.exe parses its argv naively, so
# the only safe approach is "reject anything that isn't a plain
# identifier". Same shape as first-time-setup.ps1.
foreach ($pair in @(
    @{ Name = "DbName"; Value = $DbName },
    @{ Name = "DbUser"; Value = $DbUser },
    @{ Name = "DbHost"; Value = $DbHost },
    @{ Name = "ApiPort"; Value = $ApiPort }
)) {
    if ($pair.Value -notmatch '^[A-Za-z0-9_.\-]{1,128}$') {
        Write-Error "Refusing to use $($pair.Name)='$($pair.Value)' — must match ^[A-Za-z0-9_.-]{1,128}$"
        exit 1
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$LogFile   = Join-Path $ScriptDir "aggregator-first-time-setup.log"

function Step($n, $msg) {
    $line = "[STEP $n] $msg"
    Write-Host $line -ForegroundColor Cyan
    Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  $line"
}
function Info($msg) { Write-Host "       $msg"; Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  $msg" }
function Warn($msg) { Write-Host "       [WARN] $msg" -ForegroundColor Yellow; Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  WARN $msg" }

# Aggregator hostname rules mirror Test-SquadronName in first-time-setup.ps1
# so the same regex protects every script that writes a NetBIOS name.
function Test-AggregatorName($value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    $v = $value.Trim()
    if ($v.Length -lt 1 -or $v.Length -gt 15) { return $false }
    if ($v -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') { return $false }
    if ($v -match '^[0-9]+$') { return $false }
    return $true
}

function Test-HostnameOrIp($value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    return $value -match '^[A-Za-z0-9._\-]{1,253}$'
}

function Test-PeerToken($value) {
    # Tokens minted by reset-peer-token.ps1 / first-time-setup.ps1 look
    # like `phk_<uuid>_<hex>`. We don't pin to that format — a future
    # rotate-token UI could mint a different shape — but we DO require
    # something printable, no whitespace, and a sensible length so a
    # blank line or pasted ANSI escape doesn't get stored as a token.
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    if ($value -match '\s') { return $false }
    if ($value.Length -lt 16 -or $value.Length -gt 512) { return $false }
    return $true
}

Add-Content -Path $LogFile -Value ""
Add-Content -Path $LogFile -Value "=========================================================="
Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  aggregator-first-time-setup.ps1 started"
Add-Content -Path $LogFile -Value "=========================================================="

# ── Step 1 — Role + hostname ──────────────────────────────────────────
Step 1 "Choosing aggregator role + Windows hostname..."
if ([string]::IsNullOrWhiteSpace($Role)) {
    Write-Host ""
    Write-Host "   Which kind of aggregator is this PC?" -ForegroundColor Yellow
    Write-Host "     [1] wing  — Wing Commander PC (rolls up several squadrons)" -ForegroundColor Yellow
    Write-Host "     [2] base  — Base Commander PC (rolls up several wings)"     -ForegroundColor Yellow
    do {
        $pick = (Read-Host "   Pick 1 or 2").Trim()
        switch ($pick) {
            "1" { $Role = "wing" }
            "2" { $Role = "base" }
            default { Warn "Pick 1 or 2." }
        }
    } while ([string]::IsNullOrWhiteSpace($Role))
}
$InstallProfile = if ($Role -eq "wing") { "aggregator-wing" } else { "aggregator-base" }
Info "Role: $Role  (INSTALL_PROFILE=$InstallProfile)"

if ([string]::IsNullOrWhiteSpace($AggregatorName)) {
    Write-Host ""
    Write-Host "   Pick a short, friendly name for this PC." -ForegroundColor Yellow
    Write-Host "   Examples: wing-cmd-pc, base-cmd-pc, hq-rollup" -ForegroundColor Yellow
    Write-Host "   Rules: 1-15 characters, letters / digits / hyphen, no leading or" -ForegroundColor Yellow
    Write-Host "          trailing hyphen, not all digits. The LAN will resolve this" -ForegroundColor Yellow
    Write-Host "          PC as <name>.local." -ForegroundColor Yellow
    Write-Host ""
    do {
        $AggregatorName = (Read-Host "   Aggregator hostname").Trim()
        if (-not (Test-AggregatorName $AggregatorName)) {
            Warn "Invalid hostname. Try again."
            $AggregatorName = ""
        }
    } while ([string]::IsNullOrWhiteSpace($AggregatorName))
} elseif (-not (Test-AggregatorName $AggregatorName)) {
    Write-Error "Invalid -AggregatorName '$AggregatorName' — must be 1-15 chars [A-Za-z0-9-], no leading/trailing hyphen, not all digits."
    exit 2
}
$AggregatorName = $AggregatorName.Trim()
Info "Aggregator hostname: $AggregatorName"

$currentName = $env:COMPUTERNAME
if ($currentName -ieq $AggregatorName) {
    Info "Computer name already '$AggregatorName' — no rename needed."
} else {
    Info "Renaming computer from '$currentName' to '$AggregatorName'..."
    try {
        Rename-Computer -NewName $AggregatorName -Force -ErrorAction Stop
        Warn "Computer rename queued. A REBOOT IS REQUIRED before '$AggregatorName.local' resolves on the LAN."
        Warn "Reboot with: shutdown /r /t 0   (after this script finishes)."
    } catch {
        Warn "Could not rename computer: $_. Re-run this script as Administrator, or rename manually under System Properties."
    }
}

# ── Step 2 — Postgres reachable (auto-install if missing) ─────────────
Step 2 "Checking Postgres availability ($PsqlPath)..."
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
        Write-Error "Postgres is not installed and 'winget' is not available. Install Postgres 14+ manually from https://www.postgresql.org/download/windows/ and re-run this script."
        exit 10
    }
    Info "Installing PostgreSQL via winget (PostgreSQL.PostgreSQL.16). This may take a few minutes..."
    & winget install --id PostgreSQL.PostgreSQL.16 --accept-package-agreements --accept-source-agreements --silent --disable-interactivity 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "winget install failed (exit $LASTEXITCODE). Install Postgres manually and re-run."
        exit 10
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
        Write-Error "Postgres install completed but psql is still not on PATH. Open a new shell and re-run."
        exit 10
    }
}

$pgPw = Read-Host -AsSecureString "Enter password for Postgres superuser '$DbUser'"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPw)
$plainPg = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$env:PGPASSWORD = $plainPg
# URL-encode the password before baking it into a postgres:// URL.
# Real-world passwords contain `@`, `:`, `/`, `#`, `?`, `%` etc. which
# are reserved characters in URI userinfo and silently break the
# connection string when interpolated raw. Mirrors first-time-setup.ps1
# Step 2 — both wizards share the same uninstall regex which only
# survives URL-encoded passwords.
$encPg = [uri]::EscapeDataString($plainPg)
$superUrl = "postgresql://$DbUser`@$DbHost`:$DbPort/postgres"

# ── Step 3 — Create DB ────────────────────────────────────────────────
Step 3 "Ensuring database '$DbName' exists..."
$dbExists = & $PsqlPath $superUrl -A -t -c "select 1 from pg_database where datname='$DbName';" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Cannot connect to Postgres: $dbExists"
    exit 11
}
if ([string]::IsNullOrWhiteSpace($dbExists.Trim())) {
    Info "Creating database $DbName..."
    & $PsqlPath $superUrl -c "create database `"$DbName`";" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create database."; exit 12 }
} else {
    Info "Already present."
}

# ── Step 4 — Write api-server .env ────────────────────────────────────
# start-api-host.ps1 — the same script the auto-start scheduled task
# invokes — explicitly loads artifacts/api-server/.env. INSTALL_PROFILE
# being baked into the .env (rather than only the scheduled task argv)
# means manual restarts also boot in aggregator mode.
Step 4 "Writing api-server .env (INSTALL_PROFILE=$InstallProfile)..."
$apiEnv = Join-Path $RepoRoot "artifacts\api-server\.env"
if (Test-Path $apiEnv) {
    Warn "$apiEnv already exists; not overwriting. Edit by hand if needed."
    $existing = Get-Content $apiEnv
    if (-not ($existing | Where-Object { $_ -match '^INSTALL_PROFILE=' })) {
        Add-Content -Path $apiEnv -Value "INSTALL_PROFILE=$InstallProfile"
        Info "Appended INSTALL_PROFILE=$InstallProfile to existing .env"
    } else {
        Info "Existing .env already pins INSTALL_PROFILE — leaving it alone."
    }
} else {
    $bootstrap = -join ((1..32) | ForEach-Object { [char[]]'abcdefghjkmnpqrstuvwxyz23456789' | Get-Random })
    @"
DATABASE_URL=postgresql://$DbUser`:$encPg`@$DbHost`:$DbPort/$DbName
HAWK_INTERNAL_SESSION_AUTH=required
HAWK_LAN_BOOTSTRAP_TOKEN=$bootstrap
HAWK_LAN_DEV_NO_AUTH=0
INSTALL_PROFILE=$InstallProfile
NODE_ENV=production
PORT=$ApiPort
AGGREGATOR_NAME=$AggregatorName
"@ | Out-File -FilePath $apiEnv -Encoding ASCII
    Info "Wrote $apiEnv (bootstrap token: $bootstrap)"
    Info "STORE THE BOOTSTRAP TOKEN — you'll need it once to mint the super_admin."
}

# ── Step 5 — Build api-server ────────────────────────────────────────
Step 5 "Building api-server (one-time bundle for the scheduled task)..."
Push-Location $RepoRoot
try {
    & pnpm --filter @workspace/api-server run build 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "api-server build failed. Fix the error above and re-run."
        Pop-Location
        exit 13
    }
} finally {
    Pop-Location
}

# ── Step 6 — Boot once via start-api-host.ps1 (schema + then keep up) ──
# Unlike first-time-setup.ps1 which boots, runs ensureFullSchema(), and
# stops, the aggregator wizard needs the api-server up for ALL of:
#   - super_admin login (Step 7),
#   - peer creation POSTs (Steps 8-9),
# so we boot it once here and tear it down at the very end.
Step 6 "Booting api-server (so super_admin login + /api/aggregate/peers work)..."
$startScript = Join-Path $ScriptDir "start-api-host.ps1"
$apiProc = $null
$apiReady = $false
if (-not (Test-Path $startScript)) {
    Warn "start-api-host.ps1 not found; cannot continue with super_admin + peer setup."
} else {
    try {
        $apiProc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$startScript`"","-SkipBuild" `
            -PassThru -WindowStyle Hidden
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            try {
                $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($h.StatusCode -eq 200) {
                    $body = $h.Content | ConvertFrom-Json
                    if ([string]$body.installProfile -ne $InstallProfile) {
                        Warn "api-server reports installProfile='$($body.installProfile)' but we wrote '$InstallProfile' to .env. Did this PC first boot as a different profile?"
                    }
                    $apiReady = $true
                    break
                }
            } catch { }
        }
        if (-not $apiReady) {
            Warn "api-server did not become ready on port $ApiPort within 30s. Skipping super_admin + peer setup."
        }
    } catch {
        Warn "Could not boot api-server: $_."
    }
}

try {

# ── Step 7 — Mint super_admin ────────────────────────────────────────
Step 7 "Minting first super_admin (required for the address book)..."
$adminUser     = ""
$plainAdmin    = $null
$adminCreated  = $false
$sessionToken  = $null
if (-not $apiReady) {
    Warn "Skipping super_admin — api-server is not running."
} else {
    $adminUser = Read-Host "First super_admin username"
    if ([string]::IsNullOrWhiteSpace($adminUser)) {
        Warn "Skipped — no username given."
    } elseif ($adminUser -notmatch '^[A-Za-z0-9_.\-]{1,64}$') {
        Warn "Refusing to use username '$adminUser' — must match ^[A-Za-z0-9_.-]{1,64}$. Skipped."
        $adminUser = ""
    } else {
        $adminPw = Read-Host -AsSecureString "Password for '$adminUser' (>=8 chars)"
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPw)
        $plainAdmin = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        if ($plainAdmin.Length -lt 8) {
            Warn "Password too short. Skipped."
            $plainAdmin = $null
        } else {
            # The aggregator's bootstrap window (first user, no LAN
            # session yet) is the same `/auth/lan/bootstrap` route used
            # on the hub. We pull HAWK_LAN_BOOTSTRAP_TOKEN out of the
            # .env file we just wrote.
            $bootstrapToken = ""
            foreach ($l in (Get-Content $apiEnv)) {
                if ($l -match '^HAWK_LAN_BOOTSTRAP_TOKEN=(.+)$') { $bootstrapToken = $matches[1].Trim() }
            }
            if ([string]::IsNullOrWhiteSpace($bootstrapToken)) {
                Warn "HAWK_LAN_BOOTSTRAP_TOKEN missing from .env — cannot bootstrap super_admin. Skipped."
                $plainAdmin = $null
            } else {
                # /auth/lan/bootstrap creates the user but does NOT
                # return a session token. We always follow with
                # /auth/lan/login to get the session we need for the
                # peer-add POSTs below. Bootstrap returns 409
                # `lan_bootstrap_already_done` on re-runs once any
                # lan_users row exists, in which case we skip straight
                # to login.
                $bootBody = @{
                    token        = $bootstrapToken
                    username     = $adminUser
                    password     = $plainAdmin
                    display_name = $adminUser
                    role         = "super_admin"
                } | ConvertTo-Json -Compress
                $userExists = $false
                try {
                    Invoke-RestMethod -Method Post `
                        -Uri "http://127.0.0.1:$ApiPort/api/aggregate/auth/lan/bootstrap" `
                        -ContentType "application/json" -Body $bootBody -TimeoutSec 10 | Out-Null
                    Info "Created super_admin '$adminUser'."
                    $userExists = $true
                } catch {
                    $msg = $_.Exception.Message
                    try {
                        $stream = $_.Exception.Response.GetResponseStream()
                        $reader = New-Object System.IO.StreamReader($stream)
                        $payload = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
                        if ($payload.error) { $msg = [string]$payload.error }
                    } catch { }
                    if ($msg -eq "lan_bootstrap_already_done") {
                        Info "lan_users already populated — assuming '$adminUser' already exists."
                        $userExists = $true
                    } else {
                        Warn "Bootstrap call failed: $msg"
                    }
                }
                if ($userExists) {
                    try {
                        $loginBody = @{ username = $adminUser; password = $plainAdmin } | ConvertTo-Json -Compress
                        $loginResp = Invoke-RestMethod -Method Post `
                            -Uri "http://127.0.0.1:$ApiPort/api/aggregate/auth/lan/login" `
                            -ContentType "application/json" -Body $loginBody -TimeoutSec 10
                        if ($loginResp.token) {
                            $sessionToken = [string]$loginResp.token
                            $adminCreated = $true
                            Info "Signed in as super_admin '$adminUser'."
                        } else {
                            Warn "Login response had no session token: $($loginResp | ConvertTo-Json -Compress)"
                        }
                    } catch {
                        Warn "Login as '$adminUser' failed: $_"
                    }
                }
            }
        }
    }
}
$plainAdmin = $null   # scrub from memory

# ── Helpers for Steps 8 + 9 — peer discovery + add ────────────────────
function Invoke-MdnsHubBrowse {
    param([int]$TimeoutSeconds)
    $dnsSd = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($null -eq $dnsSd) {
        $candidates = @(
            "C:\Program Files\Bonjour\dns-sd.exe",
            "C:\Program Files (x86)\Bonjour\dns-sd.exe"
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { $dnsSd = [pscustomobject]@{ Source = $c }; break }
        }
    }
    if ($null -eq $dnsSd) {
        Warn "dns-sd.exe not found (Bonjour Print Services for Windows is not installed)."
        Warn "Install Bonjour or fall back to manual entry. Skipping discovery."
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
        # dns-sd -B output:
        # Timestamp  A/R Flags if Domain  Service Type      Instance Name
        # 13:01:02   Add 2 12 local.     _hawkeye-hub._tcp.  tigers-hub
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

function Resolve-MdnsHub {
    param([string]$InstanceName, [int]$TimeoutSeconds = 4)
    if ($InstanceName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9 _\-]{0,61}[A-Za-z0-9])?$') {
        Warn "Refusing to dns-sd -L on suspicious instance name '$InstanceName'."
        return $null
    }
    $dnsSd = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($null -eq $dnsSd) {
        $candidates = @(
            "C:\Program Files\Bonjour\dns-sd.exe",
            "C:\Program Files (x86)\Bonjour\dns-sd.exe"
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { $dnsSd = [pscustomobject]@{ Source = $c }; break }
        }
    }
    if ($null -eq $dnsSd) { return $null }
    $tmp = New-TemporaryFile
    $proc = Start-Process -FilePath $dnsSd.Source `
        -ArgumentList "-L",$InstanceName,"_hawkeye-hub._tcp","local." `
        -RedirectStandardOutput $tmp.FullName `
        -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds $TimeoutSeconds
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    $hostName = $null; $port = $null
    if (Test-Path $tmp.FullName) {
        foreach ($line in (Get-Content $tmp.FullName -ErrorAction SilentlyContinue)) {
            # `tigers-hub.local. can be reached at hawk-host.local.:3847 (interface 12)`
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

function Test-PeerHubReachable {
    param([string]$BaseUrl)
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/api/healthz" -TimeoutSec 6 -Method GET
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = "no response: $($_.Exception.Message)"; Profile = $null }
    }
    if ($resp.StatusCode -lt 200 -or $resp.StatusCode -ge 300) {
        return [pscustomobject]@{ Ok = $false; Reason = "HTTP $($resp.StatusCode)"; Profile = $null }
    }
    $profile = $null
    try {
        $body = $resp.Content | ConvertFrom-Json -ErrorAction Stop
        $profile = [string]$body.installProfile
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = "non-JSON healthz body"; Profile = $null }
    }
    if ($profile -ne "hub") {
        return [pscustomobject]@{ Ok = $false; Reason = "installProfile='$profile' (expected 'hub')"; Profile = $profile }
    }
    return [pscustomobject]@{ Ok = $true; Reason = ""; Profile = $profile }
}

function Add-PeerToAddressBook {
    param(
        [string]$SquadronId,
        [string]$SquadronName,
        [string]$BaseUrl,
        [string]$Token,
        [string]$Session
    )
    $body = @{
        squadron_id   = $SquadronId
        squadron_name = $SquadronName
        base_url      = $BaseUrl
        token         = $Token
    } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Method Post `
            -Uri "http://127.0.0.1:$ApiPort/api/aggregate/peers" `
            -ContentType "application/json" `
            -Headers @{ "x-hawk-lan-session" = $Session } `
            -Body $body -TimeoutSec 10
        return [pscustomobject]@{ Ok = $true; Id = [string]$resp.id; Reason = "" }
    } catch {
        $reason = $_.Exception.Message
        # Try to surface the structured error code from the JSON body so
        # we can recognise `peer_already_exists` and tell the operator
        # plainly instead of dumping a 409.
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $payload = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
            if ($payload.error) { $reason = [string]$payload.error }
        } catch { }
        return [pscustomobject]@{ Ok = $false; Id = ""; Reason = $reason }
    }
}

function Read-PeerEntryAndAdd {
    param(
        [string]$DefaultSquadronId,
        [string]$DefaultHost,
        [int]$DefaultPort,
        [string]$Session
    )
    # squadron_id: short stable handle the aggregator stores the peer
    # under. We default to the discovered instance / hostname so a
    # plain Enter accepts what we already know.
    $sid = (Read-Host "         squadron_id [$DefaultSquadronId]").Trim()
    if ([string]::IsNullOrWhiteSpace($sid)) { $sid = $DefaultSquadronId }
    if ($sid -notmatch '^[A-Za-z0-9_.\-]{1,64}$') {
        Warn "squadron_id must be 1-64 chars [A-Za-z0-9_.-]. Skipping this peer."
        return $false
    }

    $name = (Read-Host "         display name (optional, e.g. 'Tigers Squadron')").Trim()
    if ($name -eq "") { $name = $sid }

    $hostInput = (Read-Host "         hostname or IP [$DefaultHost]").Trim()
    if ([string]::IsNullOrWhiteSpace($hostInput)) { $hostInput = $DefaultHost }
    if (-not (Test-HostnameOrIp $hostInput)) {
        Warn "Invalid hostname/IP '$hostInput'. Skipping this peer."
        return $false
    }

    $portInput = (Read-Host "         port [$DefaultPort]").Trim()
    $port = if ([string]::IsNullOrWhiteSpace($portInput)) { $DefaultPort } else { [int]$portInput }
    if ($port -lt 1 -or $port -gt 65535) {
        Warn "Port '$port' out of range. Skipping this peer."
        return $false
    }

    $base = "http://$hostInput`:$port"
    Info "Validating $base/api/healthz..."
    $probe = Test-PeerHubReachable -BaseUrl $base
    if (-not $probe.Ok) {
        Warn "Hub at $base is not reachable as a Hawk Eye hub: $($probe.Reason)."
        $cont = (Read-Host "         Add anyway? (y/N)").Trim().ToLower()
        if ($cont -ne "y") { Info "Skipped."; return $false }
    } else {
        Info "OK — $base reports installProfile='hub'."
    }

    $tokSecure = Read-Host -AsSecureString "         peer access token (paste from squadron's first-time-setup)"
    $tbstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokSecure)
    $tok = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($tbstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tbstr)
    if (-not (Test-PeerToken $tok)) {
        Warn "Token looks invalid (blank, has whitespace, or unusual length). Skipping this peer."
        return $false
    }

    $add = Add-PeerToAddressBook -SquadronId $sid -SquadronName $name -BaseUrl $base -Token $tok -Session $Session
    # Scrub the token from memory now that it's posted to the local DB.
    $tok = $null
    if ($add.Ok) {
        Info "Added peer '$sid' ($base) to the address book (id=$($add.Id))."
        return $true
    } else {
        if ($add.Reason -eq "peer_already_exists") {
            Warn "Peer '$sid' is already in the address book. Use the dashboard or /api/aggregate/peers PATCH to swap its token."
        } else {
            Warn "Failed to add peer '$sid': $($add.Reason)"
        }
        return $false
    }
}

# ── Step 8 — Auto-discover squadron hubs ──────────────────────────────
Step 8 "Discovering squadron hubs on the LAN (_hawkeye-hub._tcp)..."
$instances = @()
if ($SkipDiscovery) {
    Info "-SkipDiscovery passed; jumping straight to manual entry."
} elseif (-not $apiReady -or -not $adminCreated -or [string]::IsNullOrWhiteSpace($sessionToken)) {
    Warn "api-server is not ready or no super_admin session — skipping discovery."
} else {
    $instances = @(Invoke-MdnsHubBrowse -TimeoutSeconds $MdnsBrowseSeconds)
    if ($instances.Count -eq 0) {
        Warn "No squadron hubs advertised _hawkeye-hub._tcp on the LAN."
        Warn "Either no hubs are broadcasting (squadron skipped -EnableMdns), or the LAN blocks multicast."
    } else {
        Write-Host ""
        Write-Host "       Detected hubs:" -ForegroundColor Green
        for ($i = 0; $i -lt $instances.Count; $i++) {
            $resolved = Resolve-MdnsHub -InstanceName $instances[$i]
            $extra = if ($resolved) { "  →  $($resolved.Host):$($resolved.Port)" } else { "  (unresolved)" }
            Write-Host ("         [{0}] {1}{2}" -f ($i + 1), $instances[$i], $extra)
        }
        Write-Host "         [a] Add ALL of the above"
        Write-Host "         [s] Skip discovery, jump to manual entry"
        Write-Host ""
        $rawPick = (Read-Host "       Pick by number (comma-separated, e.g. 1,3), 'a' for all, or 's' to skip").Trim()
        $picks = @()
        switch -Regex ($rawPick.ToLower()) {
            '^a$' { $picks = 0..($instances.Count - 1) }
            '^s$' { $picks = @() }
            default {
                foreach ($p in ($rawPick -split ',')) {
                    $p2 = $p.Trim()
                    if ($p2 -match '^[0-9]+$') {
                        $idx = [int]$p2 - 1
                        if ($idx -ge 0 -and $idx -lt $instances.Count) { $picks += $idx }
                    }
                }
            }
        }
        foreach ($idx in $picks) {
            $name = $instances[$idx]
            Write-Host ""
            Info "Adding squadron '$name'..."
            $resolved = Resolve-MdnsHub -InstanceName $name
            $defHost = if ($resolved -and $resolved.Host) { $resolved.Host } else { "$name.local" }
            $defPort = if ($resolved -and $resolved.Port) { [int]$resolved.Port } else { 3847 }
            [void](Read-PeerEntryAndAdd -DefaultSquadronId $name -DefaultHost $defHost -DefaultPort $defPort -Session $sessionToken)
        }
    }
}

# ── Step 9 — Manual fallback (always offered) ─────────────────────────
Step 9 "Optional: add more squadrons by hand (for sites that block mDNS)..."
if (-not $apiReady -or -not $adminCreated -or [string]::IsNullOrWhiteSpace($sessionToken)) {
    Warn "api-server is not ready or no super_admin session — skipping manual peer entry."
} else {
    while ($true) {
        $more = (Read-Host "       Add another squadron by hand? (y/N)").Trim().ToLower()
        if ($more -ne "y") { break }
        [void](Read-PeerEntryAndAdd -DefaultSquadronId "" -DefaultHost "" -DefaultPort 3847 -Session $sessionToken)
    }
}

# Best-effort logout to invalidate the short-lived session we created.
if ($apiReady -and $sessionToken) {
    try {
        Invoke-RestMethod -Method Post `
            -Uri "http://127.0.0.1:$ApiPort/api/aggregate/auth/lan/logout" `
            -Headers @{ "x-hawk-lan-session" = $sessionToken } `
            -ContentType "application/json" -TimeoutSec 5 | Out-Null
    } catch {
        # Non-fatal — the session expires on its own in 30 days.
    }
}
$sessionToken = $null

} finally {
    if ($apiProc -and -not $apiProc.HasExited) {
        Stop-Process -Id $apiProc.Id -Force -ErrorAction SilentlyContinue
        Info "Stopped the bring-up api-server (the scheduled task in Step 10 takes over from here)."
    }
}

# ── Step 10 + 11 — Scheduled tasks ────────────────────────────────────
if ($SkipScheduledTasks) {
    Step 10 "Skipping scheduled tasks (-SkipScheduledTasks)."
} else {
    Step 10 "Registering api-server scheduled task..."
    $apiTask = Join-Path $ScriptDir "install-api-startup-task.ps1"
    if (Test-Path $apiTask) {
        & powershell -ExecutionPolicy Bypass -File $apiTask
    } else {
        Warn "install-api-startup-task.ps1 not found; skipped."
    }

    Step 11 "Registering nightly backup scheduled task..."
    $bkTask = Join-Path $ScriptDir "install-backup-task.ps1"
    if (Test-Path $bkTask) {
        & powershell -ExecutionPolicy Bypass -File $bkTask
    } else {
        Warn "install-backup-task.ps1 not found; skipped."
    }
}

# Clear the postgres password from the environment.
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

Write-Host ""
# ── Step 12 — Optional magic-LAN announce (_hawkeye._tcp) ─────────────
if ($EnableMdns) {
    Write-Host ""
    Write-Host "Step 12: Registering magic-LAN announce (_hawkeye._tcp role=$InstallProfile)..." -ForegroundColor Cyan
    $mdnsScript = Join-Path $ScriptDir "register-mdns.ps1"
    if (-not (Test-Path $mdnsScript)) {
        Warn "register-mdns.ps1 not found; skipped."
    } else {
        try {
            $instanceName = "$($env:COMPUTERNAME)"
            & powershell -NoProfile -ExecutionPolicy Bypass -File $mdnsScript `
                -SquadronName $instanceName -ApiPort $ApiPort `
                -ServiceType "_hawkeye._tcp" -Role $InstallProfile `
                -Hostname $env:COMPUTERNAME `
                -TaskName "HawkEye-Mdns-Magic-OnStartup"
            if ($LASTEXITCODE -ne 0) {
                Warn "register-mdns.ps1 exited with code $LASTEXITCODE."
            }
        } catch {
            Warn "mDNS registration failed: $_."
        }
    }
}

Write-Host "DONE. This PC is a $InstallProfile aggregator." -ForegroundColor Green
Write-Host "  - Address book lives in DB '$DbName' (table: peer_squadrons)."
Write-Host "  - Manage peers later via the dashboard or POST/PATCH/DELETE /api/aggregate/peers."
Write-Host "  - To re-discover hubs after squadrons opt in to mDNS, re-run this script."
Write-Host ""
Write-Host "Log: $LogFile" -ForegroundColor Green
if ($currentName -ine $AggregatorName) {
    Write-Host ""
    Write-Host "REBOOT REQUIRED so this PC is reachable as '$AggregatorName.local' on the LAN." -ForegroundColor Yellow
    Write-Host "Run: shutdown /r /t 0" -ForegroundColor Yellow
}
exit 0
