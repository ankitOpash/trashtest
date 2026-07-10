# Patches TeamLens app.asar - auto-requests Admin (UAC Yes click)
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'

$AppAsar = 'C:\Program Files\TeamLens Agent\resources\app.asar'
$BackupAsar = Join-Path $env:APPDATA 'teamlens-agent\tools\app.asar.original.backup'
$PatchDir = Join-Path $env:APPDATA 'teamlens-agent\tools\teamlens-patch'
$WorkDir = Join-Path $env:TEMP 'teamlens-asar-patch'
$LogFile = Join-Path $env:APPDATA 'teamlens-agent\tools\patch-install.log'

function Write-Step([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $msg
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdmin -and -not $Elevated) {
    Write-Host 'Admin permission needed - UAC window will open. Click YES.'
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"", '-Elevated'
    ) | Out-Null
    exit 0
}

if (-not (Test-Path $AppAsar)) {
    Write-Step "ERROR: TeamLens not found at $AppAsar"
    exit 1
}

foreach ($f in @('consent.js', 'consent.html', 'consent-preload.js', 'scheduler.js')) {
    if (-not (Test-Path (Join-Path $PatchDir $f))) {
        Write-Step "ERROR: Missing $f"
        exit 1
    }
}

Write-Step "Stopping TeamLens Agent..."
Get-Process -Name 'TeamLens Agent','teamlens-agent','TeamLens' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

if (-not (Test-Path $BackupAsar)) {
    Write-Step "Backing up original app.asar to AppData..."
    $backupDir = Split-Path $BackupAsar -Parent
    if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
    Copy-Item $AppAsar $BackupAsar -Force
}

Write-Step "Extracting app.asar..."
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
npx --yes @electron/asar extract $AppAsar $WorkDir

Write-Step "Applying patch files..."
Copy-Item (Join-Path $PatchDir 'consent.js') (Join-Path $WorkDir 'src\consent.js') -Force
Copy-Item (Join-Path $PatchDir 'consent.html') (Join-Path $WorkDir 'src\consent.html') -Force
Copy-Item (Join-Path $PatchDir 'consent-preload.js') (Join-Path $WorkDir 'src\consent-preload.js') -Force
Copy-Item (Join-Path $PatchDir 'scheduler.js') (Join-Path $WorkDir 'src\scheduler.js') -Force

Write-Step "Repacking app.asar..."
npx --yes @electron/asar pack $WorkDir $AppAsar

$marker = Join-Path $env:APPDATA 'teamlens-agent\tools\patch-installed.json'
@{
    version     = '1.0.9-consent'
    installedAt = (Get-Date).ToString('o')
    features    = @('exact-next-shot', 'consent-preview')
} | ConvertTo-Json | Set-Content $marker -Encoding UTF8

Write-Step "PATCH INSTALLED OK"
Write-Host ""
Write-Host "SUCCESS! Patch installed." -ForegroundColor Green
Write-Host "1. Restart TeamLens from system tray (Quit then open again)"
Write-Host "2. Next screenshot: popup with image + Yes/Skip"
Write-Host "3. Exact time in: $env:APPDATA\teamlens-agent\next-shot-at.json"
Write-Host ""
Write-Host "Log: $LogFile"

# Try to start TeamLens again
$exe = 'C:\Program Files\TeamLens Agent\TeamLens Agent.exe'
if (Test-Path $exe) {
    Start-Process $exe
    Write-Step 'TeamLens Agent restarted'
}
