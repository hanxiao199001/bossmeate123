#!/bin/bash
# BossMate 本地发布 Agent — 双击启动器 (macOS)
# 放在客户包根目录, 与 dist/ package.json 同级。双击即可。
cd "$(dirname "$0")" || exit 1
clear
echo "==================================================="
echo "      BossMate 本地发布 Agent — 正在启动"
echo "==================================================="
echo

# 1) 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[缺少 Node.js] 需要先安装 Node.js (LTS 版)。"
  echo "正在为你打开下载页…"
  open "https://nodejs.org/zh-cn/download" 2>/dev/null
  echo
  echo "装好后再次双击本程序即可。按回车键退出。"
  read -r _
  exit 1
fi

# 2) 读配对配置 bossmate.cfg
SERVER_URL=""; PAIR_CODE=""; DEVICE_NAME=""
if [ -f "bossmate.cfg" ]; then
  while IFS='=' read -r k v; do
    key="$(printf '%s' "$k" | tr -d '[:space:]')"
    val="$(printf '%s' "$v" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$key" in
      SERVER_URL) SERVER_URL="$val" ;;
      PAIR_CODE)  PAIR_CODE="$val" ;;
      DEVICE_NAME) DEVICE_NAME="$val" ;;
    esac
  done < <(grep -v '^[[:space:]]*#' bossmate.cfg)
fi
[ -z "$DEVICE_NAME" ] && DEVICE_NAME="$(hostname)"

# 3) 首次安装运行环境
if [ ! -d "node_modules" ]; then
  echo "[首次运行] 正在安装运行环境(只需一次, 可能要几分钟)…"
  npm install --omit=dev || { echo; echo "环境安装失败, 请检查网络后重试。按回车键退出。"; read -r _; exit 1; }
  echo
fi

# 4) 未配对则配对
if [ ! -f "$HOME/.bossmate-agent/config.json" ]; then
  if [ -z "$SERVER_URL" ]; then read -r -p "服务器地址 (如 http://122.152.234.155): " SERVER_URL; fi
  if [ -z "$PAIR_CODE" ]; then read -r -p "配对码 (网页生成, 6 位数字): " PAIR_CODE; fi
  echo "正在配对…"
  if ! node dist/cli.js pair "$SERVER_URL" "$PAIR_CODE" "$DEVICE_NAME"; then
    echo; echo "配对失败。配对码可能已过期(10分钟), 请在网页重新生成/重新下载配置后再试。按回车键退出。"; read -r _; exit 1
  fi
  echo
  echo "配对成功! 接下来扫码登录平台账号: 会弹出浏览器, 请用对应账号的手机 App 扫码。"
  node dist/cli.js login --all || true
  echo
fi

# 5) 挂机领任务 (caffeinate 防休眠)
echo "开始挂机自动发布。请保持本窗口开着、电脑不要休眠。停止请按 Ctrl + C。"
echo
caffeinate -i node dist/cli.js run
echo
echo "Agent 已停止。按回车键关闭窗口。"
read -r _
