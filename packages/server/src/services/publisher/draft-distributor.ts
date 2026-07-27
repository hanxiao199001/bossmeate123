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

// ============ 7-27 可发池准入判据(模块级导出, 供单测锁行为) ============

/**
 * 红线类待审原因(信任事故/废稿) — 永不进草稿箱, 留人工。
 * 7-25 补 body_fabrication(下方硬闸自己打的标, 不进名单会被反复重拦); 7-27 补 output_unhealthy(同理)。
 * ⚠️ 7-27 把"未评上分"(旧名 sixdim_degraded)从这里**移出去了** —— 当天零产出的直接死因:
 *   质检 LLM 一超时, 20/25 条内容全被当"信任事故"剔除。"评分器挂了"≠"内容有问题"。
 */
export const RED_LINE_REASONS = ["title_data_fabricated", "title_body_inconsistent", "body_fabrication", "output_unhealthy"];

/**
 * "没评上分"的 reason(不是"分低")。sixdim_degraded 是 7-27 前的旧名, 库里有存量, 一并识别。
 * 这类内容: ① 允许进草稿箱(草稿箱本身就是人工筛选台, 推进去还要人工挑+手动发, 不是自动群发)
 *          ② 但排在**队尾**, 只在有分的内容不够保底下限时才被取用
 *          ③ 仍要过所有确定性闸(出稿健康闸/正文编造闸)与发布期的合规+敏感词闸
 */
export const UNSCORED_REASONS = new Set(["quality_check_unavailable", "sixdim_degraded"]);

/** 纯函数: 该 status/待审原因能否进可发池(红线剔除, 其余包括"未评上分"放行) */
export function passesReasonGate(status: string | null, needsReviewReason: string | null | undefined): boolean {
  if (status === "generated") return true;
  return !needsReviewReason || !RED_LINE_REASONS.includes(needsReviewReason);
}

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
  // 剔除: 红线两类(信任事故)
  // 7-25 补 body_fabrication: 它是下方硬闸自己打的标(:112), 却不在红线名单里 —— 被拦下标记过的内容
  //   下一轮又能进池、再被同一道闸拦一次(白跑 + 日志刷屏)。编造是数据造假红线, 与标题编造同级。
  // 7-27 补 output_unhealthy: 出稿健康闸打的标(:118 附近), 同 body_fabrication 的道理 ——
  //   被拦下标记过的废稿(占位文/截断/复读)下一轮又能进池、再被同一道闸拦一次(白跑 + 日志刷屏)。
  //   而且它是"这稿子根本不是内容"级别的问题, 比六维分低严重得多, 必须留人工。
  //
  // ⚠️ 7-27 把"未评上分"从红线里**移出来** —— 这是当天零产出的直接死因。
  //   原来 sixdim_degraded 在红线名单里, 于是质检 LLM 一超时, 20/25 条内容全被当"信任事故"剔除,
  //   整天零条进草稿箱, 而且**没有任何告警**。可"没评上分"和"标题造假"根本不是一回事:
  //   前者是我们自己的评分器挂了, 内容本身没有任何已知问题。
  //   新策略见 UNSCORED_REASONS: 不剔除, 但排到队尾 —— 有分的内容优先, 分不够时才用它顶上,
  //   既不静默停产, 也不让未经评分的内容抢掉正常内容的名额。
  //   (判据常量与纯函数已提到模块级导出: RED_LINE_REASONS / UNSCORED_REASONS / passesReasonGate)
  const rawPool = await db
    .select({ id: contents.id, title: contents.title, body: contents.body, status: contents.status, metadata: contents.metadata })
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
  const reasonPassed = rawPool.filter((c) =>
    passesReasonGate(c.status, (c.metadata as { needsReviewReason?: string } | null)?.needsReviewReason),
  ).slice(0, 300);

  // 7-21 发布前编造硬闸(确定性兜底): 纯国内刊正文出现 DB 无据的 IF/分区 → 不进草稿箱, 标 needs_review/body_fabrication。
  //   即使生成侧 prompt 漏网、六维分侥幸过线, 也发不出去。骑墙刊(含sci-core)豁免。复用 checkBodyFabrication。
  const { checkBodyFabricationForPublish } = await import("../compliance/content-check.js");
  // 7-27 出稿健康闸(确定性兜底, 零 LLM/零 DB): 占位文/空/截断/复读 → 不进草稿箱, 标 needs_review/output_unhealthy。
  //   ⚠️ 关键: 这道闸放在**不看 status** 的位置 —— 上面的 reasonPassed 对 status=generated 是**无条件放行**的,
  //   7-27 那篇标题="抱歉，AI暂时无法响应，请稍后重试。"、六维 80 分、status=generated 的废稿正是从这个口子溜进草稿箱的。
  const { checkOutputHealth, OUTPUT_UNHEALTHY_REASON } = await import("./output-health.js");
  const pool: Array<{ id: string; title: string | null }> = [];
  const unscoredIds = new Set<string>(); // 7-27: 没评上分的, 排队尾(见 UNSCORED_REASONS)
  for (const c of reasonPassed) {
    const health = checkOutputHealth({ title: c.title, body: c.body, type: "article" });
    if (!health.healthy) {
      await db.update(contents)
        .set({ status: "needs_review", metadata: sql`COALESCE(${contents.metadata},'{}'::jsonb) || ${JSON.stringify({ needsReviewReason: OUTPUT_UNHEALTHY_REASON, outputHealth: { codes: health.codes, issues: health.issues } })}::jsonb`, updatedAt: new Date() })
        .where(eq(contents.id, c.id));
      logger.warn({ contentId: c.id, status: c.status, codes: health.codes, summary: health.summary }, "草稿分发硬闸: 出稿不健康(废稿特征), 剔除不进草稿箱, 转 needs_review");
      void import("../ops/incidents.js").then((m) => m.recordIncident({
        kind: "output_unhealthy",
        severity: "error",
        tenantId,
        message: `草稿分发拦下废稿(${health.codes.join("/")}): ${health.summary}`.slice(0, 500),
        detail: { contentId: c.id, stage: "draft_distribute", status: c.status, codes: health.codes, issues: health.issues },
      })).catch(() => { /* 告警旁路, 不阻塞分发 */ });
      continue;
    }
    const cMeta = (c.metadata as { journalId?: string; journalIds?: string[] } | null) ?? {};
    const journalId = cMeta.journalId ?? null;
    // 7-25: 多刊盘点(roundup)的 metadata 带 journalIds 而非 journalId, 原来这里一律当"无期刊"放行。
    const journalIds = Array.isArray(cMeta.journalIds) ? cMeta.journalIds : null;
    const fab = await checkBodyFabricationForPublish({ body: c.body, journalId, journalIds });
    if (fab.length > 0) {
      await db.update(contents)
        .set({ status: "needs_review", metadata: sql`COALESCE(${contents.metadata},'{}'::jsonb) || ${JSON.stringify({ needsReviewReason: "body_fabrication", bodyFabrication: fab })}::jsonb`, updatedAt: new Date() })
        .where(eq(contents.id, c.id));
      logger.warn({ contentId: c.id, journalId, fab }, "草稿分发硬闸: 正文编造无据IF/分区, 剔除不进草稿箱, 转 needs_review");
      continue;
    }
    const reason = (c.metadata as { needsReviewReason?: string } | null)?.needsReviewReason;
    if (c.status === "needs_review" && reason && UNSCORED_REASONS.has(reason)) unscoredIds.add(c.id);
    pool.push({ id: c.id, title: c.title });
  }
  // 7-27: 有分的排前面, 没评上分的垫底(stable, 组内仍保持 createdAt desc)。
  //   正常日子 unscoredIds 是空的, 排序等于没发生; 只有质检大面积挂掉那天才轮到它们顶上,
  //   把"零产出"换成"产出里混了几篇未评分的" —— 后者运营在草稿箱里一眼能认出来(有 needs_review 标),
  //   前者只会被无声吞掉。
  if (unscoredIds.size > 0) {
    const scored = pool.filter((p) => !unscoredIds.has(p.id));
    const unscored = pool.filter((p) => unscoredIds.has(p.id));
    pool.length = 0;
    pool.push(...scored, ...unscored);
    logger.info({ tenantId, scored: scored.length, unscored: unscored.length }, "7-27 可发池: 未评上分的内容排队尾(有分的优先)");
  }
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
