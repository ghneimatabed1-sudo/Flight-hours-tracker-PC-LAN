# launch-viewer.ps1
#
# Hawk Eye — viewer launcher (Squadron / Flight Commander laptops).
#
# Pre-checks the squadron hub before opening the dashboard so the
# operator gets a friendly error instead of a generic loading spinner
# when the LAN is broken or the hub PC is off.
#
# Sequence:
#   1. Read .viewer-config.json (written by setup-viewer.ps1).
#   2. GET <hubBaseUrl>/api/healthz with a short timeout.
#      - If unreachable: pop a Windows MessageBox naming the hub and
#        squadron, then exit 2 without launching the browser.
#   3. Start a tiny in-process HTTP listener that serves the prebuilt
#      dist/public folder. Any unknown path falls back to index.html
#      (SPA-friendly).
#   4. Open the dashboard in Edge `--app=` mode (kiosk-style window
#      with no browser chrome). Falls back to Chrome, then to the
#      default browser.
#   5. Wait for the browser to close, then stop the listener.
#
# This launcher does not require Node at runtime — it only needs the
# already-built dist/public folder and Windows PowerShell.

[CmdletBinding()]
param(
    [string]$ViewerConfig = "",
    [int]   $LocalPort    = 0,
    [switch]$NoBrowser     # diagnostic: serve only, don't open the browser
)

$ErrorActionPreference = "Stop"

# WinForms is present on every Desktop Windows SKU but not on Server
# Core / nano. Try to load it once and fall back to a console message
# if the type isn't available — viewers should never run on Core, but
# we'd rather print a usable error than crash here.
$script:HasMsgBox = $false
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop | Out-Null
    $script:HasMsgBox = $true
} catch {
    $script:HasMsgBox = $false
}

function Resolve-RepoRoot {
    $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
        $PSScriptRoot
    } else {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

function Show-FriendlyError {
    param([string]$Message, [string]$Title = "Hawk Eye")
    if ($script:HasMsgBox) {
        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            $Title,
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
    } else {
        Write-Host ""
        Write-Host "[$Title]" -ForegroundColor Red
        Write-Host $Message -ForegroundColor Red
    }
}

# ── Step 1 — Load viewer config ──────────────────────────────────────
$RepoRoot = Resolve-RepoRoot
if (-not $ViewerConfig) {
    $ViewerConfig = Join-Path $RepoRoot "artifacts\pilot-dashboard\.viewer-config.json"
}
if (-not (Test-Path $ViewerConfig)) {
    Show-FriendlyError -Title "Hawk Eye — viewer not configured" -Message @"
This PC has not been set up as a Hawk Eye viewer yet.

Missing config file:
  $ViewerConfig

Run setup-viewer.ps1 first.
"@
    exit 1
}

$conf = Get-Content -Raw -Path $ViewerConfig | ConvertFrom-Json
$hubBaseUrl   = [string]$conf.hubBaseUrl
$squadronName = [string]$conf.squadronName
$distRoot     = [string]$conf.distRoot
if ($LocalPort -le 0) { $LocalPort = [int]$conf.localPort }
if ($LocalPort -le 0) { $LocalPort = 5500 }

if (-not (Test-Path (Join-Path $distRoot "index.html"))) {
    Show-FriendlyError -Title "Hawk Eye — bundle missing" -Message @"
The local dashboard bundle is missing from:
  $distRoot

Re-run setup-viewer.ps1 (or change-viewer-hub.ps1) to rebuild.
"@
    exit 1
}

# ── Step 2 — Pre-check hub ───────────────────────────────────────────
$hubLabel = if ($squadronName) { "$squadronName hub at $hubBaseUrl" } else { "the hub at $hubBaseUrl" }
$probeUrl = "$hubBaseUrl/api/healthz"

$reachable = $false
$reason    = ""
try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $probeUrl -TimeoutSec 6 -Method GET
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
        $body = $resp.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($body -and $body.installProfile -eq "hub") {
            $reachable = $true
        } else {
            $reason = "the hub responded but is not in 'hub' mode (got '$($body.installProfile)')."
        }
    } else {
        $reason = "the hub returned HTTP $($resp.StatusCode)."
    }
} catch {
    $reason = "the hub did not respond ($($_.Exception.Message))."
}

if (-not $reachable) {
    Show-FriendlyError -Title "Hawk Eye — cannot reach the hub" -Message @"
Cannot reach $hubLabel — $reason

Check the network or contact your Ops Pilot.
"@
    exit 2
}

# ── Step 3 — Tiny static HTTP listener for dist/public ───────────────
$listener = New-Object System.Net.HttpListener
$prefix   = "http://127.0.0.1:$LocalPort/"
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    # HttpListener.Start() can fail for two completely different
    # reasons that need different fixes:
    #
    #   * HttpListenerException ErrorCode 5  → Access Denied
    #     The current user has no URL ACL reservation for this prefix.
    #     setup-viewer.ps1 Step 5b registers the ACL during install,
    #     but if the viewer was unzipped manually or the install was
    #     never elevated, we land here.
    #
    #   * HttpListenerException ErrorCode 32 / 183 → port in use
    #     Another process owns the port; user must free it or pick
    #     another with -LocalPort.
    #
    # Showing one generic "port busy" message for both is what kept
    # field operators stuck. Distinguish them.
    $inner = $_.Exception
    while ($inner -and -not ($inner -is [System.Net.HttpListenerException])) {
        $inner = $inner.InnerException
    }
    $code = if ($inner) { $inner.ErrorCode } else { 0 }
    if ($code -eq 5) {
        Show-FriendlyError -Title "Hawk Eye — launcher needs URL permission" -Message @"
Could not bind to $prefix because Windows refused (Access Denied,
HRESULT 5). This means there is no URL ACL reservation for the
current user account.

Fix on this PC by running ONE of the following from an elevated
PowerShell:

    netsh http add urlacl url=$prefix user="BUILTIN\Users"

…or re-run setup-viewer.ps1 from an elevated shell — it registers
the reservation in Step 5b.
"@
        exit 5
    } elseif ($code -eq 32 -or $code -eq 183) {
        Show-FriendlyError -Title "Hawk Eye — local launcher port busy" -Message @"
Could not bind to $prefix

Another program is already using port $LocalPort. Close it or pass
-LocalPort <free-port> to launch-viewer.ps1.
"@
        exit 3
    } else {
        Show-FriendlyError -Title "Hawk Eye — launcher could not start" -Message @"
Could not bind to $prefix

$($_.Exception.Message)

Try -LocalPort <free-port> or contact your Ops Pilot.
"@
        exit 4
    }
}

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".mjs"  = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".gif"  = "image/gif"
    ".ico"  = "image/x-icon"
    ".woff" = "font/woff"
    ".woff2"= "font/woff2"
    ".ttf"  = "font/ttf"
    ".webmanifest" = "application/manifest+json"
    ".map"  = "application/json"
    ".txt"  = "text/plain; charset=utf-8"
}

# Background runspace so the listener loop doesn't block the foreground
# (which is the bit that launches the browser and waits for it to exit).
$rs = [runspacefactory]::CreateRunspace()
$rs.ApartmentState = "MTA"
$rs.ThreadOptions  = "ReuseThread"
$rs.Open()
$rs.SessionStateProxy.SetVariable("listener", $listener)
$rs.SessionStateProxy.SetVariable("distRoot", $distRoot)
$rs.SessionStateProxy.SetVariable("mime", $mime)

$ps = [powershell]::Create()
$ps.Runspace = $rs
[void]$ps.AddScript({
    param()
    while ($listener.IsListening) {
        try {
            $ctx = $listener.GetContext()
        } catch {
            break
        }
        try {
            $req = $ctx.Request
            $res = $ctx.Response
            $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
            if ($rel -eq "/" -or [string]::IsNullOrEmpty($rel)) { $rel = "/index.html" }
            # Strip leading slash and refuse any path-traversal attempt.
            $relTrim = $rel.TrimStart("/")
            if ($relTrim.Contains("..")) {
                $res.StatusCode = 400
                $res.Close()
                continue
            }
            $abs = Join-Path $distRoot $relTrim
            if (-not (Test-Path $abs -PathType Leaf)) {
                # SPA fallback — serve index.html for unknown routes so
                # client-side routing (BrowserRouter) keeps working.
                $abs = Join-Path $distRoot "index.html"
            }
            $ext = [System.IO.Path]::GetExtension($abs).ToLowerInvariant()
            $contentType = $mime[$ext]
            if (-not $contentType) { $contentType = "application/octet-stream" }
            $bytes = [System.IO.File]::ReadAllBytes($abs)
            $res.StatusCode = 200
            $res.ContentType = $contentType
            $res.ContentLength64 = $bytes.LongLength
            # Disable caching — the bundle has hashed filenames already
            # and we want a re-launch to immediately reflect a rebuild.
            $res.Headers["Cache-Control"] = "no-store"
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            $res.Close()
        } catch {
            try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
        }
    }
})
$asyncResult = $ps.BeginInvoke()

$localUrl = "http://127.0.0.1:$LocalPort/"
Write-Host "[hawk-eye] Serving $distRoot at $localUrl"
Write-Host "[hawk-eye] Hub:      $hubBaseUrl"

if ($NoBrowser) {
    Write-Host "[hawk-eye] -NoBrowser — listener up. Press Ctrl+C to stop."
    while ($listener.IsListening) { Start-Sleep -Seconds 1 }
    exit 0
}

# ── Step 4 — Launch a kiosk-style browser window ─────────────────────
$browserCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$browser = $null
foreach ($cand in $browserCandidates) {
    if (Test-Path $cand) { $browser = $cand; break }
}

$proc = $null
try {
    if ($browser) {
        $title = if ($squadronName) { "Hawk Eye - $squadronName" } else { "Hawk Eye" }
        $userDataDir = Join-Path $env:LOCALAPPDATA "HawkEyeViewer\BrowserProfile"
        if (-not (Test-Path $userDataDir)) { New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null }
        $proc = Start-Process -FilePath $browser `
            -ArgumentList "--app=$localUrl","--user-data-dir=$userDataDir","--window-size=1400,900","--no-first-run","--no-default-browser-check" `
            -PassThru
    } else {
        # Fallback: default browser, normal window.
        $proc = Start-Process -FilePath $localUrl -PassThru
    }

    if ($proc) {
        Write-Host "[hawk-eye] Browser launched (PID $($proc.Id)). Closing the window will stop the launcher."
        $proc.WaitForExit()
    } else {
        Write-Host "[hawk-eye] Could not launch a browser process. Press Ctrl+C to stop."
        while ($listener.IsListening) { Start-Sleep -Seconds 1 }
    }
} finally {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
    try { $ps.Stop() } catch {}
    try { $ps.Dispose() } catch {}
    try { $rs.Close(); $rs.Dispose() } catch {}
}

exit 0
