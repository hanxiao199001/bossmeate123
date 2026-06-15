@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title BossMate 本地发布 Agent
echo ===================================================
echo       BossMate 本地发布 Agent - 正在启动
echo ===================================================
echo.

REM 1) 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [缺少 Node.js] 需要先安装 Node.js LTS 版。
  echo 正在为你打开下载页...
  start "" "https://nodejs.org/zh-cn/download"
  echo.
  echo 装好后再次双击本程序即可。
  pause
  exit /b 1
)

REM 2) 读配对配置 bossmate.cfg
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

REM 3) 首次安装运行环境
if not exist "node_modules" (
  echo [首次运行] 正在安装运行环境^(只需一次, 可能要几分钟^)...
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo 环境安装失败, 请检查网络后重试。
    pause
    exit /b 1
  )
  echo.
)

REM 4) 未配对则配对
if not exist "%USERPROFILE%\.bossmate-agent\config.json" (
  if "!SERVER_URL!"=="" set /p "SERVER_URL=服务器地址 (如 http://122.152.234.155): "
  if "!PAIR_CODE!"=="" set /p "PAIR_CODE=配对码 (网页生成, 6 位数字): "
  echo 正在配对...
  node dist\cli.js pair "!SERVER_URL!" "!PAIR_CODE!" "!DEVICE_NAME!"
  if errorlevel 1 (
    echo.
    echo 配对失败。配对码可能已过期^(10分钟^), 请在网页重新生成/重新下载配置后再试。
    pause
    exit /b 1
  )
  echo.
  echo 配对成功! 接下来扫码登录平台账号: 会弹出浏览器, 请用对应账号的手机 App 扫码。
  node dist\cli.js login --all
  echo.
)

REM 5) 挂机领任务
echo 开始挂机自动发布。请保持本窗口开着、电脑不要休眠。停止请按 Ctrl + C。
echo.
node dist\cli.js run
echo.
echo Agent 已停止。
pause
