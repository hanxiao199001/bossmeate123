/**
 * 版本化迁移 — 每条只跑一次, 由 schema_migrations 表追踪。
 *
 * 取代"往 SQL_CREATE_TABLES 大 blob 塞 ALTER + 手工保证幂等"的旧法:
 *   旧法问题: 加列易被 CREATE IF NOT EXISTS 跳过 / 裸 ALTER 重跑报错 / 无版本追踪。
 *   新法: 每个结构变更 = 数组里一条 { version, sql }, runner 只执行未应用过的, 事务包裹, 记账。
 *
 * 加结构变更: 在数组末尾追加一条, version 用"递增编号_描述"。
 *   ⚠️ 不要修改 / 删除已发布的条目 (已应用的不会重跑; 改了也不生效, 只会让新库行为不一致)。
 *   ⚠️ sql 尽量幂等 (IF NOT EXISTS), 万一同条在不同库状态不一仍安全。
 */
import { buildDisciplineCodeSql } from "../services/recommendation/discipline-mapping.js";
import { buildJournalKindSql } from "../services/journals/journal-kind.js";

export interface Migration {
  version: string;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: "001_journals_core_indexes",
    description: "中文核心筛选加速: catalogs GIN 索引 + pku/cscd 部分索引",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_journals_catalogs_gin ON journals USING gin (catalogs);
      CREATE INDEX IF NOT EXISTS idx_journals_pku_core ON journals (pku_core_level) WHERE pku_core_level IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_journals_cscd ON journals (cscd_level) WHERE cscd_level IS NOT NULL;
    `,
  },
  {
    version: "002_platform_accounts_journal_scope",
    description: "PR-K: 账号期刊定位字段 journal_scope (domestic/international/both)",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS journal_scope varchar(20) NOT NULL DEFAULT 'both';
    `,
  },
  {
    version: "003_fk_ondelete_contents",
    description: "P0-1: 引用 contents 的外键加 ON DELETE(强归属CASCADE/弱引用SET NULL), 删文章不再被外键挡500",
    sql: `
      -- 健壮辅助: 按列动态找现有外键名→替换为带 ON DELETE 的(不怕默认命名差异)
      CREATE OR REPLACE FUNCTION _set_fk_ondelete(p_tbl text, p_col text, p_parent text, p_act text) RETURNS void AS $fn$
      DECLARE c text;
      BEGIN
        FOR c IN
          SELECT con.conname FROM pg_constraint con
          WHERE con.conrelid = p_tbl::regclass AND con.contype = 'f'
            AND p_col = ANY(SELECT a.attname FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey))
        LOOP EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', p_tbl, c); END LOOP;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s',
                       p_tbl, p_tbl || '_' || p_col || '_fkey', p_col, p_parent, p_act);
      END $fn$ LANGUAGE plpgsql;

      SELECT _set_fk_ondelete('boss_edits',           'content_id',        'contents', 'CASCADE');
      SELECT _set_fk_ondelete('content_metrics',      'content_id',        'contents', 'CASCADE');
      SELECT _set_fk_ondelete('distribution_records', 'content_id',        'contents', 'SET NULL');
      SELECT _set_fk_ondelete('production_records',   'content_id',        'contents', 'SET NULL');
      SELECT _set_fk_ondelete('column_calendars',     'content_id',        'contents', 'SET NULL');
      SELECT _set_fk_ondelete('leads',                'source_content_id', 'contents', 'SET NULL');
      SELECT _set_fk_ondelete('batch_rows',           'article_id',        'contents', 'SET NULL');

      DROP FUNCTION _set_fk_ondelete(text, text, text, text);
    `,
  },
  {
    version: "004_fk_ondelete_aggregates",
    description: "P0-1: 聚合根(tenants/users/conversations/leads/journals/batches/content_templates/platform_accounts)的所有子表外键统一加 ON DELETE — NOT NULL→CASCADE, 可空→SET NULL。删租户/用户/账号等不再被外键挡500",
    sql: `
      DO $do$
      DECLARE
        parents text[] := ARRAY['tenants','users','conversations','leads','journals','batches','content_templates','platform_accounts'];
        p text; r record;
      BEGIN
        FOREACH p IN ARRAY parents LOOP
          FOR r IN
            SELECT con.conname,
                   con.conrelid::regclass::text AS tbl,
                   att.attname AS col,
                   att.attnotnull AS notnull
            FROM pg_constraint con
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
            WHERE con.contype = 'f'
              AND con.confrelid = p::regclass
              AND array_length(con.conkey, 1) = 1
          LOOP
            EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
            EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(id) ON DELETE %s',
                           r.tbl, r.conname, r.col, p,
                           CASE WHEN r.notnull THEN 'CASCADE' ELSE 'SET NULL' END);
          END LOOP;
        END LOOP;
      END $do$;
    `,
  },
  {
    version: "005_journal_usage",
    description: "PR-N: 期刊使用记录表(15天不重复冷却)",
    sql: `
      CREATE TABLE IF NOT EXISTS journal_usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        journal_id UUID NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
        content_id UUID REFERENCES contents(id) ON DELETE SET NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ju_lookup ON journal_usage (tenant_id, journal_id, used_at);
    `,
  },
  {
    version: "006_pa_browser_login",
    description: "PR-S1: platform_accounts 加浏览器登录态字段 — login_state(加密cookie/storage) / login_status(none|logged_in|expired) / login_at, 半自动平台扫码登录→推草稿箱用",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS login_state TEXT;
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS login_status VARCHAR(20) NOT NULL DEFAULT 'none';
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS login_at TIMESTAMPTZ;
    `,
  },
  {
    version: "007_agent_publish",
    description: "Agent-1 (B轨): 本地发布 Agent — agent_devices 设备表 + agent_publish_tasks 任务队列",
    sql: `
      CREATE TABLE IF NOT EXISTS agent_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        last_seen_at TIMESTAMPTZ,
        version VARCHAR(20),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_devices_tenant ON agent_devices (tenant_id);

      CREATE TABLE IF NOT EXISTS agent_publish_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        content_id UUID NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
        account_id UUID NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
        platform VARCHAR(20) NOT NULL,
        account_name VARCHAR(200),
        video_source TEXT NOT NULL,
        caption TEXT,
        title VARCHAR(200),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        agent_device_id UUID REFERENCES agent_devices(id) ON DELETE SET NULL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_apt_tenant_status ON agent_publish_tasks (tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_apt_content ON agent_publish_tasks (content_id);
    `,
  },
  {
    version: "008_pa_agent_device_binding",
    description:
      "PR-A16: 账号↔设备绑定 — platform_accounts.agent_device_id (该账号浏览器登录态在哪台客户机)。claim 按绑定路由: 未绑定任意设备可领, 已绑定只派持有登录态的那台; 设备首次成功完成该账号任务时自动绑定。多客户机不再互抢任务导致 login_expired",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS agent_device_id UUID REFERENCES agent_devices(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_pa_agent_device ON platform_accounts (agent_device_id);
    `,
  },
  {
    version: "009_cost_ledger",
    description:
      "PR-W1: 成本台账 — 每笔真金白银扣费(DVH合成/TTS/渲染/LLM)记一行流水, 按租户+时间可聚合出今日/本月消耗; 预算闸与今日驾驶舱的数据底座",
    sql: `
      CREATE TABLE IF NOT EXISTS cost_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL,
        content_id UUID REFERENCES contents(id) ON DELETE SET NULL,
        amount_cents INTEGER NOT NULL,
        quantity INTEGER,
        note VARCHAR(300),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_tenant_time ON cost_ledger (tenant_id, created_at DESC);
    `,
  },
  {
    version: "010_pa_discipline",
    description:
      "PR-W5: 账号领域定位 — platform_accounts.discipline (该账号只生成/发布此学科的内容; NULL=不限按日轮换)。配合一键生成 exclusive 模式: 每账号生成各自领域的专属内容, 解决全账号发同样文章的同质化撞车",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS discipline VARCHAR(20);
    `,
  },
  {
    version: "011_pa_disciplines_multi",
    description:
      "PR-W5b: 账号领域定位改多选 — disciplines JSONB 数组(一个号可跨多领域, 生成时从其领域池选题); 旧单选 discipline 自动迁入数组",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS disciplines JSONB NOT NULL DEFAULT '[]';
      UPDATE platform_accounts SET disciplines = jsonb_build_array(discipline) WHERE discipline IS NOT NULL AND disciplines = '[]'::jsonb;
    `,
  },
  {
    version: "012_account_persona_style",
    description:
      "PR-X1/X3: 账号人设画像(persona 自由文本注入生成prompt) + 风格画像(style_profile 由范文LLM提炼) + batch_rows.account_id(独家生成时按账号注入人设)",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS persona TEXT;
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS style_profile TEXT;
      ALTER TABLE batch_rows ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES platform_accounts(id) ON DELETE SET NULL;
    `,
  },
  {
    version: "014_pa_dvh_template",
    description: "6-19: 账号绑定数字人形象 dvh_template(目录key) — 不同账号用不同形象防查重封号",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS dvh_template varchar(40);
    `,
  },
  {
    version: "013_pa_remark",
    description: "6-19: 账号手动备注名 remark(扫码后自己标一个名字, 与自动抓的真实昵称/系统占位名并存, 显示优先)",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS remark varchar(100);
    `,
  },
  {
    version: "015_journals_composite_if",
    description: "6-20: 知网复合影响因子持久化 composite_impact_factor(国内刊影响力指标, 独立列不污染 impact_factor/hasWosData)",
    sql: `
      ALTER TABLE journals ADD COLUMN IF NOT EXISTS composite_impact_factor real;
    `,
  },
  {
    version: "016_tenant_kyc_user_phone",
    description: "6-20: 多租户地基 — tenants 企业实名(营业执照/信用代码唯一/认证状态) + users.email 改可空 + users.phone 索引(手机号登录)",
    sql: `
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS credit_code varchar(30);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_person varchar(50);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_license_url text;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verified_status varchar(20) DEFAULT 'unverified';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verified_at timestamp;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS verified_by varchar(100);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_credit_code ON tenants(credit_code);
      ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    `,
  },
  {
    version: "017_sms_codes_tenant_invites",
    description: "6-20 Phase2: 手机验证码表 sms_codes(防爆破attempt/一码一用) + 员工邀请表 tenant_invites",
    sql: `
      CREATE TABLE IF NOT EXISTS sms_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        phone varchar(20) NOT NULL,
        code_hash text NOT NULL,
        purpose varchar(30) NOT NULL,
        attempt_count integer NOT NULL DEFAULT 0,
        consumed_at timestamp,
        ip varchar(50),
        expires_at timestamp NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_sms_phone_created ON sms_codes(phone, created_at);
      CREATE TABLE IF NOT EXISTS tenant_invites (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        phone varchar(20) NOT NULL,
        role varchar(40) NOT NULL,
        invited_by_user_id uuid NOT NULL REFERENCES users(id),
        status varchar(20) NOT NULL DEFAULT 'pending',
        expires_at timestamp NOT NULL,
        accepted_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_invites_tenant ON tenant_invites(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_invites_phone_status ON tenant_invites(phone, status);
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    `,
  },
  {
    version: "018_fk_on_delete",
    description: "6-20 数据完整性: 给69个外键补 ON DELETE — 租户/内容/子表 CASCADE, 共享journals及弱引用(线索来源/账单/设备) SET NULL; notNull用户外键留RESTRICT(不硬删用户)。临时PL/pgSQL按表+列定位约束, 不依赖约束名, 幂等。",
    sql: `
      -- 临时助手: 按(表,列)定位单列外键约束(不依赖约束名), drop 后带 ON DELETE 重建。幂等。
      CREATE OR REPLACE FUNCTION _bm_set_fk(p_table text, p_col text, p_ref text, p_action text) RETURNS void AS $FN$
      DECLARE cname text;
      BEGIN
        SELECT con.conname INTO cname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND rel.relname = p_table AND att.attname = p_col
          AND array_length(con.conkey, 1) = 1
        LIMIT 1;
        IF cname IS NOT NULL THEN
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', p_table, cname);
        END IF;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s',
                       p_table, left(p_table || '_' || p_col || '_fkey', 63), p_col, p_ref, p_action);
      END;
      $FN$ LANGUAGE plpgsql;

SELECT _bm_set_fk('users','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('tenant_invites','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('conversations','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('messages','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('messages','conversation_id','conversations','CASCADE');
      SELECT _bm_set_fk('contents','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('contents','conversation_id','conversations','SET NULL');
      SELECT _bm_set_fk('token_logs','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('keywords','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('journals','tenant_id','tenants','SET NULL');
      SELECT _bm_set_fk('competitors','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('distribution_records','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('distribution_records','content_id','contents','CASCADE');
      SELECT _bm_set_fk('knowledge_entries','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('wechat_configs','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('dedup_msgs','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('work_wechat_configs','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('hard_guard_whitelist','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('tenant_feature_flags','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('keyword_history','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('industry_keywords','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('style_analyses','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('learned_templates','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('tenant_ip_profiles','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('production_records','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('production_records','content_id','contents','CASCADE');
      SELECT _bm_set_fk('content_metrics','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('content_metrics','content_id','contents','CASCADE');
      SELECT _bm_set_fk('content_metrics','distribution_id','distribution_records','SET NULL');
      SELECT _bm_set_fk('column_calendars','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('column_calendars','content_id','contents','SET NULL');
      SELECT _bm_set_fk('tasks','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('tasks','conversation_id','conversations','SET NULL');
      SELECT _bm_set_fk('task_logs','task_id','tasks','CASCADE');
      SELECT _bm_set_fk('platform_accounts','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('platform_accounts','agent_device_id','agent_devices','SET NULL');
      SELECT _bm_set_fk('content_templates','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('daily_recommendations','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('daily_content_plans','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('agent_logs','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('boss_edits','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('boss_edits','content_id','contents','CASCADE');
      SELECT _bm_set_fk('daily_reports','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('peer_content_crawls','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('leads','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('leads','source_content_id','contents','SET NULL');
      SELECT _bm_set_fk('leads','assigned_user_id','users','SET NULL');
      SELECT _bm_set_fk('leads','taken_over_by','users','SET NULL');
      SELECT _bm_set_fk('sales_messages','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('sales_messages','lead_id','leads','CASCADE');
      SELECT _bm_set_fk('tenant_preferences','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('batches','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('batch_rows','batch_id','batches','CASCADE');
      SELECT _bm_set_fk('batch_rows','account_id','platform_accounts','SET NULL');
      SELECT _bm_set_fk('batch_rows','article_id','contents','SET NULL');
      SELECT _bm_set_fk('journal_enrichment_log','journal_id','journals','CASCADE');
      SELECT _bm_set_fk('content_publish_log','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('content_publish_log','account_id','platform_accounts','CASCADE');
      SELECT _bm_set_fk('content_publish_log','initiated_user_id','users','SET NULL');
      SELECT _bm_set_fk('journal_usage','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('journal_usage','journal_id','journals','CASCADE');
      SELECT _bm_set_fk('journal_usage','content_id','contents','SET NULL');
      SELECT _bm_set_fk('cost_ledger','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('cost_ledger','content_id','contents','SET NULL');
      SELECT _bm_set_fk('agent_devices','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('agent_publish_tasks','tenant_id','tenants','CASCADE');
      SELECT _bm_set_fk('agent_publish_tasks','content_id','contents','CASCADE');
      SELECT _bm_set_fk('agent_publish_tasks','account_id','platform_accounts','CASCADE');
      SELECT _bm_set_fk('agent_publish_tasks','agent_device_id','agent_devices','SET NULL');
      DROP FUNCTION _bm_set_fk(text, text, text, text);
    `,
  },
  {
    version: "019_account_clip_style",
    description: "6-22 剪辑风格: platform_accounts 加 clip_style(academic/popsci/marketing/data; 空=按领域/范围/人设自动匹配)。",
    sql: `ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS clip_style VARCHAR(20);`,
  },
  {
    version: "020_account_cloned_voice",
    description: "6-26 声音克隆: platform_accounts 加 cloned_voice_id(百炼Qwen-TTS声音复刻voice_id; 空=用全局/预置音色)。",
    sql: `ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS cloned_voice_id VARCHAR(120);`,
  },
  {
    version: "021_work_wechat_kf",
    description: "7-2 企微微信客服 AI 客服: work_wechat_configs 加 kf_secret_enc + kf_sync_cursors 游标表 + kf_conversations/kf_messages 会话消息 + kf_faqs FAQ 库",
    sql: `
      ALTER TABLE work_wechat_configs ADD COLUMN IF NOT EXISTS kf_secret_enc TEXT;

      CREATE TABLE IF NOT EXISTS kf_sync_cursors (
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        open_kfid VARCHAR(64) NOT NULL,
        cursor TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, open_kfid)
      );

      CREATE TABLE IF NOT EXISTS kf_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        open_kfid VARCHAR(64) NOT NULL,
        external_userid VARCHAR(64) NOT NULL,
        mode VARCHAR(10) NOT NULL DEFAULT 'auto',
        last_msg_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kf_conv_uniq ON kf_conversations (tenant_id, open_kfid, external_userid);

      CREATE TABLE IF NOT EXISTS kf_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES kf_conversations(id) ON DELETE CASCADE,
        direction VARCHAR(5) NOT NULL,
        msg_type VARCHAR(20) NOT NULL DEFAULT 'text',
        content TEXT NOT NULL DEFAULT '',
        ai_intent VARCHAR(30),
        ai_action VARCHAR(20),
        wx_msgid VARCHAR(100) UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kf_msg_conv ON kf_messages (conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS kf_faqs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_kf_faqs_tenant ON kf_faqs (tenant_id, enabled, sort);
    `,
  },
  {
    version: "022_kf_agent_notify",
    description: "7-2 企微客服 handoff 运营通知: work_wechat_configs 加 agent_secret_enc(自建应用Secret加密存) + notify_userids(接收通知的企微userid逗号分隔, 空=@all)",
    sql: `
      ALTER TABLE work_wechat_configs ADD COLUMN IF NOT EXISTS agent_secret_enc TEXT;
      ALTER TABLE work_wechat_configs ADD COLUMN IF NOT EXISTS notify_userids TEXT;
    `,
  },
  {
    version: "023_cpl_status_varchar30",
    description: "7-06 ② 效果回流运营选择信号: content_publish_log.status 扩到 varchar(30) (published_by_operator=21字符, 旧 varchar(20) 放不下)",
    sql: `
      ALTER TABLE content_publish_log ALTER COLUMN status TYPE VARCHAR(30);
    `,
  },
  {
    version: "024_voice_catalog",
    description:
      "7-10 音色库: voice_catalog 表(tenant NULL=全局共享, 照抄 journals 模式) + 种子 4 个 qwen-tts 预置音色(Cherry/Serena/Ethan/Chelsie, env.ts 已确认可用) + 存量 platform_accounts.cloned_voice_id 幂等补录成 catalog 条目(老克隆音在库里可见可选)",
    sql: `
      CREATE TABLE IF NOT EXISTS voice_catalog (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(60) NOT NULL,
        voice_id VARCHAR(120) NOT NULL,
        type VARCHAR(10) NOT NULL DEFAULT 'cloned',
        sample_url TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_voice_catalog_tenant ON voice_catalog (tenant_id, type);

      -- 种子: qwen-tts 预置音色(dashscope provider 直接可用; 名字须匹配 /^[A-Z][A-Za-z]+$/ 才会被 tts-service 采纳)
      INSERT INTO voice_catalog (tenant_id, name, voice_id, type)
      SELECT NULL, v.name, v.voice_id, 'preset'
      FROM (VALUES
        ('芊悦·阳光女声(Cherry)', 'Cherry'),
        ('苏瑶·温柔女声(Serena)', 'Serena'),
        ('晨煦·阳光男声(Ethan)', 'Ethan'),
        ('千雪·轻甜女声(Chelsie)', 'Chelsie')
      ) AS v(name, voice_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM voice_catalog vc
        WHERE vc.tenant_id IS NULL AND vc.type = 'preset' AND vc.voice_id = v.voice_id
      );

      -- 兼容补录: 现存账号已绑的克隆音 → catalog 条目(name=备注名/账号名+"的声音"), 幂等可重跑
      INSERT INTO voice_catalog (tenant_id, name, voice_id, type)
      SELECT DISTINCT ON (pa.tenant_id, pa.cloned_voice_id)
        pa.tenant_id,
        LEFT(COALESCE(NULLIF(TRIM(pa.remark), ''), NULLIF(TRIM(pa.account_name), ''), '账号') || '的声音', 60),
        pa.cloned_voice_id,
        'cloned'
      FROM platform_accounts pa
      WHERE pa.cloned_voice_id IS NOT NULL AND pa.cloned_voice_id <> ''
        AND NOT EXISTS (
          SELECT 1 FROM voice_catalog vc
          WHERE vc.voice_id = pa.cloned_voice_id
            AND (vc.tenant_id = pa.tenant_id OR vc.tenant_id IS NULL)
        );
    `,
  },
  {
    version: "025_fk_orphan_guard",
    description:
      "7-18 架构审计补外键(审计 B13): content_publish_log.content_id + user_skip_log.content_id 缺外键→删内容留孤儿, 补 FK ON DELETE CASCADE(先清孤儿再加约束)。幂等: 约束存在则跳过。注: 审计 B14 的 6 处 userId 无级联本次不动 — 改 SET NULL 需列 nullable, 会涟漪 TS 类型到读取方代码, 风险>收益(删单用户才留残留, tenantId 有 cascade 兜底=影响可控), 标记已知债暂不动。",
    sql: `
      -- ① content_publish_log.content_id: 先清孤儿(指向已删 contents 的行), 再加 CASCADE 外键
      DELETE FROM content_publish_log cpl
      WHERE cpl.content_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.id = cpl.content_id);

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cpl_content_id_fk') THEN
          ALTER TABLE content_publish_log
            ADD CONSTRAINT cpl_content_id_fk
            FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE;
        END IF;
      END $$;

      -- ①b user_skip_log.content_id 同样缺外键(审计同类), 先清孤儿再补 CASCADE
      DELETE FROM user_skip_log usl
      WHERE usl.content_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM contents c WHERE c.id = usl.content_id);
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usl_content_id_fk') THEN
          ALTER TABLE user_skip_log
            ADD CONSTRAINT usl_content_id_fk
            FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `,
  },
  {
    version: "026_journals_discipline_code",
    description:
      "7-20 学科码归一(生成列): journals 加 discipline_code, 表达式由 discipline-mapping.ts 的 RULES 生成。" +
      "治'国内刊 discipline 存中文(临床医学/综合性人文、社会科学…)、选刊器按英文码 ILIKE 匹配'的错配 —— " +
      "生产实测国内 verified 刊仅 137/2379(5.8%) 能被学科匹配到, 其余只能靠不带学科的兜底层选出, " +
      "近30天全库只用到 231 本不同刊。归一后 2379 本全部可进学科匹配层(1920 具体学科 + 459 generic 通吃)。" +
      "用生成列而非普通列回填: crawler 新插刊/enricher 改 discipline 时 DB 自动重算, 无需在写入点手工调用, 永不漂。" +
      "⚠️ 改 RULES 不会自动生效 — 必须新加 migration 走 DROP COLUMN + 重建 ADD COLUMN GENERATED。",
    sql: `
      ALTER TABLE journals DROP COLUMN IF EXISTS discipline_code;
      ALTER TABLE journals ADD COLUMN discipline_code varchar(20)
        GENERATED ALWAYS AS (${buildDisciplineCodeSql("discipline")}) STORED;

      -- 选刊热路径: pickScopedFreshJournal 按 (status, discipline_code) 过滤 + conf 门槛
      CREATE INDEX IF NOT EXISTS idx_journals_disc_code ON journals (discipline_code);
      CREATE INDEX IF NOT EXISTS idx_journals_pick ON journals (status, discipline_code, confidence);
    `,
  },
  {
    version: "027_ops_alerting",
    description:
      "7-25 运维告警三件套: ops_incidents(异常事件流水 — 记账失败/LLM额度不足/零产出/简报推送失败, " +
      "这些点原先只有 logger.error 运营看不见) + ops_briefings(每日运营简报快照, 推送成功与否都落库, " +
      "保证企微挂了也能在今日驾驶舱看到)。tenant_id 在 incidents 可空(LLM 额度是平台级故障, 不属任何租户)。",
    sql: `
      CREATE TABLE IF NOT EXISTS ops_incidents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        kind VARCHAR(40) NOT NULL,
        severity VARCHAR(10) NOT NULL DEFAULT 'error',
        message VARCHAR(500) NOT NULL,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ops_incidents_time ON ops_incidents (created_at);
      CREATE INDEX IF NOT EXISTS idx_ops_incidents_kind_time ON ops_incidents (kind, created_at);

      CREATE TABLE IF NOT EXISTS ops_briefings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        brief_date DATE NOT NULL,
        level VARCHAR(10) NOT NULL DEFAULT 'ok',
        summary JSONB NOT NULL,
        text TEXT NOT NULL,
        pushed BOOLEAN NOT NULL DEFAULT FALSE,
        push_error VARCHAR(300),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ops_briefings_tenant_date ON ops_briefings (tenant_id, brief_date);
    `,
  },
  {
    version: "028_pa_publish_mode",
    description:
      "7-27 无人值守: platform_accounts.publish_mode (auto=客户端自动发 / manual=人工下载后自己上传)。" +
      "列默认 'auto' 保持现状语义不变; 随后一次性回填把 douyin/wechat_video 置为 manual —— " +
      "这两个平台目前的真实运营方式就是'系统出视频→运营下载→手机上传', 客户端根本不开机, " +
      "再按心跳判 agent_offline 每天固定刷 11 条噪音告警(7-27 简报实况), 把真问题淹掉。" +
      "回填只改这一列、只碰这两个平台, 要退回执行: " +
      "UPDATE platform_accounts SET publish_mode='auto' WHERE platform IN ('douyin','wechat_video');",
    sql: `
      ALTER TABLE platform_accounts ADD COLUMN IF NOT EXISTS publish_mode varchar(10) NOT NULL DEFAULT 'auto';

      -- 一次性回填(版本化迁移天然只跑一次)。加 publish_mode='auto' 条件保证即便重跑也只动没被人手动改过的行。
      UPDATE platform_accounts
         SET publish_mode = 'manual', updated_at = NOW()
       WHERE platform IN ('douyin', 'wechat_video')
         AND publish_mode = 'auto';

      -- 简报/矩阵按 (tenant, publish_mode) 分桶统计
      CREATE INDEX IF NOT EXISTS idx_pa_publish_mode ON platform_accounts (tenant_id, publish_mode);
    `,
  },
  {
    version: "029_journals_journal_kind",
    description:
      "7-28 期刊体系归一(生成列): journals 加 journal_kind ('intl'纯国外 / 'both'骑墙 / 'cn'国内 / 'unknown'无信号), " +
      "表达式由 services/journals/journal-kind.ts 的 buildJournalKindSql() 生成。" +
      "收口项目里 4 套各写各的'国内刊'启发式(journal-scope / wanfang-resolver / smart-assign / article-skill), " +
      "并治好它们之间的**定义裂缝**: enricher 只写 cscd_level/pku_core_level 而不回写 catalogs → " +
      "这类刊 catalogs 空且无 IF, 老口径判它'既不是国内刊也不是国外刊' → 对任何 scope 都不可见, " +
      "选刊器永远选不到, 日志只打一句'对口刊枯竭'(看着完全正常)。归一后它们落 'cn', 国内槽位可见。" +
      "同 026 的纪律: 改 journal-kind.ts 的信号定义不会自动生效 —— 必须新加 migration 走 DROP COLUMN + 重建 " +
      "ADD COLUMN GENERATED, 并更新 __tests__/journal-kind-generated-column-drift.test.ts 的冻结快照。",
    sql: `
      ALTER TABLE journals DROP COLUMN IF EXISTS journal_kind;
      ALTER TABLE journals ADD COLUMN journal_kind varchar(12)
        GENERATED ALWAYS AS (${buildJournalKindSql()}) STORED;

      -- 选刊热路径: pickScopedFreshJournal 按 (journal_kind, discipline_code, status) 过滤
      CREATE INDEX IF NOT EXISTS idx_journals_kind_pick ON journals (journal_kind, discipline_code, status);
    `,
  },
  {
    version: "030_journals_journal_kind_rebuild",
    description:
      "7-29 修 hasIntlSignal 读错列: 原信号只挑 impact_factor / partition / cas_partition, " +
      "而生产实测 cas_partition **整列为空(0 行)**、partition 仅 40 行 —— 三个信号只有一个在真工作。" +
      "真正有数据的 cas_partition_new(2203) 与 jcr_full(4229) 一个没读, 后果是 704 本一线国际刊" +
      "(Elsevier 154 / Wiley 90 / Springer 46 …, ISSN 覆盖 704/704, 零 ai_fabricated)被判 " +
      "journal_kind='unknown', 对 international scope 隐身, 选刊器永远选不到且日志不报错。" +
      "本迁移按新信号定义重建生成列。jcr_full 判据要求真有 WoS 证据(wosLevel / jifSubjects / " +
      "jciSubjects), 不是简单判非空 —— 实测 4229 行非空里有 123 行只带 isTopJournal 之类布尔标记, " +
      "拿它当分区证据等于让'是不是顶刊'冒充分区。全表 8650 行重写是毫秒级。" +
      "退回执行: 用 029 的表达式重建同名列即可。",
    sql: `
      ALTER TABLE journals DROP COLUMN IF EXISTS journal_kind;
      ALTER TABLE journals ADD COLUMN journal_kind varchar(12)
        GENERATED ALWAYS AS (CASE
    WHEN coalesce((impact_factor IS NOT NULL OR btrim(coalesce("partition", '')) <> '' OR btrim(coalesce(cas_partition, '')) <> '' OR btrim(coalesce(cas_partition_new, '')) <> '' OR (btrim(coalesce(jcr_full->>'wosLevel', '')) <> '' OR (jsonb_typeof(jcr_full->'jifSubjects') = 'array' AND jsonb_array_length(jcr_full->'jifSubjects') > 0) OR (jsonb_typeof(jcr_full->'jciSubjects') = 'array' AND jsonb_array_length(jcr_full->'jciSubjects') > 0))), false) AND NOT coalesce(((jsonb_typeof(catalogs) = 'array' AND jsonb_array_length(catalogs) > 0) OR btrim(coalesce(cscd_level, '')) <> '' OR btrim(coalesce(pku_core_level, '')) <> '' OR btrim(coalesce(catalog_type, '')) IN ('pku-core', 'cssci', 'cssci-ext', 'cscd', 'cstpcd') OR btrim(coalesce(cn_number, '')) <> '' OR composite_impact_factor IS NOT NULL), false) THEN 'intl'
    WHEN coalesce((impact_factor IS NOT NULL OR btrim(coalesce("partition", '')) <> '' OR btrim(coalesce(cas_partition, '')) <> '' OR btrim(coalesce(cas_partition_new, '')) <> '' OR (btrim(coalesce(jcr_full->>'wosLevel', '')) <> '' OR (jsonb_typeof(jcr_full->'jifSubjects') = 'array' AND jsonb_array_length(jcr_full->'jifSubjects') > 0) OR (jsonb_typeof(jcr_full->'jciSubjects') = 'array' AND jsonb_array_length(jcr_full->'jciSubjects') > 0))), false) AND coalesce(((jsonb_typeof(catalogs) = 'array' AND jsonb_array_length(catalogs) > 0) OR btrim(coalesce(cscd_level, '')) <> '' OR btrim(coalesce(pku_core_level, '')) <> '' OR btrim(coalesce(catalog_type, '')) IN ('pku-core', 'cssci', 'cssci-ext', 'cscd', 'cstpcd') OR btrim(coalesce(cn_number, '')) <> '' OR composite_impact_factor IS NOT NULL), false) THEN 'both'
    WHEN coalesce(((jsonb_typeof(catalogs) = 'array' AND jsonb_array_length(catalogs) > 0) OR btrim(coalesce(cscd_level, '')) <> '' OR btrim(coalesce(pku_core_level, '')) <> '' OR btrim(coalesce(catalog_type, '')) IN ('pku-core', 'cssci', 'cssci-ext', 'cscd', 'cstpcd') OR btrim(coalesce(cn_number, '')) <> '' OR composite_impact_factor IS NOT NULL), false) THEN 'cn'
    ELSE 'unknown'
  END) STORED;
      CREATE INDEX IF NOT EXISTS idx_journals_kind_pick ON journals (journal_kind, discipline_code, status);
    `,
  },
  {
    version: "031_golden_set_annotations",
    description:
      "8-02 Golden Set 标注基准表: 人对内容质量的判断(good/fair/poor + 一句话理由)独立落库。" +
      "为什么不塞 contents.metadata —— ①一篇会被多人标(老板定标尺/运营续标), metadata 是单值坑; " +
      "②标注要可改, 靠 UNIQUE(content_id, annotator_id) 保证同一人对同一篇只有一条(ON CONFLICT 更新); " +
      "③这批数据的用途是**跟六维分算相关性**, 与被评估对象解耦才能日后换评分器重跑对照。" +
      "reason 刻意留自由文本(不做下拉): 它是将来提炼「驳回原因分类词表」的原料, 提前枚举等于提前把答案写死。" +
      "content_id / tenant_id / annotator_id 全 ON DELETE CASCADE(与 003 的强归属口径一致, 删内容不留孤儿)。",
    sql: `
      CREATE TABLE IF NOT EXISTS golden_set_annotations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content_id UUID NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        annotator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label VARCHAR(10) NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 同一人对同一篇只有一条(可改不可重), 也是 upsert 的冲突目标
      CREATE UNIQUE INDEX IF NOT EXISTS uq_golden_content_annotator
        ON golden_set_annotations (content_id, annotator_id);
      -- "我标过的 / 还没标的" 热路径
      CREATE INDEX IF NOT EXISTS idx_golden_tenant_annotator
        ON golden_set_annotations (tenant_id, annotator_id);
      -- 按内容反查(算相关性时 JOIN contents)
      CREATE INDEX IF NOT EXISTS idx_golden_content
        ON golden_set_annotations (content_id);
    `,
  },
  {
    version: "032_contents_deferred_index",
    description:
      "8-03 失败分类 + 服务恢复自动重跑: 探测器每 30 分钟要扫一遍\"哪些内容在等重跑\"" +
      "(WHERE metadata->'deferred' IS NOT NULL)。contents 是全系统最大的表之一(60 天保留窗内数万行), " +
      "不加索引就是每半小时一次全表扫。用**部分索引**而不是整列 GIN: 带 deferred 的行只占极小比例" +
      "(正常日子是 0 行), 部分索引几乎不占空间、写入几乎零开销, 而 GIN 要为每一行的整个 metadata 建项。" +
      "索引表达式取 reason 而不是整个 deferred 块 —— 查询就是按 reason 过滤(quota_exceeded / service_down)。" +
      "⚠️ 纯性能索引, 不改任何语义: 不建也能跑, 只是慢。退回执行: DROP INDEX idx_contents_deferred。",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_contents_deferred
        ON contents ((metadata -> 'deferred' ->> 'reason'))
        WHERE metadata -> 'deferred' IS NOT NULL;
    `,
  },
  {
    version: "033_checker_ledger",
    description:
      "8-14 方法论移植 Phase 1: 检查器台账。**聚合计数, 不逐条落行** —— 命中明细继续走各闸自己的 " +
      "metadata/incident, 本表只做按周聚合, 给 DB 加的写入压力接近零(每个 checker 每周一行, upsert)。" +
      "为什么要它: 措辞闸 37 报 0 中被降级、排名闸 2 报 2 中被保留, 这两次都是人肉数出来的; " +
      "移植后每个检查器自动记账, 台账自动生成去留建议。" +
      "已裁决数(confirmed_true + confirmed_false)是台账成熟度的唯一度量 —— " +
      "所有自动判定都以它为门槛, 未裁决的命中不计入任何结论" +
      "(执行顺序上 Phase 3 的人工反馈入口晚于本表, 前两周 confirmed_true 恒为 0; " +
      " 没有门槛的话, 正在正常干活的反编造四道闸会被一起建议降级)。" +
      "退回执行: DROP TABLE checker_ledger。",
    sql: `
      CREATE TABLE IF NOT EXISTS checker_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        -- 检查器唯一名, 与 services/ops/checker-registry.ts 的 id 对齐
        checker_id VARCHAR(80) NOT NULL,
        -- 聚合周期: 该周周一(UTC)的日期, 按周聚合
        period_start DATE NOT NULL,
        -- 评估次数(闸跑过几次) / 命中次数(报了几条)
        evaluated INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 0,
        -- 人工裁决结果(Phase 3 的反馈入口写入); 未裁决的命中两栏都不计
        confirmed_true INTEGER NOT NULL DEFAULT 0,
        confirmed_false INTEGER NOT NULL DEFAULT 0,
        -- 本该拦而没拦(漏网举报)
        confirmed_miss INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- 一个检查器一周一行 —— upsert 的冲突目标
      CREATE UNIQUE INDEX IF NOT EXISTS uq_checker_ledger_period
        ON checker_ledger (checker_id, period_start);
      CREATE INDEX IF NOT EXISTS idx_checker_ledger_period
        ON checker_ledger (period_start DESC);
    `,
  },
  {
    version: "034_checker_adjudications",
    description:
      "8-14 方法论移植 Phase 3(后端数据路径): 人工裁决记录。**只存裁决, 不存命中** —— " +
      "命中实例由 checkOutputHealth 现算(判据永远等于当前代码), 存下来的只有'人怎么判的'。" +
      "为什么不建命中表: 033 定的硬纪律是聚合不逐条落行; 而且命中一旦落表就会与闸的当前判据漂移, " +
      "裁决一条三周前按旧判据命中的记录, 得到的结论对今天的闸没有意义。" +
      "本表是台账 confirmed_true/false 的来源与去重依据(同一人对同一条命中只算一次)。" +
      "退回执行: DROP TABLE checker_adjudications。",
    sql: `
      CREATE TABLE IF NOT EXISTS checker_adjudications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        -- 与 services/ops/checker-registry.ts 的 id 对齐
        checker_id VARCHAR(80) NOT NULL,
        -- 被裁决的那条内容
        content_id UUID NOT NULL,
        -- true_positive=拦对了 / false_positive=拦错了 / miss=本该拦没拦
        verdict VARCHAR(20) NOT NULL,
        -- 谁判的(users.id)。不做外键: 用户删了裁决记录仍应保留, 否则台账会凭空缩水
        annotator_id UUID,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- 同一人对同一条命中只算一次(改判走 upsert 覆盖, 不叠加)
      CREATE UNIQUE INDEX IF NOT EXISTS uq_checker_adjudication
        ON checker_adjudications (checker_id, content_id, annotator_id);
      CREATE INDEX IF NOT EXISTS idx_checker_adjudication_created
        ON checker_adjudications (created_at DESC);
    `,
  },
  {
    version: "035_contents_batch_row_unique",
    description:
      "8-17: 一个 batch_row 最多一条 content。8-16 夜百炼欠费致生成全失败, 同一 batch_row 被重试 4 次, " +
      "每次新插一行空壳(标题=topic, 正文 0 字), 一晚 32 条。" +
      "为什么用 batch_row_id 而不是(标题+日期): 后者会误伤合法内容 —— 同一标题配不同刊本来就会撞, " +
      "实测 3 组'普通院校教师发核心'是非 batch 链路的真产物; 而 batch_row_id 表达的是真正的不变量。" +
      "**部分索引(仅 NOT NULL)**: 历史行该列为 NULL 不受约束 —— 存量有 30 组 [failed(有正文)+archived] " +
      "是历史真实产物, 不该为了加约束去删它们。新行由 batch-worker 写入该列, 从此受管。" +
      "配套: 插入侧 ON CONFLICT DO NOTHING(冲突=已存在=跳过, 不是报错) —— " +
      "约束防重复, 冲突处理保韧性, 缺一半都不行(约束上线那天重试风暴撞上它就是 batch 全线崩)。" +
      "退回执行: DROP INDEX uq_contents_batch_row; ALTER TABLE contents DROP COLUMN batch_row_id。",
    sql: `
      ALTER TABLE contents ADD COLUMN IF NOT EXISTS batch_row_id UUID;
      -- 部分唯一: 只管有值的行(= 新行), 历史 NULL 行不受影响
      CREATE UNIQUE INDEX IF NOT EXISTS uq_contents_batch_row
        ON contents (batch_row_id) WHERE batch_row_id IS NOT NULL;
    `,
  },
  {
    version: "036_decision_traces",
    description:
      "8-17 决策留痕(第一批: 选刊链路)。**纯观测, 零行为变更。** " +
      "动机: 追查 education 期刊日耗 14 本时, 静态读代码只追到 5 本, 剩下 9 本追不出来 —— " +
      "一条内容为什么用了这本刊, 答案只存在于'当时那次运行的控制流'里, 跑完就没了。" +
      "两类行: intent(调用选刊器之前记'我要请求了') 与 consumption(每消耗一本刊记一行)。" +
      "**为什么要记 intent**: 只记选中的话, 遇到空白分不清'这条路没跑'还是'跑了但没接留痕'; " +
      "意图与消耗对不上的就是漏接路径 —— 接线完整性检查的运行时版本。" +
      "口径: 一行 consumption = **一次期刊消耗**(不是一篇内容、不是一次请求); " +
      "roundup 一篇用 3 本刊 = 3 行; 重试不重复计(batch_row_id 幂等已上, migration 035)。" +
      "退回执行: DROP TABLE decision_traces。",
    sql: `
      CREATE TABLE IF NOT EXISTS decision_traces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        -- 决策点名: journal_pick / topic_pick / ...
        point VARCHAR(40) NOT NULL,
        -- intent = 请求之前; consumption = 真的消耗了一本刊
        phase VARCHAR(16) NOT NULL,
        -- 把同一次决策的 intent 与 consumption 串起来
        correlation_id UUID,
        -- 谁在请求: daily_cron_article / daily_cron_roundup / admin_roundup / batch / unknown
        --   unknown = 有人没传上下文 = 漏接的路径, 正是要抓的
        requested_by VARCHAR(40) NOT NULL DEFAULT 'unknown',
        -- 🔴 需求侧: 配额按它计
        slot_discipline VARCHAR(32),
        -- 🔴 供给侧: 池子余量按它算。两个口径都对, 绝不能互换
        journal_discipline VARCHAR(32),
        scope VARCHAR(24),
        journal_id UUID,
        content_id UUID,
        -- 降级链, 任意层数: [{layer, tier, reason}]
        fallback JSONB NOT NULL DEFAULT '[]'::jsonb,
        -- 是否落到 generic 通配兜底(它在任何学科槽位都算命中, 是配额的潜在后门)
        generic_wildcard BOOLEAN NOT NULL DEFAULT false,
        tenant_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_decision_traces_created ON decision_traces (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_traces_point ON decision_traces (point, phase, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_decision_traces_corr ON decision_traces (correlation_id);
    `,
  },
];