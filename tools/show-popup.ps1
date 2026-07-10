param(
    [string]$Title,
    [string]$Message,
    [int]$AutoCloseSec = 0
)

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot
$payloadPath = Join-Path $toolsDir 'popup-payload.json'
$logPath = Join-Path $toolsDir 'popup-error.log'

function Write-PopupLog([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $logPath -Value $line -Encoding UTF8
}

try {
    if ((-not $Title -or -not $Message) -and (Test-Path $payloadPath)) {
        $payload = Get-Content $payloadPath -Raw | ConvertFrom-Json
        if (-not $Title) { $Title = [string]$payload.Title }
        if (-not $Message) { $Message = [string]$payload.Message }
        if ($AutoCloseSec -le 0) { $AutoCloseSec = [int]$payload.AutoCloseSec }
    }

    if (-not $Title) { $Title = 'TeamLens Screenshot Alert' }
    if (-not $Message) {
        $Message = "TeamLens may capture your screen in about 1 minute.`r`n`r`nPlease switch to your work window now.`r`n`r`nThis alert closes automatically in 30 seconds."
    }
    if ($AutoCloseSec -le 0) { $AutoCloseSec = 30 }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    try { [System.Media.SystemSounds]::Exclamation.Play() } catch {}

    [void][System.Windows.Forms.Application]::EnableVisualStyles()

    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Title
    $form.Size = New-Object System.Drawing.Size(520, 260)
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $true
    $form.BackColor = [System.Drawing.Color]::White

    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Text = 'Screenshot coming soon'
    $titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
    $titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(180, 90, 0)
    $titleLabel.AutoSize = $true
    $titleLabel.Location = New-Object System.Drawing.Point(18, 18)
    $form.Controls.Add($titleLabel)

    $bodyLabel = New-Object System.Windows.Forms.Label
    $bodyLabel.Text = $Message
    $bodyLabel.Font = New-Object System.Drawing.Font('Segoe UI', 11)
    $bodyLabel.ForeColor = [System.Drawing.Color]::Black
    $bodyLabel.BackColor = [System.Drawing.Color]::White
    $bodyLabel.AutoSize = $false
    $bodyLabel.Size = New-Object System.Drawing.Size(470, 120)
    $bodyLabel.Location = New-Object System.Drawing.Point(18, 50)
    $form.Controls.Add($bodyLabel)

    $script:SecondsLeft = $AutoCloseSec
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = "OK ($script:SecondsLeft)"
    $btn.Size = New-Object System.Drawing.Size(120, 34)
    $btn.Location = New-Object System.Drawing.Point(195, 175)
    $btn.Add_Click({ $form.Close() })
    $form.Controls.Add($btn)

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.Add_Tick({
        $script:SecondsLeft--
        if ($script:SecondsLeft -le 0) {
            $timer.Stop()
            $form.Close()
            return
        }
        $btn.Text = "OK ($script:SecondsLeft)"
    })
    $timer.Start()

    $form.Add_Shown({
        $form.Activate()
        $form.BringToFront()
        [void]$form.Focus()
    })

    [void]$form.ShowDialog()
}
catch {
    Write-PopupLog $_.Exception.Message
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($Message, $Title, 'OK', 'Warning') | Out-Null
    }
    catch {
        Write-PopupLog "Fallback MessageBox failed: $($_.Exception.Message)"
    }
}
