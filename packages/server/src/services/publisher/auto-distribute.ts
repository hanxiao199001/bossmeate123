/**
 * PR-W6: 每日全自动分发 — 07:00 BJ cron:
 * 对开了 automationConfig.autoDistribute 的租户, 把今日推荐池文章按账号领域智能配对,
 * 入 bulk-distribute 队列 → 公众号草稿 (capability=draft_only 的号只建草稿, 不直接群发, 风险可控)。
 * 老板早上打开今日页看到的就是"已分好已进草稿箱", 只需抽查。
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, tenants, users } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { bulkDistributeQueue, initBulkProgress } from "../bulk-distribute/queue.js";
import { computeSmartPairs } from "./smart-assign.js";
import { logger } from "../../config/logger.js";

const BJ_OFFSET_MS = 8 * 3600_000;

function startOfTodayBJ(): Date {
  const bj = new Date(Date.now() + BJ_OFFSET_MS);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - BJ_OFFSET_MS);
}

export async function runDailyAutoDistribute(): Promise<{ tenantsProcessed: number; queued: number }> {
  // 1. 今日推荐池 (system 租户当日生成的文章)
  const pool = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(
      eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID),
      eq(contents.type, "article"),
      gte(contents.createdAt, startOfTodayBJ()),
      eq(contents.status, "generated"), // PR-U2 只自动分发质检通过的
    ))
    .limit(100);
  if (pool.length === 0) {
    logger.info("PR-W6 auto-distribute: 今日推荐池为空, 跳过");
    return { tenantsProcessed: 0, queued: 0 };
  }
  const poolIds = pool.map((p) => p.id);

  // 2. 开了开关的租户
  const allTenants = await db.select({ id: tenants.id, config: tenants.config }).from(tenants);
  const enabled = allTenants.filter((t) => {
    const cfg = t.config as { automationConfig?: { autoDistribute?: boolean } } | null;
    return cfg?.automationConfig?.autoDistribute === true;
  });

  let totalQueued = 0;
  for (const t of enabled) {
    try {
      // PR-Z1 多租户隔离: 租户有自己当日生成的池就用自己的 (客户间不发同样的文章); 没有才用系统共享池
      const own = await db
        .select({ id: contents.id })
        .from(contents)
        .where(and(
          eq(contents.tenantId, t.id),
          eq(contents.type, "article"),
          gte(contents.createdAt, startOfTodayBJ()),
          eq(contents.status, "generated"), // PR-U2 只自动分发质检通过的
        ))
        .limit(100);
      const useIds = own.length > 0 ? own.map((o) => o.id) : poolIds;
      const { pairs, unmatched } = await computeSmartPairs({ tenantId: t.id, articleIds: useIds });
      if (pairs.length === 0) {
        logger.info({ tenantId: t.id, unmatched: unmatched.length }, "PR-W6 auto-distribute: 该租户无可配对内容");
        continue;
      }
      // 已发过的 (content,account) 跳过
      const tupleConds = pairs.map((p) => sql`(${p.articleId}::uuid, ${p.accountId}::uuid)`);
      const existing = await db.execute(sql`
        SELECT content_id, account_id FROM content_publish_log
        WHERE status = 'success' AND (content_id, account_id) IN (${sql.join(tupleConds, sql`, `)})
      `);
      const done = new Set(((existing as any).rows as Array<{ content_id: string; account_id: string }>)
        .map((r) => `${r.content_id}|${r.account_id}`));
      const fresh = pairs.filter((p) => !done.has(`${p.articleId}|${p.accountId}`));
      if (fresh.length === 0) continue;

      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, t.id)).limit(1);
      if (!u) continue;

      const dateStr = new Date(Date.now() + BJ_OFFSET_MS).toISOString().slice(0, 10);
      const batchId = `auto-${dateStr}-${t.id.slice(0, 8)}`;
      initBulkProgress(batchId, fresh.length, 0);
      for (let i = 0; i < fresh.length; i++) {
        const p = fresh[i]!;
        await bulkDistributeQueue.add(
          "bulk-job",
          { batchId, contentId: p.articleId, accountId: p.accountId, tenantId: t.id, userId: u.id },
          { delay: i * 5000, jobId: `${batchId}-${p.articleId}-${p.accountId}` }
        );
      }
      totalQueued += fresh.length;
      logger.info({ tenantId: t.id, queued: fresh.length, unmatched: unmatched.length, batchId }, "PR-W6 auto-distribute: 已入队");
    } catch (err) {
      logger.error({ tenantId: t.id, err: err instanceof Error ? err.message : err }, "PR-W6 auto-distribute: 租户处理失败 (跳过)");
    }
  }
  return { tenantsProcessed: enabled.length, queued: totalQueued };
}
