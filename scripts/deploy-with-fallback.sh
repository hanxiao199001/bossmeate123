#!/usr/bin/env bash
# Smart deploy: 直连 git fetch 3 次 retry → 失败自动 bundle 绕路。
# 用法：./scripts/deploy-with-fallback.sh
# 5-1 期间腾讯云 122.152.234.155 出口对 github.com:443 间歇性 TLS 不通，
# 每次 deploy 手工 bundle 绕路浪费 1-2 分钟 + 心智，本脚本固化流程。
#
# Bug 修复（PR #49）：原版 line 39 fetch 后没 merge 直接 branch -d → bundle data 孤儿；
# line 46 bundle 路径再跑 git pull origin → TLS 失败 + ssh 子 shell 无 pipefail
# + tail -3 总返 0 → false-green deploy（install/build/restart 在 stale 代码上跑）。
# 修：
#   1. bundle 路径 fetch 后 git merge --ff-only 再 branch -d
#   2. 直连 / bundle 路径互斥 — bundle 后不再跑 git pull
#   3. ssh 子 shell heredoc 加 set -euo pipefail（错误严格传播）
#   4. 末尾断言 server HEAD == origin/main HEAD，不一致 fail（杜绝 false-green）
set -euo pipefail

SERVER="ubuntu@122.152.234.155"
REMOTE_PATH="/home/projects/bossmate"
BRANCH="main"
START=$(date +%s)
DEPLOY_PATH="unset"

echo "🚀 BossMate smart deploy"

# Step 1: 直连 fetch 3 次 retry（5/10/15s exponential backoff）
DIRECT_OK=0
for backoff in 5 10 15; do
  if ssh "$SERVER" "cd $REMOTE_PATH && timeout 30 git fetch origin $BRANCH" 2>&1 | tail -2; then
    DIRECT_OK=1
    DEPLOY_PATH="direct"
    break
  fi
  echo "  direct fetch failed, retry in ${backoff}s..."
  sleep "$backoff"
done

# Step 2: 直连失败 → bundle 绕路（fetch + merge --ff-only + 清理）
if [ $DIRECT_OK -eq 0 ]; then
  echo "🔁 直连 3 次全失败 → bundle 绕路"
  SERVER_HEAD=$(ssh "$SERVER" "cd $REMOTE_PATH && git rev-parse HEAD" | tr -d '[:space:]')
  LOCAL_HEAD=$(git rev-parse "$BRANCH")
  if [ "$SERVER_HEAD" = "$LOCAL_HEAD" ]; then
    echo "✅ HEAD already matches, nothing to deploy"; exit 0
  fi
  BUNDLE="/tmp/bossmate-deploy-$(date +%Y%m%d-%H%M%S).bundle"
  git bundle create "$BUNDLE" "${SERVER_HEAD}..${BRANCH}"
  scp "$BUNDLE" "$SERVER:$BUNDLE"
  ssh "$SERVER" bash <<EOF
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
# 直连路径还需 git pull；bundle 路径已 ff-merged，跳过
PULL_BLOCK=""
if [ "$DEPLOY_PATH" = "direct" ]; then
  PULL_BLOCK="git pull --ff-only origin $BRANCH 2>&1 | tail -3"
fi
ssh "$SERVER" bash <<EOF
set -euo pipefail
cd "$REMOTE_PATH"
${PULL_BLOCK}
pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm --filter @bossmate/server build 2>&1 | tail -3
# PR Q.7.1: deploy:smart 漏 build 前端（5-7 user 验收暴露：dist 5-4 mtime stale，
# PR Q.0/Q.2/Q.3/Q.4/Q.7 前端改动从未自动 deploy 到服务器）。nginx serve
# /home/projects/bossmate/apps/web/dist；build 后新 hash 文件自动 serve，浏览器硬刷可见。
pnpm --filter @bossmate/web build 2>&1 | tail -3
pm2 restart bossmate-server --update-env
EOF

# Step 4: 最终断言 — server HEAD 必须 == 本地 BRANCH HEAD（杜绝 false-green）
SERVER_FINAL=$(ssh "$SERVER" "cd $REMOTE_PATH && git rev-parse HEAD" | tr -d '[:space:]')
LOCAL_FINAL=$(git rev-parse "$BRANCH")
if [ "$SERVER_FINAL" != "$LOCAL_FINAL" ]; then
  echo "❌ deploy verification FAILED: server $SERVER_FINAL ≠ local $LOCAL_FINAL"
  exit 1
fi

ELAPSED=$(($(date +%s) - START))
echo "✅ deploy=$DEPLOY_PATH elapsed=${ELAPSED}s HEAD=$(git rev-parse --short "$BRANCH")"
