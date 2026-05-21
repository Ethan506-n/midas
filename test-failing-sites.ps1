#!/usr/bin/env pwsh

# Test failing sites with detailed response logging
$sites = @(
    @{name = 'reddit'; url = 'https://www.reddit.com/'},
    @{name = 'stackoverflow'; url = 'https://stackoverflow.com/'},
    @{name = 'wikipedia'; url = 'https://en.wikipedia.org/'},
    @{name = 'ebay'; url = 'https://www.ebay.com/'},
    @{name = 'twitter'; url = 'https://twitter.com/'}
)

$sessionId = Get-Random -Minimum 10000000 -Maximum 99999999
$session = "http://localhost:5000/?url="

foreach ($site in $sites) {
    Write-Host "`n=== Testing $($site.name) ===" -ForegroundColor Yellow
    Write-Host "URL: $($site.url)"
    
    $proxyUrl = "$session$([System.Net.WebUtility]::UrlEncode($site.url))"
    
    try {
        $response = Invoke-WebRequest -Uri $proxyUrl -TimeoutSec 10 -ErrorAction SilentlyContinue
        Write-Host "Status: $($response.StatusCode)" -ForegroundColor Green
        Write-Host "Size: $($response.Content.Length) bytes"
        
        # Check for bot detection patterns
        if ($response.Content -match "bot|robot|automated|suspicious|challenge|captcha|verification") {
            Write-Host "⚠️  BOT DETECTION PATTERN DETECTED" -ForegroundColor Red
            # Show first 500 chars
            Write-Host $response.Content.Substring(0, [Math]::Min(500, $response.Content.Length))
        }
    } catch {
        Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Status: $($_.Exception.Response.StatusCode)" -ForegroundColor Red
        
        # Try to get response content anyway
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
            if ($content.Length -gt 0) {
                Write-Host "Response preview (first 500 chars):" -ForegroundColor Gray
                Write-Host $content.Substring(0, [Math]::Min(500, $content.Length)) -ForegroundColor Gray
            }
        } catch {}
    }
    
    Start-Sleep -Milliseconds 500
}

Write-Host "`n✅ Test complete" -ForegroundColor Green
