#!/usr/bin/env bash
# Smart deploy: 直连 git fetch 3 次 retry → 失败自动 bundle 绕路。
# 用法：./scripts/deploy-with-fallback.sh
# 5-1 期间腾讯云 122.152.234.155 出口对 github.com:443 间歇性 TLS 不通，
# 每次 deploy 手工 bundle 绕路浪费 1-2 分钟 + 心智，本脚本固化流程。
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

# Step 2: 直连失败 → bundle 绕路
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
  ssh "$SERVER" "cd $REMOTE_PATH && git fetch '$BUNDLE' $BRANCH:bundle-tmp && git branch -d bundle-tmp 2>/dev/null; rm -f '$BUNDLE'"
  rm -f "$BUNDLE"
  DEPLOY_PATH="bundle"
fi

# Step 3: pull + install + build + restart（直连或 bundle 后都跑）
ssh "$SERVER" "cd $REMOTE_PATH && \
  git pull --ff-only origin $BRANCH 2>&1 | tail -3 && \
  pnpm install --frozen-lockfile 2>&1 | tail -3 && \
  pnpm --filter @bossmate/server build 2>&1 | tail -3 && \
  pm2 restart bossmate-server --update-env"

ELAPSED=$(($(date +%s) - START))
echo "✅ deploy=$DEPLOY_PATH elapsed=${ELAPSED}s HEAD=$(ssh "$SERVER" "cd $REMOTE_PATH && git rev-parse --short HEAD")"
