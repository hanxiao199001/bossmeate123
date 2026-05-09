/**
 * P5 industry-monthly cron handler（5-14 V2 P5）。
 *
 * 流程：
 * 1. 拿当前 tenant 的 system user (role=owner)
 * 2. for industry in INDUSTRIES:
 *    a. generateIndustryTopics(industry) → 50 topic
 *    b. 转 CsvRow[] (template 行业固定 / priority=3 / journal_id 缺则 AI 推荐)
 *    c. createBatch → 入 P4 batchQueue
 * 3. 返回 { medical: batchId, it: batchId, law: batchId, education: batchId }
 *
 * Caller:
 * - cron monthly 自动跑（scheduler 注册 '0 0 1 * *' 每月 1 号 00:00 BJ）
 * - admin 手动 trigger（routes/industry-monthly.ts POST /admin/industry-monthly/trigger）
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { users, tenants } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { createBatch } from "../batch/batch-service.js";
import type { CsvRow } from "../batch/csv-parser.js";
import {
  generateIndustryTopics,
  INDUSTRIES,
  INDUSTRY_TEMPLATE_MAP,
  type Industry,
} from "./topic-generator.js";

export interface IndustryRunResult {
  industry: Industry;
  ok: boolean;
  batchId?: string;
  rowCount?: number;
  error?: string;
}

/**
 * 跑一个行业：LLM 生成 topic + createBatch 入队。
 * caller 负责选 tenant + user（cron 用 system user，admin trigger 用当前 user）。
 */
export async function runIndustryBatch(args: {
  tenantId: string;
  userId: string;
  industry: Industry;
}): Promise<IndustryRunResult> {
  try {
    const result = await generateIndustryTopics(args.industry);
    const templateLetter: Record<string, "A" | "B" | "C" | "E"> = {
      "shunshi-style": "A",
      "marketing-conversion": "B",
      "popular-science": "C",
      "industry-vertical": "E",
    };
    const tpl = templateLetter[INDUSTRY_TEMPLATE_MAP[args.industry]] ?? "A";

    const rows: CsvRow[] = result.topics.map((topic, i) => ({
      rowIndex: i + 1,
      topic,
      journalId: null, // 缺则 article-skill AI 推荐
      template: tpl,
      priority: 3,
    }));

    const batch = await createBatch({
      tenantId: args.tenantId,
      userId: args.userId,
      filename: `industry-monthly-${args.industry}-${new Date().toISOString().slice(0, 10)}.csv`,
      rows,
    });

    logger.info(
      { industry: args.industry, batchId: batch.batchId, rowCount: batch.rowCount, llmMs: result.llmDurationMs },
      "P5 行业 batch 已创建 ✅",
    );
    return { industry: args.industry, ok: true, batchId: batch.batchId, rowCount: batch.rowCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ industry: args.industry, err: msg }, "P5 行业 batch 失败");
    return { industry: args.industry, ok: false, error: msg };
  }
}

/** 跑全部 4 行业（cron monthly 用） */
export async function runAllIndustriesMonthly(args: { tenantId: string; userId: string }): Promise<IndustryRunResult[]> {
  const results: IndustryRunResult[] = [];
  for (const industry of INDUSTRIES) {
    results.push(await runIndustryBatch({ ...args, industry }));
  }
  return results;
}

/** Cron 入口：找每个 active tenant 的 owner user，跑 4 行业 */
export async function cronMonthlyAllTenants(): Promise<void> {
  const activeTenants = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  for (const tenant of activeTenants) {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenant.id), eq(users.role, "owner")))
      .limit(1);
    if (!owner) {
      logger.warn({ tenantId: tenant.id, name: tenant.name }, "P5 cron tenant 无 owner，跳过");
      continue;
    }
    const results = await runAllIndustriesMonthly({ tenantId: tenant.id, userId: owner.id });
    const successCount = results.filter((r) => r.ok).length;
    logger.info({ tenantId: tenant.id, success: successCount, total: results.length }, "P5 cron tenant 完成");
  }
}
