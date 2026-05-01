# check-mdns-health.ps1
#
# Hawk Eye — operator-facing healthcheck for the mDNS broadcast.
#
# Reads the heartbeat file written by mdns-supervisor.ps1 and
# reports whether the broadcast is alive, stale, or between
# restarts. No RDP into the box required — call this from any
# elevated PowerShell on the host PC.
#
# Exit codes:
#   0 — broadcast is alive (recent heartbeat, child running)
#   1 — heartbeat file missing / unreadable / mDNS never enabled
#   2 — heartbeat is stale (supervisor task likely died)
#   3 — supervisor is currently between restarts (transient)

param(
    [int]$StaleThresholdSec = 90,
    [string]$HeartbeatPath  = ""
)

$ErrorActionPreference = "Stop"

# Shared helpers (currently exposes Get-RotatedLogCount).
$scriptDir = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
. (Join-Path $scriptDir "supervisor-log.ps1")

if ([string]::IsNullOrWhiteSpace($HeartbeatPath)) {
    $HeartbeatPath = Join-Path $env:ProgramData "HawkEye\mdns-supervisor.heartbeat"
}
$logPath = Join-Path $env:ProgramData "HawkEye\mdns-supervisor.log"

if (-not (Test-Path $HeartbeatPath)) {
    Write-Error "[hawk-eye] mDNS supervisor heartbeat not found at '$HeartbeatPath'. Either mDNS was never enabled (-EnableMdns), the supervisor task is not registered, or it has not started yet. Check Task Scheduler -> HawkEye-Mdns-OnStartup."
    exit 1
}

try {
    $raw = Get-Content -Path $HeartbeatPath -Raw -ErrorAction Stop
    $hb  = $raw | ConvertFrom-Json
} catch {
    Write-Error "[hawk-eye] Could not read heartbeat file: $($_.Exception.Message)"
    exit 1
}

$tsRaw = $hb.timestamp
if ([string]::IsNullOrWhiteSpace($tsRaw)) {
    Write-Error "[hawk-eye] Heartbeat missing 'timestamp' field."
    exit 1
}

try {
    $ts = [DateTime]::Parse(
        $tsRaw,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
} catch {
    Write-Error "[hawk-eye] Heartbeat timestamp '$tsRaw' is not a valid ISO-8601 value."
    exit 1
}

$ageSec = [int]((Get-Date).ToUniversalTime() - $ts).TotalSeconds

Write-Host "[hawk-eye] mDNS supervisor heartbeat:"
Write-Host "  timestamp     : $($hb.timestamp) (age: ${ageSec}s)"
Write-Host "  squadronName  : $($hb.squadronName)"
Write-Host "  apiPort       : $($hb.apiPort)"
Write-Host "  state         : $($hb.state)"
Write-Host "  childPid      : $($hb.childPid)"
Write-Host "  restartCount  : $($hb.restartCount)"

# Surface log rotation activity so operators can confirm the
# in-process rotation is working (and so a flapping supervisor
# becomes visible from the on-disk backup files, not just from
# restartCount). Note: this counts rotated files currently on
# disk (0..MaxBackups), not cumulative rotations since boot —
# once backups saturate the count plateaus at MaxBackups.
$rotated = Get-RotatedLogCount -Path $logPath
$logSizeBytes = 0
if (Test-Path $logPath) {
    try { $logSizeBytes = (Get-Item -Path $logPath -Force -ErrorAction Stop).Length } catch { }
}
Write-Host "  log           : $logPath ($logSizeBytes B, $rotated rotated backup file(s) on disk)"

if ($ageSec -gt $StaleThresholdSec) {
    Write-Error "[hawk-eye] Heartbeat is stale (>${StaleThresholdSec}s old). Supervisor task may have died — check Task Scheduler -> HawkEye-Mdns-OnStartup, then re-run scripts\lan-host\register-mdns.ps1 to reinstall it."
    exit 2
}

if ($hb.state -ne "running") {
    Write-Warning "[hawk-eye] Supervisor is in state '$($hb.state)' — broadcast is currently down between restarts. Re-run this script in ~$([Math]::Max(5, $StaleThresholdSec / 3))s to confirm it recovered."
    exit 3
}

Write-Host "[hawk-eye] mDNS broadcast is alive (state=running, restarts=$($hb.restartCount))."
exit 0
