# Get session
$resp = Invoke-WebRequest http://localhost:5000/_midas/session -UseBasicParsing
$b = ($resp.Content | ConvertFrom-Json).paths.browse

Write-Host "=== Midas Proxy Site Test ===" -ForegroundColor Magenta
Write-Host "Session path: $b`n" -ForegroundColor Green

$sites = @(
  'google.com', 'youtube.com', 'github.com', 'reddit.com', 'stackoverflow.com',
  'wikipedia.org', 'duckduckgo.com', 'bing.com', 'amazon.com', 'ebay.com',
  'facebook.com', 'twitter.com', 'netflix.com', 'linkedin.com', 'instagram.com'
)

$results = @()

foreach ($site in $sites) {
  Write-Host -NoNewline "$site... "
  try {
    $start = Get-Date
    $r = Invoke-WebRequest "http://localhost:5000/_midas/$b`?url=https://$site" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    $time = ((Get-Date) - $start).TotalSeconds
    $size = [Math]::Round($r.Content.Length / 1024, 1)
    Write-Host "[OK] $size KB ($($time.ToString('F1'))s)" -ForegroundColor Green
    $results += "$site,OK,$size"
  } catch {
    $status = $_.Exception.Response.StatusCode
    if (!$status) { $status = "TIMEOUT" }
    Write-Host "[FAIL] $status" -ForegroundColor Red
    $results += "$site,$status,0"
  }
  Start-Sleep -Milliseconds 500
}

Write-Host "`n=== Summary ===" -ForegroundColor Magenta
$ok = ($results | Where-Object { $_ -match ',OK,' }).Count
$total = $results.Count
Write-Host "Working: $ok / $total" -ForegroundColor Green

