# mdns-announce-builder.ps1
#
# Hawk Eye — emit the role-aware `register-mdns.ps1` invocation that
# this PC should run for magic LAN auto-discovery.
#
# Each Hawk Eye install profile (hub / aggregator-wing /
# aggregator-base / viewer) needs to broadcast on the same shared
# service type `_hawkeye._tcp` but with its own TXT records (role,
# wing, base, hostname, version). The first-time-setup scripts
# call this helper to compute the correct register-mdns.ps1 command
# line for the chosen role and either echo it (preview), execute it
# (apply), or write it to a per-PC bootstrap script.
#
# Usage:
#   .\mdns-announce-builder.ps1 `
#       -SquadronName "tigers-hub" -ApiPort 3847 `
#       -Role hub -Wing "1st-air-wing" -Base "azraq-ab" `
#       -AppVersion "1.1.110"                                # preview
#
#   .\mdns-announce-builder.ps1 ... -Apply                   # exec it
#
# Preview is non-mutating; -Apply hands the rendered command to
# `Invoke-Expression`. The script intentionally does NOT default to
# Apply — operators always see what would run before it runs.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SquadronName,

    [Parameter(Mandatory = $true)]
    [ValidateSet("hub", "aggregator-wing", "aggregator-base", "viewer")]
    [string]$Role,

    [string]$ApiPort    = "3847",
    [string]$Wing       = "",
    [string]$Base       = "",
    [string]$Hostname   = "",
    [string]$AppVersion = "",
    [string]$DnsSdPath  = "",

    # Where register-mdns.ps1 lives. Defaults to a sibling script of
    # this builder so first-time-setup scripts that copy the lan-host
    # folder around (e.g. into ProgramData) keep working.
    [string]$RegisterScript = "",

    [switch]$Apply
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Hostname)) {
    $Hostname = $env:COMPUTERNAME
}

if ([string]::IsNullOrWhiteSpace($RegisterScript)) {
    $here = if ($PSScriptRoot -and $PSScriptRoot.Trim() -ne "") {
        $PSScriptRoot
    } else {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    $RegisterScript = Join-Path $here "register-mdns.ps1"
}
if (-not (Test-Path $RegisterScript)) {
    Write-Error "register-mdns.ps1 not found at '$RegisterScript'."
    exit 5
}

# Build the argument list. Quote every value so spaces in wing /
# base / hostname survive Invoke-Expression and schtasks.
$argParts = @(
    "-SquadronName", "`"$SquadronName`"",
    "-ApiPort",      "`"$ApiPort`"",
    "-ServiceType",  "`"_hawkeye._tcp`"",
    "-Role",         "`"$Role`"",
    "-Hostname",     "`"$Hostname`""
)
if (-not [string]::IsNullOrWhiteSpace($Wing))       { $argParts += @("-Wing",       "`"$Wing`"") }
if (-not [string]::IsNullOrWhiteSpace($Base))       { $argParts += @("-Base",       "`"$Base`"") }
if (-not [string]::IsNullOrWhiteSpace($AppVersion)) { $argParts += @("-AppVersion", "`"$AppVersion`"") }
if (-not [string]::IsNullOrWhiteSpace($DnsSdPath))  { $argParts += @("-DnsSdPath",  "`"$DnsSdPath`"") }

$cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$RegisterScript`" $($argParts -join ' ')"

Write-Host "[hawk-eye] Computed register-mdns.ps1 invocation:"
Write-Host $cmd

if ($Apply) {
    Write-Host "[hawk-eye] Applying…"
    Invoke-Expression $cmd
    exit $LASTEXITCODE
}

# Preview mode — also expose the rendered command so callers can
# capture it (e.g. `$cmd = .\mdns-announce-builder.ps1 ... | Select-Object -Last 1`).
$cmd
exit 0
