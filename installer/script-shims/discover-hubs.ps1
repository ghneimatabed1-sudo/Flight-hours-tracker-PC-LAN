# discover-hubs.ps1
#
# Helper invoked by the Inno Setup viewer page when the operator
# clicks "Discover hubs on the LAN". Browses _hawkeye-hub._tcp via
# Bonjour's dns-sd.exe, resolves each instance to a hostname:port,
# and writes the results to -OutputFile, one per line, formatted as:
#
#   <instance-name>|<host>|<port>
#
# Lines starting with "#" are status / warning messages the wizard
# can show. Exits 0 if at least the browse phase completed (even if
# no hubs were found); exits non-zero only if dns-sd.exe is missing.
#
# Mirrors the dns-sd usage in scripts\lan-host\aggregator-first-time-setup.ps1
# (Invoke-MdnsHubBrowse + Resolve-MdnsHub) so behaviour matches what
# the manual aggregator install does.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string] $OutputFile,
    [int] $BrowseTimeoutSeconds  = 4,
    [int] $ResolveTimeoutSeconds = 2
)

$ErrorActionPreference = "Continue"

function Find-DnsSd {
    $cmd = Get-Command dns-sd.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "C:\Program Files\Bonjour\dns-sd.exe",
        "C:\Program Files (x86)\Bonjour\dns-sd.exe"
    )) { if (Test-Path $p) { return $p } }
    return $null
}

# Always (re)create the output file so the wizard can stat it cleanly.
"# discover-hubs.ps1 starting" | Out-File -FilePath $OutputFile -Encoding UTF8

$dnsSd = Find-DnsSd
if (-not $dnsSd) {
    "# dns-sd.exe not found (Bonjour Print Services for Windows is not installed). Manual entry only." |
        Add-Content -Path $OutputFile -Encoding UTF8
    exit 2
}

# Browse for instances.
$browseTmp = [System.IO.Path]::GetTempFileName()
$proc = Start-Process -FilePath $dnsSd `
    -ArgumentList "-B","_hawkeye-hub._tcp","local." `
    -RedirectStandardOutput $browseTmp `
    -PassThru -WindowStyle Hidden
Start-Sleep -Seconds $BrowseTimeoutSeconds
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

$instances = @()
if (Test-Path $browseTmp) {
    foreach ($line in (Get-Content $browseTmp -ErrorAction SilentlyContinue)) {
        if ($line -match '\bAdd\b\s+\d+\s+\d+\s+\S+\s+_hawkeye-hub\._tcp\.\s+(.+?)\s*$') {
            $name = $matches[1].Trim()
            if ($name -and ($instances -notcontains $name)) { $instances += $name }
        }
    }
    Remove-Item -Path $browseTmp -ErrorAction SilentlyContinue
}

if ($instances.Count -eq 0) {
    "# no _hawkeye-hub._tcp instances found on the LAN" | Add-Content -Path $OutputFile -Encoding UTF8
    exit 0
}

foreach ($inst in $instances) {
    if ($inst -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9 _\-]{0,61}[A-Za-z0-9])?$') {
        "# skipping suspicious instance name '$inst'" | Add-Content -Path $OutputFile -Encoding UTF8
        continue
    }
    $resolveTmp = [System.IO.Path]::GetTempFileName()
    $rp = Start-Process -FilePath $dnsSd `
        -ArgumentList "-L",$inst,"_hawkeye-hub._tcp","local." `
        -RedirectStandardOutput $resolveTmp `
        -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds $ResolveTimeoutSeconds
    if (-not $rp.HasExited) { Stop-Process -Id $rp.Id -Force -ErrorAction SilentlyContinue }
    $hostName = $null; $port = $null
    if (Test-Path $resolveTmp) {
        foreach ($line in (Get-Content $resolveTmp -ErrorAction SilentlyContinue)) {
            if ($line -match 'can be reached at\s+(\S+?)\.?:(\d+)') {
                $hostName = $matches[1]
                $port     = [int]$matches[2]
            }
        }
        Remove-Item -Path $resolveTmp -ErrorAction SilentlyContinue
    }
    if ($hostName -and $port) {
        "$inst|$hostName|$port" | Add-Content -Path $OutputFile -Encoding UTF8
    } else {
        "# failed to resolve instance '$inst'" | Add-Content -Path $OutputFile -Encoding UTF8
    }
}

exit 0
