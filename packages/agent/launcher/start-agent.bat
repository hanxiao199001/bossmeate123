@echo off

chcp 65001 >nul

setlocal enabledelayedexpansion

cd /d "%~dp0"

title BossMate Agent

echo ===================================================

echo       BossMate Local Publisher Agent

echo ===================================================

echo.

where node >nul 2>nul

if errorlevel 1 (

  echo [Node.js not found] Please install Node.js LTS first.

  echo Opening the download page in your browser...

  start "" "https://nodejs.org/en/download"

  echo.

  echo After installing Node.js, double-click this file again.

  echo.

  pause

  exit /b 1

)

set "SERVER_URL="

set "PAIR_CODE="

set "DEVICE_NAME="

if exist "bossmate.cfg" (

  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("bossmate.cfg") do (

    if /i "%%a"=="SERVER_URL" set "SERVER_URL=%%b"

    if /i "%%a"=="PAIR_CODE"  set "PAIR_CODE=%%b"

    if /i "%%a"=="DEVICE_NAME" set "DEVICE_NAME=%%b"

  )

)

if "!DEVICE_NAME!"=="" set "DEVICE_NAME=%COMPUTERNAME%"

if not exist "node_modules" (

  echo [First run] Installing runtime, this may take a few minutes...

  call npm install --omit=dev

  if errorlevel 1 (

    echo.

    echo Install failed. Please check the network and try again.

    pause

    exit /b 1

  )

  echo.

)

if exist "%USERPROFILE%\.bossmate-agent\config.json" goto run_section



:pair_loop

if "!SERVER_URL!"=="" set /p "SERVER_URL=Server URL e.g. http://122.152.234.155 : "

if "!PAIR_CODE!"=="" set /p "PAIR_CODE=Pairing code 6 digits from the web : "

echo Pairing...

node dist\cli.js pair "!SERVER_URL!" "!PAIR_CODE!" "!DEVICE_NAME!"

if errorlevel 1 (

  echo.

  echo Pairing failed. The code may have expired, valid only 10 minutes.

  echo Ask for a fresh code, then enter it again.

  set "PAIR_CODE="

  goto pair_loop

)

echo.

echo Paired. A browser will open, scan the QR with your phone app.




:run_section
node dist\cli.js ensure-login

echo.

echo Running. Keep this window open and do not let the computer sleep. Press Ctrl+C to stop.

echo.

node dist\cli.js run

echo.

echo Agent stopped.

pause

