@echo off
chcp 65001 >nul
title BossMate Agent Cleanup
echo ===================================================
echo    BossMate Agent - Reset / Cleanup
echo    Use this once if you see "device revoked" stuck.
echo ===================================================
echo.
echo This removes the OLD (revoked) agent config so you can
echo pair again with a FRESH code from the web.
echo.
echo Step 1/2: stopping any running agent...
node dist\cli.js uninstall-service >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul
echo Step 2/2: removing old config...
if exist "%USERPROFILE%\.bossmate-agent" (
  rmdir /s /q "%USERPROFILE%\.bossmate-agent"
  if exist "%USERPROFILE%\.bossmate-agent" (
    echo.
    echo [!] Could not fully remove. Please close any open agent window
    echo     and run this cleanup again.
  ) else (
    echo Done. Old config removed.
  )
) else (
  echo Already clean - no old config found.
)
echo.
echo ===================================================
echo Next steps:
echo   1. Ask your contact for a FRESH 6-digit pairing code.
echo   2. Double-click "start-agent.bat" in the NEW package.
echo   3. Enter the fresh code when asked.
echo   4. Scan the QR with your phone app to log in accounts.
echo ===================================================
echo.
pause
