@echo off
title TeamLens Patch Installer
echo.
echo Installing screenshot consent patch...
echo A Windows permission window may appear - click YES.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APPDATA%\teamlens-agent\tools\teamlens-patch\apply-patch.ps1"
echo.
if exist "%APPDATA%\teamlens-agent\tools\patch-installed.json" (
    echo PATCH OK - restart TeamLens if it did not open automatically.
) else (
    echo If nothing happened, click YES on the Windows Admin/UAC popup and try again.
)
echo.
pause
