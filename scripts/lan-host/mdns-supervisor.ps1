# mdns-supervisor.ps1
#
# Hawk Eye — watchdog around the dns-sd.exe Bonjour broadcast.
#
# Started by the HawkEye-Mdns-OnStartup scheduled task in SYSTEM
# context at boot. Loops forever: spawns dns-sd.exe, waits for it,
# and restarts it on any exit (OOM kill, manual kill, console
# session close, dns-sd crash, …) within $RestartDelaySec seconds
# (capped at $MaxRestartDelaySec to avoid busy-looping on a
# permanently broken setup).
#
# Writes a heartbeat file every $HeartbeatIntervalSec seconds so
# operators (or check-mdns-health.ps1, or any monitoring tool) can
# verify the broadcast is alive without RDP'ing into the box.
#
# Output paths:
#   %PROGRAMDATA%\HawkEye\mdns-supervisor.log         (rolling text log)
#   %PROGRAMDATA%\HawkEye\mdns-supervisor.heartbeat   (latest JSON tick)
#
# This script is invoked by register-mdns.ps1; operators do not
# need to call it directly.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SquadronName,

    [Parameter(Mandatory = $true)]
    [string]$ApiPort,

    [Parameter(Mandatory = $true)]
    [string]$DnsSdPath,

    # Service type to register. Default keeps the legacy hub-only
    # registration shape; magic LAN auto-discovery passes
    # `_hawkeye._tcp` along with -Role + TXT records.
    [string]$ServiceType = "_hawkeye-hub._tcp",
    [string]$Role        = "",
    [string]$Wing        = "",
    [string]$Base        = "",
    [string]$Hostname    = "",
    [string]$AppVersion  = "",

    # How long to wait before respawning dns-sd.exe after a crash.
    # Doubles up to $MaxRestartDelaySec on repeated rapid failures,
    # then resets after a run that lasted at least 60s.
    [int]$RestartDelaySec      = 5,
    [int]$MaxRestartDelaySec   = 60,

    # How often the supervisor refreshes the heartbeat file while
    # the child is alive.
    [int]$HeartbeatIntervalSec = 15,

    # In-process log rotation (see supervisor-log.ps1). The log
    # rotates to <log>.1 .. <log>.N when it exceeds $MaxLogBytes;
    # the oldest copy is discarded so the on-disk footprint is
    # bounded by roughly $MaxLogBytes * ($MaxLogBackups + 1).
    # Defaults: 1 MiB per file, 3 rotated copies => ~4 MiB max,
    # which is plenty for years of healthy operation and survives
    # weeks of pathological flapping without filling the disk.
    [int]$MaxLogBytes   = 1048576,
    [int]$MaxLogBackups = 3
)

$ErrorActionPreference = "Stop"

# Shared in-process log rotation helpers.
. (Join-Path $PSScriptRoot "supervisor-log.ps1")

if (-not (Test-Path $DnsSdPath)) {
    throw "dns-sd.exe not found at '$DnsSdPath'."
}
if ($RestartDelaySec -lt 1)                       { $RestartDelaySec = 1 }
if ($MaxRestartDelaySec -lt $RestartDelaySec)     { $MaxRestartDelaySec = $RestartDelaySec }
if ($HeartbeatIntervalSec -lt 1)                  { $HeartbeatIntervalSec = 1 }
if ($MaxLogBytes -lt 0)                           { $MaxLogBytes = 0 }
if ($MaxLogBackups -lt 0)                         { $MaxLogBackups = 0 }

$dataDir = Join-Path $env:ProgramData "HawkEye"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
$logFile       = Join-Path $dataDir "mdns-supervisor.log"
$heartbeatFile = Join-Path $dataDir "mdns-supervisor.heartbeat"

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
        [string]$State
    )
    $payload = [ordered]@{
        timestamp     = (Get-Date).ToUniversalTime().ToString("o")
        squadronName  = $SquadronName
        apiPort       = $ApiPort
        dnsSdPath     = $DnsSdPath
        childPid      = $ChildPid
        restartCount  = $RestartCount
        state         = $State
    } | ConvertTo-Json -Compress
    try {
        Set-Content -Path $heartbeatFile -Value $payload -Encoding UTF8 -ErrorAction Stop
    } catch { }
}

Write-SupervisorLog "[supervisor] start: SquadronName=$SquadronName ApiPort=$ApiPort DnsSdPath=$DnsSdPath restartDelay=${RestartDelaySec}s maxDelay=${MaxRestartDelaySec}s heartbeat=${HeartbeatIntervalSec}s logRotate=${MaxLogBytes}B/${MaxLogBackups}backups"
Write-Heartbeat -ChildPid 0 -RestartCount 0 -State "starting"

# `$args` is an automatic variable in PowerShell, so name this
# something distinct. Magic LAN auto-discovery (ServiceType
# `_hawkeye._tcp`) appends role-aware TXT records so peers can
# decide whether this PC is a hub, aggregator, or viewer without
# having to ask. dns-sd.exe accepts TXT records as
# `key=value` positional args after the port.
$dnsArgs = @("-R", $SquadronName, $ServiceType, "local", $ApiPort)
if ($ServiceType -eq "_hawkeye._tcp") {
    if (-not [string]::IsNullOrWhiteSpace($Role))       { $dnsArgs += "role=$Role" }
    if (-not [string]::IsNullOrWhiteSpace($Wing))       { $dnsArgs += "wing=$Wing" }
    if (-not [string]::IsNullOrWhiteSpace($Base))       { $dnsArgs += "base=$Base" }
    if (-not [string]::IsNullOrWhiteSpace($Hostname))   { $dnsArgs += "hostname=$Hostname" }
    if (-not [string]::IsNullOrWhiteSpace($AppVersion)) { $dnsArgs += "version=$AppVersion" }
}

$restartCount = 0
$currentDelay = $RestartDelaySec

while ($true) {
    $startedAt = Get-Date
    try {
        $proc = Start-Process -FilePath $DnsSdPath -ArgumentList $dnsArgs -PassThru -WindowStyle Hidden
    } catch {
        Write-SupervisorLog "[supervisor] failed to spawn dns-sd.exe: $($_.Exception.Message). Sleeping ${currentDelay}s."
        Write-Heartbeat -ChildPid 0 -RestartCount $restartCount -State "spawn-failed"
        Start-Sleep -Seconds $currentDelay
        $currentDelay = [Math]::Min($currentDelay * 2, $MaxRestartDelaySec)
        continue
    }

    Write-SupervisorLog "[supervisor] spawned dns-sd.exe pid=$($proc.Id)"
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
    Write-SupervisorLog ("[supervisor] dns-sd.exe pid={0} exited code={1} after {2:N0}s — restarting in {3}s" -f $proc.Id, $exitCode, $ranFor, $delay.ThisDelay)

    $restartCount++
    Write-Heartbeat -ChildPid 0 -RestartCount $restartCount -State "restarting"
    Start-Sleep -Seconds $delay.ThisDelay
    $currentDelay = $delay.NextDelay
}
