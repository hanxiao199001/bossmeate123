#!/bin/bash
# BossMate 部署脚本 v3 — 只需扫2次微信码
#
# 原理：先打tar包，SCP一次上传（扫码1次），再SSH一次执行（扫码1次）
# 用法: cd 到项目根目录, 运行 bash deploy.sh

set -e

SERVER="root@106.53.163.120"
REMOTE_BASE="/home/projects/bossmate"
TAR_FILE="/tmp/bossmate-deploy.tar.gz"

echo "🚀 BossMate 部署 v3（只需扫2次码）"
echo ""

# ===== Step 1: 本地打tar包 =====
echo "📦 [1/3] 打包文件中..."

# 需要部署的文件列表
tar czf "$TAR_FILE" \
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
  packages/server/src/services/style-learner.ts \
  packages/server/src/services/agents/keyword-analyzer.ts \
  packages/server/src/services/agents/keyword-trend.ts \
  packages/server/src/services/agents/keyword-dictionary.ts \
  packages/server/src/services/skills/topic-skill.ts \
  packages/server/src/services/ai/providers/base.ts \
  packages/server/src/routes/keywords.ts \
  packages/server/src/routes/journals.ts \
  packages/server/src/routes/topic.ts \
  packages/server/src/routes/workflow.ts \
  packages/server/src/routes/content.ts \
  packages/server/src/routes/accounts.ts \
  packages/server/src/routes/wechat.ts \
  packages/server/src/services/wechat.ts \
  packages/server/src/services/publisher/index.ts \
  packages/server/src/services/publisher/adapters/wechat.ts \
  packages/server/src/services/publisher/adapters/baijiahao.ts \
  packages/server/src/services/publisher/adapters/toutiao.ts \
  packages/server/src/services/publisher/adapters/zhihu.ts \
  packages/server/src/services/publisher/adapters/xiaohongshu.ts \
  packages/server/src/models/schema.ts \
  packages/server/src/models/migrate.ts \
  packages/server/src/config/env.ts \
  packages/server/src/index.ts \
  apps/web/src/pages/KeywordsPage.tsx \
  apps/web/src/pages/WorkflowPage.tsx \
  apps/web/src/pages/ContentPage.tsx \
  apps/web/src/pages/ContentDetailPage.tsx \
  apps/web/src/pages/AccountsPage.tsx \
  apps/web/src/pages/DashboardPage.tsx \
  apps/web/src/pages/SettingsPage.tsx \
  apps/web/src/utils/api.ts \
  apps/web/src/App.tsx \
  2>/dev/null

TAR_SIZE=$(du -h "$TAR_FILE" | cut -f1)
echo "   打包完成: $TAR_FILE ($TAR_SIZE)"

# ===== Step 2: SCP 上传（扫码第1次）=====
echo ""
echo "📤 [2/3] 上传到服务器（请扫码验证）..."
scp "$TAR_FILE" "$SERVER:/tmp/bossmate-deploy.tar.gz"
echo "   上传完成！"

# ===== Step 3: SSH 执行部署（扫码第2次）=====
echo ""
echo "🔨 [3/3] 远程执行部署（请再次扫码验证）..."
ssh "$SERVER" bash -s <<'REMOTE_SCRIPT'
set -e
cd /home/projects/bossmate

echo ">>> 解压文件..."
tar xzf /tmp/bossmate-deploy.tar.gz

echo ">>> 删除旧爬虫文件..."
rm -f packages/server/src/services/crawler/baidu-crawler.ts \
      packages/server/src/services/crawler/weibo-crawler.ts \
      packages/server/src/services/crawler/zhihu-crawler.ts \
      packages/server/src/services/crawler/toutiao-crawler.ts

echo ">>> 安装依赖..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo ">>> 同步数据库结构..."
# 用 Node.js 跑迁移（服务器上没有 psql）
cd packages/server
node -e "
import('pg').then(({default:pg})=>{
  const fs=require('fs');
  let envFile='../../.env';
  if(fs.existsSync('.env')) envFile='.env';
  const url=fs.readFileSync(envFile,'utf8').match(/DATABASE_URL=(.+)/)[1].trim();
  const c=new pg.Client({connectionString:url});
  c.connect().then(()=>c.query(\`
    CREATE TABLE IF NOT EXISTS wechat_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) UNIQUE,
      app_id VARCHAR(100) NOT NULL,
      app_secret VARCHAR(200) NOT NULL,
      access_token TEXT, token_expires_at TIMESTAMP,
      account_name VARCHAR(100),
      is_verified BOOLEAN DEFAULT false,
      thumb_media_id TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
    ALTER TABLE wechat_configs ADD COLUMN IF NOT EXISTS thumb_media_id TEXT;
    CREATE TABLE IF NOT EXISTS platform_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      platform VARCHAR(50) NOT NULL,
      account_name VARCHAR(200) NOT NULL,
      account_id VARCHAR(200),
      credentials JSONB NOT NULL DEFAULT '{}',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      is_verified BOOLEAN DEFAULT false,
      group_name VARCHAR(100),
      metadata JSONB DEFAULT '{}',
      last_published_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pa_tenant ON platform_accounts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_pa_platform ON platform_accounts(platform);
    CREATE INDEX IF NOT EXISTS idx_pa_group ON platform_accounts(group_name);

    CREATE TABLE IF NOT EXISTS keyword_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      keyword VARCHAR(200) NOT NULL,
      snapshot_date DATE NOT NULL,
      heat_score REAL NOT NULL DEFAULT 0,
      composite_score REAL DEFAULT 0,
      platforms JSONB DEFAULT '[]',
      platform_count INTEGER DEFAULT 1,
      category VARCHAR(50),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kwh_tenant ON keyword_history(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_kwh_keyword ON keyword_history(keyword);
    CREATE INDEX IF NOT EXISTS idx_kwh_date ON keyword_history(snapshot_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwh_tenant_keyword_date ON keyword_history(tenant_id, keyword, snapshot_date);

    CREATE TABLE IF NOT EXISTS industry_keywords (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      word VARCHAR(200) NOT NULL,
      level VARCHAR(20) NOT NULL,
      category VARCHAR(50),
      weight REAL DEFAULT 1.0,
      is_system BOOLEAN DEFAULT true,
      is_active BOOLEAN DEFAULT true,
      source VARCHAR(50) DEFAULT 'system',
      hit_count INTEGER DEFAULT 0,
      last_hit_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ik_tenant ON industry_keywords(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_ik_level ON industry_keywords(level);
    CREATE INDEX IF NOT EXISTS idx_ik_active ON industry_keywords(is_active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ik_tenant_word_level ON industry_keywords(tenant_id, word, level);

    -- 风格分析结果表
    CREATE TABLE IF NOT EXISTS style_analyses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      account_name VARCHAR(200) NOT NULL,
      source VARCHAR(20) NOT NULL,
      article_count INTEGER DEFAULT 0,
      title_patterns JSONB DEFAULT '{}',
      content_style JSONB DEFAULT '{}',
      layout_features JSONB DEFAULT '{}',
      overall_summary TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sa_tenant ON style_analyses(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sa_source ON style_analyses(source);

    -- 学习生成的模版库
    CREATE TABLE IF NOT EXISTS learned_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id),
      name VARCHAR(100) NOT NULL,
      "desc" TEXT,
      icon VARCHAR(10) DEFAULT '📝',
      source VARCHAR(50) NOT NULL,
      source_account VARCHAR(200),
      sections JSONB DEFAULT '[]',
      title_formula TEXT,
      style_tags JSONB DEFAULT '[]',
      sample_title TEXT,
      prompt TEXT,
      is_active BOOLEAN DEFAULT true,
      usage_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lt_tenant ON learned_templates(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_lt_source ON learned_templates(source);
    CREATE INDEX IF NOT EXISTS idx_lt_active ON learned_templates(is_active);

    -- 清理 journals 表重复数据（保留最早的一条）
    DELETE FROM journals a USING journals b
    WHERE a.tenant_id = b.tenant_id AND a.name = b.name AND a.id > b.id;

    -- 加唯一约束防止后续重复
    CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_tenant_name ON journals(tenant_id, name);
  \`)).then(()=>{console.log('   数据库迁移完成');c.end()}).catch(e=>{console.log('   迁移警告:',e.message);c.end()})
})" 2>/dev/null || echo "   数据库迁移跳过"
cd ../..

echo ">>> 编译项目..."
pnpm build

echo ">>> 重启服务..."
# 先杀掉旧进程
pkill -f "node.*dist/index.js" 2>/dev/null || true
sleep 1

# 尝试用 pm2（可能在 npx 或全局路径里）
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
echo "✅ 部署完成！"
REMOTE_SCRIPT

echo ""
echo "🎉 全部完成! 访问: http://106.53.163.120"
echo ""
echo "完整8步工作流已就绪:"
echo "  1-3 关键词搜索→聚类→标题生成"
echo "  4   找期刊文章（LetPub匹配）"
echo "  5   匹配文章模版"
echo "  6   AI创作图文"
echo "  7   核对信息准确度"
echo "  8   一键发布（预览/编辑/复制/导出HTML）"

# 清理
rm -f "$TAR_FILE"
