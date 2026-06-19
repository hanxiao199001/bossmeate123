-- 期刊知识库数据质量盘点 (6-19)
-- 用法(在新服务器上): psql "postgresql://bossmate:<DB密码>@localhost:5432/bossmate" -f scripts/journal-quality-audit.sql
-- 目的: 量化"生成内容里 IF/分区等有出入"的规模 —— 看多少刊低可信/AI编造/从未验证/IF缺失。

\echo '========== 1) 总量 =========='
SELECT count(*) AS 总刊数,
       count(*) FILTER (WHERE status = 'active') AS 启用,
       count(*) FILTER (WHERE impact_factor IS NOT NULL) AS 有IF,
       count(*) FILTER (WHERE partition IS NOT NULL) AS 有分区
FROM journals;

\echo '========== 2) 按数据来源 data_source(可信度从低到高) =========='
SELECT COALESCE(data_source, '(空)') AS 数据来源,
       count(*) AS 刊数,
       count(*) FILTER (WHERE impact_factor IS NOT NULL) AS 其中有IF,
       round(avg(confidence)) AS 平均可信分
FROM journals
GROUP BY data_source
ORDER BY 刊数 DESC;

\echo '========== 3) 可信度分档 confidence =========='
SELECT CASE
         WHEN confidence IS NULL THEN '(空)'
         WHEN confidence >= 80 THEN 'A 高 (>=80)'
         WHEN confidence >= 50 THEN 'B 中 (50-79)'
         ELSE 'C 低 (<=49)'
       END AS 可信档,
       count(*) AS 刊数
FROM journals
GROUP BY 1 ORDER BY 1;

\echo '========== 4) 高危: 会被选进生成、但数据可疑的刊 =========='
-- ai_fabricated 现已被选刊护栏排除, 但这里仍列出供清洗参考;
-- 另含: 启用 + 有IF + 低可信/从未验证 —— 这些 IF 最可能"有出入"。
SELECT COALESCE(data_source, '(空)') AS 来源,
       count(*) AS 刊数,
       count(*) FILTER (WHERE impact_factor IS NOT NULL) AS 带IF的
FROM journals
WHERE status = 'active'
  AND (data_source = 'ai_fabricated'
       OR confidence <= 49
       OR last_verified_at IS NULL)
GROUP BY data_source
ORDER BY 刊数 DESC;

\echo '========== 5) 从未验证 + 验证陈旧(>180天) =========='
SELECT count(*) FILTER (WHERE last_verified_at IS NULL) AS 从未验证,
       count(*) FILTER (WHERE last_verified_at < NOW() - INTERVAL '180 days') AS 超180天没验,
       count(*) FILTER (WHERE last_verified_at >= NOW() - INTERVAL '180 days') AS 近180天验过
FROM journals;

\echo '========== 6) 抽样: 启用 + ai_fabricated/低可信 且带 IF 的刊(最该核查的) =========='
SELECT name, name_en, impact_factor AS IF, partition AS 分区,
       data_source AS 来源, confidence AS 可信, last_verified_at::date AS 最后验证
FROM journals
WHERE status = 'active' AND impact_factor IS NOT NULL
  AND (data_source = 'ai_fabricated' OR confidence <= 49)
ORDER BY confidence ASC NULLS FIRST
LIMIT 30;
