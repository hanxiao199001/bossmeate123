-- 期刊 IF 信息源排查 + 清洗 (6-19)
-- 背景: 只有 LetPub(镜像 JCR/中科院)是靠谱的 IF 源; OpenAlex 存的是 2yr_mean_citedness(2年平均被引),
--   ≠ 官方影响因子, 与期刊官网对不上。代码侧已修(openalex-crawler 不再写 IF); 这里清存量 + 重核验。
-- 用法: psql "postgresql://bossmate:<DB密码>@localhost:5432/bossmate" -f scripts/journal-if-source-cleanup.sql

\echo '========== 1) 按数据来源看"带 IF"的刊(看不靠谱源贡献了多少 IF) =========='
SELECT COALESCE(data_source, '(空)') AS 数据来源,
       count(*) AS 刊数,
       count(*) FILTER (WHERE impact_factor IS NOT NULL) AS 带IF的,
       round(avg(confidence)) AS 平均可信
FROM journals
GROUP BY data_source
ORDER BY 带IF的 DESC;

\echo '========== 2) 按 fieldProvenance 看 IF 字段到底来自哪个源(若有记录) =========='
SELECT COALESCE(field_provenance->>'if', field_provenance->>'if_history', '(未记录)') AS IF来源,
       count(*) AS 刊数
FROM journals
WHERE impact_factor IS NOT NULL
GROUP BY 1 ORDER BY 刊数 DESC;

\echo '========== 3) 不靠谱 IF 抽样: openalex 来源 / 非 letpub 来源 且带 IF =========='
SELECT name, name_en, impact_factor AS IF, data_source AS 来源,
       field_provenance->>'if' AS IF源, confidence AS 可信, last_verified_at::date AS 最后验证
FROM journals
WHERE impact_factor IS NOT NULL
  AND data_source = 'openalex_ingest'
ORDER BY confidence ASC NULLS FIRST
LIMIT 50;

-- ========================================================================
-- 4) 清洗(确认上面结果后, 去掉注释逐条跑)。原则: 宁可显示 N/A, 不显示错的 IF。
-- ========================================================================

-- 4a. 把"仅来自 OpenAlex 的 IF"清空(这些是 2年平均被引, 非官方 IF)。
--     清空后视频卡显示 N/A、正文按提示词不写具体数字 —— 不再有"出入"。
-- BEGIN;
-- UPDATE journals SET impact_factor = NULL
--  WHERE data_source = 'openalex_ingest' AND impact_factor IS NOT NULL;
-- -- 看影响行数, 确认无误再 COMMIT; 不对就 ROLLBACK;
-- COMMIT;

-- 4b. (可选, 更严)若 fieldProvenance 明确记了 IF 来自 openalex, 也一并清:
-- UPDATE journals SET impact_factor = NULL
--  WHERE field_provenance->>'if' ILIKE '%openalex%' AND impact_factor IS NOT NULL;

-- 5) 补真值: 清空后, 到后台「期刊审计页」筛选这些刊 → 一键「重新核验 reverify」,
--    会从 LetPub 等靠谱源重拉真实 IF/分区。或调 POST /api/v1/admin/journals/:id/reverify。
