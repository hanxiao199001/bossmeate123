#!/bin/bash
# BossMate Agent 清理 / 重置 (macOS)
# 仅在出现「设备已吊销」卡死时双击一次: 清掉旧的(已吊销)身份, 之后用新配对码重新配对。
cd "$(dirname "$0")" || exit 1
clear
echo "==================================================="
echo "    BossMate Agent — 清理 / 重置"
echo "    出现「设备已吊销」卡死时, 双击本程序一次即可。"
echo "==================================================="
echo
echo "本工具会移除旧的(已吊销)Agent 身份, 让你能用网页生成的"
echo "新配对码重新配对。不影响服务器上的任何数据。"
echo

echo "第 1/2 步: 停止正在运行的 Agent…"
# 先卸载常驻服务(否则 launchd 会把它自动拉起, 清理无效)
node dist/cli.js uninstall-service >/dev/null 2>&1
# 再杀 BossMate Agent 自己(按 cli.js 进程匹配), 不动你电脑上其它 Node 程序
pkill -f "dist/cli.js" >/dev/null 2>&1
sleep 1

echo "第 2/2 步: 删除旧身份配置…"
if [ -d "$HOME/.bossmate-agent" ]; then
  rm -rf "$HOME/.bossmate-agent"
  if [ -d "$HOME/.bossmate-agent" ]; then
    echo
    echo "[!] 没能完全删除。请先关闭所有 Agent 窗口, 再运行一次本清理。"
  else
    echo "完成。旧身份已清除。"
  fi
else
  echo "已经是干净的 — 没有发现旧身份配置。"
fi

echo
echo "==================================================="
echo "接下来:"
echo "  1. 向对接人要一个新的 6 位配对码。"
echo "  2. 双击新客户包里的 \"start-agent.command\"。"
echo "  3. 按提示输入新配对码。"
echo "  4. 用手机 App 扫码登录账号。"
echo "==================================================="
echo
echo "按回车键关闭窗口。"
read -r _
