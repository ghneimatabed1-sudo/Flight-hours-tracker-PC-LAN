# register-mdns.ps1
#
# Hawk Eye — optional mDNS / Bonjour broadcast for any Hawk Eye PC
# (hub / aggregator-wing / aggregator-base / viewer).
#
# Service type:
#   * Default (back-compat with installs ≤1.1.x)  : `_hawkeye-hub._tcp`
#     — used by the legacy hub-only `<squadron>.local` discovery path.
#   * Magic LAN auto-discovery (T-R, default for >=1.1.110) :
#     `_hawkeye._tcp` with role-aware TXT records. Every Hawk Eye PC
#     advertises on this name; aggregators / viewers browse it to
#     auto-discover the squadron Hub on first launch and offer the
#     operator a one-click pairing card.
#
# TXT records advertised when -ServiceType "_hawkeye._tcp":
#   role=hub|aggregator-wing|aggregator-base|viewer
#   wing=<wing-name-or-empty>
#   base=<base-name-or-empty>
#   hostname=<computer-name>
#   version=<app-semver>
#
# OFF by default. Pass `-EnableMdns` to first-time-setup.ps1, or run
# this script directly, only on sites where mDNS is allowed on the LAN
# (some MOD networks deliberately block multicast). Air-gapped sites can
# leave it off and operators can still pair manually via setup-aggregator.ps1.
#
# Implementation: registers a SYSTEM-context scheduled task at boot
# that runs `mdns-supervisor.ps1`. The supervisor wraps the actual
# `dns-sd.exe -R "<name>" <serviceType> local <port> [TXT…]` call in a
# watchdog loop so that if dns-sd.exe is killed (OOM, manual kill,
# console session close, crash) it respawns within ~5s (capped at 60s
# on repeated rapid failures). dns-sd.exe ships portable in
# `installer/bonjour-portable/` (vendored) and is also available from
# Apple's Bonjour Print Services package; on a stripped-down PC
# without either, this script warns and exits cleanly so the operator
# can install Bonjour and re-run.
#
# Operators can verify the broadcast is alive at any time without
# RDP'ing to the host via:
#     scripts\lan-host\check-mdns-health.ps1
# The supervisor writes a heartbeat file at
#     %PROGRAMDATA%\HawkEye\mdns-supervisor.heartbeat
# and a rolling log at
#     %PROGRAMDATA%\HawkEye\mdns-supervisor.log
#
# Usage (legacy hub-only):
#   .\register-mdns.ps1 -SquadronName "tigers-hub" -ApiPort 3847
#
# Usage (T-R magic LAN auto-discovery, all roles):
#   .\register-mdns.ps1 -SquadronName "tigers-hub" -ApiPort 3847 `
#       -ServiceType "_hawkeye._tcp" -Role hub `
#       -Wing "1st-air-wing" -Base "azraq-ab" `
#       -Hostname "HUB-PC-01" -AppVersion "1.1.110"
#
# Unregister:
#   .\register-mdns.ps1 -SquadronName "tigers-hub" -Unregister

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SquadronName,

    [string]$ApiPort  = "3847",
    [string]$TaskName = "HawkEye-Mdns-OnStartup",
    [string]$DnsSdPath = "",

    # Service type to advertise. Default keeps back-compat with the
    # ≤1.1.x hub-only discovery path. Magic LAN auto-discovery passes
    # `_hawkeye._tcp` along with `-Role`.
    [ValidateSet("_hawkeye-hub._tcp", "_hawkeye._tcp")]
    [string]$ServiceType = "_hawkeye-hub._tcp",

    # Role of this PC. Required when -ServiceType is `_hawkeye._tcp`,
    # ignored otherwise. The four valid roles match the install-profile
    # values resolved by the api-server.
    [ValidateSet("", "hub", "aggregator-wing", "aggregator-base", "viewer")]
    [string]$Role = "",

    [string]$Wing       = "",
    [string]$Base       = "",
    [string]$Hostname   = "",
    [string]$AppVersion = "",

    [switch]$Unregister
)

$ErrorActionPreference = "Stop"

if ($SquadronName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$' -or
    $SquadronName.Length -gt 15 -or
    $SquadronName -match '^[0-9]+$') {
    Write-Error "Invalid -SquadronName '$SquadronName' — must be 1-15 chars [A-Za-z0-9-], no leading/trailing hyphen, not all digits."
    exit 2
}
if ($ApiPort -notmatch '^[0-9]{1,5}$') {
    Write-Error "Invalid -ApiPort '$ApiPort'."
    exit 2
}
if ($ServiceType -eq "_hawkeye._tcp" -and [string]::IsNullOrWhiteSpace($Role)) {
    Write-Error "-ServiceType _hawkeye._tcp requires -Role hub|aggregator-wing|aggregator-base|viewer."
    exit 2
}

if ($Unregister) {
    Write-Host "[hawk-eye] Stopping any running supervisor instance: $TaskName"
    schtasks /End /TN "$TaskName" 2>&1 | Out-Null
    Write-Host "[hawk-eye] Removing scheduled task: $TaskName"
    schtasks /Delete /F /TN "$TaskName" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not delete task (it may not exist). Exit code: $LASTEXITCODE"
        exit 0
    }
    # Best-effort: also kill the specific dns-sd.exe child that this
    # supervisor was running, so peers stop seeing this PC immediately
    # rather than at the next OS-level mDNS cache expiry.
    $heartbeatFile = Join-Path $env:ProgramData "HawkEye\mdns-supervisor.heartbeat"
    if (Test-Path $heartbeatFile) {
        try {
            $hb = (Get-Content -Path $heartbeatFile -Raw -ErrorAction Stop) | ConvertFrom-Json
            if ($hb.childPid -and [int]$hb.childPid -gt 0) {
                $childPid = [int]$hb.childPid
                $proc = Get-Process -Id $childPid -ErrorAction SilentlyContinue
                if ($proc -and $proc.ProcessName -like "dns-sd*") {
                    try {
                        Stop-Process -Id $childPid -Force -ErrorAction Stop
                        Write-Host "[hawk-eye] Stopped supervised dns-sd.exe (pid=$childPid)."
                    } catch {
                        Write-Warning "Could not stop dns-sd.exe pid=$childPid : $($_.Exception.Message)"
                    }
                }
            }
        } catch {
            Write-Warning "Could not read heartbeat file to identify child dns-sd.exe: $($_.Exception.Message)"
        }
    }
    Write-Host "[hawk-eye] mDNS broadcast task removed."
    exit 0
}

# Locate dns-sd.exe. Search order:
#   1. -DnsSdPath param
#   2. anywhere on PATH (Bonjour Print Services adds itself; the
#      installer prepends the vendored bonjour-portable\ directory
#      so PATH-resolution works on stripped-down PCs)
#   3. standard Bonjour install dirs
if ([string]::IsNullOrWhiteSpace($DnsSdPath)) {
    $found = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($found) {
        $DnsSdPath = $found.Source
    } else {
        $candidates = @(
            "C:\Program Files\Bonjour\dns-sd.exe",
            "C:\Program Files (x86)\Bonjour\dns-sd.exe",
            (Join-Path $env:ProgramFiles "HawkEye\bonjour-portable\dns-sd.exe")
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { $DnsSdPath = $c; break }
        }
    }
}
if ([string]::IsNullOrWhiteSpace($DnsSdPath) -or -not (Test-Path $DnsSdPath)) {
    Write-Warning "dns-sd.exe not found. mDNS broadcast not registered."
    Write-Warning "The Hawk Eye installer ships a portable copy in 'installer/bonjour-portable/' and prepends it to PATH."
    Write-Warning "If you uninstalled Bonjour or removed the portable copy, install Bonjour Print Services from https://support.apple.com/kb/dl999 and re-run this script,"
    Write-Warning "or leave mDNS disabled and have operators pair manually via setup-aggregator.ps1."
    exit 3
}

# The supervisor wrapper holds the foreground; it spawns dns-sd.exe
# and respawns it on any exit. We point the scheduled task at the
# supervisor instead of dns-sd.exe directly so the broadcast survives
# OOM kills, manual kills, console session closes, etc. without
# operator intervention.
$scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$supervisorScript = Join-Path $scriptDir "mdns-supervisor.ps1"
if (-not (Test-Path $supervisorScript)) {
    Write-Error "mdns-supervisor.ps1 not found at '$supervisorScript'. Reinstall from the source tree."
    exit 5
}

$supervisorArgs = @(
    "-SquadronName", "`"$SquadronName`"",
    "-ApiPort",      "`"$ApiPort`"",
    "-DnsSdPath",    "`"$DnsSdPath`"",
    "-ServiceType",  "`"$ServiceType`""
)
if ($ServiceType -eq "_hawkeye._tcp") {
    $supervisorArgs += @("-Role",     "`"$Role`"")
    if (-not [string]::IsNullOrWhiteSpace($Wing))       { $supervisorArgs += @("-Wing",       "`"$Wing`"") }
    if (-not [string]::IsNullOrWhiteSpace($Base))       { $supervisorArgs += @("-Base",       "`"$Base`"") }
    if (-not [string]::IsNullOrWhiteSpace($Hostname))   { $supervisorArgs += @("-Hostname",   "`"$Hostname`"") }
    if (-not [string]::IsNullOrWhiteSpace($AppVersion)) { $supervisorArgs += @("-AppVersion", "`"$AppVersion`"") }
}
$registerCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$supervisorScript`" $($supervisorArgs -join ' ')"

Write-Host "[hawk-eye] Registering scheduled task: $TaskName"
Write-Host "[hawk-eye] Command: $registerCmd"

# Stop any prior supervisor instance so the new task definition
# (e.g. a different ApiPort or role) takes effect immediately.
schtasks /End /TN "$TaskName" 2>&1 | Out-Null

# Replace any prior task definition so re-runs are idempotent.
schtasks /Create /F /RU SYSTEM /SC ONSTART /TN "$TaskName" /TR $registerCmd | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create scheduled task '$TaskName'."
    exit 4
}

# Start it now so the broadcast is live without waiting for a reboot.
schtasks /Run /TN "$TaskName" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not start the task immediately (exit $LASTEXITCODE). It will start on next boot."
}

Write-Host "[hawk-eye] mDNS broadcast registered (supervised — auto-restarts on dns-sd.exe death)."
Write-Host "[hawk-eye] Service: $ServiceType"
Write-Host "[hawk-eye] Name:    $SquadronName"
Write-Host "[hawk-eye] Port:    $ApiPort"
if ($ServiceType -eq "_hawkeye._tcp") {
    Write-Host "[hawk-eye] Role:    $Role"
    if (-not [string]::IsNullOrWhiteSpace($Wing))       { Write-Host "[hawk-eye] Wing:    $Wing" }
    if (-not [string]::IsNullOrWhiteSpace($Base))       { Write-Host "[hawk-eye] Base:    $Base" }
    if (-not [string]::IsNullOrWhiteSpace($Hostname))   { Write-Host "[hawk-eye] Host:    $Hostname" }
    if (-not [string]::IsNullOrWhiteSpace($AppVersion)) { Write-Host "[hawk-eye] Version: $AppVersion" }
}
Write-Host "[hawk-eye] Verify alive: scripts\lan-host\check-mdns-health.ps1"
Write-Host "[hawk-eye] Logs:    %PROGRAMDATA%\HawkEye\mdns-supervisor.log"
Write-Host "[hawk-eye] To stop broadcasting: re-run with -Unregister"
exit 0
