# supervisor-health.ps1
#
# Hawk Eye — shared helper that prints a single supervisor heartbeat
# block in operator-facing format. Dot-sourced by check-host-health.ps1
# so the api / mdns / dashboard supervisor sections share one
# implementation, and so the formatting can be unit-tested in isolation
# (see scripts/lan-host/tests/supervisor-health.tests.ps1).
#
# Every call is best-effort: a missing or unreadable heartbeat file
# emits a warning and returns — it never throws or exits — so a hub
# install with no dashboard supervisor (or an mDNS-disabled hub) still
# completes the rest of the printout.

function Show-SupervisorHeartbeat {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$HeartbeatPath,
    [Parameter(Mandatory=$true)][string]$ReinstallHint,
    [Parameter(Mandatory=$true)][int]$StaleThresholdSec,
    [string[]]$ExtraFields = @()
  )

  Write-Host ""
  if (-not (Test-Path $HeartbeatPath)) {
    Write-Warning "[hawk-eye] $Name heartbeat not found at '$HeartbeatPath'. Either the supervisor task is not registered yet (this PC may not run that role), or this host predates the supervised wrapper. $ReinstallHint"
    return
  }

  try {
    $raw = Get-Content -Path $HeartbeatPath -Raw -ErrorAction Stop
    $hb  = $raw | ConvertFrom-Json
  } catch {
    Write-Warning "[hawk-eye] Could not read $Name heartbeat: $($_.Exception.Message)"
    return
  }

  $tsRaw = $hb.timestamp
  $ageSec = $null
  if (-not [string]::IsNullOrWhiteSpace($tsRaw)) {
    try {
      $ts = [DateTime]::Parse(
        $tsRaw,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind
      ).ToUniversalTime()
      $ageSec = [int]((Get-Date).ToUniversalTime() - $ts).TotalSeconds
    } catch {
      $ageSec = $null
    }
  }

  Write-Host "[hawk-eye] $Name heartbeat:"
  if ($null -ne $ageSec) {
    Write-Host "  timestamp     : $($hb.timestamp) (age: ${ageSec}s)"
  } else {
    Write-Host "  timestamp     : $($hb.timestamp)"
  }
  Write-Host "  state         : $($hb.state)"
  Write-Host "  childPid      : $($hb.childPid)"
  Write-Host "  restartCount  : $($hb.restartCount)"
  foreach ($field in $ExtraFields) {
    $val = $hb.$field
    if ($null -ne $val -and "$val" -ne "") {
      $label = ($field + (' ' * 14)).Substring(0, 14)
      Write-Host "  $label: $val"
    }
  }
  if ($null -ne $hb.lastExitCode) {
    Write-Host "  lastExitCode  : $($hb.lastExitCode)"
  }
  if ($null -ne $hb.lastRunSec) {
    Write-Host ("  lastRunSec    : {0:N0}" -f [double]$hb.lastRunSec)
  }

  if ($null -ne $ageSec -and $ageSec -gt $StaleThresholdSec) {
    Write-Warning "[hawk-eye] $Name heartbeat is stale (>${StaleThresholdSec}s old). The supervisor task itself may have died. $ReinstallHint (The wrapped service may still be answering traffic; this only means the watchdog is no longer watching.)"
  }
}
