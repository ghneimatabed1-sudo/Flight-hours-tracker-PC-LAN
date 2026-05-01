# api-supervisor.ps1
#
# Hawk Eye — watchdog around the api-server hub process.
#
# Started by the HawkEye-ApiServer-OnStartup scheduled task in SYSTEM
# context at boot. Loops forever: spawns `start-api-host.ps1`
# (which loads artifacts/api-server/.env and execs node), waits for
# it, and restarts it on any exit (OOM kill, unhandled exception,
# postgres glitch, manual kill, …) within $RestartDelaySec seconds
# (capped at $MaxRestartDelaySec to avoid busy-looping on a
# permanently broken setup, e.g. missing DATABASE_URL or schema
# corruption).
#
# Writes a heartbeat file every $HeartbeatIntervalSec seconds so
# operators (or check-host-health.ps1, or any monitoring tool) can
# verify the api-server is alive without RDP'ing into the box.
#
# Output paths:
#   %PROGRAMDATA%\HawkEye\api-supervisor.log         (rolling text log)
#   %PROGRAMDATA%\HawkEye\api-supervisor.heartbeat   (latest JSON tick)
#
# Mirrors the structure of mdns-supervisor.ps1 deliberately so
# operators only need to learn one watchdog idiom on the host PC.
#
# This script is invoked by install-api-startup-task.ps1; operators
# do not need to call it directly. To run the api-server in the
# foreground for manual debugging, call start-api-host.ps1 directly
# (without the supervisor wrapper).

[CmdletBinding()]
param(
    [string]$RepoRoot          = "",
    [string]$EnvFile           = "",

    # How long to wait before respawning the api-server after a
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
    # Defaults: 2 MiB per file, 3 rotated copies => ~8 MiB max,
    # which is plenty for years of healthy operation and survives
    # weeks of pathological flapping without filling the disk.
    [int]$MaxLogBytes   = 2097152,
    [int]$MaxLogBackups = 3
)

$ErrorActionPreference = "Stop"

# Shared in-process log rotation helpers (supervisor-log.ps1 was
# introduced in #397 as the cross-supervisor rotation lib; both
# mdns-supervisor.ps1 and dashboard-supervisor.ps1 dot-source it
# too).
. (Join-Path $PSScriptRoot "supervisor-log.ps1")

if ($RestartDelaySec -lt 1)                       { $RestartDelaySec = 1 }
if ($MaxRestartDelaySec -lt $RestartDelaySec)     { $MaxRestartDelaySec = $RestartDelaySec }
if ($HeartbeatIntervalSec -lt 1)                  { $HeartbeatIntervalSec = 1 }
if ($MaxLogBytes -lt 0)                           { $MaxLogBytes = 0 }
if ($MaxLogBackups -lt 0)                         { $MaxLogBackups = 0 }

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
$startScript = Join-Path $root "scripts\lan-host\start-api-host.ps1"
if (-not (Test-Path $startScript)) {
    throw "start-api-host.ps1 not found at '$startScript'. Reinstall from the source tree."
}

$dataDir = Join-Path $env:ProgramData "HawkEye"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
$logFile       = Join-Path $dataDir "api-supervisor.log"
$heartbeatFile = Join-Path $dataDir "api-supervisor.heartbeat"

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
        startScript   = $startScript
        envFile       = $EnvFile
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

Write-SupervisorLog "[supervisor] start: RepoRoot=$root StartScript=$startScript EnvFile=$EnvFile restartDelay=${RestartDelaySec}s maxDelay=${MaxRestartDelaySec}s heartbeat=${HeartbeatIntervalSec}s logRotate=${MaxLogBytes}B/${MaxLogBackups}backups"
Write-Heartbeat -ChildPid 0 -RestartCount 0 -State "starting"

# The startup task always passes -SkipBuild via install-api-startup-task.ps1
# because the api-server is built once at install time. We mirror that
# here so a freshly-spawned child boots in the same shape on every
# restart and never blocks on a slow rebuild.
#
# Pre-quote paths so an install on a path containing spaces (e.g.
# `C:\Program Files\HawkEye`) round-trips through Start-Process
# correctly. Start-Process splits on whitespace if it sees an
# unquoted token.
$childArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$startScript`"",
    "-SkipBuild",
    "-RepoRoot", "`"$root`""
)
if ($EnvFile -and $EnvFile.Trim() -ne "") {
    $childArgs += @("-EnvFile", "`"$EnvFile`"")
}

$childExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$restartCount = 0
$currentDelay = $RestartDelaySec

while ($true) {
    $startedAt = Get-Date
    try {
        $proc = Start-Process -FilePath $childExe -ArgumentList $childArgs -PassThru -WindowStyle Hidden
    } catch {
        Write-SupervisorLog "[supervisor] failed to spawn start-api-host.ps1: $($_.Exception.Message). Sleeping ${currentDelay}s."
        Write-Heartbeat -ChildPid 0 -RestartCount $restartCount -State "spawn-failed"
        Start-Sleep -Seconds $currentDelay
        $currentDelay = [Math]::Min($currentDelay * 2, $MaxRestartDelaySec)
        continue
    }

    Write-SupervisorLog "[supervisor] spawned start-api-host.ps1 pid=$($proc.Id)"
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
    Write-SupervisorLog ("[supervisor] start-api-host.ps1 pid={0} exited code={1} after {2:N0}s — restarting in {3}s" -f $proc.Id, $exitCode, $ranFor, $delay.ThisDelay)

    $restartCount++
    Write-Heartbeat -ChildPid 0 -RestartCount $restartCount -State "restarting" -LastExitCode $exitCode -LastRunSec $ranFor
    Start-Sleep -Seconds $delay.ThisDelay
    $currentDelay = $delay.NextDelay
}
