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

-- 风格分析结果
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

-- 学习生成的模板库
CREATE TABLE IF NOT EXISTS learned_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
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

-- V4: 租户IP定位
CREATE TABLE IF NOT EXISTS tenant_ip_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  brand_name VARCHAR(200) NOT NULL,
  industry VARCHAR(100) NOT NULL,
  sub_industry VARCHAR(100),
  target_audience TEXT,
  tone_of_voice VARCHAR(100),
  content_goals JSONB DEFAULT '[]',
  taboo_topics JSONB DEFAULT '[]',
  reference_accounts JSONB DEFAULT '[]',
  visual_style JSONB DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_tenant ON tenant_ip_profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ip_industry ON tenant_ip_profiles(industry);

-- V4: 生产记录+衍生追踪
CREATE TABLE IF NOT EXISTS production_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  content_id UUID REFERENCES contents(id),
  parent_id UUID,
  format VARCHAR(50) NOT NULL,
  platform VARCHAR(50),
  title VARCHAR(500),
  body TEXT,
  word_count INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  produced_by VARCHAR(50) DEFAULT 'ai',
  tokens_used INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prod_tenant ON production_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_prod_content ON production_records(content_id);
CREATE INDEX IF NOT EXISTS idx_prod_parent ON production_records(parent_id);
CREATE INDEX IF NOT EXISTS idx_prod_format ON production_records(format);
CREATE INDEX IF NOT EXISTS idx_prod_status ON production_records(status);

-- V4: 内容数据表现
CREATE TABLE IF NOT EXISTS content_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  content_id UUID REFERENCES contents(id),
  distribution_id UUID REFERENCES distribution_records(id),
  platform VARCHAR(50) NOT NULL,
  snapshot_date DATE NOT NULL,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  followers INTEGER DEFAULT 0,
  inquiries INTEGER DEFAULT 0,
  completion_rate REAL,
  ctr REAL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cm_tenant ON content_metrics(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cm_content ON content_metrics(content_id);
CREATE INDEX IF NOT EXISTS idx_cm_distribution ON content_metrics(distribution_id);
CREATE INDEX IF NOT EXISTS idx_cm_platform ON content_metrics(platform);
CREATE INDEX IF NOT EXISTS idx_cm_date ON content_metrics(snapshot_date);

-- V4: 栏目规划日历
CREATE TABLE IF NOT EXISTS column_calendars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  column_name VARCHAR(200) NOT NULL,
  frequency VARCHAR(50) NOT NULL,
  platforms JSONB DEFAULT '[]',
  content_formats JSONB DEFAULT '[]',
  topic_pool JSONB DEFAULT '[]',
  scheduled_date DATE,
  assignee VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'planned',
  content_id UUID REFERENCES contents(id),
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_tenant ON column_calendars(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cal_column ON column_calendars(column_name);
CREATE INDEX IF NOT EXISTS idx_cal_date ON column_calendars(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cal_status ON column_calendars(status);

-- V4.5: 异步任务表
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  conversation_id UUID REFERENCES conversations(id),
  type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status);

-- V4.5: 任务执行日志表
CREATE TABLE IF NOT EXISTS task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  model VARCHAR(50),
  duration_ms INTEGER,
  detail JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);

-- 每日选题推荐
CREATE TABLE IF NOT EXISTS daily_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  date DATE NOT NULL,
  recommendations JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_rec_tenant_date ON daily_recommendations(tenant_id, date);

-- Agent: 每日内容计划
CREATE TABLE IF NOT EXISTS daily_content_plans (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  date VARCHAR(10) NOT NULL,
  tasks JSONB NOT NULL DEFAULT '[]',
  total_articles INTEGER DEFAULT 0,
  total_videos INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(tenant_id, date)
);

-- Agent: 执行日志
CREATE TABLE IF NOT EXISTS agent_logs (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agent_name VARCHAR(50) NOT NULL,
  action VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  input JSONB,
  output JSONB,
  error TEXT,
  duration_ms INTEGER,
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_tenant_date ON agent_logs(tenant_id, created_at);

-- Agent: 老板审核/修改记录
CREATE TABLE IF NOT EXISTS boss_edits (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  content_id UUID NOT NULL REFERENCES contents(id),
  action VARCHAR(20) NOT NULL,
  original_title TEXT,
  edited_title TEXT,
  original_body TEXT,
  edited_body TEXT,
  reject_reason TEXT,
  edit_distance INTEGER,
  patterns_extracted JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_boss_edits_tenant ON boss_edits(tenant_id, created_at);

-- Agent: 每日运营报告
CREATE TABLE IF NOT EXISTS daily_reports (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  date VARCHAR(10) NOT NULL,
  report JSONB NOT NULL,
  ai_summary TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(tenant_id, date)
);

-- Agent: 同行内容抓取记录
CREATE TABLE IF NOT EXISTS peer_content_crawls (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  competitor_id VARCHAR(100) NOT NULL,
  platform VARCHAR(30) NOT NULL,
  original_url TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  read_count INTEGER,
  like_count INTEGER,
  knowledge_extracted BOOLEAN DEFAULT false,
  entries_created INTEGER DEFAULT 0,
  crawled_at TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(tenant_id, content_hash)
);

-- Agent: 定时发布队列
CREATE TABLE IF NOT EXISTS scheduled_publishes (
  id VARCHAR(36) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  content_id UUID NOT NULL REFERENCES contents(id),
  platform VARCHAR(30) NOT NULL,
  account_id VARCHAR(100) NOT NULL,
  scheduled_at TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  published_at TIMESTAMP,
  error TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sp_pending ON scheduled_publishes(status, scheduled_at);

-- ============ V3 AI 销售模块 ============

-- 销售线索
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  channel VARCHAR(50) NOT NULL,
  external_id VARCHAR(200),
  name VARCHAR(200),
  contact_id VARCHAR(200),
  phone VARCHAR(50),
  email VARCHAR(200),
  source_content_id UUID REFERENCES contents(id),
  profile JSONB DEFAULT '{}',
  stage VARCHAR(30) NOT NULL DEFAULT 'new',
  intent_score INTEGER DEFAULT 0,
  assigned_user_id UUID REFERENCES users(id),
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_channel_external
  ON leads(tenant_id, channel, external_id);

-- 补丁：给已存在的 leads 表补上销售 CRM 接管相关列
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'handover_mode'
  ) THEN
    ALTER TABLE leads ADD COLUMN handover_mode VARCHAR(10) NOT NULL DEFAULT 'ai';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'taken_over_by'
  ) THEN
    ALTER TABLE leads ADD COLUMN taken_over_by UUID REFERENCES users(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'taken_over_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN taken_over_at TIMESTAMP;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'last_read_at'
  ) THEN
    ALTER TABLE leads ADD COLUMN last_read_at TIMESTAMP;
  END IF;
END $$;

-- 销售对话消息
CREATE TABLE IF NOT EXISTS sales_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id),
  direction VARCHAR(10) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  is_ai_generated BOOLEAN DEFAULT false,
  sent_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sm_lead ON sales_messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_sm_tenant ON sales_messages(tenant_id);
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
