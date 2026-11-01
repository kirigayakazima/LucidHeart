# Pair Device Script for FullAwake
# Prints configuration JSON ready to paste into Phone DSH MCP Client

$localIp = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi*", "以太网*", "Ethernet*" -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "169.254*" } | Select-Object -First 1).IPAddress
if (-not $localIp) {
    $localIp = "192.168.1.100"
}

$port = 8765
$token = "xiaoman-pc-bridge-secret-2026"

Write-Host "--- Copy and paste this into Phone DSHA MCP Client configuration ---" -ForegroundColor Green
$configJson = @"
{
  "mcpServers": {
    "fullawake": {
      "url": "http://$($localIp):$($port)/sse",
      "headers": {
        "Authorization": "Bearer $token"
      }
    }
  }
}
"@

Write-Host $configJson -ForegroundColor Yellow
