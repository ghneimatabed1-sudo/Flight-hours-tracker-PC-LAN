# setup-viewer.ps1
#
# Hawk Eye — Squadron / Flight Commander laptop install wizard.
#
# Viewer PCs are pure dashboard clients. They do NOT install Postgres
# and do NOT run the api-server. They build (or copy) the dashboard
# locally so the laptop has cached UI assets, then point it at the
# squadron's hub PC over the LAN. Login still happens against the hub
# with the user's normal username/password.
#
# What this script does:
#   1. Asks (or accepts via -HubAddress) for the squadron hub address.
#   2. Optional -AutoDiscover scans the LAN for `_hawkeye-hub._tcp`
#      via Bonjour (`dns-sd.exe`) and offers a pick-list. Manual entry
#      still works when nothing is found or Bonjour isn't installed.
#   3. Validates by hitting `http://<address>:<port>/api/healthz` and
#      confirming `installProfile === "hub"`. Refuses to proceed if
#      the hub doesn't respond or responds with a non-hub profile.
#   4. Writes artifacts/pilot-dashboard/.env.production.local with
#      VITE_INTERNAL_API_URL pinned to the hub.
#   5. Builds the dashboard (or copies a -PrebuiltDist folder you
#      shipped on USB). Vite bakes VITE_INTERNAL_API_URL into the
#      bundle, so the dashboard talks to the right hub even if the
#      .env file is later removed.
#   6. Records the resolved hub config to .viewer-config.json next
#      to dist/public so launch-viewer.ps1 + change-viewer-hub.ps1
#      can read the same canonical settings.
#   7. Registers a Windows desktop shortcut + Start Menu entry that
#      run launch-viewer.ps1 (which pre-checks the hub and opens
#      the dashboard in a kiosk-style browser window).
#   8. Confirms in the output that this PC is a viewer — no Postgres,
#      no api-server, no local data.
#
# Run from an elevated PowerShell window. Re-running is safe: every
# step overwrites the env, the bundle, and the shortcuts in place.

[CmdletBinding()]
param(
    [string]$HubAddress    = "",
    [int]   $HubPort       = 3847,
    [switch]$AutoDiscover,
    [string]$SquadronName  = "",
    [int]   $LocalPort     = 5500,
    [string]$PrebuiltDist  = "",
    [switch]$SkipBuild,
    [switch]$SkipShortcuts,
    # Magic LAN auto-discovery: announce this viewer on `_hawkeye._tcp`
    # with role=viewer so a Hub super_admin can see active viewers in
    # their dashboard. Off by default; pass on sites that allow
    # multicast. Note: viewers do NOT run an api-server, so this is
    # informational only — viewers can't accept inbound pairing.
    [switch]$EnableMdns
)

$ErrorActionPreference = "Stop"

# ── Shared helpers ────────────────────────────────────────────────────
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
    # Accept dotted hostnames (`tigers-hub.local`), bare hostnames,
    # IPv4 addresses, or simple `host:port` (we strip :port before
    # this check). Anything with whitespace or shell-meaningful
    # characters is rejected.
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return $Value -match '^[A-Za-z0-9._\-:]{1,253}$'
}

function Step($n, $msg) {
    Write-Host ""
    Write-Host "[STEP $n] $msg" -ForegroundColor Cyan
}
function Info($msg) { Write-Host "       $msg" }
function Warn($msg) { Write-Host "       [WARN] $msg" -ForegroundColor Yellow }
function Fail($msg, $code) {
    Write-Host ""
    Write-Host "[FAIL] $msg" -ForegroundColor Red
    exit $code
}

# ── mDNS auto-discovery via Bonjour `dns-sd.exe` ──────────────────────
function Invoke-MdnsHubDiscovery {
    param([int]$TimeoutSeconds = 4)

    $dnsSd = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($null -eq $dnsSd) {
        Warn "dns-sd.exe not found (Bonjour Print Services for Windows is not installed). Falling back to manual entry."
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
        $lines = Get-Content $tmp.FullName -ErrorAction SilentlyContinue
        Remove-Item $tmp.FullName -ErrorAction SilentlyContinue
        # dns-sd -B output format:
        # Timestamp  A/R Flags if Domain                Service Type     Instance Name
        # 13:01:02.111 Add 2 12 local.                 _hawkeye-hub._tcp.  tigers-hub
        foreach ($line in $lines) {
            if ($line -match '\bAdd\b\s+\d+\s+\d+\s+\S+\s+_hawkeye-hub\._tcp\.\s+(.+?)\s*$') {
                $name = $matches[1].Trim()
                if ($name -and ($instances -notcontains $name)) {
                    $instances += $name
                }
            }
        }
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

# ── Hub validation ────────────────────────────────────────────────────
function Update-DashboardCsp {
    # The dashboard's index.html ships a defence-in-depth CSP whose
    # `connect-src` only allows the Supabase / replit.app origins it
    # was authored against. A LAN viewer talks to a private host like
    # http://tigers-hub.local:3847, which the browser will block
    # unless we add that exact origin to `connect-src` and (for
    # potential realtime channels in future) the matching ws:// scheme.
    # We patch the EMITTED dist/public/index.html so the bundle the
    # viewer launcher serves at 127.0.0.1 can talk to the hub.
    param(
        [Parameter(Mandatory)] [string]$IndexHtmlPath,
        [Parameter(Mandatory)] [string]$HubOrigin   # e.g. http://tigers-hub.local:3847
    )
    if (-not (Test-Path $IndexHtmlPath)) {
        Fail "Cannot patch CSP — $IndexHtmlPath does not exist." 25
    }
    $html = Get-Content -Raw -Path $IndexHtmlPath
    if ($html -notmatch 'http-equiv=["'']Content-Security-Policy["'']') {
        Warn "No CSP meta tag found in $IndexHtmlPath — skipping patch (the bundle may not be ours)."
        return
    }
    $wsOrigin = $HubOrigin -replace '^http://','ws://' -replace '^https://','wss://'
    # Replace the connect-src directive in-place. Idempotent: matches
    # the existing connect-src, parses it, adds our two origins if
    # missing, writes it back.
    $patched = [regex]::Replace($html, "(connect-src)([^;]*);", {
        param($m)
        $tokens = $m.Groups[2].Value.Trim() -split '\s+' | Where-Object { $_ -ne "" }
        $set = New-Object System.Collections.Generic.HashSet[string]
        foreach ($t in $tokens) { [void]$set.Add($t) }
        [void]$set.Add($HubOrigin)
        [void]$set.Add($wsOrigin)
        return "connect-src " + ($set -join ' ') + ";"
    }, 1)
    if ($patched -eq $html) {
        Info "CSP already includes $HubOrigin — no change."
    } else {
        Set-Content -Path $IndexHtmlPath -Value $patched -Encoding UTF8 -NoNewline
        Info "Patched CSP connect-src in $IndexHtmlPath to include $HubOrigin (+$wsOrigin)."
    }
}

function Test-DashboardBundleTargetsHub {
    # Vite bakes VITE_INTERNAL_API_URL into the JS at build time.
    # When the operator passes -PrebuiltDist or -SkipBuild we have to
    # confirm the bundle was actually built against the hub the
    # operator is asking us to point at — otherwise the dashboard
    # will silently call a different hub no matter what env file we
    # write. We grep assets/*.js (and the few other text files in
    # dist) for the configured base URL; if it isn't present the
    # bundle was built for a different hub and we refuse to install.
    param(
        [Parameter(Mandatory)] [string]$DistRoot,
        [Parameter(Mandatory)] [string]$ExpectedBaseUrl
    )
    $files = Get-ChildItem -Path $DistRoot -Recurse -File -Include "*.js","*.mjs","*.html","*.json" -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        try {
            $needle = $ExpectedBaseUrl
            # Use Select-String for streaming match; -SimpleMatch avoids
            # treating dots/colons in the URL as regex metachars.
            if (Select-String -Path $f.FullName -SimpleMatch -Pattern $needle -Quiet -ErrorAction SilentlyContinue) {
                return $true
            }
        } catch { continue }
    }
    return $false
}

function Test-HubReachable {
    param([string]$BaseUrl)
    $url = "$BaseUrl/api/healthz"
    Info "Probing $url ..."
    try {
        # -UseBasicParsing avoids IE engine dep on Server Core.
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 6 -Method GET
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = "no response: $($_.Exception.Message)"; Profile = $null }
    }
    if ($resp.StatusCode -lt 200 -or $resp.StatusCode -ge 300) {
        return [pscustomobject]@{ Ok = $false; Reason = "HTTP $($resp.StatusCode)"; Profile = $null }
    }
    $installProfile = $null
    try {
        $body = $resp.Content | ConvertFrom-Json -ErrorAction Stop
        $installProfile = [string]$body.installProfile
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = "non-JSON healthz body"; Profile = $null }
    }
    if ($installProfile -ne "hub") {
        return [pscustomobject]@{ Ok = $false; Reason = "installProfile='$installProfile' (expected 'hub')"; Profile = $installProfile }
    }
    return [pscustomobject]@{ Ok = $true; Reason = ""; Profile = $installProfile }
}

# ── Begin ─────────────────────────────────────────────────────────────
$RepoRoot       = Resolve-RepoRoot
$DashRoot       = Join-Path $RepoRoot "artifacts\pilot-dashboard"
$DashEnvFile    = Join-Path $DashRoot ".env.production.local"
$DashDistRoot   = Join-Path $DashRoot "dist\public"
$ViewerConfFile = Join-Path $DashRoot ".viewer-config.json"

Write-Host ""
Write-Host "Hawk Eye — viewer install (Squadron / Flight Commander laptop)" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green

# ── Step 1 — Resolve hub address ──────────────────────────────────────
Step 1 "Resolve squadron hub address"

if ($AutoDiscover -and -not $HubAddress) {
    $found = Invoke-MdnsHubDiscovery
    if ($found.Count -gt 0) {
        Write-Host "       Found hubs on the LAN:"
        for ($i = 0; $i -lt $found.Count; $i++) {
            Write-Host ("         [{0}] {1}" -f ($i + 1), $found[$i])
        }
        Write-Host "         [m] Enter address manually"
        $pick = Read-Host "       Pick a hub by number (or 'm' for manual)"
        if ($pick -match '^[0-9]+$') {
            $idx = [int]$pick - 1
            if ($idx -ge 0 -and $idx -lt $found.Count) {
                $resolved = Resolve-MdnsInstance -InstanceName $found[$idx]
                if ($resolved) {
                    $HubAddress = $resolved.Host
                    if ($resolved.Port) { $HubPort = $resolved.Port }
                    Info "Resolved $($found[$idx]) -> $HubAddress`:$HubPort"
                } else {
                    Warn "Could not resolve '$($found[$idx])' via Bonjour. Falling back to manual entry."
                }
            }
        }
    } else {
        Warn "No hubs advertised _hawkeye-hub._tcp on the LAN."
    }
}

if (-not $HubAddress) {
    $HubAddress = Read-Host "       Squadron hub address (hostname or IP, e.g. tigers-hub.local)"
}

# Strip optional :port from the address and prefer it over $HubPort.
if ($HubAddress -match '^(?<host>[^:]+):(?<port>\d+)$') {
    $HubAddress = $matches['host']
    $HubPort    = [int]$matches['port']
}

$HubAddress = $HubAddress.Trim()
if (-not (Test-HostnameOrIp $HubAddress)) {
    Fail "Refusing to use hub address '$HubAddress' — not a valid hostname/IP." 20
}
if ($HubPort -lt 1 -or $HubPort -gt 65535) {
    Fail "Refusing to use port '$HubPort' — out of range." 20
}

$BaseUrl = "http://$HubAddress`:$HubPort"
Info "Using hub URL: $BaseUrl"

# ── Step 2 — Validate hub ─────────────────────────────────────────────
Step 2 "Validate hub via /api/healthz"
$probe = Test-HubReachable -BaseUrl $BaseUrl
if (-not $probe.Ok) {
    Fail "Hub at $BaseUrl is not a usable Hawk Eye hub: $($probe.Reason)" 21
}
Info "OK — $BaseUrl reports installProfile='$($probe.Profile)'."

# ── Step 3 — Write dashboard env ──────────────────────────────────────
Step 3 "Write dashboard env override ($([System.IO.Path]::GetFileName($DashEnvFile)))"
@"
# Generated by setup-viewer.ps1 on $(Get-Date -Format o)
# Squadron hub: $BaseUrl
VITE_LAN_SESSION_LOGIN=1
VITE_INTERNAL_API_URL=$BaseUrl
VITE_LAN_NO_AUTH=0
"@ | Out-File -FilePath $DashEnvFile -Encoding ASCII
Info "Wrote $DashEnvFile"

# ── Step 4 — Build (or copy prebuilt) ────────────────────────────────
Step 4 "Provision dashboard bundle"

$builtFresh = $false
if ($PrebuiltDist) {
    $src = (Resolve-Path $PrebuiltDist -ErrorAction SilentlyContinue)
    if (-not $src) { Fail "PrebuiltDist '$PrebuiltDist' does not exist." 22 }
    Info "Copying prebuilt dashboard from $($src.Path) -> $DashDistRoot"
    if (Test-Path $DashDistRoot) {
        Remove-Item -Recurse -Force $DashDistRoot
    }
    New-Item -ItemType Directory -Force -Path $DashDistRoot | Out-Null
    Copy-Item -Recurse -Force (Join-Path $src.Path "*") $DashDistRoot
    Info "Copy complete."
} elseif ($SkipBuild) {
    if (-not (Test-Path (Join-Path $DashDistRoot "index.html"))) {
        Fail "-SkipBuild was passed but $DashDistRoot\index.html does not exist." 23
    }
    Info "-SkipBuild — using existing $DashDistRoot."
} else {
    Info "Building dashboard via pnpm (this can take a minute)..."
    Push-Location $RepoRoot
    try {
        # vite.config.ts requires PORT and BASE_PATH at config time.
        $env:PORT      = "$LocalPort"
        $env:BASE_PATH = "/"
        $env:NODE_ENV  = "production"
        & pnpm --filter @workspace/pilot-dashboard run build
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Fail "Dashboard build failed (pnpm exit $LASTEXITCODE)." 24
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path (Join-Path $DashDistRoot "index.html"))) {
        Fail "Build finished but $DashDistRoot\index.html is missing." 24
    }
    Info "Build complete: $DashDistRoot"
    $builtFresh = $true
}

# ── Step 4b — Verify the bundle actually targets this hub ────────────
# Vite bakes VITE_INTERNAL_API_URL at build time. A fresh build we
# just ran with the right env file is guaranteed to be correct, but
# -PrebuiltDist and -SkipBuild paths could ship a bundle aimed at a
# different hub — refuse to install in that case so the operator
# isn't left with a viewer that silently calls the wrong squadron.
if (-not $builtFresh) {
    Info "Verifying bundle was built against $BaseUrl..."
    if (-not (Test-DashboardBundleTargetsHub -DistRoot $DashDistRoot -ExpectedBaseUrl $BaseUrl)) {
        Fail @"
The dashboard bundle in $DashDistRoot does not contain the configured
hub URL ($BaseUrl). Vite bakes VITE_INTERNAL_API_URL into the JS at
build time, so a bundle built for a different hub will keep calling
that other hub no matter what env file we write here.

Either rebuild on this PC (omit -PrebuiltDist / -SkipBuild) or supply
a -PrebuiltDist that was built with VITE_INTERNAL_API_URL=$BaseUrl.
"@ 26
    }
    Info "OK — bundle references $BaseUrl."
}

# ── Step 4c — Patch dist/public/index.html CSP ───────────────────────
# Ensure the LAN hub origin is in `connect-src` so the browser
# actually permits the dashboard's fetch() / WebSocket calls. The
# bundled index.html restricts connect-src to Supabase + replit.app
# origins by default; a private LAN host wouldn't pass that check.
Update-DashboardCsp -IndexHtmlPath (Join-Path $DashDistRoot "index.html") -HubOrigin $BaseUrl

# ── Step 5 — Record viewer config ─────────────────────────────────────
Step 5 "Record viewer config ($([System.IO.Path]::GetFileName($ViewerConfFile)))"
$conf = [ordered]@{
    hubAddress    = $HubAddress
    hubPort       = $HubPort
    hubBaseUrl    = $BaseUrl
    squadronName  = $SquadronName
    localPort     = $LocalPort
    distRoot      = $DashDistRoot
    configuredAt  = (Get-Date).ToString("o")
}
$conf | ConvertTo-Json -Depth 4 | Out-File -FilePath $ViewerConfFile -Encoding ASCII
Info "Wrote $ViewerConfFile"

# ── Step 5b — Reserve the launcher URL ACL ───────────────────────────
# launch-viewer.ps1 binds System.Net.HttpListener to
# http://127.0.0.1:<LocalPort>/. On Windows that requires either:
#   (a) the launcher running as administrator, OR
#   (b) a netsh URL ACL reservation for the current user / Users group.
# The desktop shortcut runs as a normal user, so without (b) every
# launch fails with HRESULT 5 (Access Denied) — which is impossible to
# diagnose from the friendly MessageBox alone. We register the
# reservation here while we still have the elevated install shell.
Step "5b" "Reserving HTTP URL ACL for the launcher"
$urlAclTarget = "http://127.0.0.1:$LocalPort/"
try {
    # Idempotent: delete any prior reservation (returns nonzero if
    # there isn't one — that's fine), then add a fresh one for the
    # built-in Users group so the per-user shortcut can bind.
    & netsh http delete urlacl url=$urlAclTarget 2>&1 | Out-Null
    $aclOut = & netsh http add urlacl url=$urlAclTarget user="BUILTIN\Users" 2>&1
    if ($LASTEXITCODE -eq 0) {
        Info "Reserved $urlAclTarget for BUILTIN\Users."
    } else {
        Warn "netsh add urlacl exit $LASTEXITCODE: $aclOut"
        Warn "If the launcher fails with 'Access Denied', re-run setup-viewer.ps1 from an elevated shell."
    }
} catch {
    Warn "Could not reserve URL ACL: $_. Launcher may need to run as administrator."
}

# ── Step 6 — Shortcuts ───────────────────────────────────────────────
Step 6 "Register desktop + Start Menu shortcuts"
if ($SkipShortcuts) {
    Info "-SkipShortcuts — skipping shortcut registration."
} else {
    $launcher = Join-Path $PSScriptRoot "launch-viewer.ps1"
    if (-not (Test-Path $launcher)) {
        Warn "launch-viewer.ps1 not found at $launcher — shortcuts not created."
    } else {
        $label = if ($SquadronName) { "Hawk Eye — $SquadronName" } else { "Hawk Eye Viewer" }
        $desktopDir = [Environment]::GetFolderPath("Desktop")
        $startDir   = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "Microsoft\Windows\Start Menu\Programs\Hawk Eye"
        if (-not (Test-Path $startDir)) { New-Item -ItemType Directory -Force -Path $startDir | Out-Null }

        $targets = @(
            (Join-Path $desktopDir "$label.lnk"),
            (Join-Path $startDir   "$label.lnk")
        )
        $shell = New-Object -ComObject WScript.Shell
        foreach ($lnkPath in $targets) {
            $sc = $shell.CreateShortcut($lnkPath)
            $sc.TargetPath  = (Get-Command powershell.exe).Source
            $sc.Arguments   = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
            $sc.WorkingDirectory = $PSScriptRoot
            $sc.IconLocation = "$((Get-Command powershell.exe).Source),0"
            $sc.Description  = "Open the Hawk Eye dashboard against $BaseUrl"
            $sc.WindowStyle  = 7  # Minimized — launcher pops the browser itself.
            $sc.Save()
            Info "Wrote shortcut $lnkPath"
        }
    }
}

# ── Step 6b — Optional magic-LAN announce (_hawkeye._tcp role=viewer) ─
if ($EnableMdns) {
    Info "Registering magic-LAN announce (_hawkeye._tcp role=viewer)..."
    $mdnsScript = Join-Path $PSScriptRoot "register-mdns.ps1"
    if (-not (Test-Path $mdnsScript)) {
        Warn "register-mdns.ps1 not found; skipped."
    } else {
        try {
            $instanceName = "$($env:COMPUTERNAME)"
            # Viewers don't host an api-server — advertise the local
            # dashboard port so operators inspecting the broadcast
            # see something meaningful.
            & powershell -NoProfile -ExecutionPolicy Bypass -File $mdnsScript `
                -SquadronName $instanceName -ApiPort $LocalPort `
                -ServiceType "_hawkeye._tcp" -Role viewer `
                -Hostname $env:COMPUTERNAME `
                -TaskName "HawkEye-Mdns-Magic-OnStartup"
            if ($LASTEXITCODE -ne 0) {
                Warn "register-mdns.ps1 exited with code $LASTEXITCODE."
            } else {
                Info "OK — this viewer now announces on _hawkeye._tcp."
            }
        } catch {
            Warn "mDNS registration failed: $_."
        }
    }
}

# ── Step 7 — Confirmation ────────────────────────────────────────────
Write-Host ""
Write-Host "DONE. This PC is a viewer — it does not store any data locally." -ForegroundColor Green
Write-Host "  - No Postgres installed by this script."
Write-Host "  - No api-server installed by this script."
Write-Host "  - All login + read/write goes to: $BaseUrl"
Write-Host ""
Write-Host "Launch the dashboard from the desktop shortcut, or run:"
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'launch-viewer.ps1')`""
exit 0
