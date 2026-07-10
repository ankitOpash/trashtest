# Restarts ss-warning if the background watcher has stopped.
$toolsDir = Join-Path $env:APPDATA 'teamlens-agent\tools'
$pidFile = Join-Path $toolsDir 'ss-warning.pid'
$scriptPath = Join-Path $toolsDir 'ss-warning.ps1'
$logPath = Join-Path $toolsDir 'ss-warning.log'

function Write-WatchdogLog([string]$msg) {
    $line = "[{0}] [watchdog] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

$alive = $false
if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
        $alive = $true
    }
}

if (-not $alive) {
    Write-WatchdogLog 'Watcher not running - restarting (node v6)'
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
    $nodeScript = Join-Path $toolsDir 'ss-warning.js'
    Start-Process -FilePath $nodeExe -ArgumentList "`"$nodeScript`" --start" -WindowStyle Hidden -WorkingDirectory $toolsDir | Out-Null
}
