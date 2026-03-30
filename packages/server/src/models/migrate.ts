/**
 * 数据库迁移脚本
 * 使用方式：pnpm db:migrate
 *
 * 首次运行时创建所有表
 * 使用 drizzle-kit 管理后续迁移
 */
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const SQL_CREATE_TABLES = `
-- 租户表
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL,
  plan VARCHAR(20) NOT NULL DEFAULT 'trial',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  password_hash TEXT NOT NULL,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  avatar TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 对话表
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(200) DEFAULT '新对话',
  skill_type VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant ON conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  model VARCHAR(50),
  tokens_used INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_tenant ON messages(tenant_id);

-- 内容资产表
CREATE TABLE IF NOT EXISTS contents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  conversation_id UUID REFERENCES conversations(id),
  type VARCHAR(20) NOT NULL,
  title VARCHAR(300),
  body TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  platforms JSONB DEFAULT '[]',
  tokens_total INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_tenant ON contents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_content_user ON contents(user_id);
CREATE INDEX IF NOT EXISTS idx_content_type ON contents(type);

-- Token 用量日志
CREATE TABLE IF NOT EXISTS token_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  model VARCHAR(50) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_cents INTEGER DEFAULT 0,
  skill_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_tenant ON token_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_token_created ON token_logs(created_at);

-- 关键词库
CREATE TABLE IF NOT EXISTS keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  keyword VARCHAR(200) NOT NULL,
  source_platform VARCHAR(50) NOT NULL,
  heat_score REAL NOT NULL DEFAULT 0,
  composite_score REAL DEFAULT 0,
  category VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  first_seen_at TIMESTAMP DEFAULT NOW() NOT NULL,
  last_seen_at TIMESTAMP DEFAULT NOW() NOT NULL,
  appear_count INTEGER NOT NULL DEFAULT 1,
  used_in_articles JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  crawl_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kw_tenant ON keywords(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kw_platform ON keywords(source_platform);
CREATE INDEX IF NOT EXISTS idx_kw_category ON keywords(category);
CREATE INDEX IF NOT EXISTS idx_kw_crawl_date ON keywords(crawl_date);
CREATE INDEX IF NOT EXISTS idx_kw_composite ON keywords(composite_score);

-- 期刊库
CREATE TABLE IF NOT EXISTS journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(300) NOT NULL,
  name_en VARCHAR(300),
  issn VARCHAR(20),
  publisher VARCHAR(200),
  discipline VARCHAR(100),
  partition VARCHAR(20),
  impact_factor REAL,
  annual_volume INTEGER,
  acceptance_rate REAL,
  review_cycle VARCHAR(50),
  is_warning_list BOOLEAN NOT NULL DEFAULT false,
  warning_year VARCHAR(10),
  letpub_views INTEGER DEFAULT 0,
  peer_write_count INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  source VARCHAR(50),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_tenant ON journals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_journal_discipline ON journals(discipline);
CREATE INDEX IF NOT EXISTS idx_journal_partition ON journals(partition);
CREATE INDEX IF NOT EXISTS idx_journal_warning ON journals(is_warning_list);

-- 竞品内容库
CREATE TABLE IF NOT EXISTS competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  account_id VARCHAR(200) NOT NULL,
  account_name VARCHAR(200),
  platform VARCHAR(50) NOT NULL,
  article_title VARCHAR(500),
  article_content TEXT,
  article_url VARCHAR(1000),
  content_type VARCHAR(50),
  hook_words JSONB DEFAULT '[]',
  journal_mentioned JSONB DEFAULT '[]',
  public_metrics JSONB DEFAULT '{}',
  crawl_date DATE NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comp_tenant ON competitors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_comp_platform ON competitors(platform);
CREATE INDEX IF NOT EXISTS idx_comp_crawl_date ON competitors(crawl_date);
CREATE INDEX IF NOT EXISTS idx_comp_content_type ON competitors(content_type);

-- 分发记录库
CREATE TABLE IF NOT EXISTS distribution_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  content_id UUID REFERENCES contents(id),
  platform VARCHAR(50) NOT NULL,
  account_name VARCHAR(200),
  published_title VARCHAR(500),
  published_url VARCHAR(1000),
  adapted_content TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  published_at TIMESTAMP,
  metrics JSONB DEFAULT '{}',
  metrics_updated_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dist_tenant ON distribution_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dist_content ON distribution_records(content_id);
CREATE INDEX IF NOT EXISTS idx_dist_platform ON distribution_records(platform);
CREATE INDEX IF NOT EXISTS idx_dist_status ON distribution_records(status);

-- 知识库条目
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  category VARCHAR(50) NOT NULL,
  title VARCHAR(300),
  content TEXT NOT NULL,
  source VARCHAR(500),
  vector_id VARCHAR(100),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON knowledge_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);

-- 微信公众号配置
CREATE TABLE IF NOT EXISTS wechat_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) UNIQUE,
  app_id VARCHAR(100) NOT NULL,
  app_secret VARCHAR(200) NOT NULL,
  access_token TEXT,
  token_expires_at TIMESTAMP,
  account_name VARCHAR(100),
  is_verified BOOLEAN DEFAULT false,
  thumb_media_id TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 补丁：给已存在的 wechat_configs 表补上缺失的列
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wechat_configs' AND column_name = 'thumb_media_id'
  ) THEN
    ALTER TABLE wechat_configs ADD COLUMN thumb_media_id TEXT;
  END IF;
END $$;

-- 关键词热度历史（每日快照）
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

-- 行业关键词库（动态词库）
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

-- 平台账号管理（多账号+多平台）
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
`;

async function migrate() {
  logger.info("🔄 开始数据库迁移...");

  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  try {
    await client.connect();
    await client.query(SQL_CREATE_TABLES);
    logger.info("✅ 数据库迁移完成，所有表已创建");
  } catch (err) {
    logger.fatal(err, "❌ 数据库迁移失败");
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
