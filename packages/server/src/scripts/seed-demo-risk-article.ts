/**
 * 5-22 hotfix #154 后置: seed 一篇 demo 专用 risk-control trigger article 到推荐池。
 *
 * 用途: 5-22 老板 demo 第 3 act 演示 RiskAuditModal — 现 50 篇推荐池全 clean,
 * 需要一篇含营销诱导词 (扫码免费领 / 加微信 / 100% 保证) 的 article 才能触发 modal。
 *
 * 用法 (prod):
 *   ssh "$BOSSMATE_DEPLOY_SERVER" 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     node dist/scripts/seed-demo-risk-article.js'
 *
 * 幂等: 按 metadata->>'seedSource'='demo-risk-control-trigger' 查重, 已存在则 skip。
 */
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { logger } from "../config/logger.js";

// System agent user (与现有 system tenant article 同 userId, 见 contents.user_id)
const SYSTEM_AGENT_USER_ID = "00000000-0000-0000-0000-000000000002";

const DEMO_TITLE = "【Q2 期刊速投】录用率 48% 心理学顶刊 + 投稿模板免费送";

const DEMO_BODY = `# Frontiers in Psychology: Q2 期刊投稿全指南

## 期刊概况

Frontiers in Psychology 是 Q2 SCI 期刊，影响因子 2.6，2024 年录用率约 48%，
审稿周期 5-8 周，适合心理学、教育学、行为学领域研究生与青椒投稿。

期刊属于 Frontiers 出版集团旗下重要刊物，发文量大、审稿透明，作者可在线追踪
全流程进度。近年来在认知心理学、教育心理学、社会心理学等子领域均有稳定收稿。

## 投稿要求

**论文格式**

- 全文长度：8000-15000 词，含图表 6-12 个
- 参考文献：APA 7th edition，建议引用 60+ 篇近 5 年文献
- 摘要：200-350 词，结构化 (Background / Methods / Results / Conclusions)
- 关键词：5-8 个，建议覆盖 MeSH 主题词

**Cover Letter**

需 1-2 页，重点说明研究 novelty、与期刊范围匹配度、推荐 2-3 位 reviewer 候选。
切忌空话，需具体到本研究在领域内的位置 (与已发表近似工作对比、补足了哪些 gap)。

**审稿流程**

1. Editor 形式审查：3-7 天
2. Reviewer 邀请：1-2 周
3. 首轮 review：3-5 周（通常 2-3 位 reviewer）
4. Revision: minor 2-4 周 / major 6-8 周
5. Final decision: 1 周内

**拒稿主要原因**

- 研究问题缺乏 novelty (约 35%)
- 方法学缺陷 (样本量不足 / 统计方法不当, 约 25%)
- 与期刊 scope 不匹配 (约 15%)
- 写作质量差 / 英文不达标 (约 15%)
- 其他 (10%)

## 推荐策略

对于初次投稿 Frontiers 系列的作者，建议：

1. 先精读 3-5 篇本刊近 1 年发表的相关主题论文，对齐写作风格
2. 使用 Frontiers 官方 LaTeX/Word 模板，避免格式被拒
3. 投稿前找 1-2 位领域内同行预审 (peer review), 提前发现问题
4. Cover Letter 强调研究贡献的"3 个 W": Why now / Why here / Why us
5. 若被 reject，认真分析 reviewer 意见，2-3 月后改投同集团其他刊

## 投稿模板下载

扫码免费领模板 + 投稿信范文，加微信 wx-bossmate-demo 一对一辅导，
100% 保证录用前的格式审核。限时免费，仅限本周。
`;

const SEED_SOURCE = "demo-risk-control-trigger";

export async function seedDemoRiskArticle(): Promise<{ inserted: number; skipped: number; articleId: string | null }> {
  // 幂等: 按 metadata->>'seedSource' 查重
  const existing = await db
    .select({ id: contents.id })
    .from(contents)
    .where(
      and(
        eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID),
        sql`metadata->>'seedSource' = ${SEED_SOURCE}`
      )
    )
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    logger.info({ articleId: existing[0].id }, "seed-demo-risk-article skip (exists)");
    return { inserted: 0, skipped: 1, articleId: existing[0].id };
  }

  // 30s 前 created_at 让它排推荐池顶部
  const createdAt = new Date(Date.now() - 30_000);

  const [row] = await db
    .insert(contents)
    .values({
      tenantId: SYSTEM_RECOMMENDATION_TENANT_ID,
      userId: SYSTEM_AGENT_USER_ID,
      type: "article",
      status: "generated",
      title: DEMO_TITLE,
      body: DEMO_BODY,
      platforms: [],
      metadata: {
        demoOnly: true,
        seedSource: SEED_SOURCE,
        expectedHits: ["扫码免费领", "加微信", "100% 保证"],
        sourceJournal: "Frontiers in Psychology",
        note: "5-22 demo 第 3 act risk-control modal 演示用, 真审稿时应跳过此条",
      },
      createdAt,
      updatedAt: createdAt,
      statusUpdatedAt: createdAt,
    })
    .returning({ id: contents.id });

  if (!row) {
    return { inserted: 0, skipped: 0, articleId: null };
  }

  logger.info({ articleId: row.id, title: DEMO_TITLE }, "seed-demo-risk-article inserted");
  return { inserted: 1, skipped: 0, articleId: row.id };
}

async function main() {
  const r = await seedDemoRiskArticle();
  console.log(JSON.stringify({ ok: true, ...r }));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
