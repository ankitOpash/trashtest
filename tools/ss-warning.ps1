# TeamLens Screenshot Warning — launcher for ss-warning.js (v6)
# Uses TeamLens activity.js idle logic + scheduler.js min/max policy.

param(
    [switch]$InstallStartup,
    [switch]$UninstallStartup,
    [switch]$StopTool,
    [switch]$TestNotification,
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'

$ToolsDir = Join-Path $env:APPDATA 'teamlens-agent\tools'
$NodeScript = Join-Path $ToolsDir 'ss-warning.js'
$WatchdogScript = Join-Path $ToolsDir 'watchdog.ps1'
$TaskName = 'TeamLens-SS-Warning'
$WatchdogTaskName = 'TeamLens-SS-Warning-Watchdog'

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path (Join-Path $ToolsDir 'ss-warning.log') -Value $line -Encoding UTF8
}

function Get-NodeExe {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { return $node.Source }
    $fallback = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path $fallback) { return $fallback }
    throw 'Node.js not found. Install from https://nodejs.org'
}

function Install-StartupTask {
    $nodeExe = Get-NodeExe
    $action = New-ScheduledTaskAction `
        -Execute $nodeExe `
        -Argument "`"$NodeScript`" --start" `
        -WorkingDirectory $ToolsDir

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Log "Startup task installed: $TaskName (node v6)"

    $watchdogAction = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchdogScript`""

    $watchdogTriggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
        (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $watchdogSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $WatchdogTaskName -Action $watchdogAction -Trigger $watchdogTriggers -Settings $watchdogSettings -Principal $principal -Force | Out-Null
    Write-Log "Watchdog task installed: $WatchdogTaskName (every 5 min)"

    Write-Host 'Installed startup + watchdog tasks.'
}

function Uninstall-StartupTask {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Removed startup tasks (if they existed).'
}

function Stop-RunningTool {
    if (Test-Path $NodeScript) {
        & (Get-NodeExe) $NodeScript --stop 2>$null
    }
    $pidFile = Join-Path $ToolsDir 'ss-warning.pid'
    if (Test-Path $pidFile) {
        $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped ss-warning (PID $oldPid)."
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Host 'No running ss-warning instance found.'
    }
}

function Start-WatcherBackground {
    if (-not (Test-Path $NodeScript)) {
        throw "Missing $NodeScript"
    }
    Stop-RunningTool
    Start-Sleep -Milliseconds 500
    & (Get-NodeExe) $NodeScript --start
}

if (-not (Test-Path $ToolsDir)) {
    New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null
}

if ($TestNotification) {
    & (Get-NodeExe) $NodeScript --test
    exit 0
}

if ($InstallStartup) {
    Install-StartupTask
    Start-WatcherBackground
    exit 0
}

if ($UninstallStartup) {
    Uninstall-StartupTask
    exit 0
}

if ($StopTool) {
    Stop-RunningTool
    exit 0
}

if ($StartNow) {
    Start-WatcherBackground
    exit 0
}

# Foreground mode (manual debug)
& (Get-NodeExe) $NodeScript --foreground
