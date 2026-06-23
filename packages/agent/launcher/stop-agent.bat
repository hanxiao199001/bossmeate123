@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BossMate Agent - Stop
echo ===================================================
echo     BossMate Agent - Stop Background Service
echo ===================================================
echo.
echo This stops the background publisher service and disables auto-start.
echo Your logins/accounts are kept. To start again, double-click start-agent.bat.
echo.
node dist\cli.js uninstall-service
echo.
echo Done. Press any key to close.
pause >nul
