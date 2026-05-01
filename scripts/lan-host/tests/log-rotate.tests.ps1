# log-rotate.tests.ps1
#
# Pester tests for scripts\lan-host\supervisor-log.ps1 (the shared
# in-process log-rotation lib used by api-supervisor.ps1,
# mdns-supervisor.ps1 and dashboard-supervisor.ps1 — Task #400 / T-O).
#
# Why a Pester test and not a Node `tsx` test like the rest of the
# repo: the rotation lib is PowerShell, runs on the Windows host with
# real filesystem semantics, and there is no portable JavaScript
# equivalent that exercises Move-Item with the exact -Force/-Encoding
# flags it uses.
#
# Run on Windows:
#   Invoke-Pester -Path scripts\lan-host\tests\log-rotate.tests.ps1
#
# Run on Linux/macOS (PowerShell Core 7+, Pester 5+ installed):
#   pwsh -Command "Invoke-Pester -Path scripts/lan-host/tests/log-rotate.tests.ps1"
#
# Acceptance (from task T-O step 6):
#   - Writing >MaxLogBytes triggers a rotation.
#   - Rotation honours MaxLogBackups (oldest dropped, .1..N shifted).

BeforeAll {
    $libRoot = Join-Path $PSScriptRoot "..\supervisor-log.ps1"
    if (-not (Test-Path $libRoot)) {
        throw "supervisor-log.ps1 not found at '$libRoot'."
    }
    . $libRoot
}

Describe "Write-RotatingLog" {

    BeforeEach {
        # Each test gets its own scratch dir under TEMP so concurrent
        # test runs don't trample each other.
        $script:scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("hawk-eye-log-rotate-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:scratch | Out-Null
        $script:logPath = Join-Path $script:scratch "test.log"
    }

    AfterEach {
        if ($script:scratch -and (Test-Path $script:scratch)) {
            Remove-Item -Recurse -Force -Path $script:scratch -ErrorAction SilentlyContinue
        }
    }

    It "creates the log file when it does not exist" {
        Write-RotatingLog -Path $script:logPath -Line "first line" -MaxBytes 1048576 -MaxBackups 3
        Test-Path $script:logPath | Should -BeTrue
        (Get-Content -Path $script:logPath -Raw) | Should -Match "first line"
    }

    It "does not rotate while the log stays under MaxBytes" {
        # Three small lines, plenty of headroom under a 4 KB cap.
        for ($i = 0; $i -lt 3; $i++) {
            Write-RotatingLog -Path $script:logPath -Line ("line " + $i) -MaxBytes 4096 -MaxBackups 3
        }
        Test-Path "$($script:logPath).1" | Should -BeFalse
        Get-RotatedLogCount -Path $script:logPath | Should -Be 0
    }

    It "rotates once the file exceeds MaxBytes (5 MB write at 2 MB cap)" {
        # Mirror the task acceptance: write 5 MB of log -> file rotates.
        # Use 32 KB chunks so we don't blow the test out with 5M
        # individual Write-RotatingLog calls.
        $chunk = [string]::new('x', 32768)
        for ($i = 0; $i -lt 160; $i++) {  # 160 * 32 KB = 5 MB
            Write-RotatingLog -Path $script:logPath -Line $chunk -MaxBytes 2097152 -MaxBackups 3
        }
        Test-Path "$($script:logPath).1" | Should -BeTrue
        # Live file is back below the cap (it was just rotated and then
        # got the latest few chunks appended).
        $liveSize = (Get-Item -Path $script:logPath).Length
        $liveSize | Should -BeLessThan 2097152
    }

    It "honours MaxLogBackups (3) and never keeps a .4" {
        # Force at least 5 rotations by setting a tiny cap.
        $line = [string]::new('x', 600)
        for ($i = 0; $i -lt 25; $i++) {
            Write-RotatingLog -Path $script:logPath -Line $line -MaxBytes 1024 -MaxBackups 3
        }
        # Backups .1..3 must exist; .4 must not.
        Test-Path "$($script:logPath).1" | Should -BeTrue
        Test-Path "$($script:logPath).2" | Should -BeTrue
        Test-Path "$($script:logPath).3" | Should -BeTrue
        Test-Path "$($script:logPath).4" | Should -BeFalse
        Get-RotatedLogCount -Path $script:logPath | Should -Be 3
    }

    It "discards history when MaxBackups=0" {
        $line = [string]::new('x', 600)
        for ($i = 0; $i -lt 5; $i++) {
            Write-RotatingLog -Path $script:logPath -Line $line -MaxBytes 1024 -MaxBackups 0
        }
        Test-Path "$($script:logPath).1" | Should -BeFalse
        Get-RotatedLogCount -Path $script:logPath | Should -Be 0
    }

    It "never throws even if the target dir is read-only" {
        # Simulate a hostile FS by pointing at a path under a removed
        # directory. The rotation lib promises best-effort logging
        # (a logger failure must not crash the supervisor).
        $bogus = Join-Path $script:scratch "does-not-exist\nope.log"
        { Write-RotatingLog -Path $bogus -Line "boom" -MaxBytes 1024 -MaxBackups 3 } |
            Should -Not -Throw
    }
}

Describe "Get-RotatedLogCount" {

    BeforeEach {
        $script:scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("hawk-eye-log-rotate-count-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $script:scratch | Out-Null
        $script:logPath = Join-Path $script:scratch "supv.log"
    }

    AfterEach {
        if ($script:scratch -and (Test-Path $script:scratch)) {
            Remove-Item -Recurse -Force -Path $script:scratch -ErrorAction SilentlyContinue
        }
    }

    It "returns 0 when nothing has rotated yet" {
        Set-Content -Path $script:logPath -Value "live" -Encoding UTF8
        Get-RotatedLogCount -Path $script:logPath | Should -Be 0
    }

    It "counts contiguous rotations" {
        Set-Content -Path $script:logPath -Value "live" -Encoding UTF8
        Set-Content -Path "$($script:logPath).1" -Value "r1" -Encoding UTF8
        Set-Content -Path "$($script:logPath).2" -Value "r2" -Encoding UTF8
        Get-RotatedLogCount -Path $script:logPath | Should -Be 2
    }

    It "stops at the first gap (does not count a stray .5)" {
        Set-Content -Path $script:logPath -Value "live" -Encoding UTF8
        Set-Content -Path "$($script:logPath).1" -Value "r1" -Encoding UTF8
        # No .2; a stray .5 should not be counted.
        Set-Content -Path "$($script:logPath).5" -Value "r5" -Encoding UTF8
        Get-RotatedLogCount -Path $script:logPath | Should -Be 1
    }
}
