# supervisor-log.Tests.ps1
#
# Pester tests for the in-process log-rotation helpers in
# supervisor-log.ps1 (Hawk Eye Task #406, Step 6).
#
# These tests can only run on a host with PowerShell + Pester
# installed (i.e. the Windows LAN box where the supervisors live).
# They are NOT part of the Linux dev container's `release:verify`
# gate; the operator runbook documents how to run them by hand
# during install acceptance.
#
#   PS> Install-Module Pester -Scope CurrentUser -Force
#   PS> Invoke-Pester -Path scripts/lan-host/supervisor-log.Tests.ps1
#
# What we cover (each Hawk Eye supervisor depends on every one of
# these holding):
#   - Write-RotatingLog appends until MaxBytes is exceeded
#   - Once the threshold is crossed it shells through to
#     Invoke-SupervisorLogRotation, demoting the active log to .1
#   - Repeated saturation walks .1 → .2 → ... → .MaxBackups; the
#     oldest copy is discarded (no unbounded growth)
#   - Get-RotatedLogCount reports the saturated count, plateauing
#     at MaxBackups (it is a current-on-disk count, not a lifetime
#     counter)
#   - MaxBackups = 0 means "discard, don't archive"
#   - Write-RotatingLog never throws even when the directory is
#     read-only or the path is bogus (a logging failure must never
#     take the supervisor down with it)

BeforeAll {
    $script:ModuleUnderTest = Join-Path $PSScriptRoot 'supervisor-log.ps1'
    if (-not (Test-Path $script:ModuleUnderTest)) {
        throw "Cannot find supervisor-log.ps1 next to $($MyInvocation.MyCommand.Path)"
    }
    . $script:ModuleUnderTest

    $script:WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
        "hawkeye-supervisor-log-tests-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $script:WorkRoot | Out-Null
}

AfterAll {
    if ($script:WorkRoot -and (Test-Path $script:WorkRoot)) {
        Remove-Item -Path $script:WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Write-RotatingLog' {

    BeforeEach {
        $script:LogPath = Join-Path $script:WorkRoot ("supervisor-" + [guid]::NewGuid().ToString("N") + ".log")
    }

    It 'appends a line to a brand-new log without rotating' {
        Write-RotatingLog -Path $script:LogPath -Line 'first boot' `
            -MaxBytes 1048576 -MaxBackups 3

        Test-Path $script:LogPath | Should -BeTrue
        (Get-Content -Path $script:LogPath) | Should -Be 'first boot'
        Get-RotatedLogCount -Path $script:LogPath | Should -Be 0
    }

    It 'appends without rotating while size stays under MaxBytes' {
        for ($i = 1; $i -le 10; $i++) {
            Write-RotatingLog -Path $script:LogPath -Line ("line-$i") `
                -MaxBytes 1048576 -MaxBackups 3
        }
        (Get-Content -Path $script:LogPath).Count | Should -Be 10
        Get-RotatedLogCount -Path $script:LogPath | Should -Be 0
    }

    It 'rotates the active log to .1 once writing the next line would exceed MaxBytes' {
        # MaxBytes=20 means after a couple of short lines we will
        # cross the threshold and the helper must rotate.
        Write-RotatingLog -Path $script:LogPath -Line 'aaaaaaaa' -MaxBytes 20 -MaxBackups 3
        Write-RotatingLog -Path $script:LogPath -Line 'bbbbbbbb' -MaxBytes 20 -MaxBackups 3

        # The third short line pushes us over 20 bytes worth of
        # accumulated content + newline overhead.
        Write-RotatingLog -Path $script:LogPath -Line 'cccccccc' -MaxBytes 20 -MaxBackups 3

        Test-Path "$($script:LogPath).1" | Should -BeTrue
        # Active log now holds only the post-rotation line.
        (Get-Content -Path $script:LogPath) | Should -Be 'cccccccc'
        Get-RotatedLogCount -Path $script:LogPath | Should -Be 1
    }

    It 'walks rotations .1 → .2 → ... → .MaxBackups and discards the oldest' {
        # Force MaxBytes very small so every Write triggers a
        # rotation. Each line is ~10 bytes after CRLF.
        $maxBackups = 3
        for ($i = 1; $i -le 6; $i++) {
            Write-RotatingLog -Path $script:LogPath -Line ("gen-$i") `
                -MaxBytes 5 -MaxBackups $maxBackups
        }

        # Saturated: exactly $maxBackups archives plus the active log.
        Get-RotatedLogCount -Path $script:LogPath | Should -Be $maxBackups
        Test-Path "$($script:LogPath).$($maxBackups + 1)" | Should -BeFalse

        # Newest archive holds the second-most-recent generation,
        # oldest archive is the one just before it fell off.
        (Get-Content -Path "$($script:LogPath).1") | Should -Be 'gen-5'
        (Get-Content -Path "$($script:LogPath).2") | Should -Be 'gen-4'
        (Get-Content -Path "$($script:LogPath).3") | Should -Be 'gen-3'
    }

    It 'is a no-op when MaxBytes is 0 (rotation disabled)' {
        for ($i = 1; $i -le 5; $i++) {
            Write-RotatingLog -Path $script:LogPath -Line ("line-$i") `
                -MaxBytes 0 -MaxBackups 3
        }
        (Get-Content -Path $script:LogPath).Count | Should -Be 5
        Get-RotatedLogCount -Path $script:LogPath | Should -Be 0
    }

    It 'never throws when the parent directory does not exist' {
        $bogus = Join-Path $script:WorkRoot 'no-such-dir/never-existed.log'
        { Write-RotatingLog -Path $bogus -Line 'should not crash' `
            -MaxBytes 1024 -MaxBackups 3 } | Should -Not -Throw
        Test-Path $bogus | Should -BeFalse
    }
}

Describe 'Invoke-SupervisorLogRotation' {

    BeforeEach {
        $script:LogPath = Join-Path $script:WorkRoot ("rot-" + [guid]::NewGuid().ToString("N") + ".log")
        Set-Content -Path $script:LogPath -Value 'active'
    }

    It 'is a no-op when the path does not exist' {
        $missing = Join-Path $script:WorkRoot 'nope.log'
        { Invoke-SupervisorLogRotation -Path $missing -MaxBackups 3 } |
            Should -Not -Throw
        Test-Path "$missing.1" | Should -BeFalse
    }

    It 'with MaxBackups=0 simply deletes the active log (no archive)' {
        Invoke-SupervisorLogRotation -Path $script:LogPath -MaxBackups 0
        Test-Path $script:LogPath | Should -BeFalse
        Test-Path "$($script:LogPath).1" | Should -BeFalse
        Get-RotatedLogCount -Path $script:LogPath | Should -Be 0
    }

    It 'shifts existing archives one slot up before promoting the active log' {
        Set-Content -Path "$($script:LogPath).1" -Value 'old-1'
        Set-Content -Path "$($script:LogPath).2" -Value 'old-2'

        Invoke-SupervisorLogRotation -Path $script:LogPath -MaxBackups 3

        (Get-Content -Path "$($script:LogPath).1") | Should -Be 'active'
        (Get-Content -Path "$($script:LogPath).2") | Should -Be 'old-1'
        (Get-Content -Path "$($script:LogPath).3") | Should -Be 'old-2'
        Test-Path $script:LogPath | Should -BeFalse
        Get-RotatedLogCount -Path $script:LogPath | Should -Be 3
    }

    It 'discards the .MaxBackups archive when the chain is already saturated' {
        Set-Content -Path "$($script:LogPath).1" -Value 'old-1'
        Set-Content -Path "$($script:LogPath).2" -Value 'old-2'
        Set-Content -Path "$($script:LogPath).3" -Value 'oldest-going-away'

        Invoke-SupervisorLogRotation -Path $script:LogPath -MaxBackups 3

        Get-RotatedLogCount -Path $script:LogPath | Should -Be 3
        # The previously-oldest .3 must be gone; the new .3 is the
        # demoted .2 from the prior generation.
        (Get-Content -Path "$($script:LogPath).3") | Should -Be 'old-2'
        Test-Path "$($script:LogPath).4" | Should -BeFalse
    }
}

Describe 'Get-RotatedLogCount' {

    It 'returns 0 when no archives exist' {
        $p = Join-Path $script:WorkRoot ("count-empty-" + [guid]::NewGuid().ToString("N") + ".log")
        Get-RotatedLogCount -Path $p | Should -Be 0
        Set-Content -Path $p -Value 'active only'
        Get-RotatedLogCount -Path $p | Should -Be 0
    }

    It 'counts contiguous archives and stops at the first gap' {
        $p = Join-Path $script:WorkRoot ("count-gap-" + [guid]::NewGuid().ToString("N") + ".log")
        Set-Content -Path $p          -Value 'active'
        Set-Content -Path "$p.1"      -Value 'a'
        Set-Content -Path "$p.2"      -Value 'b'
        # Deliberately skip .3 and create .4 — Get-RotatedLogCount
        # must stop at the first gap, mirroring the contiguous
        # numbering that Invoke-SupervisorLogRotation produces.
        Set-Content -Path "$p.4"      -Value 'orphan'
        Get-RotatedLogCount -Path $p | Should -Be 2
    }

    It 'plateaus at MaxBackups regardless of how many rotations have happened' {
        $p = Join-Path $script:WorkRoot ("count-plateau-" + [guid]::NewGuid().ToString("N") + ".log")
        for ($i = 1; $i -le 50; $i++) {
            Write-RotatingLog -Path $p -Line ("g-$i") -MaxBytes 5 -MaxBackups 3
        }
        Get-RotatedLogCount -Path $p | Should -Be 3
    }
}
