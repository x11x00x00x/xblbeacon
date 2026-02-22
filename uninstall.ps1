# Manual Uninstall Script for XBL Beacon
# Run this script as Administrator if needed

Write-Host "XBL Beacon Uninstaller" -ForegroundColor Cyan
Write-Host "========================" -ForegroundColor Cyan
Write-Host ""

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Note: Some operations may require administrator privileges." -ForegroundColor Yellow
    Write-Host ""
}

# Application paths
$appDataPath = "$env:APPDATA\xblbeacon"
$localAppDataPath = "$env:LOCALAPPDATA\Programs\xblbeacon"
$registryUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.xbl.beacon"
$registryRunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$registryAppKey = "HKCU:\Software\XBLBeacon"

$removed = $false

# Remove application data
if (Test-Path $appDataPath) {
    Write-Host "Removing application data..." -ForegroundColor Green
    Remove-Item -Path $appDataPath -Recurse -Force -ErrorAction SilentlyContinue
    $removed = $true
    Write-Host "  ✓ Removed: $appDataPath" -ForegroundColor Green
} else {
    Write-Host "  - Application data not found" -ForegroundColor Gray
}

# Remove application files
if (Test-Path $localAppDataPath) {
    Write-Host "Removing application files..." -ForegroundColor Green
    Remove-Item -Path $localAppDataPath -Recurse -Force -ErrorAction SilentlyContinue
    $removed = $true
    Write-Host "  ✓ Removed: $localAppDataPath" -ForegroundColor Green
} else {
    Write-Host "  - Application files not found" -ForegroundColor Gray
}

# Remove registry entries
Write-Host "Removing registry entries..." -ForegroundColor Green

if (Test-Path $registryUninstallKey) {
    Remove-Item -Path $registryUninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  ✓ Removed uninstall registry key" -ForegroundColor Green
    $removed = $true
} else {
    Write-Host "  - Uninstall registry key not found" -ForegroundColor Gray
}

if (Test-Path $registryAppKey) {
    Remove-Item -Path $registryAppKey -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  ✓ Removed application registry key" -ForegroundColor Green
    $removed = $true
} else {
    Write-Host "  - Application registry key not found" -ForegroundColor Gray
}

# Remove startup entry
$runValue = Get-ItemProperty -Path $registryRunKey -Name "XBL Beacon" -ErrorAction SilentlyContinue
if ($runValue) {
    Remove-ItemProperty -Path $registryRunKey -Name "XBL Beacon" -Force -ErrorAction SilentlyContinue
    Write-Host "  ✓ Removed startup entry" -ForegroundColor Green
    $removed = $true
} else {
    Write-Host "  - Startup entry not found" -ForegroundColor Gray
}

Write-Host ""
if ($removed) {
    Write-Host "Uninstall completed successfully!" -ForegroundColor Green
    Write-Host "You may need to restart your computer for all changes to take effect." -ForegroundColor Yellow
} else {
    Write-Host "No XBL Beacon installation found." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

