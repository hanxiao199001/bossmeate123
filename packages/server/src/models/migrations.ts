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
];
