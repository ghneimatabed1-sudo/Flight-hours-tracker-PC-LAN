# supervisor-health.tests.ps1
#
# Pester tests for `Show-SupervisorHeartbeat` (factored out of
# check-host-health.ps1 into supervisor-health.ps1) and an integration
# test that proves a single `check-host-health.ps1` run surfaces *all
# three* supervisor blocks (api / mdns / dashboard) in one execution
# path — the acceptance criterion from task #409 / T-O.
#
# Run on a Windows host PC with Pester 5+:
#   Invoke-Pester -Path scripts\lan-host\tests\supervisor-health.tests.ps1

BeforeAll {
    $script:scriptDir = Split-Path -Parent $PSCommandPath
    $script:lanHost   = Split-Path -Parent $script:scriptDir
    . (Join-Path $script:lanHost "supervisor-health.ps1")
}

function New-HeartbeatFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$AgeSec,
        [hashtable]$Extra = @{}
    )
    $hb = @{
        timestamp    = (Get-Date).ToUniversalTime().AddSeconds(-$AgeSec).ToString("o")
        state        = "running"
        childPid     = 1234
        restartCount = 0
    }
    foreach ($key in $Extra.Keys) { $hb[$key] = $Extra[$key] }
    $hb | ConvertTo-Json -Depth 4 | Set-Content -Path $Path -Encoding UTF8
}

Describe "Show-SupervisorHeartbeat" {

    It "prints heartbeat fields when the file is fresh" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".heartbeat")
        try {
            New-HeartbeatFile -Path $tmp -AgeSec 5 -Extra @{ restartCount = 7 }
            $output = & {
                Show-SupervisorHeartbeat `
                    -Name "api-supervisor" `
                    -HeartbeatPath $tmp `
                    -ReinstallHint "Re-run install-api-startup-task.ps1." `
                    -StaleThresholdSec 90
            } 6>&1 | Out-String

            $output | Should -Match "api-supervisor heartbeat:"
            $output | Should -Match "state\s*:\s*running"
            $output | Should -Match "restartCount\s*:\s*7"
        } finally {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    It "warns and returns when the heartbeat file is missing (no throw)" {
        $missing = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".heartbeat")
        $warnings = @()
        $output = & {
            Show-SupervisorHeartbeat `
                -Name "dashboard-supervisor" `
                -HeartbeatPath $missing `
                -ReinstallHint "Re-run install-dashboard-startup-task.ps1." `
                -StaleThresholdSec 90 `
                -WarningVariable +warnings `
                -WarningAction SilentlyContinue
        } *>&1 | Out-String

        # No exception thrown, and a warning was emitted that names the file.
        $warnings.Count | Should -BeGreaterOrEqual 1
        ($warnings -join "`n") | Should -Match "dashboard-supervisor heartbeat not found"
        ($warnings -join "`n") | Should -Match "install-dashboard-startup-task.ps1"
    }

    It "emits a stale warning when the heartbeat is older than the threshold" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".heartbeat")
        $warnings = @()
        try {
            New-HeartbeatFile -Path $tmp -AgeSec 600
            $null = & {
                Show-SupervisorHeartbeat `
                    -Name "mdns-supervisor" `
                    -HeartbeatPath $tmp `
                    -ReinstallHint "Re-run register-mdns.ps1." `
                    -StaleThresholdSec 90 `
                    -WarningVariable +warnings `
                    -WarningAction SilentlyContinue
            } *>&1
            ($warnings -join "`n") | Should -Match "stale"
        } finally {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    It "renders the requested ExtraFields when present in the heartbeat" {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".heartbeat")
        try {
            New-HeartbeatFile -Path $tmp -AgeSec 5 -Extra @{
                squadronName = "RJ-1"
                apiPort      = 3847
            }
            $output = & {
                Show-SupervisorHeartbeat `
                    -Name "mdns-supervisor" `
                    -HeartbeatPath $tmp `
                    -ReinstallHint "Re-run register-mdns.ps1." `
                    -StaleThresholdSec 90 `
                    -ExtraFields @("squadronName", "apiPort")
            } 6>&1 | Out-String

            $output | Should -Match "squadronName\s*:\s*RJ-1"
            $output | Should -Match "apiPort\s*:\s*3847"
        } finally {
            Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe "check-host-health.ps1 integration" {

    It "surfaces api + mdns + dashboard heartbeats in a single run" {
        # Stage three fresh heartbeat fixtures (one per supervisor) and
        # run check-host-health.ps1 against a stub /api/healthz response.
        # The acceptance criterion for #409 is that *all three* blocks
        # appear in a single execution — nothing short-circuits when an
        # earlier supervisor's heartbeat is missing or stale.
        $apiHb       = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".api.heartbeat")
        $mdnsHb      = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".mdns.heartbeat")
        $dashboardHb = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".dashboard.heartbeat")
        try {
            New-HeartbeatFile -Path $apiHb       -AgeSec 5
            New-HeartbeatFile -Path $mdnsHb      -AgeSec 5 -Extra @{ squadronName = "RJ-1"; apiPort = 3847 }
            New-HeartbeatFile -Path $dashboardHb -AgeSec 5 -Extra @{ childScript = "C:\HawkEye\start-dashboard-host.ps1"; dashboardPort = 5001 }

            # Stub Invoke-RestMethod so the script never actually hits
            # the network. Pester 5 mocks dot-sourced/invoked scripts
            # via global function override.
            function global:Invoke-RestMethod { @{ ok = $true } }
            try {
                $script = Join-Path $script:lanHost "check-host-health.ps1"
                $output = & $script `
                    -ApiBaseUrl "http://stub" `
                    -HeartbeatPath $apiHb `
                    -MdnsHeartbeatPath $mdnsHb `
                    -DashboardHeartbeatPath $dashboardHb `
                    *>&1 | Out-String
            } finally {
                Remove-Item function:Invoke-RestMethod -ErrorAction SilentlyContinue
            }

            $output | Should -Match "api-supervisor heartbeat:"
            $output | Should -Match "mdns-supervisor heartbeat:"
            $output | Should -Match "dashboard-supervisor heartbeat:"
        } finally {
            Remove-Item $apiHb,$mdnsHb,$dashboardHb -Force -ErrorAction SilentlyContinue
        }
    }

    It "still prints later supervisor blocks when an earlier heartbeat is missing" {
        # api heartbeat absent → warns, then continues to mdns + dashboard.
        $missingApi  = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".missing.heartbeat")
        $mdnsHb      = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".mdns.heartbeat")
        $dashboardHb = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + ".dashboard.heartbeat")
        try {
            New-HeartbeatFile -Path $mdnsHb      -AgeSec 5 -Extra @{ squadronName = "RJ-1"; apiPort = 3847 }
            New-HeartbeatFile -Path $dashboardHb -AgeSec 5 -Extra @{ childScript = "C:\HawkEye\start-dashboard-host.ps1" }

            function global:Invoke-RestMethod { @{ ok = $true } }
            try {
                $script = Join-Path $script:lanHost "check-host-health.ps1"
                $output = & $script `
                    -ApiBaseUrl "http://stub" `
                    -HeartbeatPath $missingApi `
                    -MdnsHeartbeatPath $mdnsHb `
                    -DashboardHeartbeatPath $dashboardHb `
                    *>&1 | Out-String
            } finally {
                Remove-Item function:Invoke-RestMethod -ErrorAction SilentlyContinue
            }

            $output | Should -Match "api-supervisor heartbeat not found"
            $output | Should -Match "mdns-supervisor heartbeat:"
            $output | Should -Match "dashboard-supervisor heartbeat:"
        } finally {
            Remove-Item $mdnsHb,$dashboardHb -Force -ErrorAction SilentlyContinue
        }
    }
}
