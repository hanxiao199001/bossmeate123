-- 诊断: 为什么"国外期刊"槽位没产出内容 (6-19)
-- 用法: psql "postgresql://bossmate:<DB密码>@localhost:5432/bossmate" -f scripts/diagnose-international-supply.sql
-- 看两件事: ① 设置里国外期刊每天配了几篇  ② 国外刊池子有多大、有多少没被15天冷却挡住。

\set SYS '00000000-0000-0000-0000-000000000001'

\echo '========== 1) 每日内容配置 contentQuota(看 international 的 count) =========='
SELECT jsonb_pretty(config->'automationConfig'->'contentQuota') AS 每日内容配置
FROM tenants WHERE id = :'SYS';

\echo '========== 2) 国外/国内 刊池子大小(active 且非编造) =========='
-- 国外 = 无中文目录标签 且 有 IF 或分区; 国内 = 有目录标签。
SELECT
  count(*) FILTER (WHERE (catalogs IS NULL OR jsonb_array_length(catalogs)=0)
                     AND (impact_factor IS NOT NULL OR partition IS NOT NULL)) AS 国外刊_总,
  count(*) FILTER (WHERE catalogs IS NOT NULL AND jsonb_array_length(catalogs)>0) AS 国内刊_总
FROM journals
WHERE status='active' AND data_source IS DISTINCT FROM 'ai_fabricated';

\echo '========== 3) 国外刊里"15天内没用过"的还有多少(fresh, 决定还能不能选出来) =========='
SELECT count(*) AS 国外_可选新刊_fresh
FROM journals j
WHERE j.status='active' AND j.data_source IS DISTINCT FROM 'ai_fabricated'
  AND (j.catalogs IS NULL OR jsonb_array_length(j.catalogs)=0)
  AND (j.impact_factor IS NOT NULL OR j.partition IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM journal_usage ju
    WHERE ju.journal_id = j.id AND ju.tenant_id = :'SYS'
      AND ju.used_at > NOW() - INTERVAL '15 days'
  );

\echo '========== 4) 今日(系统池)按来源/范围已生成的文章, 看国外占比 =========='
SELECT
  count(*) AS 今日总,
  count(*) FILTER (WHERE (metadata->>'source')='roundup') AS 多刊盘点,
  count(*) FILTER (WHERE metadata->>'journalId' IS NOT NULL) AS 挂了期刊的
FROM contents
WHERE tenant_id = :'SYS' AND type='article'
  AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai';
