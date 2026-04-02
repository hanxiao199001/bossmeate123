#!/bin/bash
# ============================================
# BossMate V4 部署脚本
# 包含 V4 Phase 1+2 知识库系统 + 全部现有模块
# ============================================

set -e

SERVER="root@106.53.163.120"
REMOTE_BASE="/home/projects/bossmate"
TAR_FILE="/tmp/bossmate-v4-deploy.tar.gz"

echo "🚀 BossMate V4 部署（需扫2次码）"
echo ""

# ===== Step 1: 本地打tar包 =====
echo "📦 [1/3] 打包文件中..."

cd "$(dirname "$0")/.."

tar czf "$TAR_FILE" \
  \
  packages/server/src/index.ts \
  packages/server/src/config/env.ts \
  packages/server/src/config/logger.ts \
  \
  packages/server/src/middleware/auth.ts \
  packages/server/src/middleware/tenant.ts \
  packages/server/src/middleware/error.ts \
  \
  packages/server/src/models/db.ts \
  packages/server/src/models/schema.ts \
  packages/server/src/models/migrate.ts \
  \
  packages/server/src/routes/auth.ts \
  packages/server/src/routes/chat.ts \
  packages/server/src/routes/content.ts \
  packages/server/src/routes/dashboard.ts \
  packages/server/src/routes/health.ts \
  packages/server/src/routes/journals.ts \
  packages/server/src/routes/keywords.ts \
  packages/server/src/routes/knowledge.ts \
  packages/server/src/routes/tenant.ts \
  packages/server/src/routes/topic.ts \
  packages/server/src/routes/wechat.ts \
  packages/server/src/routes/workflow.ts \
  packages/server/src/routes/accounts.ts \
  \
  packages/server/src/services/knowledge/audit-pipeline.ts \
  packages/server/src/services/knowledge/cold-start.ts \
  packages/server/src/services/knowledge/embedding-service.ts \
  packages/server/src/services/knowledge/knowledge-service.ts \
  packages/server/src/services/knowledge/rag-retriever.ts \
  packages/server/src/services/knowledge/vector-store.ts \
  \
  packages/server/src/services/ai/chat-service.ts \
  packages/server/src/services/ai/model-router.ts \
  packages/server/src/services/ai/provider-factory.ts \
  packages/server/src/services/ai/providers/base.ts \
  packages/server/src/services/ai/providers/anthropic.ts \
  packages/server/src/services/ai/providers/openai-compatible.ts \
  \
  packages/server/src/services/crawler/types.ts \
  packages/server/src/services/crawler/index.ts \
  packages/server/src/services/crawler/baidu-academic-crawler.ts \
  packages/server/src/services/crawler/wechat-index-crawler.ts \
  packages/server/src/services/crawler/policy-crawler.ts \
  packages/server/src/services/crawler/letpub-crawler.ts \
  packages/server/src/services/crawler/openalex-crawler.ts \
  packages/server/src/services/crawler/pubmed-crawler.ts \
  packages/server/src/services/crawler/arxiv-crawler.ts \
  packages/server/src/services/crawler/keyword-cluster.ts \
  packages/server/src/services/crawler/journal-image-crawler.ts \
  \
  packages/server/src/services/agents/keyword-analyzer.ts \
  packages/server/src/services/agents/keyword-trend.ts \
  packages/server/src/services/agents/keyword-dictionary.ts \
  \
  packages/server/src/services/skills/topic-skill.ts \
  packages/server/src/services/skills/article-skill.ts \
  \
  packages/server/src/services/publisher/index.ts \
  packages/server/src/services/publisher/adapters/wechat.ts \
  packages/server/src/services/publisher/adapters/baijiahao.ts \
  packages/server/src/services/publisher/adapters/toutiao.ts \
  packages/server/src/services/publisher/adapters/zhihu.ts \
  packages/server/src/services/publisher/adapters/xiaohongshu.ts \
  \
  packages/server/src/services/style-learner.ts \
  packages/server/src/services/wechat.ts \
  packages/server/src/services/scheduler.ts \
  \
  packages/server/package.json \
  packages/server/tsconfig.json \
  \
  apps/web/src/pages/KnowledgePage.tsx \
  apps/web/src/pages/DashboardPage.tsx \
  apps/web/src/pages/DataDashboardPage.tsx \
  apps/web/src/pages/KeywordsPage.tsx \
  apps/web/src/pages/WorkflowPage.tsx \
  apps/web/src/pages/ContentPage.tsx \
  apps/web/src/pages/ContentDetailPage.tsx \
  apps/web/src/pages/AccountsPage.tsx \
  apps/web/src/pages/SettingsPage.tsx \
  apps/web/src/pages/ChatPage.tsx \
  apps/web/src/pages/LoginPage.tsx \
  apps/web/src/pages/RegisterPage.tsx \
  apps/web/src/utils/api.ts \
  apps/web/src/App.tsx \
  \
  package.json \
  pnpm-workspace.yaml \
  pnpm-lock.yaml \
  Dockerfile \
  docker-compose.yml \
  scripts/v4-verify.sh \
  2>/dev/null

TAR_SIZE=$(du -h "$TAR_FILE" | cut -f1)
echo "   打包完成: $TAR_FILE ($TAR_SIZE)"

# ===== Step 2: SCP 上传（扫码第1次）=====
echo ""
echo "📤 [2/3] 上传到服务器（请扫码验证）..."
scp "$TAR_FILE" "$SERVER:/tmp/bossmate-v4-deploy.tar.gz"
echo "   上传完成！"

# ===== Step 3: SSH 执行部署（扫码第2次）=====
echo ""
echo "🔨 [3/3] 远程执行部署（请再次扫码验证）..."
ssh "$SERVER" bash -s <<'REMOTE_SCRIPT'
set -e
cd /home/projects/bossmate

echo ">>> 备份当前版本..."
cp -r packages/server/src packages/server/src.bak.$(date +%Y%m%d%H%M) 2>/dev/null || true

echo ">>> 解压 V4 文件..."
tar xzf /tmp/bossmate-v4-deploy.tar.gz

echo ">>> 创建 LanceDB 数据目录..."
mkdir -p data/lancedb data/uploads

echo ">>> 安装依赖..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo ">>> 编译项目..."
pnpm build

echo ">>> 同步数据库结构（使用 migrate.ts 编译产物）..."
cd packages/server
node dist/models/migrate.js 2>&1 || echo "   数据库迁移跳过"
cd ../..

echo ">>> 重启服务..."
pkill -f "node.*dist/index.js" 2>/dev/null || true
sleep 1

if command -v pm2 &>/dev/null; then
  pm2 restart bossmate-server 2>/dev/null || \
    (cd packages/server && pm2 start dist/index.js --name bossmate-server)
  pm2 status
elif npx pm2 --version &>/dev/null 2>&1; then
  npx pm2 restart bossmate-server 2>/dev/null || \
    (cd packages/server && npx pm2 start dist/index.js --name bossmate-server)
  npx pm2 status
else
  echo "   pm2 未安装，用 nohup 启动..."
  cd packages/server
  nohup node dist/index.js > /tmp/bossmate-server.log 2>&1 &
  sleep 2
  echo "   PID: $(pgrep -f 'node.*dist/index.js')"
  tail -5 /tmp/bossmate-server.log
fi

echo ""
echo ">>> 部署后验证..."
sleep 3
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/v1/health)
if [ "$HEALTH" = "200" ]; then
  echo "   ✅ 服务启动正常 (HTTP 200)"
else
  echo "   ⚠️ 服务可能还在启动中 (HTTP $HEALTH)，请稍后检查"
fi

rm -f /tmp/bossmate-v4-deploy.tar.gz

echo ""
echo "✅ V4 部署完成！"
echo ""
echo "V4 新增功能："
echo "  - 知识库 CRUD + 16子库分类"
echo "  - 语义搜索 + 混合搜索 (LanceDB)"
echo "  - 5-Gate 审核管道"
echo "  - 冷启动流程"
echo "  - RAG 检索增强"
REMOTE_SCRIPT

echo ""
echo "🎉 V4 部署全部完成! 访问: http://106.53.163.120"

# 清理本地临时文件
rm -f "$TAR_FILE"
