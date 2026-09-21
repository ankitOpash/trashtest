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

$patchFiles = @(
    'consent.js',
    'consent.html',
    'consent-preload.js',
    'scheduler.js',
    'activity.js',
    'main.js',
    'config.js'
)
foreach ($f in $patchFiles) {
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
foreach ($f in $patchFiles) {
    Copy-Item (Join-Path $PatchDir $f) (Join-Path $WorkDir "src\$f") -Force
}

Write-Step "Repacking app.asar..."
npx --yes @electron/asar pack $WorkDir $AppAsar

$marker = Join-Path $env:APPDATA 'teamlens-agent\tools\patch-installed.json'
@{
    version     = '1.0.11-consent-noidle-toggle'
    installedAt = (Get-Date).ToString('o')
    features    = @(
        'exact-next-shot',
        'consent-preview',
        'auto-post-timeout',
        'skip-replace',
        'no-idle',
        'tray-toggle'
    )
} | ConvertTo-Json | Set-Content $marker -Encoding UTF8

Write-Step "PATCH INSTALLED OK"
Write-Host ""
Write-Host "SUCCESS! Patch installed." -ForegroundColor Green
Write-Host "1. Tray menu: SS approval + no idle (checkbox on/off)"
Write-Host "2. When ON: consent popup, 30s auto-post, Skip=pick file, no idle"
Write-Host "3. When OFF: silent upload + normal idle detection"
Write-Host ""
Write-Host "Log: $LogFile"

$exe = 'C:\Program Files\TeamLens Agent\TeamLens Agent.exe'
if (Test-Path $exe) {
    Start-Process $exe
    Write-Step 'TeamLens Agent restarted'
}
