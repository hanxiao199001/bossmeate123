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
];
