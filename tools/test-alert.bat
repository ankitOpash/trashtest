@echo off
title TeamLens Alert Test
echo Showing test alert dialog...
(
echo TeamLens Screenshot Alert
) > "%APPDATA%\teamlens-agent\tools\popup-title.txt"
(
echo TEST: If you see this yellow warning box, alerts are working.^
echo.^
echo It will auto-close in 30 seconds.
) > "%APPDATA%\teamlens-agent\tools\popup-msg.txt"
echo 30> "%APPDATA%\teamlens-agent\tools\popup-timeout.txt"
wscript.exe "%APPDATA%\teamlens-agent\tools\show-popup.vbs"
pause
