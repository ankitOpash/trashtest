@echo off
title TeamLens SS Warning - Install + Start
echo Installing startup task and starting the warning tool now...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APPDATA%\teamlens-agent\tools\ss-warning.ps1" -InstallStartup
echo.
echo Done. A test popup should appear if a warning is due soon.
echo To test alerts manually, run test-alert.bat
pause
