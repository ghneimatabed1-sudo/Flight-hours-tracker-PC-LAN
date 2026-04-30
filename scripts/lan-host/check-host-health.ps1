param(
  [string]$ApiBaseUrl = "http://127.0.0.1:3847",
  [int]$TimeoutSec = 5
)

$ErrorActionPreference = "Stop"

function Normalize-Base {
  param([string]$Url)
  return $Url.TrimEnd("/")
}

$base = Normalize-Base -Url $ApiBaseUrl
$healthUrl = "$base/api/healthz"

Write-Host "[hawk-eye] Checking API health at $healthUrl"

try {
  $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec $TimeoutSec
} catch {
  Write-Error "[hawk-eye] API health check failed: $($_.Exception.Message)"
  exit 1
}

if ($null -eq $response) {
  Write-Error "[hawk-eye] Empty health response."
  exit 1
}

$ok = $false
if ($response -is [hashtable] -or $response -is [pscustomobject]) {
  $ok = ($response.ok -eq $true)
}

if (-not $ok) {
  Write-Error "[hawk-eye] Health endpoint returned non-ok payload."
  $response | ConvertTo-Json -Depth 6
  exit 1
}

Write-Host "[hawk-eye] API healthy."
$response | ConvertTo-Json -Depth 6
exit 0
