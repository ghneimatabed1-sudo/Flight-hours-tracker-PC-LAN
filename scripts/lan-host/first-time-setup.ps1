# first-time-setup.ps1
#
# Hawk Eye — host PC first-time setup wizard.
#
# Walks the operator (a normal squadron IT person, not a developer)
# through the one-time install on the LAN host PC. Idempotent: safe to
# re-run; every step checks first and skips if already done.
#
# Steps performed:
#   1. Pick a friendly squadron name and (re)name the host PC so it is
#      reachable on the LAN as `<name>.local`.
#   2. Verify Postgres is installed and reachable.
#   3. Create the `hawkeye_internal` database + role if missing.
#   4. Write artifacts/api-server/.env (the file every LAN host script
#      reads — start-api-host.ps1 looks for this exact path) with the
#      chosen DATABASE_URL, bootstrap token, PORT, and SQUADRON_NAME.
#   5. Write artifacts/pilot-dashboard/.env.production.local with the
#      mDNS host name (default `hawk-host.local`) so every workstation
#      finds the api-server.
#   6. Build the api-server once (so the scheduled task can run with
#      -SkipBuild), then boot it briefly via start-api-host.ps1 so the
#      same env-loading code path runs and ensureFullSchema() creates
#      every table (lan_users, lan_sessions, audit_log, wings, bases).
#   7. Mint the first super_admin account interactively.
#   8. Boot api-server, log in as that super_admin, mint the FIRST peer
#      access token, print it once with copy-paste instructions for the
#      Wing Commander PC operator, and persist it to a secured file
#      (`%PROGRAMDATA%\HawkEye\peer-token-initial.txt`, ACL'd to local
#      Administrators).
#   9. Optionally advertise the hub on mDNS as `_hawkeye-hub._tcp`
#      (off by default; pass `-EnableMdns` on sites that allow it).
#  10. Register the api-server scheduled task so it auto-starts on boot.
#  11. Register the nightly Postgres backup task.
#
# Run from an elevated PowerShell prompt (right-click -> Run as
# Administrator). All log output goes to STDOUT and is also appended to
# .\first-time-setup.log next to the script.

[CmdletBinding()]
param(
    [string]$DbName       = "hawkeye_internal",
    [string]$DbUser       = "postgres",
    [string]$DbHost       = "127.0.0.1",
    [int]   $DbPort       = 5432,
    [string]$ApiPort      = "3847",
    [string]$LanHostName  = "hawk-host.local",
    [string]$PsqlPath     = "psql.exe",
    [string]$SquadronName = "",
    [switch]$EnableMdns,
    [switch]$SkipScheduledTasks
)

$ErrorActionPreference = "Stop"

# All identifiers that flow into raw SQL (database name, role name, etc.)
# are validated against a strict allow-list here so we never depend on
# operator input being safely quoted later. psql --command does not
# accept bind params, so the only safe approach is "reject anything
# that isn't a plain identifier".
foreach ($pair in @(
    @{ Name = "DbName"; Value = $DbName },
    @{ Name = "DbUser"; Value = $DbUser },
    @{ Name = "DbHost"; Value = $DbHost },
    @{ Name = "LanHostName"; Value = $LanHostName },
    @{ Name = "ApiPort"; Value = $ApiPort }
)) {
    if ($pair.Value -notmatch '^[A-Za-z0-9_.\-]{1,128}$') {
        Write-Error "Refusing to use $($pair.Name)='$($pair.Value)' — must match ^[A-Za-z0-9_.-]{1,128}$"
        exit 1
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir "..\..")
$LogFile   = Join-Path $ScriptDir "first-time-setup.log"

function Step($n, $msg) {
    $line = "[STEP $n] $msg"
    Write-Host $line -ForegroundColor Cyan
    Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  $line"
}
function Info($msg) { Write-Host "       $msg"; Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  $msg" }
function Warn($msg) { Write-Host "       [WARN] $msg" -ForegroundColor Yellow; Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  WARN $msg" }

# Squadron names must be a valid Windows NetBIOS / DNS host label so the
# PC is reachable as `<name>.local` on the LAN: 1–15 chars, letters /
# digits / hyphen, no leading or trailing hyphen, not all digits.
function Test-SquadronName($value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    $v = $value.Trim()
    if ($v.Length -lt 1 -or $v.Length -gt 15) { return $false }
    if ($v -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') { return $false }
    if ($v -match '^[0-9]+$') { return $false }
    return $true
}

Add-Content -Path $LogFile -Value ""
Add-Content -Path $LogFile -Value "=========================================================="
Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  first-time-setup.ps1 started"
Add-Content -Path $LogFile -Value "=========================================================="

# ── Step 1 — Squadron name + Windows hostname ──────────────────────────
Step 1 "Naming the squadron hub..."
if ([string]::IsNullOrWhiteSpace($SquadronName)) {
    Write-Host ""
    Write-Host "   Pick a short, friendly name for this squadron's hub PC." -ForegroundColor Yellow
    Write-Host "   Examples: tigers-hub, eagles-hub, bravo-hub" -ForegroundColor Yellow
    Write-Host "   Rules: 1-15 characters, letters / digits / hyphen, no leading or" -ForegroundColor Yellow
    Write-Host "          trailing hyphen, not all digits. Wing/Base operators will" -ForegroundColor Yellow
    Write-Host "          see this name when adding squadrons, and the LAN will" -ForegroundColor Yellow
    Write-Host "          resolve this PC as <name>.local." -ForegroundColor Yellow
    Write-Host ""
    do {
        $SquadronName = (Read-Host "   Squadron name").Trim()
        if (-not (Test-SquadronName $SquadronName)) {
            Warn "Invalid squadron name. Try again."
            $SquadronName = ""
        }
    } while ([string]::IsNullOrWhiteSpace($SquadronName))
} elseif (-not (Test-SquadronName $SquadronName)) {
    Write-Error "Invalid -SquadronName '$SquadronName' — must be 1-15 chars [A-Za-z0-9-], no leading/trailing hyphen, not all digits."
    exit 2
}

$SquadronName = $SquadronName.Trim()
Info "Squadron name: $SquadronName"

# Set the Windows computer name. Skip when we already match (re-runs).
$currentName = $env:COMPUTERNAME
if ($currentName -ieq $SquadronName) {
    Info "Computer name already '$SquadronName' — no rename needed."
} else {
    Info "Renaming computer from '$currentName' to '$SquadronName'..."
    try {
        Rename-Computer -NewName $SquadronName -Force -ErrorAction Stop
        Warn "Computer rename queued. A REBOOT IS REQUIRED before '$SquadronName.local' resolves on the LAN."
        Warn "Reboot with: shutdown /r /t 0   (after this script finishes)."
    } catch {
        Warn "Could not rename computer: $_. Re-run this script as Administrator, or rename manually under System Properties."
    }
}

# ── Step 2 — Postgres reachable (auto-install if missing) ──────────────
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
    # Try winget first (Windows 10 1809+, Windows 11 ship with it).
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
    # Update PATH for this session and re-locate psql.
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

# Prompt for the postgres superuser password (only used to create db/role).
$pgPw = Read-Host -AsSecureString "Enter password for Postgres superuser '$DbUser'"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPw)
$plainPg = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$env:PGPASSWORD = $plainPg
# URL-encode the password before baking it into a postgres:// URL.
# Real-world passwords contain `@`, `:`, `/`, `#`, `?`, `%` etc. which
# are reserved characters in URI userinfo and silently break the
# connection string when interpolated raw.
$encPg = [uri]::EscapeDataString($plainPg)
$superUrl = "postgresql://$DbUser`@$DbHost`:$DbPort/postgres"

# ── Step 3 — Create DB + role ──────────────────────────────────────────
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

# ── Step 4 — Write api-server .env ─────────────────────────────────────
# Filename is .env (not .env.production) because start-api-host.ps1 —
# the same script the auto-start scheduled task and `pnpm
# lan:host:start-api` invoke — explicitly loads
# artifacts/api-server/.env. Keeping a single canonical filename means
# the bootstrap boot in Step 6, the scheduled task, and any manual
# operator restart all read the same DATABASE_URL/PORT/secrets.
Step 4 "Writing api-server .env..."
$apiEnv = Join-Path $RepoRoot "artifacts\api-server\.env"
$bootstrap = $null
if (Test-Path $apiEnv) {
    Warn "$apiEnv already exists; not overwriting. Edit by hand if needed."
    # Ensure SQUADRON_NAME is present even on re-run so downstream steps
    # (peer-token issuance, mDNS) have a single source of truth.
    $existing = Get-Content $apiEnv
    if (-not ($existing | Where-Object { $_ -match '^SQUADRON_NAME=' })) {
        Add-Content -Path $apiEnv -Value "SQUADRON_NAME=$SquadronName"
        Info "Appended SQUADRON_NAME=$SquadronName to existing .env"
    }
} else {
    $bootstrap = -join ((1..32) | ForEach-Object { [char[]]'abcdefghjkmnpqrstuvwxyz23456789' | Get-Random })
    @"
DATABASE_URL=postgresql://$DbUser`:$encPg`@$DbHost`:$DbPort/$DbName
HAWK_INTERNAL_SESSION_AUTH=required
HAWK_LAN_BOOTSTRAP_TOKEN=$bootstrap
HAWK_LAN_DEV_NO_AUTH=0
NODE_ENV=production
PORT=$ApiPort
SQUADRON_NAME=$SquadronName
"@ | Out-File -FilePath $apiEnv -Encoding ASCII
    Info "Wrote $apiEnv (bootstrap token: $bootstrap)"
    Info "STORE THE BOOTSTRAP TOKEN — you'll need it once to mint the super_admin."
}

# ── Step 5 — Write dashboard .env.production.local ─────────────────────
Step 5 "Writing dashboard .env.production.local..."
$dashEnv = Join-Path $RepoRoot "artifacts\pilot-dashboard\.env.production.local"
if (Test-Path $dashEnv) {
    Warn "$dashEnv already exists; not overwriting."
} else {
    @"
VITE_LAN_SESSION_LOGIN=1
VITE_INTERNAL_API_URL=http://$LanHostName`:$ApiPort
VITE_LAN_NO_AUTH=0
"@ | Out-File -FilePath $dashEnv -Encoding ASCII
    Info "Wrote $dashEnv (host: $LanHostName)"
}

# ── Step 6a — Build api-server ────────────────────────────────────────
# The scheduled task installed in Step 10 runs start-api-host.ps1 with
# -SkipBuild (so a Windows reboot doesn't re-bundle every time). That
# requires dist/index.mjs to already exist, so we do the build here on
# the first-time setup machine.
Step 6 "Building api-server (one-time bundle for the scheduled task)..."
Push-Location $RepoRoot
try {
    & pnpm --filter @workspace/api-server run build 2>&1 | ForEach-Object { Info $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "api-server build failed. Fix the error above and re-run first-time-setup.ps1."
        Pop-Location
        exit 13
    }
} finally {
    Pop-Location
}

# ── Step 6b — Boot api-server once via start-api-host.ps1 ─────────────
# We deliberately route through start-api-host.ps1 (with -SkipBuild)
# because that is the same script the scheduled task uses. It loads
# artifacts/api-server/.env, validates DATABASE_URL is present, and
# then launches `pnpm run start` with the env populated. Booting
# directly with `pnpm run start` here would not load .env and would
# crash with "DATABASE_URL is empty". Five seconds is plenty for
# ensureFullSchema()'s IF NOT EXISTS DDL on a fresh empty DB.
Step 6 "Booting api-server briefly to run ensureFullSchema()..."
$startScript = Join-Path $ScriptDir "start-api-host.ps1"
if (-not (Test-Path $startScript)) {
    Warn "start-api-host.ps1 not found; cannot bootstrap schema. Tables will be created on first manual boot."
} else {
    try {
        $proc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$startScript`"","-SkipBuild" `
            -PassThru -WindowStyle Hidden
        # Poll /api/healthz instead of guessing — on a slow VM the
        # api-server can take 10-20s to come up, and a fixed 6s sleep
        # would race ensureFullSchema's IF NOT EXISTS DDL.
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if ($proc.HasExited) { break }
            try {
                $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($h.StatusCode -eq 200) { $ready = $true; break }
            } catch {
                # keep polling
            }
        }
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            if ($ready) {
                Info "Schema bootstrap completed (server stopped)."
            } else {
                Warn "api-server started but /api/healthz never returned 200. Schema may be partial; check the api-server console."
            }
        } else {
            Warn "api-server exited early (code $($proc.ExitCode)). Check api-server logs and the .env path printed by start-api-host.ps1."
        }
    } catch {
        Warn "Could not auto-bootstrap schema: $_. Tables will be created on first manual boot via start-api-host.ps1."
    }
}

# ── Step 7 — Mint super_admin ──────────────────────────────────────────
Step 7 "Minting first super_admin..."
$adminUser = Read-Host "First super_admin username"
$adminCreated = $false
$plainAdmin = $null
if ([string]::IsNullOrWhiteSpace($adminUser)) {
    Warn "Skipped — no username given. Create one later with reset-admin-password.ps1 + manual insert."
} elseif ($adminUser -notmatch '^[A-Za-z0-9_.\-]{1,64}$') {
    Warn "Refusing to use username '$adminUser' — must match ^[A-Za-z0-9_.-]{1,64}$. Skipped."
} else {
    $adminPw = Read-Host -AsSecureString "Password for '$adminUser' (>=8 chars)"
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPw)
    $plainAdmin = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if ($plainAdmin.Length -lt 8) {
        Warn "Password too short. Skipped."
        $plainAdmin = $null
    } else {
        $bcryptModule = Join-Path $RepoRoot "node_modules\bcryptjs"
        $hash = & node -e "require('$($bcryptModule.Replace('\','/'))').hash(process.argv[1], 12).then(h => process.stdout.write(h));" $plainAdmin
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($hash)) {
            $appUrl = "postgresql://$DbUser`:$encPg`@$DbHost`:$DbPort/$DbName"
            $sqlFile = New-TemporaryFile
            @"
insert into lan_users (id, username, display_name, role, password_hash)
values ('super-' || md5(random()::text || clock_timestamp()::text), '$adminUser', '$adminUser', 'super_admin', `$pw`$$hash`$pw`$)
on conflict do nothing;

insert into audit_log (occurred_at, actor, type, detail)
values (now(), 'first_time_setup', 'lan_super_admin_created',
        jsonb_build_object('username', '$adminUser', 'actor_unknown', true));
"@ | Out-File -FilePath $sqlFile.FullName -Encoding ASCII
            & $PsqlPath $appUrl -f $sqlFile.FullName | Out-Null
            Remove-Item $sqlFile.FullName -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -eq 0) {
                Info "Created super_admin '$adminUser'."
                $adminCreated = $true
            } else {
                Warn "psql insert failed."
                $plainAdmin = $null
            }
        } else {
            Warn "Could not compute bcrypt hash. Skipped."
            $plainAdmin = $null
        }
    }
}

# ── Step 8 — Mint the FIRST peer access token ──────────────────────────
# Boot the api-server briefly (same path the scheduled task uses), log
# in as the super_admin we just created, POST /api/internal/peer-tokens,
# capture the plain token, print it once, and persist it to a file ACL'd
# to local Administrators so the operator can come back to it later.
Step 8 "Minting first peer access token..."
$peerTokenFileShown = $false
if (-not $adminCreated -or [string]::IsNullOrWhiteSpace($plainAdmin)) {
    Warn "Skipping peer token issuance — no super_admin was created in Step 7."
    Warn "Re-run with a valid username/password, or use reset-peer-token.ps1 once a super_admin exists."
} elseif (-not (Test-Path $startScript)) {
    Warn "start-api-host.ps1 not found; cannot mint a peer token. Run reset-peer-token.ps1 once the api-server is running."
} else {
    $apiProc = $null
    try {
        $apiProc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$startScript`"","-SkipBuild" `
            -PassThru -WindowStyle Hidden
        # Poll /api/healthz until ready (max ~20s).
        $ready = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 1
            try {
                $h = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/healthz" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($h.StatusCode -eq 200) { $ready = $true; break }
            } catch {
                # keep polling
            }
        }
        if (-not $ready) {
            Warn "api-server did not become ready on port $ApiPort. Skipping peer token issuance."
        } else {
            $loginBody = @{ username = $adminUser; password = $plainAdmin } | ConvertTo-Json -Compress
            $loginResp = $null
            try {
                $loginResp = Invoke-RestMethod -Method Post `
                    -Uri "http://127.0.0.1:$ApiPort/api/internal/auth/lan/login" `
                    -ContentType "application/json" `
                    -Body $loginBody `
                    -TimeoutSec 10
            } catch {
                Warn "Login as '$adminUser' failed: $_"
            }
            if ($null -ne $loginResp -and $loginResp.token) {
                $sessionTok = [string]$loginResp.token
                $tokenLabel = "$SquadronName initial peer token"
                $createBody = @{ name = $tokenLabel; scope = "squadron-read" } | ConvertTo-Json -Compress
                $createResp = $null
                try {
                    $createResp = Invoke-RestMethod -Method Post `
                        -Uri "http://127.0.0.1:$ApiPort/api/internal/peer-tokens" `
                        -ContentType "application/json" `
                        -Headers @{ "x-hawk-lan-session" = $sessionTok } `
                        -Body $createBody `
                        -TimeoutSec 10
                } catch {
                    Warn "Peer token create failed: $_"
                }
                if ($null -ne $createResp -and $createResp.token) {
                    $plainPeer = [string]$createResp.token
                    $tokenId = if ($createResp.row -and $createResp.row.id) { [string]$createResp.row.id } else { "" }

                    # Persist to a secured file under %PROGRAMDATA%\HawkEye.
                    $tokenDir = Join-Path $env:ProgramData "HawkEye"
                    if (-not (Test-Path $tokenDir)) {
                        New-Item -ItemType Directory -Path $tokenDir -Force | Out-Null
                    }
                    $tokenFile = Join-Path $tokenDir "peer-token-initial.txt"
                    $stamp = Get-Date -Format o
                    @"
# Hawk Eye — initial peer access token for squadron '$SquadronName'.
# Issued: $stamp
# Issued by: $adminUser (super_admin) via first-time-setup.ps1
# Token id: $tokenId
# Scope: squadron-read
#
# Paste the line below on the Wing Commander PC when adding squadron
# '$SquadronName'. Treat it like a password — anyone with this token
# can read this hub's data over the LAN.
#
# To revoke this token: sign in as super_admin and use the dashboard,
# or run scripts\lan-host\reset-peer-token.ps1 to mint a fresh one.

$plainPeer
"@ | Out-File -FilePath $tokenFile -Encoding ASCII

                    # ACL: clear inheritance, grant only Local Administrators
                    # and SYSTEM. icacls returns nonzero on harmless warnings,
                    # so we treat ACL hardening as best-effort and warn.
                    try {
                        & icacls $tokenFile /inheritance:r 2>&1 | Out-Null
                        & icacls $tokenFile /grant:r "BUILTIN\Administrators:(F)" "NT AUTHORITY\SYSTEM:(F)" 2>&1 | Out-Null
                    } catch {
                        Warn "Could not tighten ACL on $tokenFile : $_. Verify permissions manually."
                    }

                    Write-Host ""
                    Write-Host "============================================================" -ForegroundColor Green
                    Write-Host "  INITIAL PEER ACCESS TOKEN for squadron '$SquadronName'" -ForegroundColor Green
                    Write-Host "============================================================" -ForegroundColor Green
                    Write-Host ""
                    Write-Host "  $plainPeer" -ForegroundColor Yellow
                    Write-Host ""
                    Write-Host "  Copy this token now. On the Wing Commander PC, paste it" -ForegroundColor Green
                    Write-Host "  when adding squadron '$SquadronName'." -ForegroundColor Green
                    Write-Host ""
                    Write-Host "  This token is shown ONCE. A copy has also been written to:" -ForegroundColor Green
                    Write-Host "    $tokenFile" -ForegroundColor Green
                    Write-Host "  (Local Administrators only.)" -ForegroundColor Green
                    Write-Host ""
                    Write-Host "  Lost it? Run scripts\lan-host\reset-peer-token.ps1 to" -ForegroundColor Green
                    Write-Host "  mint a fresh one." -ForegroundColor Green
                    Write-Host "============================================================" -ForegroundColor Green
                    Write-Host ""
                    Add-Content -Path $LogFile -Value "$(Get-Date -Format o)  peer token issued (id=$tokenId, label='$tokenLabel') — plain token written to $tokenFile"
                    $peerTokenFileShown = $true

                    # Best-effort logout to invalidate the short-lived
                    # session we created for this single API call.
                    try {
                        Invoke-RestMethod -Method Post `
                            -Uri "http://127.0.0.1:$ApiPort/api/internal/auth/lan/logout" `
                            -Headers @{ "x-hawk-lan-session" = $sessionTok } `
                            -ContentType "application/json" `
                            -Body "{}" `
                            -TimeoutSec 5 | Out-Null
                    } catch {
                        # Non-fatal — session expires on its own in 30 days.
                    }
                }
            }
        }
    } finally {
        if ($apiProc -and -not $apiProc.HasExited) {
            Stop-Process -Id $apiProc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $peerTokenFileShown) {
        Warn "Initial peer token was NOT issued. Once the api-server is running, run:"
        Warn "  scripts\lan-host\reset-peer-token.ps1 -Username '$adminUser'"
    }
}

# Scrub the super_admin password from memory now that we're done with it.
$plainAdmin = $null

# ── Step 9 — Optional mDNS broadcast ───────────────────────────────────
if ($EnableMdns) {
    Step 9 "Registering mDNS broadcast (_hawkeye-hub._tcp + _hawkeye._tcp role=hub)..."
    $mdnsScript = Join-Path $ScriptDir "register-mdns.ps1"
    if (-not (Test-Path $mdnsScript)) {
        Warn "register-mdns.ps1 not found; skipped."
    } else {
        # 1) Legacy hub-only service so older aggregators/viewers can
        #    still find this hub via `<squadron>.local`.
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $mdnsScript `
                -SquadronName $SquadronName -ApiPort $ApiPort `
                -TaskName "HawkEye-Mdns-Hub-OnStartup"
            if ($LASTEXITCODE -ne 0) {
                Warn "register-mdns.ps1 (legacy) exited with code $LASTEXITCODE. Re-run it manually after rebooting if needed."
            }
        } catch {
            Warn "mDNS legacy registration failed: $_. Re-run register-mdns.ps1 manually if you want this hub auto-discovered."
        }
        # 2) Magic LAN auto-discovery (_hawkeye._tcp with role=hub)
        #    so aggregators/viewers ≥1.1.110 can offer one-click pairing.
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $mdnsScript `
                -SquadronName $SquadronName -ApiPort $ApiPort `
                -ServiceType "_hawkeye._tcp" -Role hub `
                -Hostname $env:COMPUTERNAME `
                -TaskName "HawkEye-Mdns-Magic-OnStartup"
            if ($LASTEXITCODE -ne 0) {
                Warn "register-mdns.ps1 (magic LAN) exited with code $LASTEXITCODE. Re-run it manually after rebooting if needed."
            }
        } catch {
            Warn "mDNS magic-LAN registration failed: $_. One-click pairing will fall back to manual setup-aggregator.ps1."
        }
    }
} else {
    Step 9 "Skipping mDNS broadcast (-EnableMdns not passed). Air-gapped sites can leave this off."
}

# ── Step 10 + 11 — Scheduled tasks ─────────────────────────────────────
if ($SkipScheduledTasks) {
    Step 10 "Skipping scheduled tasks (-SkipScheduledTasks)."
} else {
    Step 10 "Registering api-server scheduled task..."
    $apiTask = Join-Path $ScriptDir "install-api-startup-task.ps1"
    $apiTaskName = "HawkEye-ApiServer-OnStartup"
    if (Test-Path $apiTask) {
        & powershell -ExecutionPolicy Bypass -File $apiTask
        # Verify the task can actually start the api-server in SYSTEM
        # context. The most common Windows install bug here is that
        # node/pnpm are installed per-user only, so SYSTEM can't find
        # them on PATH. Run the task NOW (not at next boot) and poll
        # /api/healthz so the operator finds out at install time.
        Info "Triggering '$apiTaskName' once to verify SYSTEM-context startup..."
        & schtasks /Run /TN $apiTaskName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Warn "schtasks /Run exit $LASTEXITCODE — could not trigger the task. Boot will still fire it; check Task Scheduler."
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
                # Stop the test run; on real boot the task will fire again.
                & schtasks /End /TN $apiTaskName 2>&1 | Out-Null
            } else {
                Warn "Task '$apiTaskName' was triggered but /api/healthz never returned 200."
                Warn "Most likely cause: node or pnpm not on the SYSTEM PATH. Re-install Node 'for all users' and re-run."
                Warn "Diagnose with: schtasks /Query /TN $apiTaskName /V /FO LIST"
            }
        }
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
Write-Host "DONE. See OPERATOR-RUNBOOK.md for the rest of the rollout." -ForegroundColor Green
Write-Host "Log: $LogFile" -ForegroundColor Green
if ($currentName -ine $SquadronName) {
    Write-Host ""
    Write-Host "REBOOT REQUIRED so this PC is reachable as '$SquadronName.local' on the LAN." -ForegroundColor Yellow
    Write-Host "Run: shutdown /r /t 0" -ForegroundColor Yellow
}
