# dashboard-supervisor.ps1
#
# Hawk Eye — watchdog around the pilot-dashboard host process.
#
# Started by the HawkEye-Dashboard-OnStartup scheduled task in SYSTEM
# context at boot (on aggregator / Wing / Base PCs). Loops forever:
# spawns the dashboard launcher (`start-dashboard-host.ps1` by default,
# wraps `vite preview`), waits for it, and restarts it on any exit
# (vite crash, dropped TCP socket, OOM kill, manual kill, viewer-kiosk
# Edge --app close, …) within $RestartDelaySec seconds (capped at
# $MaxRestartDelaySec to avoid busy-looping on a permanently broken
# setup, e.g. a port collision or a missing dist folder).
#
# Writes a heartbeat file every $HeartbeatIntervalSec seconds so
# operators (or check-host-health.ps1, or the AboutThisPc dashboard
# panel) can verify the launcher is alive without RDP'ing into the
# box.
#
# Output paths:
#   %PROGRAMDATA%\HawkEye\dashboard-supervisor.log         (rolling text log)
#   %PROGRAMDATA%\HawkEye\dashboard-supervisor.heartbeat   (latest JSON tick)
#
# Mirrors the structure of api-supervisor.ps1 deliberately so
# operators only need to learn one watchdog idiom on the host PC.
#
# This script is invoked by install-dashboard-startup-task.ps1;
# operators do not need to call it directly. To run the dashboard host
# in the foreground for manual debugging, call start-dashboard-host.ps1
# directly (without the supervisor wrapper).
#
# Wrapping the viewer kiosk launcher (launch-viewer.ps1) instead of
# the vite preview backend is supported via -ChildScript: useful on a
# Squadron / Flight Commander viewer where the operator's primary
# surface is the Edge --app window itself. Closing the window will
# trigger a re-launch within $RestartDelaySec seconds.

[CmdletBinding()]
param(
    [string]$RepoRoot          = "",

    # Path to the script the supervisor wraps. Defaults to
    # start-dashboard-host.ps1 (vite preview backend) which matches
    # the existing install-dashboard-startup-task.ps1 contract. Pass
    # `launch-viewer.ps1` to wrap the kiosk Edge --app launcher
    # instead.
    [string]$ChildScript       = "",

    # Forwarded to start-dashboard-host.ps1; ignored when wrapping
    # other launchers.
    [int]$DashboardPort        = 5173,

    # How long to wait before respawning the dashboard host after a
    # crash. Doubles up to $MaxRestartDelaySec on repeated rapid
    # failures, then resets after a run that lasted at least 60s.
    [int]$RestartDelaySec      = 5,
    [int]$MaxRestartDelaySec   = 60,

    # How often the supervisor refreshes the heartbeat file while
    # the child is alive.
    [int]$HeartbeatIntervalSec = 15,

    # In-process log rotation (see supervisor-log.ps1). The log
    # rotates to <log>.1 .. <log>.N when it exceeds $MaxLogBytes;
    # the oldest copy is discarded so the on-disk footprint is
    # bounded by roughly $MaxLogBytes * ($MaxLogBackups + 1).
    # Defaults: 2 MiB per file, 3 rotated copies => ~8 MiB max.
    # Three supervisors total => ~24 MiB worst case, trivial on a
    # workstation disk.
    [int]$MaxLogBytes          = 2097152,
    [int]$MaxLogBackups        = 3
)

$ErrorActionPreference = "Stop"

# Shared in-process log rotation helpers (supervisor-log.ps1 was
# introduced in #397 as the cross-supervisor rotation lib; both
# api-supervisor.ps1 and mdns-supervisor.ps1 dot-source it too).
. (Join-Path $PSScriptRoot "supervisor-log.ps1")

if ($RestartDelaySec -lt 1)                       { $RestartDelaySec = 1 }
if ($MaxRestartDelaySec -lt $RestartDelaySec)     { $MaxRestartDelaySec = $RestartDelaySec }
if ($HeartbeatIntervalSec -lt 1)                  { $HeartbeatIntervalSec = 1 }
if ($MaxLogBytes -lt 0)                           { $MaxLogBytes = 0 }
if ($MaxLogBackups -lt 0)                         { $MaxLogBackups = 0 }
if ($DashboardPort -lt 1 -or $DashboardPort -gt 65535) {
    throw "DashboardPort '$DashboardPort' is out of range."
}

function Resolve-RepoRoot {
    param([string]$InputRoot)
    if ($InputRoot -and $InputRoot.Trim() -ne "") {
        return (Resolve-Path $InputRoot).Path
    }
    $scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
        $PSScriptRoot
    } else {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

$root = Resolve-RepoRoot -InputRoot $RepoRoot

if ([string]::IsNullOrWhiteSpace($ChildScript)) {
    $ChildScript = Join-Path $root "scripts\lan-host\start-dashboard-host.ps1"
} elseif (-not [System.IO.Path]::IsPathRooted($ChildScript)) {
    # Resolve a bare filename against scripts\lan-host\ first so the
    # operator can pass `launch-viewer.ps1` without a full path.
    $candidate = Join-Path $root "scripts\lan-host\$ChildScript"
    if (Test-Path $candidate) {
        $ChildScript = (Resolve-Path $candidate).Path
    } else {
        $ChildScript = (Resolve-Path $ChildScript).Path
    }
}

if (-not (Test-Path $ChildScript)) {
    throw "Dashboard launcher not found at '$ChildScript'. Reinstall from the source tree."
}

$dataDir = Join-Path $env:ProgramData "HawkEye"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
$logFile       = Join-Path $dataDir "dashboard-supervisor.log"
$heartbeatFile = Join-Path $dataDir "dashboard-supervisor.heartbeat"

function Write-SupervisorLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"), $Message
    Write-RotatingLog -Path $logFile -Line $line `
        -MaxBytes $MaxLogBytes -MaxBackups $MaxLogBackups
    Write-Host $line
}

function Write-Heartbeat {
    param(
        [int]$ChildPid,
        [int]$RestartCount,
        [string]$State,
        $LastExitCode = $null,
        $LastRunSec   = $null
    )
    $payload = [ordered]@{
        timestamp     = (Get-Date).ToUniversalTime().ToString("o")
        repoRoot      = $root
        childScript   = $ChildScript
        dashboardPort = $DashboardPort
        childPid      = $ChildPid
        restartCount  = $RestartCount
        state         = $State
        lastExitCode  = $LastExitCode
        lastRunSec    = $LastRunSec
    } | ConvertTo-Json -Compress
    try {
        Set-Content -Path $heartbeatFile -Value $payload -Encoding UTF8 -ErrorAction Stop
    } catch { }
}

Write-SupervisorLog "[supervisor] start: RepoRoot=$root ChildScript=$ChildScript DashboardPort=$DashboardPort restartDelay=${RestartDelaySec}s maxDelay=${MaxRestartDelaySec}s heartbeat=${HeartbeatIntervalSec}s logRotate=${MaxLogBytes}B/${MaxLogBackups}backups"
Write-Heartbeat -ChildPid 0 -RestartCount 0 -State "starting"

# Quote paths so an install on a path containing spaces (e.g.
# `C:\Program Files\HawkEye`) round-trips through Start-Process
# correctly. Start-Process splits on whitespace if it sees an
# unquoted token. SkipBuild is always passed so reboot does not
# block on a slow rebuild — start-dashboard-host.ps1 already accepts
# it; for other launchers it is harmless when ignored.
$childArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$ChildScript`""
)
# start-dashboard-host.ps1 honours -DashboardPort and -SkipBuild; pass
# them only when the wrapped child is actually that script. Other
# launchers (e.g. launch-viewer.ps1) take their own params and would
# choke on unknown ones.
$childLeaf = [System.IO.Path]::GetFileName($ChildScript).ToLowerInvariant()
if ($childLeaf -eq "start-dashboard-host.ps1") {
    $childArgs += @("-SkipBuild", "-DashboardPort", "$DashboardPort", "-RepoRoot", "`"$root`"")
}

$childExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$restartCount = 0
$currentDelay = $RestartDelaySec

while ($true) {
    $startedAt = Get-Date
    try {
        $proc = Start-Process -FilePath $childExe -ArgumentList $childArgs -PassThru -WindowStyle Hidden
    } catch {
        Write-SupervisorLog "[supervisor] failed to spawn dashboard launcher: $($_.Exception.Message). Sleeping ${currentDelay}s."
        Write-Heartbeat -ChildPid 0 -RestartCount $restartCount -State "spawn-failed"
        Start-Sleep -Seconds $currentDelay
        $currentDelay = [Math]::Min($currentDelay * 2, $MaxRestartDelaySec)
        continue
    }

    Write-SupervisorLog "[supervisor] spawned dashboard launcher pid=$($proc.Id)"
    Write-Heartbeat -ChildPid $proc.Id -RestartCount $restartCount -State "running"

    while (-not $proc.HasExited) {
        Start-Sleep -Seconds $HeartbeatIntervalSec
        if (-not $proc.HasExited) {
            Write-Heartbeat -ChildPid $proc.Id -RestartCount $restartCount -State "running"
        }
    }
    # Make sure the exit code is materialised.
    try { $proc.WaitForExit() } catch { }

    $ranFor   = (New-TimeSpan -Start $startedAt -End (Get-Date)).TotalSeconds
    $exitCode = $proc.ExitCode

    # Drive the crash-respawn backoff via the shared helper so all
    # three supervisors agree on the contract (first rapid crash
    # sleeps RestartDelaySec, then 2x, 4x, … capped at
    # MaxRestartDelaySec; reset to base after a healthy >=60s run).
    $delay = Get-NextSupervisorDelay `
        -CurrentDelay $currentDelay `
        -RanForSec $ranFor `
        -RestartDelaySec $RestartDelaySec `
        -MaxRestartDelaySec $MaxRestartDelaySec
    Write-SupervisorLog ("[supervisor] dashboard launcher pid={0} exited code={1} after {2:N0}s — restarting in {3}s" -f $proc.Id, $exitCode, $ranFor, $delay.ThisDelay)

    $restartCount++
    Write-Heartbeat -ChildPid 0 -RestartCount $restartCount -State "restarting" -LastExitCode $exitCode -LastRunSec $ranFor
    Start-Sleep -Seconds $delay.ThisDelay
    $currentDelay = $delay.NextDelay
}
