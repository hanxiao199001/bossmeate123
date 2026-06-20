-- 诊断: 今日生成的文章, 按"用的期刊"实际国内/国外拆分 + 列出刊名 (6-19)
-- 分类口径与分发端 classifyScope 一致: 有目录=国内; 无目录但有IF/分区=国外;
--   无目录无IF无分区但刊名含中文=国内; 其余=未知。
-- 用法: psql "postgresql://bossmate:<DB密码>@localhost:5432/bossmate" -f scripts/diagnose-today-scope-split.sql

\set SYS '00000000-0000-0000-0000-000000000001'

\echo '========== 今日(北京时间)挂了期刊的文章, 逐篇看刊名+判定范围 =========='
SELECT
  left(c.title, 28) AS 文章,
  left(coalesce(j.name, j.name_en, '?'), 24) AS 期刊,
  CASE
    WHEN j.catalogs IS NOT NULL AND jsonb_array_length(j.catalogs) > 0 THEN '国内(目录)'
    WHEN (j.impact_factor IS NOT NULL OR j.partition IS NOT NULL) THEN '国外(IF/分区)'
    WHEN j.name ~ '[一-龥]' THEN '国内(中文名)'
    ELSE '未知'
  END AS 判定范围,
  j.impact_factor AS IF, j.partition AS 分区,
  coalesce(jsonb_array_length(j.catalogs),0) AS 目录数
FROM contents c
JOIN journals j ON j.id = (c.metadata->>'journalId')::uuid
WHERE c.tenant_id = :'SYS' AND c.type='article'
  AND c.created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
ORDER BY 判定范围;

\echo '========== 汇总: 今日各范围篇数(挂刊文章) =========='
SELECT
  CASE
    WHEN j.catalogs IS NOT NULL AND jsonb_array_length(j.catalogs) > 0 THEN '国内(目录)'
    WHEN (j.impact_factor IS NOT NULL OR j.partition IS NOT NULL) THEN '国外'
    WHEN j.name ~ '[一-龥]' THEN '国内(中文名兜底)'
    ELSE '未知'
  END AS 范围,
  count(*) AS 篇数
FROM contents c
JOIN journals j ON j.id = (c.metadata->>'journalId')::uuid
WHERE c.tenant_id = :'SYS' AND c.type='article'
  AND c.created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
GROUP BY 范围 ORDER BY 篇数 DESC;
