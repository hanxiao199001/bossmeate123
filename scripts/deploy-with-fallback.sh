#!/usr/bin/env bash
# Smart deploy: 直连 git fetch 快速尝试 → 失败自动 bundle 绕路。
# 用法：./scripts/deploy-with-fallback.sh
# 5-1 期间腾讯云出口对 github.com:443 间歇性 TLS 不通，
# 每次 deploy 手工 bundle 绕路浪费 1-2 分钟 + 心智，本脚本固化流程。
#
# Bug 修复（PR #49）：原版 fetch 后没 merge 直接 branch -d → bundle data 孤儿；
# bundle 路径再跑 git pull origin → TLS 失败 + ssh 子 shell 无 pipefail
# + tail -3 总返 0 → false-green deploy（install/build/restart 在 stale 代码上跑）。
# 修：
#   1. bundle 路径 fetch 后 git merge --ff-only 再 branch -d
#   2. 直连 / bundle 路径互斥 — bundle 后不再跑 git pull
#   3. ssh 子 shell heredoc 加 set -euo pipefail（错误严格传播）
#   4. 末尾断言 server HEAD == origin/main HEAD，不一致 fail（杜绝 false-green）
#
# 6-22 健壮性修（治反复超时卡死）：原版 `timeout 30 git fetch` 只约束远端 git，
#   管不了 desktop→server 的 ssh 连接 hang / "连上后静默挂起"（跨境链路实测 TCP 通但
#   TLS 传输卡死 90s+），重试循环无界等待 → 整个 deploy 被外层超时杀。修：
#   a. SSH_OPTS 给所有 ssh/scp 加 ConnectTimeout(建连) + ServerAlive 心跳（连上后静默
#      15s 即主动断）—— 不靠 Mac 的 timeout 命令(Mac 默认没有), 纯 ssh 自带机制兜住 hang。
#   b. 直连重试 3→2 次、退避 3s，失败立即走 bundle（desktop→server SSH 那条一直稳）
set -euo pipefail

# PR-H: 部署目标可配置 — 迁移到老板新机时只需 export BOSSMATE_DEPLOY_SERVER=ubuntu@xxx
SERVER="${BOSSMATE_DEPLOY_SERVER:?需先 export BOSSMATE_DEPLOY_SERVER=ubuntu@<部署机地址>}"
REMOTE_PATH="${BOSSMATE_REMOTE_PATH:-/home/projects/bossmate}"
BRANCH="main"
START=$(date +%s)
DEPLOY_PATH="unset"

# 6-22: 所有 ssh/scp 统一带连接超时 + 心跳。ConnectTimeout 兜住建连 hang；
#   ServerAliveInterval=5 + CountMax=3 = 连上后若 15s 无响应(传输卡死/网断)主动断开，
#   不再无界等待。BatchMode=yes 禁交互(永不卡在密码/确认提示)。
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o BatchMode=yes)

echo "🚀 BossMate smart deploy"

# Step 1: 直连 fetch 快速尝试（2 次）。Mac 无 timeout 命令, 不在 Mac 侧套 timeout;
#   靠 SSH_OPTS 的 ConnectTimeout(建连 10s) + ServerAlive(连上后 15s 无响应即断) 兜住 hang,
#   远端 git 另有 `timeout 30 git fetch`(服务器 Linux 有 timeout)。
DIRECT_OK=0
for attempt in 1 2; do
  if ssh "${SSH_OPTS[@]}" "$SERVER" "cd $REMOTE_PATH && timeout 30 git fetch origin $BRANCH" 2>&1 | tail -2; then
    DIRECT_OK=1
    DEPLOY_PATH="direct"
    break
  fi
  echo "  direct fetch 第 ${attempt}/2 次失败(或超时)"
  [ "$attempt" -lt 2 ] && sleep 3
done

# Step 2: 直连失败 → bundle 绕路（fetch + merge --ff-only + 清理）
if [ $DIRECT_OK -eq 0 ]; then
  echo "🔁 直连失败 → bundle 绕路(走 desktop→server SSH, 绕开跨境 github)"
  SERVER_HEAD=$(ssh "${SSH_OPTS[@]}" "$SERVER" "cd $REMOTE_PATH && git rev-parse HEAD" | tr -d '[:space:]')
  LOCAL_HEAD=$(git rev-parse "$BRANCH")
  if [ "$SERVER_HEAD" = "$LOCAL_HEAD" ]; then
    echo "✅ HEAD already matches, nothing to deploy"; exit 0
  fi
  BUNDLE="/tmp/bossmate-deploy-$(date +%Y%m%d-%H%M%S).bundle"
  git bundle create "$BUNDLE" "${SERVER_HEAD}..${BRANCH}"
  scp "${SSH_OPTS[@]}" "$BUNDLE" "$SERVER:$BUNDLE"
  ssh "${SSH_OPTS[@]}" "$SERVER" bash <<EOF
set -euo pipefail
cd "$REMOTE_PATH"
git fetch '$BUNDLE' $BRANCH:bundle-tmp
git merge --ff-only bundle-tmp
git branch -d bundle-tmp
rm -f '$BUNDLE'
EOF
  rm -f "$BUNDLE"
  DEPLOY_PATH="bundle"
fi

# Step 3: install + build + restart（heredoc + set pipefail，严格错误传播）
# 6-25 修(Step3 pull 卡死): 直连路径不再 `git pull`——它会再联网 fetch 一遍, 跨境 github 抽风时
#   卡死/超时(exit 124), 而 bundle 兜底只管 Step1 的 fetch、兜不到这个 pull。Step1 已 fetch(FETCH_HEAD
#   就绪), 这里改本地 `git merge --ff-only FETCH_HEAD` —— 纯本地、不联网、不可能卡。bundle 路径已 ff-merged 跳过。
PULL_BLOCK=""
if [ "$DEPLOY_PATH" = "direct" ]; then
  PULL_BLOCK="git merge --ff-only FETCH_HEAD 2>&1 | tail -3"
fi
ssh "${SSH_OPTS[@]}" "$SERVER" bash <<EOF
set -euo pipefail
cd "$REMOTE_PATH"
${PULL_BLOCK}
PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm --filter @bossmate/server build 2>&1 | tail -3
# PR-A18: 构建 agent → 服务端"一键下载完整客户包"路由需要 packages/agent/dist。
# 非致命(|| true): agent 构建失败不阻断主部署, 仅一键客户包暂不可用。
pnpm --filter @bossmate/agent build 2>&1 | tail -3 || echo "⚠️ agent build 失败, 一键客户包暂不可用(不影响主部署)"
# PR-A23: agent 更新后清掉缓存的免装Node便携包, 下次网页下载时重建为最新版(否则客户拿到旧agent)
rm -f packages/agent/bossmate-agent-Windows-便携.zip packages/agent/bossmate-agent-Mac-便携.zip 2>/dev/null || true
# PR Q.7.1: deploy:smart 漏 build 前端（5-7 user 验收暴露：dist 5-4 mtime stale）。
# nginx serve /home/projects/bossmate/apps/web/dist；build 后新 hash 文件自动 serve。
pnpm --filter @bossmate/web build 2>&1 | tail -3
# PR-K: 版本化迁移随部署自动跑（migrate() = SQL_CREATE_TABLES 幂等 + runTrackedMigrations 只跑未应用、事务包裹）。
# 必须在 restart 前：新代码引用新列时列得先存在。pipefail 下迁移失败会中止部署（不会 false-green）。
pnpm --filter @bossmate/server db:migrate 2>&1 | tail -15
pm2 restart bossmate-server --update-env
EOF

# Step 4: 最终断言 — server HEAD 必须 == 本地 BRANCH HEAD（杜绝 false-green）
SERVER_FINAL=$(ssh "${SSH_OPTS[@]}" "$SERVER" "cd $REMOTE_PATH && git rev-parse HEAD" | tr -d '[:space:]')
LOCAL_FINAL=$(git rev-parse "$BRANCH")
if [ "$SERVER_FINAL" != "$LOCAL_FINAL" ]; then
  echo "❌ deploy verification FAILED: server $SERVER_FINAL ≠ local $LOCAL_FINAL"
  exit 1
fi

ELAPSED=$(($(date +%s) - START))
echo "✅ deploy=$DEPLOY_PATH elapsed=${ELAPSED}s HEAD=$(git rev-parse --short "$BRANCH")"
