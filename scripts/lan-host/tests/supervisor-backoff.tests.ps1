# supervisor-backoff.tests.ps1
#
# Pester tests for `Get-NextSupervisorDelay` (supervisor-log.ps1).
# Locks in the documented crash-respawn schedule used by all three
# Hawk Eye supervisors (api / mdns / dashboard):
#
#   first rapid crash  -> sleep RestartDelaySec       (SLA: <= 5s)
#   second rapid crash -> sleep 2x                    (10s)
#   third rapid crash  -> sleep 4x                    (20s)
#   fourth rapid crash -> sleep 8x                    (40s)
#   fifth rapid crash  -> capped at MaxRestartDelaySec (60s)
#   healthy run (>= 60s) -> reset to RestartDelaySec
#
# These are the assumptions check-host-health.ps1 / the operator runbook
# rely on; if anyone retunes the schedule they must update both.

BeforeAll {
    $script:scriptDir = Split-Path -Parent $PSCommandPath
    $script:lanHost   = Split-Path -Parent $script:scriptDir
    . (Join-Path $script:lanHost "supervisor-log.ps1")
}

Describe "Get-NextSupervisorDelay" {

    It "first rapid crash sleeps RestartDelaySec (5s SLA)" {
        $r = Get-NextSupervisorDelay -CurrentDelay 5 -RanForSec 0.5 `
            -RestartDelaySec 5 -MaxRestartDelaySec 60
        $r.ThisDelay | Should -Be 5
        $r.NextDelay | Should -Be 10
    }

    It "drives the documented 5->10->20->40->60 doubling sequence" {
        $expectedThis = @(5, 10, 20, 40, 60, 60)
        $expectedNext = @(10, 20, 40, 60, 60, 60)
        $current = 5
        for ($i = 0; $i -lt $expectedThis.Length; $i++) {
            $r = Get-NextSupervisorDelay -CurrentDelay $current -RanForSec 1 `
                -RestartDelaySec 5 -MaxRestartDelaySec 60
            $r.ThisDelay | Should -Be $expectedThis[$i]
            $r.NextDelay | Should -Be $expectedNext[$i]
            $current = $r.NextDelay
        }
    }

    It "resets ThisDelay to RestartDelaySec after a healthy >=60s run" {
        # Even if the previous flap left $currentDelay pinned at 60, a
        # child that ran for a full minute is treated as recovered and
        # the next crash sleeps the base value again.
        $r = Get-NextSupervisorDelay -CurrentDelay 60 -RanForSec 75 `
            -RestartDelaySec 5 -MaxRestartDelaySec 60
        $r.ThisDelay | Should -Be 5
        $r.NextDelay | Should -Be 10
    }

    It "treats RanForSec exactly equal to HealthyRunSec as healthy" {
        $r = Get-NextSupervisorDelay -CurrentDelay 40 -RanForSec 60 `
            -RestartDelaySec 5 -MaxRestartDelaySec 60
        $r.ThisDelay | Should -Be 5
    }

    It "respects a custom HealthyRunSec threshold" {
        # Lowering HealthyRunSec to 10s makes a 12s run count as healthy.
        $r = Get-NextSupervisorDelay -CurrentDelay 40 -RanForSec 12 `
            -RestartDelaySec 5 -MaxRestartDelaySec 60 -HealthyRunSec 10
        $r.ThisDelay | Should -Be 5
        $r.NextDelay | Should -Be 10
    }

    It "caps NextDelay at MaxRestartDelaySec even when ThisDelay would overshoot" {
        $r = Get-NextSupervisorDelay -CurrentDelay 60 -RanForSec 0 `
            -RestartDelaySec 5 -MaxRestartDelaySec 60
        $r.ThisDelay | Should -Be 60
        $r.NextDelay | Should -Be 60
    }
}
