#!/bin/bash
# BossMate 本地发布 Agent — 双击启动器 (macOS, 系统 Node)
cd "$(dirname "$0")" || exit 1
clear
echo "==================================================="
echo "      BossMate 本地发布 Agent — 正在启动"
echo "==================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[缺少 Node.js] 需要先安装 Node.js (LTS 版)。正在打开下载页…"
  open "https://nodejs.org/zh-cn/download" 2>/dev/null
  echo
  echo "装好后再次双击本程序即可。按回车键退出。"
  read -r _
  exit 1
fi

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

if [ ! -d "node_modules" ]; then
  echo "[首次运行] 正在安装运行环境(只需一次, 可能要几分钟)…"
  npm install --omit=dev || { echo; echo "环境安装失败, 请检查网络后重试。按回车键退出。"; read -r _; exit 1; }
  echo
fi

do_pair() {
  while true; do
    [ -z "$SERVER_URL" ] && read -r -p "服务器地址 (如 http://119.91.52.13): " SERVER_URL
    [ -z "$PAIR_CODE" ] && read -r -p "配对码 (6 位, 网页生成): " PAIR_CODE
    echo "正在配对…"
    if node dist/cli.js pair "$SERVER_URL" "$PAIR_CODE" "$DEVICE_NAME"; then
      break
    fi
    echo
    echo "配对失败 — 配对码可能已过期(10 分钟有效)。请让对接人重新发一个新码, 然后重新输入。"
    echo
    PAIR_CODE=""
  done
  echo
  echo "配对成功! 接下来扫码登录平台账号: 会弹出浏览器, 请用对应账号的手机 App 扫码。"
  echo
}

# 6-22: 配对(仅首次或被吊销后)→ 装常驻后台服务 → 关窗口也不停。
#   设备被吊销时 Agent 自动清掉本机 config.json; 这里检测到就重新配对(用本包配对码, 过期则换新码)。
if [ ! -f "$HOME/.bossmate-agent/config.json" ]; then do_pair; fi
node dist/cli.js ensure-login || true
if [ ! -f "$HOME/.bossmate-agent/config.json" ]; then
  echo; echo "本设备已被吊销/解绑, 请用新配对码重新配对…"; echo; PAIR_CODE=""; do_pair
fi

# 装常驻服务(launchd): 后台运行 + 开机自启 + 崩溃自动拉起, 关窗口也不会停。
echo "正在设置为后台常驻运行(关掉本窗口也不会停、开机自动启动)…"
echo
if node dist/cli.js install-service; then
  sleep 2
  open "http://localhost:17653" 2>/dev/null || true
  echo
  echo "✅ 已转后台常驻运行 —— 现在可以关闭本窗口了, 程序会一直在后台跑。"
  echo "   · 加号:  在弹出的「添加发布账号」网页里, 点对应账号的【登录】扫码。"
  echo "   · 被吊销/要重置: 再次双击本启动器即可。"
  echo "   · 想停掉后台: 双击「停止常驻.command」。"
else
  echo "⚠️ 常驻服务安装失败, 退回前台运行(请保持本窗口开着、电脑别休眠)。"
  echo
  caffeinate -i node dist/cli.js run
fi
echo
echo "按回车键关闭本窗口(后台服务不受影响)。"
read -r _
