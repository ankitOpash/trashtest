# Restores original TeamLens app.asar from AppData backup
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'

$AppAsar = 'C:\Program Files\TeamLens Agent\resources\app.asar'
$BackupAsar = Join-Path $env:APPDATA 'teamlens-agent\tools\app.asar.original.backup'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

if (-not $isAdmin -and -not $Elevated) {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"", '-Elevated'
    ) | Out-Null
    exit 0
}

if (-not (Test-Path $BackupAsar)) {
    Write-Host "ERROR: No backup at $BackupAsar" -ForegroundColor Red
    exit 1
}

Get-Process -Name 'TeamLens Agent','teamlens-agent','TeamLens' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Copy-Item $BackupAsar $AppAsar -Force
Remove-Item (Join-Path $env:APPDATA 'teamlens-agent\tools\patch-installed.json') -ErrorAction SilentlyContinue

Write-Host "RESTORED original TeamLens" -ForegroundColor Green
$exe = 'C:\Program Files\TeamLens Agent\TeamLens Agent.exe'
if (Test-Path $exe) { Start-Process $exe }
