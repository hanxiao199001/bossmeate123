# 部署改造说明：deploy:smart 默认走 bundle（不连 GitHub）

## 为什么改

部署的本质只是"把新代码弄到服务器"。GitHub 在流程里有两个角色：
- **代码仓库 / 备份 / 多端汇合** → 保留（push 从 Mac 发起，不受跨境影响）。
- **部署时服务器从 GitHub 拉代码** → 去掉。这步踩中"腾讯云→GitHub 跨境 HTTPS 抽风"（TCP 秒连、TLS/数据传输间歇 hang），是 deploy 卡死的根因。

改后：代码由 **Mac 打增量 bundle → SSH 直送服务器 → ff-merge**，全程不连 GitHub。Mac→服务器 SSH 一直稳。部署完三方（Mac=服务器=GitHub）仍一致。

## 改什么（给 CC 的指令）

把 `scripts/deploy-with-fallback.sh` **整体替换为下方新版**，要点：
1. **默认走 bundle**（不再先试直连 GitHub）；想强制直连用 `DEPLOY_DIRECT=1 ./scripts/deploy-with-fallback.sh`。
2. **所有 ssh 加超时**（`ConnectTimeout=10 + ServerAlive`），任何一步卡死最多 ~10s 报错，绝不无界等待。
3. Step 3（install/build/migrate/restart）+ Step 4（HEAD 断言）逻辑**原样保留**，不动。

> 注意：bundle 是从**本地 main** 打增量，所以部署前请确保要发的 commit 已在本地 main。GitHub 备份照常 `git push`（部署不再依赖它）。

## 新脚本全文

```bash
#!/usr/bin/env bash
# Smart deploy: 默认 bundle(Mac→服务器 SSH 直送代码, 不连 GitHub) —— 绕开服务器→GitHub 跨境 HTTPS 抽风。
# GitHub 仅作仓库/备份(push 从 Mac 发起不受影响); 部署不再让服务器拉 GitHub。
# 强制旧的直连 GitHub 方式: DEPLOY_DIRECT=1 ./scripts/deploy-with-fallback.sh
set -euo pipefail

SERVER="${BOSSMATE_DEPLOY_SERVER:-ubuntu@119.91.52.13}"
REMOTE_PATH="${BOSSMATE_REMOTE_PATH:-/home/projects/bossmate}"
BRANCH="main"
# 所有 ssh 都套超时: 任何一步卡死最多 ~10s 报错, 不再无界等待
SSH_OPTS="-o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2"
START=$(date +%s)
DEPLOY_PATH="unset"

echo "🚀 BossMate smart deploy"

# Step 1: 默认 bundle; 仅 DEPLOY_DIRECT=1 才试直连(1 次, 20s 快超时), 失败立刻转 bundle
DIRECT_OK=0
if [ "${DEPLOY_DIRECT:-0}" = "1" ]; then
  echo "↗️  DEPLOY_DIRECT=1: 试直连 GitHub fetch(1 次快超时)"
  if ssh $SSH_OPTS "$SERVER" "cd $REMOTE_PATH && timeout 20 git fetch origin $BRANCH" 2>&1 | tail -2; then
    DIRECT_OK=1; DEPLOY_PATH="direct"
  else
    echo "  直连失败 → 转 bundle"
  fi
fi

# Step 2: bundle 绕路(默认) —— 算 server HEAD, 打增量 bundle, scp 送, ff-merge。全程不连 GitHub。
if [ $DIRECT_OK -eq 0 ]; then
  echo "📦 bundle 部署(Mac 打包 → SSH 送服务器, 不连 GitHub)"
  SERVER_HEAD=$(ssh $SSH_OPTS "$SERVER" "cd $REMOTE_PATH && git rev-parse HEAD" | tr -d '[:space:]')
  LOCAL_HEAD=$(git rev-parse "$BRANCH")
  if [ "$SERVER_HEAD" = "$LOCAL_HEAD" ]; then
    echo "✅ HEAD already matches, nothing to deploy"; exit 0
  fi
  BUNDLE="/tmp/bossmate-deploy-$(date +%Y%m%d-%H%M%S).bundle"
  git bundle create "$BUNDLE" "${SERVER_HEAD}..${BRANCH}"
  scp $SSH_OPTS "$BUNDLE" "$SERVER:$BUNDLE"
  ssh $SSH_OPTS "$SERVER" bash <<EOF
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

# Step 3: install + build + migrate + restart(严格错误传播)
# 仅直连路径需 git pull; bundle 路径已 ff-merged, 跳过
PULL_BLOCK=""
if [ "$DEPLOY_PATH" = "direct" ]; then
  PULL_BLOCK="timeout 20 git pull --ff-only origin $BRANCH 2>&1 | tail -3"
fi
ssh $SSH_OPTS "$SERVER" bash <<EOF
set -euo pipefail
cd "$REMOTE_PATH"
${PULL_BLOCK}
PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile 2>&1 | tail -3
pnpm --filter @bossmate/server build 2>&1 | tail -3
pnpm --filter @bossmate/agent build 2>&1 | tail -3 || echo "⚠️ agent build 失败, 一键客户包暂不可用(不影响主部署)"
rm -f packages/agent/bossmate-agent-Windows-便携.zip packages/agent/bossmate-agent-Mac-便携.zip 2>/dev/null || true
pnpm --filter @bossmate/web build 2>&1 | tail -3
pnpm --filter @bossmate/server db:migrate 2>&1 | tail -15
pm2 restart bossmate-server --update-env
EOF

# Step 4: 最终断言 — server HEAD 必须 == 本地 BRANCH HEAD(杜绝 false-green)
SERVER_FINAL=$(ssh $SSH_OPTS "$SERVER" "cd $REMOTE_PATH && git rev-parse HEAD" | tr -d '[:space:]')
LOCAL_FINAL=$(git rev-parse "$BRANCH")
if [ "$SERVER_FINAL" != "$LOCAL_FINAL" ]; then
  echo "❌ deploy verification FAILED: server $SERVER_FINAL ≠ local $LOCAL_FINAL"
  exit 1
fi

ELAPSED=$(($(date +%s) - START))
echo "✅ deploy=$DEPLOY_PATH elapsed=${ELAPSED}s HEAD=$(git rev-parse --short "$BRANCH")"
```

## 验证步骤（CC 换完必做）

1. 本地随便提一个小 commit（或用现有未部署的 commit）。
2. 跑 `pnpm deploy:smart`，应看到 `📦 bundle 部署...` 且 `deploy=bundle elapsed=Xs`（X 应是几十秒，不再卡几分钟）。
3. 末尾断言通过（server HEAD == 本地 HEAD），`health` 200，`pm2 status` online。
4. 顺手跑一下 `scripts/__tests__/deploy-with-fallback.test.sh`（若有断言依赖旧的"直连优先"逻辑，按新行为更新）。
5. 通过后 commit + push（仓库备份）。

## 影响 / 回退

- **零业务影响**：纯部署链路改造，不碰任何业务代码。
- **回退**：万一 bundle 路径有问题，`DEPLOY_DIRECT=1 pnpm deploy:smart` 立刻回到旧的直连 GitHub 方式。
- 迁移服务器时仍只需 `export BOSSMATE_DEPLOY_SERVER=...`，逻辑不变。
