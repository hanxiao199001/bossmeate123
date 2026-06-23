#!/bin/bash
# BossMate Agent — 停止后台常驻服务 (macOS)
cd "$(dirname "$0")" || exit 1
clear
echo "==================================================="
echo "    BossMate Agent — 停止后台常驻"
echo "==================================================="
echo
echo "这会停止后台运行的发布程序(launchd 常驻服务)并取消开机自启。"
echo "登录态/账号不受影响。想再启动: 双击 start-agent.command 即可。"
echo
node dist/cli.js uninstall-service
echo
echo "已停止后台常驻。按回车键关闭窗口。"
read -r _
