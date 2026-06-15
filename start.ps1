param(
  [string]$Subdomain = "fyxzupload"
)

$ProjectDir = "C:\Users\Admin\Desktop\Fyxz Upload"
$env:Path = "$env:LOCALAPPDATA\nodejs;$ProjectDir\ffmpeg;$env:Path"

Write-Host "Starting Fyxz Upload..." -ForegroundColor Cyan

$serverLog = "$ProjectDir\server.log"
if (Test-Path $serverLog) { Remove-Item $serverLog -Force }

Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -Command `$env:Path = '$env:LOCALAPPDATA\nodejs;$ProjectDir\ffmpeg;$env:Path'; Set-Location '$ProjectDir'; node server.js 2>&1 | Out-File '$serverLog'"

Start-Sleep -Seconds 3

Write-Host "Starting public tunnel..." -ForegroundColor Cyan
$ltLog = "$ProjectDir\tunnel\lt.log"
if (Test-Path $ltLog) { Remove-Item $ltLog -Force }

Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -Command `$env:Path = '$env:LOCALAPPDATA\nodejs;$env:Path'; Set-Location '$ProjectDir'; npx localtunnel --port 3000 --subdomain $Subdomain 2>&1 | Out-File '$ltLog'"

Start-Sleep -Seconds 6

if (Test-Path $ltLog) {
  $log = Get-Content $ltLog -Raw
  if ($log -match 'your url is: (https://[^\s]+)') {
    $url = $matches[1]
    $SubtleColor = "Cyan"
    Write-Host "`n======================================" -ForegroundColor Green
    Write-Host "  Fyxz Upload is LIVE!" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Green
    Write-Host "  Upload page : $url" -ForegroundColor $SubtleColor
    Write-Host "  Share link  : $url/v/VIDEO_ID" -ForegroundColor $SubtleColor
    Write-Host "======================================" -ForegroundColor Green
    Write-Host "  Press Q to stop`n" -ForegroundColor Gray
  } else {
    Write-Host "Tunnel started, but couldn't detect URL." -ForegroundColor Yellow
    Write-Host "Check $ltLog for details." -ForegroundColor Yellow
  }
} else {
  Write-Host "Tunnel log not found. Trying to start anyway..." -ForegroundColor Yellow
}

try {
  do {
    Start-Sleep -Milliseconds 500
    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq 'Q') { break }
    }
  } while ($true)
} finally {
  Write-Host "`nShutting down..." -ForegroundColor Yellow
  Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
}
