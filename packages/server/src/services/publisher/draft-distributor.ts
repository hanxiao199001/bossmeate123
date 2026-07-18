/**
 * 7-05 ⑤ 公众号草稿箱分发 — 每天早上给每个绑定公众号的账号推 top-N 候选进微信草稿箱,
 * 运营在公众号后台自选发布 (draft/add, 永不自动群发)。
 *
 * 与 PR-W6 auto-distribute 的分工:
 *   - auto-distribute: 租户开 autoDistribute 开关才跑, 走 bulk 队列, 目标是"当日推荐当日配对"。
 *   - draft-distributor: 面向"可发池"(近 7 天已过质检/人工采用/AI 采用、未发布、未推过),
 *     每号固定 top-N (env DRAFT_PUSH_PER_ACCOUNT), 强制 draft_only, 直接同步推 (量小, 每号≤N)。
 *
 * 复用 (红线 #11):
 *   - computeSmartPairs (smart-assign): 账号领域/国内外定位匹配 + 每号 dailyCap + 负载均衡。
 *   - publishToAccounts + WechatAdapter: draft/add + 封面 thumb_media_id + 图片上传素材库全链路。
 *   - content_publish_log: status='draft_pushed' 防重复推 (与 success/draft 同表同唯一索引)。
 *
 * 【一篇只推一个号 — 写死, 不做配置】
 *   同一篇文章绝不推给同租户多个公众号: 公众号平台有原创判重, 多号同文会被判"相互抄袭"
 *   连坐降权/封原创。computeSmartPairs 天生每篇只配一号(匹配分最高/负载最低者), 这里再用
 *   publish_log 按 contentId 排除任何"已推过/已发过"的文章做双保险。
 */
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { contents, contentPublishLog, platformAccounts, tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { computeSmartPairs } from "./smart-assign.js";
import { publishToAccounts } from "./index.js";

const POOL_WINDOW_DAYS = 7; // 可发池回看窗口: 太老的文章时效性差, 不推

export interface DraftPushAccountReport {
  accountId: string;
  accountName: string;
  pushed: Array<{ contentId: string; title: string | null }>;
  errors: Array<{ contentId: string; error: string }>;
}

export interface DraftDistributeReport {
  tenantId: string;
  perAccount: DraftPushAccountReport[];
  poolSize: number;
  pushed: number;
  failed: number;
  skippedReason?: string;
  /** 7-14: 每号保底下限/上限, 供运营核对 */
  targetPerAccount?: number;
  capPerAccount?: number;
  /** 7-14: 两轮保底后仍未达下限的号 (内容不足信号, 明确报告不静默) */
  shortfalls?: Array<{ accountId: string; accountName: string | null; assigned: number; target: number }>;
}

/** 单租户跑一轮 */
export async function distributeDraftsForTenant(tenantId: string): Promise<DraftDistributeReport> {
  const report: DraftDistributeReport = { tenantId, perAccount: [], poolSize: 0, pushed: 0, failed: 0 };
  // 7-14: cap=每号上限(DRAFT_PUSH_PER_ACCOUNT); target=每号保底下限(DRAFT_TARGET_PER_ACCOUNT), 夹 ≤ cap。
  const perAccount = Math.max(1, Math.floor(env.DRAFT_PUSH_PER_ACCOUNT));
  const target = Math.max(1, Math.min(perAccount, Math.floor(env.DRAFT_TARGET_PER_ACCOUNT)));
  report.targetPerAccount = target;
  report.capPerAccount = perAccount;

  // 1. 该租户启用中的公众号
  const accounts = await db
    .select({ id: platformAccounts.id, accountName: platformAccounts.accountName })
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.tenantId, tenantId),
      eq(platformAccounts.platform, "wechat"),
      eq(platformAccounts.status, "active"),
    ));
  if (accounts.length === 0) {
    report.skippedReason = "无启用中的公众号";
    return report;
  }
  const nameById = new Map(accounts.map((a) => [a.id, a.accountName]));

  // 2. 可发池: 近 7 天、article
  //    7-13 修复"草稿箱饿死": 草稿箱本身就是运营人工筛选台(推进去还要人工挑+手动发, 非自动群发),
  //    所以"质检没过但不危险"的文章应带分数流进草稿箱让运营挑 —— 质检门不该在草稿箱前二次拦死。
  //    纳入: status=generated(已过/人工采用) + needs_review 里"六维偏低"这类质量问题;
  //    仍排除的红线类(标题数据造假 title_data_fabricated / 标题正文矛盾 title_body_inconsistent)——
  //    信任事故不进草稿箱, 永远留人工. 判据读 metadata.needsReviewReason。
  const since = new Date(Date.now() - POOL_WINDOW_DAYS * 24 * 3600_000);
  // 剔除: 红线两类(信任事故)+ 评分降级(分数不可信, 不是"分低"而是"没算准", 该重评不该进草稿箱)
  const RED_LINE_REASONS = ["title_data_fabricated", "title_body_inconsistent", "sixdim_degraded"];
  const rawPool = await db
    .select({ id: contents.id, title: contents.title, status: contents.status, metadata: contents.metadata })
    .from(contents)
    .where(and(
      or(eq(contents.tenantId, tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
      eq(contents.type, "article"),
      inArray(contents.status, ["generated", "needs_review"]),
      gte(contents.createdAt, since),
    ))
    .orderBy(desc(contents.createdAt))
    .limit(500);
  // needs_review 的文章: 只有非红线(六维偏低等质量问题)才放进草稿箱; 红线类剔除留人工
  const pool = rawPool.filter((c) => {
    if (c.status === "generated") return true;
    const reason = (c.metadata as { needsReviewReason?: string } | null)?.needsReviewReason;
    return !reason || !RED_LINE_REASONS.includes(reason);
  }).slice(0, 300).map((c) => ({ id: c.id, title: c.title }));
  if (pool.length === 0) {
    report.skippedReason = "可发池为空";
    return report;
  }

  // 3. 排除"已推过草稿/已发布"的文章 — 按 contentId 整篇排除 (一篇只推一个号, 推过任何号就不再推)
  const poolIds = pool.map((p) => p.id);
  const logged = await db
    .select({ contentId: contentPublishLog.contentId })
    .from(contentPublishLog)
    .where(and(
      eq(contentPublishLog.tenantId, tenantId),
      inArray(contentPublishLog.contentId, poolIds),
      inArray(contentPublishLog.status, ["success", "draft", "draft_pushed", "dispatched"]),
    ));
  const usedIds = new Set(logged.map((r) => r.contentId));
  const fresh = pool.filter((p) => !usedIds.has(p.id));
  report.poolSize = fresh.length;
  if (fresh.length === 0) {
    report.skippedReason = "可发池文章均已推过/发过";
    return report;
  }
  const titleById = new Map(fresh.map((p) => [p.id, p.title]));

  // 4. 领域/定位匹配 (复用 smart-assign; dailyCap=每号 top-N; 内部已按质检分排序=top 候选先占坑)
  const { pairs, unmatched, shortfalls } = await computeSmartPairs({
    tenantId,
    articleIds: fresh.map((p) => p.id),
    accountIds: accounts.map((a) => a.id),
    dailyCap: perAccount, // 上限
    target,               // 7-14 保底下限: 两轮保底填到该数
  });
  // 7-14: 未达保底下限的号 — 明确报告(带号名), 不静默。内容不足时供运营/运维决定提量或补内容。
  if (shortfalls && shortfalls.length > 0) {
    report.shortfalls = shortfalls.map((s) => ({ ...s, accountName: nameById.get(s.accountId) ?? null }));
    logger.warn(
      { tenantId, target, cap: perAccount, pool: fresh.length, accounts: accounts.length, shortfalls: report.shortfalls },
      `⚠️ 草稿分发: ${shortfalls.length}/${accounts.length} 个号未达保底(${target}篇/天) — 内容不足, 需提高生成量或补内容`,
    );
  }
  if (pairs.length === 0) {
    report.skippedReason = `无可配对内容 (unmatched=${unmatched.length})`;
    return report;
  }

  // 5. 逐对推草稿 — 强制 draft_only; 单号失败(token 失效/API 挂)只记日志跳过, 不阻塞其他号
  const byAccount = new Map<string, DraftPushAccountReport>();
  for (const a of accounts) {
    byAccount.set(a.id, { accountId: a.id, accountName: a.accountName, pushed: [], errors: [] });
  }
  for (const pair of pairs) {
    const acct = byAccount.get(pair.accountId);
    if (!acct) continue;
    try {
      const results = await publishToAccounts({
        contentId: pair.articleId,
        tenantId,
        accountIds: [pair.accountId],
        forceOverride: true, // 内容已过质检/采用, 且只进草稿箱(人工后台终审), 跳 audit gate 与 bulk-distribute 同策略
        overrideReason: "draft-distribute 草稿箱分发(仅建草稿, 运营后台终审)",
        capabilityOverride: "draft_only",
      });
      const r = results[0];
      if (r?.success) {
        // 落 log 防重复推: status='draft_pushed' (区别于浏览器推草稿的 'draft' 与真发布的 'success')
        await db.insert(contentPublishLog).values({
          tenantId,
          contentId: pair.articleId,
          accountId: pair.accountId,
          status: "draft_pushed",
          mediaId: r.mediaId ?? null,
          initiatedBy: "draft_dist",
        }).onConflictDoUpdate({
          target: [contentPublishLog.contentId, contentPublishLog.accountId],
          set: { status: "draft_pushed", mediaId: r.mediaId ?? null, initiatedBy: "draft_dist", updatedAt: new Date() },
        });
        acct.pushed.push({ contentId: pair.articleId, title: titleById.get(pair.articleId) ?? null });
        report.pushed++;
      } else {
        const error = (r?.error || r?.reason || r?.message || "推草稿失败").slice(0, 200);
        acct.errors.push({ contentId: pair.articleId, error });
        report.failed++;
        logger.warn({ tenantId, accountId: pair.accountId, contentId: pair.articleId, error }, "草稿分发: 单篇失败, 跳过");
      }
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      acct.errors.push({ contentId: pair.articleId, error });
      report.failed++;
      logger.warn({ tenantId, accountId: pair.accountId, contentId: pair.articleId, error }, "草稿分发: 单篇异常, 跳过");
    }
  }
  report.perAccount = [...byAccount.values()];
  logger.info(
    { tenantId, pushed: report.pushed, failed: report.failed, pool: report.poolSize, unmatched: unmatched.length },
    "草稿分发: 租户完成",
  );
  return report;
}

/** 全租户跑一轮 (cron 入口)。单租户失败不阻塞其他租户。 */
export async function runDraftDistribute(): Promise<{ tenantsProcessed: number; reports: DraftDistributeReport[] }> {
  const activeTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), sql`${tenants.id} != ${SYSTEM_RECOMMENDATION_TENANT_ID}::uuid`));
  const reports: DraftDistributeReport[] = [];
  for (const t of activeTenants) {
    try {
      reports.push(await distributeDraftsForTenant(t.id));
    } catch (err) {
      logger.error({ tenantId: t.id, err: err instanceof Error ? err.message : err }, "草稿分发: 租户失败 (跳过)");
    }
  }
  return { tenantsProcessed: activeTenants.length, reports };
}
