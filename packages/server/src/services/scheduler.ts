/**
 * 定时任务调度器（BullMQ 版）
 *
 * 基于 BullMQ 的可持久化任务调度，支持：
 * - cron 定时触发
 * - 失败重试（指数退避）
 * - 任务持久化（Redis 重启不丢）
 * - 多种任务类型：爬虫、关键词分析、热点监控、领域知识采集、竞品拆解、质检
 */

import { Worker, Queue } from "bullmq";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { EXTERNAL_FEEDBACK_AVAILABLE, EXTERNAL_FEEDBACK_DISABLED_SINCE } from "./metrics/external-feedback-status.js";
import { crawlAll, crawlByTrack, crawlPlatform } from "./crawler/index.js";
import { analyzeKeywords } from "./agents/keyword-analyzer.js";
import { db } from "../models/db.js";
import { tenants, contents, journals } from "../models/schema.js";
import { eq, and, lt, inArray } from "drizzle-orm";
import { getRedisConnection, crawlerQueue } from "./task/queue.js";
import type { PlatformName, CrawlerTrack } from "./crawler/types.js";

// ============ 任务类型 ============

export type SchedulerJobType =
  | "daily-crawl"              // 每日全量爬虫（三条线）
  | "crawl-track"              // 按业务线爬虫
  | "crawl-platform"           // 单平台爬虫
  | "keyword-analysis"         // 关键词分析
  | "hot-event-monitor"        // 热点事件监控
  | "domain-knowledge"         // 领域知识采集
  | "competitor-analysis"      // 竞品内容拆解
  | "style-learning"           // 风格学习
  | "quality-check"            // 批量质检
  | "knowledge-engine"         // 知识引擎 Agent
  | "orchestrator"             // 总指挥 Agent
  | "midday-knowledge"         // 午间知识补充
  | "evening-knowledge"        // 晚间知识补充
  | "journal-catalog-update"   // 月度期刊基础库更新（Springer + LetPub）
  | "heat-journal-match"       // 热度×期刊交叉匹配
  | "journal-cover-prefetch"   // 期刊封面图预抓取
  | "journal-trust-reverify"   // PR #107 5-9 治理 PR 3：30 天前 / 未验证期刊 batch reverify
  | "industry-monthly"         // P5 5-14：每月 1 号 4 行业 × 50 篇 article 自动生成
  | "daily-recommendation"     // PR #130 V2.5 5-13：每日 03:00 BJ 10 篇推荐 article 入 system tenant
  | "monthly-journal-refresh"  // PR #178：每月 1 日 04:00 BJ 月度期刊池刷新 + 异常检测
  | "content-retention-cleanup" // PR #178：每日 03:30 BJ 60 天保留清理
  | "stale-review-cleanup"     // 清理超时未审核内容（3天）
  | "login-keepalive"          // 6-11: 抖音/视频号登录态每日保活巡检(掉线标expired+cookie续期)
  | "daily-auto-distribute"    // PR-W6: 每日 07:00 BJ 推荐池按账号领域自动配对分发(草稿), 租户开关 autoDistribute
  | "journal-gap-fill"         // PR-FW: 每日补全缺 IF/分区/录用率 的期刊(知识库自愈)
  | "journal-topic-mining"     // 6-19: 每日从期刊库 LLM 衍生选题入库(选题库自动扩充, 按学科表现加权)
  | "ai-review-scan"           // 7-05 ④: 每小时 AI 审稿员扫灰区待审(影子模式记建议/live 自动裁决)
  | "draft-distribute"         // 7-05 ⑤: 每日早晨公众号草稿箱分发(每号 top-N 候选)
  | "wechat-stats-collect"     // 7-06 ①: 每日拉"昨日"公众号阅读数据回流 (getarticlesummary T+1)
  | "ops-daily-briefing"       // 7-25: 每日运营简报(异常汇总→企微推送, 推失败降级落库+今日驾驶舱)
  | "ops-weekly-judgment"      // 8-14 Phase 2: 判断层周报(检查器台账 + 去留建议 → 企微推运营)
  | "service-health-probe"     // 8-03: 每 30 分钟探外部依赖是否恢复 → 自动重跑积压内容(欠费/服务挂)
  | "daily-backup"             // 8-26: 每日 02:00 BJ 全库 pg_dump + Redis RDB → 上传 OSS(跨云) + 30 天保留期清理
  | "backup-restore-drill"     // 8-26: 每周一 04:00 BJ 恢复演练
  | "dvh-poll";                // 9-04 件 2: 每 5 分钟扫 dvh_tasks 未落定任务

export interface SchedulerJobData {
  type: SchedulerJobType;
  tenantId?: string;
  platform?: PlatformName;
  track?: CrawlerTrack;
  payload?: Record<string, unknown>;
}

// ============ Worker 处理器 ============

let schedulerWorker: Worker | null = null;

/**
 * 多租户扇出 helper（T6-B 修复）
 *
 * 用途：定时 cron job（competitor-analysis、style-learning 等）注册时不带 tenantId，
 * 之前 5 个 case 直接 throw "缺少 tenantId" → BullMQ retry 3 次进 failed 队列 → enrich 任务彻底丢失。
 *
 * 行为：
 * - 显式 tenantId：只跑该 tenant，失败仍然抛出（保留原 ad-hoc 调用方的错误传播）
 * - 无 tenantId：查 active tenants 循环跑，每 tenant 独立 try/catch，单失败不阻塞其他
 * - 返回 { tenantsProcessed, failures } 便于 BullMQ completed 队列里观察
 */
async function executeForTenants(
  jobName: string,
  fn: (tenantId: string) => Promise<unknown>,
  explicitTenantId?: string
): Promise<{ tenantsProcessed: number; failures: Array<{ tenantId: string; error: string }> }> {
  const failures: Array<{ tenantId: string; error: string }> = [];

  if (explicitTenantId) {
    try {
      await fn(explicitTenantId);
      return { tenantsProcessed: 1, failures };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failures.push({ tenantId: explicitTenantId, error: errMsg });
      throw err;
    }
  }

  const activeTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));

  let processed = 0;
  for (const t of activeTenants) {
    try {
      await fn(t.id);
      processed++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobName, tenantId: t.id, err: errMsg }, "enrich job failed for tenant");
      failures.push({ tenantId: t.id, error: errMsg });
    }
  }

  return { tenantsProcessed: processed, failures };
}

async function processJob(job: { name: string; data: SchedulerJobData }) {
  const { type, tenantId, platform, track } = job.data;
  logger.info({ type, tenantId, platform }, `⏰ 调度任务开始: ${type}`);

  switch (type) {
    case "daily-crawl": {
      const crawlerResults = await crawlAll();

      const activeTenants = await db
        .select()
        .from(tenants)
        .where(eq(tenants.status, "active"));

      for (const tenant of activeTenants) {
        try {
          await analyzeKeywords(crawlerResults, tenant.id);
          logger.info({ tenantId: tenant.id }, "租户关键词分析完成");
        } catch (err) {
          logger.error({ tenantId: tenant.id, err }, "租户关键词分析失败");
        }
      }

      /**
       * 🔴 8-17: 刷新全部 active 关键词的综合分 —— **必须在选题推荐之前**。
       *
       * 新公式含半衰 21 天的新鲜度衰减, 而库里存的是标量: 不刷就是拿三周前的分数排今天的序,
       * 老词永远压着新词 = 换个方式重演霸榜(旧公式 1098 条并列满分那个病的时间版)。
       *
       * 放在这里而不是单独 cron: 采集刚更新了 lastSeenAt/appearCount, 紧接着刷分,
       * 下一步的选题推荐读到的就是当日口径 —— 三步同一次运行内完成, 不会读到半新半旧。
       */
      try {
        const { refreshKeywordScores } = await import("./agents/keyword-score.js");
        const rs = await refreshKeywordScores({ apply: true });
        logger.info(
          { scanned: rs.scanned, updated: rs.updated, atMaxRatio: rs.after.atMaxRatio, healthy: rs.after.healthy },
          "关键词综合分已刷新",
        );
        // 分布塌了要出声 —— 打分打到人人满分等于没打分, 这条不该只在人想起来查的时候才发现
        if (!rs.after.healthy) {
          const { recordIncidentThrottled } = await import("./ops/incidents.js");
          await recordIncidentThrottled({
            kind: "keyword_score_flat",
            severity: "warn",
            message: `关键词分数分布不健康: ${rs.after.reasons.join("; ")} —— 排序区分度不足, 选题会趋同`,
            tenantId: null,
            detail: { scanned: rs.scanned, ...rs.after },
          }, { key: "keyword_score_flat" });
        }
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : err }, "关键词综合分刷新失败(不阻塞选题)");
      }

      // 生成每日选题推荐
      const { generateDailyRecommendations } = await import("./content-engine/topic-recommender.js");
      for (const tenant of activeTenants) {
        try {
          await generateDailyRecommendations(tenant.id);
          logger.info({ tenantId: tenant.id }, "今日选题推荐已生成");
        } catch (err) {
          logger.error({ tenantId: tenant.id, err }, "选题推荐生成失败");
        }
      }

      return { totalPlatforms: crawlerResults.length, tenantCount: activeTenants.length };
    }

    case "crawl-track": {
      if (!track) throw new Error("缺少 track 参数");
      const results = await crawlByTrack(track);
      return { track, count: results.length };
    }

    case "crawl-platform": {
      if (!platform) throw new Error("缺少 platform 参数");
      const result = await crawlPlatform(platform);
      return { platform, success: result.success, keywords: result.keywords.length };
    }

    case "keyword-analysis": {
      // 共用一次 crawlAll 结果给所有 tenant（避免 fan-out 时重复全量爬虫）
      const crawlerResults = await crawlAll();
      return executeForTenants(
        "keyword-analysis",
        (tid) => analyzeKeywords(crawlerResults, tid),
        tenantId
      );
    }

    case "hot-event-monitor": {
      const { detectHotEvents } = await import("./data-collection/hot-event-monitor.js");
      if (tenantId) {
        const events = await detectHotEvents(tenantId);
        return { tenantId, eventsDetected: events.length };
      }
      const activeTenants = await db.select().from(tenants).where(eq(tenants.status, "active"));
      let total = 0;
      for (const t of activeTenants) {
        const events = await detectHotEvents(t.id);
        total += events.length;
      }
      return { tenantsProcessed: activeTenants.length, totalEvents: total };
    }

    case "domain-knowledge": {
      const { collectDomainKnowledge } = await import("./data-collection/domain-knowledge-collector.js");
      return executeForTenants(
        "domain-knowledge",
        (tid) => collectDomainKnowledge(tid),
        tenantId
      );
    }

    case "competitor-analysis": {
      const { analyzeCompetitorContent } = await import("./data-collection/competitor-analyzer.js");
      return executeForTenants(
        "competitor-analysis",
        (tid) => analyzeCompetitorContent(tid),
        tenantId
      );
    }

    case "style-learning": {
      const { autoLearnStyle } = await import("./data-collection/style-learning-enhanced.js");
      return executeForTenants(
        "style-learning",
        (tid) => autoLearnStyle(tid),
        tenantId
      );
    }

    case "quality-check": {
      const { batchQualityCheck } = await import("./data-collection/quality-check-engine.js");
      return executeForTenants(
        "quality-check",
        (tid) => batchQualityCheck(tid),
        tenantId
      );
    }

    case "knowledge-engine":
    case "midday-knowledge":
    case "evening-knowledge": {
      // PR Q.7 B 方案：knowledge-engine 也归 V3 batch，统一总闸控制。
      if (!env.V3_BATCH_AGENT_ENABLED) {
        logger.info({ type }, "knowledge-engine scheduled job skipped (V3_BATCH_AGENT_ENABLED=false)");
        return { skipped: true, reason: "V3_BATCH_AGENT_ENABLED=false" };
      }
      const { agentRegistry } = await import("./agents/base/registry.js");
      const activeTenants = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      const agent = agentRegistry.get("knowledge-engine");
      if (!agent) throw new Error("KnowledgeEngine agent not registered");

      let totalCompleted = 0;
      for (const t of activeTenants) {
        try {
          const result = await agent.execute({
            tenantId: t.id,
            date: new Date().toISOString().slice(0, 10),
            triggeredBy: "scheduler",
          });
          if (result.success) totalCompleted++;
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "KnowledgeEngine execution failed");
        }
      }
      return { tenantsProcessed: activeTenants.length, totalCompleted };
    }

    case "orchestrator": {
      // PR Q.7 B 方案：V3 batch agent 总开关（默认 false）。关闭时立即返回，
      // 避免 50 条新内容批量累积污染老板 Dashboard 的"待审核队列"。
      if (!env.V3_BATCH_AGENT_ENABLED) {
        logger.info("orchestrator scheduled job skipped (V3_BATCH_AGENT_ENABLED=false)");
        return { skipped: true, reason: "V3_BATCH_AGENT_ENABLED=false" };
      }
      const { agentRegistry: registry } = await import("./agents/base/registry.js");
      const activeTenants = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      const agent = registry.get("orchestrator");
      if (!agent) throw new Error("Orchestrator agent not registered");

      let totalCompleted = 0;
      for (const t of activeTenants) {
        try {
          const result = await agent.execute({
            tenantId: t.id,
            date: new Date().toISOString().slice(0, 10),
            triggeredBy: "scheduler",
          });
          if (result.success) totalCompleted++;
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "Orchestrator execution failed");
        }
      }
      return { tenantsProcessed: activeTenants.length, totalCompleted };
    }

    case "journal-catalog-update": {
      // 月度：Springer Link 期刊基础库更新
      const { SpringerLinkCrawler } = await import("./crawler/springer-link-crawler.js");
      const springerCrawler = new SpringerLinkCrawler();

      const proxy = process.env.SPRINGER_PROXY || undefined;
      const result = await springerCrawler.crawlJournalCatalog({
        proxy,
        maxDetails: 30,
      });
      return result;
    }

    case "heat-journal-match": {
      // 热度信号 × 期刊库交叉匹配
      const { getTodayHeatMatches } = await import("./content-engine/journal-heat-matcher.js");
      const activeTenants = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      let totalMatches = 0;
      for (const t of activeTenants) {
        try {
          const matches = await getTodayHeatMatches(t.id, 20);
          totalMatches += matches.length;
          logger.info({ tenantId: t.id, matches: matches.length }, "Heat-journal match completed");
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "Heat-journal match failed");
        }
      }
      return { tenantsProcessed: activeTenants.length, totalMatches };
    }

    case "industry-monthly": {
      // P5（5-14）：每月 1 号 cron 4 行业 × 50 篇 = 200 篇 / tenant
      const { cronMonthlyAllTenants } = await import("./industry-monthly/cron-handler.js");
      await cronMonthlyAllTenants();
      logger.info("P5 industry-monthly cron 完成");
      return { ok: true };
    }
    case "daily-recommendation": {
      // PR #130（5-13 V2.5 提前）：每日 03:00 BJ 10 篇推荐 article 入 system tenant
      const { runDailyRecommendation } = await import("./recommendation/daily-cron.js");
      const result = await runDailyRecommendation();
      logger.info(result, "PR #130 daily-recommendation cron 完成");
      return result;
    }

    case "daily-auto-distribute": {
      // PR-W6: 对开了 autoDistribute 的租户, 把今日推荐池文章按账号领域配对, 入 bulk 队列(公众号草稿)
      const { runDailyAutoDistribute } = await import("./publisher/auto-distribute.js");
      return runDailyAutoDistribute();
    }

    case "journal-gap-fill": {
      // PR-FW 知识库自愈: 优先补全缺关键决策字段(IF/中科院分区/录用率)的期刊
      const { sql: gsql, or: gor, isNull: gisNull } = await import("drizzle-orm");
      const gaps = await db
        .select({ id: journals.id })
        .from(journals)
        .where(gor(gisNull(journals.impactFactor), gisNull(journals.casPartition), gisNull(journals.acceptanceRate)))
        .orderBy(gsql`${journals.confidence} DESC NULLS LAST`) // 先补高可信度的(更可能被推荐用到)
        .limit(80);
      const { enrichJournal } = await import("./journal-enricher/orchestrator.js");
      let ok = 0, bad = 0;
      for (const g of gaps) {
        try { await enrichJournal(g.id, {}); ok++; }
        catch (err) { logger.warn({ id: g.id, err }, "PR-FW gap-fill 失败(跳过)"); bad++; }
      }
      logger.info({ candidates: gaps.length, ok, bad }, "PR-FW 期刊缺字段补全完成");
      return { ok, bad, candidates: gaps.length };
    }

    case "journal-topic-mining": {
      // 6-19: 期刊库自动衍生选题(零人工)。每日抽样期刊→LLM 按学科推题→入 keywords(按学科表现加权)。
      const { mineTopicsFromJournals } = await import("./recommendation/journal-topic-miner.js");
      const res = await mineTopicsFromJournals();
      logger.info(res, "6-19 journal-topic-mining cron 完成");
      return res;
    }

    case "monthly-journal-refresh": {
      // PR #177：每月 1 日 04:00 BJ 月度期刊池刷新 + 异常检测
      const { refreshJournalsPool } = await import("../scripts/refresh-journals-pool.js");
      const refreshResult = await refreshJournalsPool({ newCount: 50, refreshExisting: true });
      logger.info(refreshResult, "PR #177 monthly-journal-refresh cron 完成");
      return refreshResult;
    }

    case "content-retention-cleanup": {
      // PR #178：每日 03:30 BJ 60 天保留清理
      const { cleanupOldContents } = await import("../scripts/cleanup-old-contents.js");
      const cleanupResult = await cleanupOldContents();
      logger.info(cleanupResult, "PR #178 content-retention-cleanup cron 完成");
      return cleanupResult;
    }

    case "daily-backup": {
      // 8-26: 每日 02:00 BJ 全库备份 → OSS。刻意排在 03:30 保留期清理**之前**。
      //   失败会落 incident(backup_failed) 并抛出 —— 抛出是故意的, 让 BullMQ 也记一次 failed。
      //   吞掉异常就变成"任务显示成功但没有备份", 正是这次改造要防的形态。
      const { runDailyBackup } = await import("./ops/backup.js");
      const backupResult = await runDailyBackup();
      logger.info(backupResult, "8-26 daily-backup cron 完成");
      return backupResult;
    }

    case "dvh-poll": {
      // 9-04 件 2: 表驱动轮询, 与请求生命周期解耦。整体不抛 —— 单条出错不该让其余的停下来。
      const { runDvhPollOnce } = await import("./digital-human/dvh-poller.js");
      const { noteDvhPollHeartbeat } = await import("./digital-human/dvh-heartbeat.js");
      const pollResult = await runDvhPollOnce();
      await noteDvhPollHeartbeat();   // 心跳: 见 dvh-heartbeat.ts 文件头(七问 Q3)
      logger.info(pollResult, "9-04 dvh-poll cron 完成");
      return pollResult;
    }

    case "backup-restore-drill": {
      // 8-26: 每周一 04:00 BJ 恢复演练。备份文件存在 ≠ 能恢复。
      const { runBackupRestoreDrill } = await import("./ops/backup.js");
      const drillResult = await runBackupRestoreDrill();
      logger.info(drillResult, "8-26 backup-restore-drill cron 完成");
      return drillResult;
    }
    case "journal-trust-reverify": {
      // PR #107 + 6-19: 每日去 LetPub 重核验, "最久没核验优先"(lastVerifiedAt ASC NULLS FIRST), ~3个月滚全库一遍。
      // 两个 env 开关(新一年 JCR 发布时加速全量核对一遍, 之后恢复默认):
      //   JOURNAL_REVERIFY_DAILY_LIMIT  每日批量(默认100; JCR新发布时可临时调高如400, 3周扫完全库, 之后调回)
      //   JOURNAL_REVERIFY_FORCE_ALL=true  忽略30天门槛, 重核所有刊(连最近核过的2025数据也重拉2026); 扫完一轮后改回 false
      const { sql: drizzleSql, isNull: drizzleIsNull, or: drizzleOr, lt: drizzleLt } = await import("drizzle-orm");
      const reverifyLimit = Number(process.env.JOURNAL_REVERIFY_DAILY_LIMIT) || 100;
      const forceAll = process.env.JOURNAL_REVERIFY_FORCE_ALL === "true";
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const candidates = await db
        .select({ id: journals.id })
        .from(journals)
        .where(forceAll ? undefined : drizzleOr(drizzleIsNull(journals.lastVerifiedAt), drizzleLt(journals.lastVerifiedAt, cutoff)))
        .orderBy(drizzleSql`${journals.lastVerifiedAt} ASC NULLS FIRST`, drizzleSql`${journals.confidence} ASC NULLS FIRST`)
        .limit(reverifyLimit);
      logger.info({ reverifyLimit, forceAll, picked: candidates.length }, "PR#107 reverify: 本轮取刊");
      const { enrichJournal } = await import("./journal-enricher/orchestrator.js");
      let success = 0; let failed = 0;
      for (const c of candidates) {
        try { await enrichJournal(c.id, { includeWebsiteScope: true }); success++; }
        catch (err) { logger.warn({ id: c.id, err }, "PR#107 cron reverify 失败（跳过）"); failed++; }
      }
      logger.info({ candidates: candidates.length, success, failed }, "PR#107 cron: 期刊治理 reverify 完成");
      return { success, failed, candidates: candidates.length };
    }
    case "journal-cover-prefetch": {
      // 期刊封面图预抓取 — 根据今日选题定向抓取
      const { prefetchJournalCovers } = await import("./crawler/journal-cover-prefetch.js");
      const { keywords: kwTable } = await import("../models/schema.js");
      const { desc: descOrder } = await import("drizzle-orm");

      const activeTenantsForCover = tenantId
        ? [{ id: tenantId }]
        : await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));

      let totalSuccess = 0;
      let totalFailed = 0;

      for (const t of activeTenantsForCover) {
        try {
          // 获取今日热门关键词作为选题
          const topKeywords = await db
            .select({ keyword: kwTable.keyword })
            .from(kwTable)
            .where(eq(kwTable.tenantId, t.id))
            .orderBy(descOrder(kwTable.compositeScore))
            .limit(10);

          const topics = topKeywords.map((k) => k.keyword);
          const result = await prefetchJournalCovers(t.id, topics);
          totalSuccess += result.success;
          totalFailed += result.failed;
          logger.info({ tenantId: t.id, ...result }, "期刊封面预抓取完成");
        } catch (err) {
          logger.error({ tenantId: t.id, err }, "期刊封面预抓取失败");
        }
      }
      return { tenantsProcessed: activeTenantsForCover.length, totalSuccess, totalFailed };
    }

    case "ai-review-scan": {
      // 7-05 ④: AI 审稿员 — 模式由 env.AI_REVIEWER_MODE 控(off/shadow/live), off 时空转
      const { runAiReviewScan } = await import("./review/ai-reviewer.js");
      return runAiReviewScan();
    }

    case "draft-distribute": {
      // 7-05 ⑤: 公众号草稿箱分发 — 每号 top-N (env DRAFT_PUSH_PER_ACCOUNT) 进微信草稿箱
      const { runDraftDistribute } = await import("./publisher/draft-distributor.js");
      const r = await runDraftDistribute();
      return {
        tenantsProcessed: r.tenantsProcessed,
        pushed: r.reports.reduce((n, x) => n + x.pushed, 0),
        failed: r.reports.reduce((n, x) => n + x.failed, 0),
      };
    }

    case "wechat-stats-collect": {
      // 7-06 ①: 公众号"昨日"阅读数据回流 — 逐号 getarticlesummary → content_metrics + ② 运营选择信号
      const { runWechatStatsCollection } = await import("./metrics/wechat-stats-collector.js");
      const r = await runWechatStatsCollection();
      return {
        date: r.date,
        accountsProcessed: r.accountsProcessed,
        matched: r.matched,
        unmatched: r.unmatched,
        expiredDrafts: r.expiredDrafts,
      };
    }

    case "ops-daily-briefing": {
      // 7-25: 每日运营简报 — 汇总过去 24h 异常 + 要人动手的事, 企微推运营。
      // 总开关 OPS_BRIEFING_ENABLED(默认 true); 关掉时空转, 不落库不推送。
      if (!env.OPS_BRIEFING_ENABLED) {
        logger.info("ops-daily-briefing skipped (OPS_BRIEFING_ENABLED=false)");
        return { skipped: true, reason: "OPS_BRIEFING_ENABLED=false" };
      }
      const { runDailyBriefing } = await import("./ops/daily-briefing.js");
      const r = await runDailyBriefing();
      return { date: r.date, level: r.level, pushed: r.pushed, tenantsProcessed: r.tenantsProcessed };
    }

    case "ops-weekly-judgment": {
      // 8-14 Phase 2: 判断层周报。与日简报共用总开关 —— 运营关掉简报就是不想被打扰,
      //   周报没道理绕过这个意图。
      if (!env.OPS_BRIEFING_ENABLED) {
        logger.info("ops-weekly-judgment skipped (OPS_BRIEFING_ENABLED=false)");
        return { skipped: true, reason: "OPS_BRIEFING_ENABLED=false" };
      }
      const { runWeeklyJudgmentReport } = await import("./ops/weekly-judgment-report.js");
      const r = await runWeeklyJudgmentReport();
      return { weekOf: r.weekOf, todos: r.todos, pushed: r.pushed };
    }

    case "service-health-probe": {
      // 8-03: 外部依赖恢复探测 + 自动重跑。
      //   探测本身要花真钱(必须是真实计费调用 —— 实测欠费时 /models 照返 200),
      //   所以三道刹车都在 runServiceHealthProbe 里: 没积压不探 / 连续失败退避 / DVH 不探。
      //   总开关 SERVICE_PROBE_ENABLED(默认开), 关掉时空转。
      if (process.env.SERVICE_PROBE_ENABLED === "0" || process.env.SERVICE_PROBE_ENABLED === "false") {
        return { skipped: true, reason: "SERVICE_PROBE_ENABLED=0" };
      }
      const { runServiceHealthProbe } = await import("./ops/service-health-probe.js");
      const r = await runServiceHealthProbe();
      return { skipped: r.skipped, reason: r.reason, backlog: r.backlog, retry: r.retry };
    }

    case "login-keepalive": {
      // 串行慢巡检(账号间8-20s), 不要与推草稿/扫码并发跑浏览器 — keepalive 内部有 running 互斥
      const { runLoginKeepalive } = await import("./publisher/login-keepalive.js");
      const summary = await runLoginKeepalive();
      if (!summary) logger.warn("login-keepalive: 已有巡检在跑, 本次跳过");
      break;
    }

    case "stale-review-cleanup": {
      // 清理超过 3 天仍处于 reviewing / draft 状态的内容
      const STALE_DAYS = 3;
      const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

      const staleRows = await db
        .select({ id: contents.id, title: contents.title, status: contents.status })
        .from(contents)
        .where(
          and(
            inArray(contents.status, ["reviewing", "draft"]),
            lt(contents.createdAt, cutoff)
          )
        );

      if (staleRows.length === 0) {
        logger.info("🧹 无超时未审核内容需要清理");
        return { deleted: 0 };
      }

      const staleIds = staleRows.map((r) => r.id);

      // 分批删除关联的 production_records 和 distribution_records
      const { productionRecords, distributionRecords } = await import("../models/schema.js");
      await db.delete(distributionRecords).where(inArray(distributionRecords.contentId, staleIds));
      await db.delete(productionRecords).where(inArray(productionRecords.contentId, staleIds));
      await db.delete(contents).where(inArray(contents.id, staleIds));

      logger.info(
        { count: staleRows.length, titles: staleRows.map((r) => r.title).slice(0, 5) },
        `🧹 已清理 ${staleRows.length} 条超过 ${STALE_DAYS} 天未审核的内容`
      );
      return { deleted: staleRows.length, cutoffDate: cutoff.toISOString() };
    }

    default:
      throw new Error(`未知任务类型: ${type}`);
  }
}

// ============ 启动调度器 ============

// ===== PR-W7: 生成/分发时间可配 (SYSTEM config.automationConfig.scheduleTimes) =====
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(v: unknown, fallback: string): { h: number; m: number; str: string } {
  const str = typeof v === "string" && TIME_RE.test(v) ? v : fallback;
  const m = TIME_RE.exec(str)!;
  return { h: Number(m[1]), m: Number(m[2]), str: `${String(Number(m[1])).padStart(2, "0")}:${m[2]}` };
}

export async function readScheduleTimes(): Promise<{ generateTime: string; distributeTime: string }> {
  try {
    const { SYSTEM_RECOMMENDATION_TENANT_ID } = await import("../config/system-recommendation.js");
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const st = ((t?.config as any)?.automationConfig?.scheduleTimes) ?? {};
    return {
      generateTime: parseHHMM(st.generateTime, "03:00").str,
      distributeTime: parseHHMM(st.distributeTime, "07:00").str,
    };
  } catch {
    return { generateTime: "03:00", distributeTime: "07:00" };
  }
}

/** 按配置(或新值)重注册两个每日任务 — 启动时和设置保存时调用, BullMQ upsert 幂等 */
export async function applyScheduleTimes(times?: { generateTime?: string; distributeTime?: string }): Promise<{ generateTime: string; distributeTime: string }> {
  const cur = await readScheduleTimes();
  const gen = parseHHMM(times?.generateTime, cur.generateTime);
  const dist = parseHHMM(times?.distributeTime, cur.distributeTime);
  await crawlerQueue.upsertJobScheduler(
    "daily-recommendation-schedule",
    { pattern: `${gen.m} ${gen.h} * * *`, tz: "Asia/Shanghai" },
    { name: "daily-recommendation", data: { type: "daily-recommendation" as SchedulerJobType } }
  );
  await crawlerQueue.upsertJobScheduler(
    "daily-auto-distribute-schedule",
    { pattern: `${dist.m} ${dist.h} * * *`, tz: "Asia/Shanghai" },
    { name: "daily-auto-distribute", data: { type: "daily-auto-distribute" as SchedulerJobType } }
  );
  logger.info({ generateTime: gen.str, distributeTime: dist.str }, "PR-W7 每日生成/分发时间已应用");
  return { generateTime: gen.str, distributeTime: dist.str };
}

export function startScheduler() {
  const connection = getRedisConnection();

  // 创建 Worker
  schedulerWorker = new Worker(
    "crawler",
    async (job) => processJob(job),
    {
      connection,
      concurrency: 2,
      limiter: { max: 3, duration: 60000 },
    }
  );

  schedulerWorker.on("completed", (job, result) => {
    logger.info({ jobId: job?.id, type: job?.data?.type, result }, "⏰ 调度任务完成");
  });

  schedulerWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, type: job?.data?.type, err: err.message }, "⏰ 调度任务失败");
  });

  // 注册 cron 定时任务
  registerCronJobs();

  logger.info("📅 BullMQ 调度器启动完成");
}

async function registerCronJobs() {
  // 每日 7:00 全量爬虫 + 关键词分析
  await crawlerQueue.upsertJobScheduler(
    "daily-crawl-schedule",
    { pattern: "0 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "daily-crawl",
      data: { type: "daily-crawl" as SchedulerJobType },
    }
  );

  // 6-11: 每日 05:00 登录态保活巡检(避开 02:00 备份 / 03:30 保留期清理 与 07:00 爬虫)
  //
  // ⚠️ 8-26 更正: 这句原本写的是"避开 03:30 备份/清理"——**03:30 只有清理, 没有备份**。
  //   03:30 跑的是 content-retention-cleanup(删 60 天前的内容), 是个纯删除任务。
  //   这句注释让人以为存在备份机制, 8-26 盘点时才发现生产**零自动备份**已经跑了几个月。
  //   注释描述了一个不存在的系统, 比没有注释更危险 —— 它让人不去查。
  //   真正的备份是同日新加的 daily-backup(02:00, 刻意排在 03:30 删数据之前)。
  await crawlerQueue.upsertJobScheduler(
    "login-keepalive-schedule",
    { pattern: "0 5 * * *", tz: "Asia/Shanghai" },
    {
      name: "login-keepalive",
      data: { type: "login-keepalive" as SchedulerJobType },
    }
  );

  // 每日 8:00 热点事件监控
  await crawlerQueue.upsertJobScheduler(
    "hot-event-schedule",
    { pattern: "0 8 * * *", tz: "Asia/Shanghai" },
    {
      name: "hot-event-monitor",
      data: { type: "hot-event-monitor" as SchedulerJobType },
    }
  );

  // 每日 9:00 竞品内容拆解
  await crawlerQueue.upsertJobScheduler(
    "competitor-schedule",
    { pattern: "0 9 * * *", tz: "Asia/Shanghai" },
    {
      name: "competitor-analysis",
      data: { type: "competitor-analysis" as SchedulerJobType },
    }
  );

  // 每周一 6:00 领域知识采集
  await crawlerQueue.upsertJobScheduler(
    "domain-knowledge-schedule",
    { pattern: "0 6 * * 1", tz: "Asia/Shanghai" },
    {
      name: "domain-knowledge",
      data: { type: "domain-knowledge" as SchedulerJobType },
    }
  );

  // 每周日 22:00 风格学习
  await crawlerQueue.upsertJobScheduler(
    "style-learning-schedule",
    { pattern: "0 22 * * 0", tz: "Asia/Shanghai" },
    {
      name: "style-learning",
      data: { type: "style-learning" as SchedulerJobType },
    }
  );

  // 每日 6:30 知识引擎
  await crawlerQueue.upsertJobScheduler(
    "knowledge-engine-schedule",
    { pattern: "30 6 * * *", tz: "Asia/Shanghai" },
    {
      name: "knowledge-engine",
      data: { type: "knowledge-engine" as SchedulerJobType },
    }
  );

  // 每日 7:00 总指挥（知识+选题+排队生产）
  await crawlerQueue.upsertJobScheduler(
    "orchestrator-schedule",
    { pattern: "0 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "orchestrator",
      data: { type: "orchestrator" as SchedulerJobType },
    }
  );

  // 每日 11:00 午间知识补充
  await crawlerQueue.upsertJobScheduler(
    "midday-knowledge-schedule",
    { pattern: "0 11 * * *", tz: "Asia/Shanghai" },
    {
      name: "midday-knowledge",
      data: { type: "midday-knowledge" as SchedulerJobType },
    }
  );

  // 每日 20:00 晚间知识补充
  await crawlerQueue.upsertJobScheduler(
    "evening-knowledge-schedule",
    { pattern: "0 20 * * *", tz: "Asia/Shanghai" },
    {
      name: "evening-knowledge",
      data: { type: "evening-knowledge" as SchedulerJobType },
    }
  );

  // 每月1号 3:00 期刊基础库全量更新（Springer Link）
  await crawlerQueue.upsertJobScheduler(
    "journal-catalog-schedule",
    { pattern: "0 3 1 * *", tz: "Asia/Shanghai" },
    {
      name: "journal-catalog-update",
      data: { type: "journal-catalog-update" as SchedulerJobType },
    }
  );

  // PR #130 + PR-W6 + PR-W7: 每日生成/分发 — 时间从 SYSTEM config 读 (默认 03:00 / 07:00), 仪表盘可改
  await applyScheduleTimes();

  // PR-FW: 每日 05:30 BJ 期刊缺字段补全(在生成前, 让当天推荐用上更全数据)
  await crawlerQueue.upsertJobScheduler(
    "journal-gap-fill-schedule",
    { pattern: "30 5 * * *", tz: "Asia/Shanghai" },
    { name: "journal-gap-fill", data: { type: "journal-gap-fill" as SchedulerJobType } }
  );

  // 7-05 ④: 每小时 :20 AI 审稿员扫灰区待审 (避开整点的爬虫/知识任务高峰; off 模式空转极便宜)
  await crawlerQueue.upsertJobScheduler(
    "ai-review-scan-schedule",
    { pattern: "20 * * * *", tz: "Asia/Shanghai" },
    { name: "ai-review-scan", data: { type: "ai-review-scan" as SchedulerJobType } }
  );

  // 7-05 ⑤: 每日 DRAFT_PUSH_CRON_HOUR 点(默认 08:00 BJ) 公众号草稿箱分发 — 在 07:00 auto-distribute 之后,
  // 老板/运营到工位时草稿已就位, 到公众号后台自选发布
  await crawlerQueue.upsertJobScheduler(
    "draft-distribute-schedule",
    { pattern: `0 ${env.DRAFT_PUSH_CRON_HOUR} * * *`, tz: "Asia/Shanghai" },
    { name: "draft-distribute", data: { type: "draft-distribute" as SchedulerJobType } }
  );

  // 7-06 ①: 每日 WECHAT_STATS_CRON_HOUR 点(默认 09:00 BJ):10 拉各公众号"昨日"图文阅读数据回流。
  // 微信 datacube T+1 出数, 上午拉最稳; :10 错开整点的推草稿/爬虫任务。
  //
  // 🔴 8-20 停用(老韩拍板)。原因与解锁条件见 metrics/external-feedback-status.ts 文件头:
  //   7 个公众号全部返回 48001「无数据分析权限」, content_metrics 空表, 跑了一个多月零产出。
  //   **不是让它继续"优雅跳过", 是不跑** —— 留着一个每天跑、每天失败的任务就是在制造下一个盲区。
  //   任务处理器(case "wechat-stats-collect")刻意保留: 认证一通, 把下面的常量改回 true 即可复活,
  //   删掉处理器会让"恢复"变成一次重写。
  if (EXTERNAL_FEEDBACK_AVAILABLE) {
    await crawlerQueue.upsertJobScheduler(
      "wechat-stats-collect-schedule",
      { pattern: `10 ${env.WECHAT_STATS_CRON_HOUR} * * *`, tz: "Asia/Shanghai" },
      { name: "wechat-stats-collect", data: { type: "wechat-stats-collect" as SchedulerJobType } }
    );
  } else {
    // 已注册过的 repeat job 不会因为这里不再 upsert 就消失 —— 必须显式移除, 否则旧调度继续跑。
    // (BullMQ 的 job scheduler 存在 Redis 里, 与本次进程启动与否无关。)
    try {
      await crawlerQueue.removeJobScheduler("wechat-stats-collect-schedule");
      logger.info({ since: EXTERNAL_FEEDBACK_DISABLED_SINCE }, "8-20 公众号数据回流 cron 已停用并移除既有调度(48001 无权限)");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "移除 wechat-stats-collect 调度失败");
    }
  }

  // 7-25: 每日 OPS_BRIEFING_CRON_HOUR:MINUTE(默认 09:30 BJ) 运营简报。
  // 排在最后 — 生成(03:00)/期刊补全(05:30)/分发(07:00)/草稿箱(08:00)/公众号数据回流(09:10) 全跑完再汇总,
  // 否则会把"还没跑到"误报成"零产出"。
  await crawlerQueue.upsertJobScheduler(
    "ops-daily-briefing-schedule",
    { pattern: `${env.OPS_BRIEFING_CRON_MINUTE} ${env.OPS_BRIEFING_CRON_HOUR} * * *`, tz: "Asia/Shanghai" },
    { name: "ops-daily-briefing", data: { type: "ops-daily-briefing" as SchedulerJobType } }
  );

  // 8-14 Phase 2: 每周一 10:00 BJ 判断层周报。
  //   排在日简报(09:30)之后半小时 —— 周报要读的台账/内容数据与日简报同源,
  //   让日简报先跑完, 避免两个任务同时扫 contents。
  //   周一发: 上周数据齐全, 且运营周一有时间处理"这周要你做的事"。
  await crawlerQueue.upsertJobScheduler(
    "ops-weekly-judgment-schedule",
    { pattern: "0 10 * * 1", tz: "Asia/Shanghai" },
    { name: "ops-weekly-judgment", data: { type: "ops-weekly-judgment" as SchedulerJobType } }
  );

  // 8-03: 每 30 分钟探一次"外部依赖回来没有" → 回来了就把积压内容自动重跑。
  //   为什么是 30 分钟: 欠费/服务挂通常是分钟到小时级, 30 分钟既不会让恢复后干等太久,
  //   又不会把探测成本做大(且没有积压时根本不发请求, 见 runServiceHealthProbe 的第一道刹车)。
  //   错开整点(:07/:37): 别和 03:00 排产、07:00 分发、09:30 简报这些整点任务挤在一起。
  await crawlerQueue.upsertJobScheduler(
    "service-health-probe-schedule",
    { pattern: "7,37 * * * *", tz: "Asia/Shanghai" },
    { name: "service-health-probe", data: { type: "service-health-probe" as SchedulerJobType } }
  );

  // 每日 7:30 热度×期刊交叉匹配（在爬虫+关键词分析之后）
  await crawlerQueue.upsertJobScheduler(
    "heat-journal-match-schedule",
    { pattern: "30 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "heat-journal-match",
      data: { type: "heat-journal-match" as SchedulerJobType },
    }
  );

  // 每日 7:45 期刊封面图预抓取（在热度匹配之后，内容生产之前）
  await crawlerQueue.upsertJobScheduler(
    "journal-cover-prefetch-schedule",
    { pattern: "45 7 * * *", tz: "Asia/Shanghai" },
    {
      name: "journal-cover-prefetch",
      data: { type: "journal-cover-prefetch" as SchedulerJobType },
    }
  );

  // 每日 2:00 清理超过 3 天未审核的内容
  await crawlerQueue.upsertJobScheduler(
    "stale-review-cleanup-schedule",
    { pattern: "0 2 * * *", tz: "Asia/Shanghai" },
    {
      name: "stale-review-cleanup",
      data: { type: "stale-review-cleanup" as SchedulerJobType },
    }
  );

  // PR #107（5-9 治理 PR 3）：每日 03:00 重新验证 30 天前 / 未验证的期刊（batch ≤ 100）
  await crawlerQueue.upsertJobScheduler(
    "journal-trust-reverify-schedule",
    { pattern: "0 3 * * *", tz: "Asia/Shanghai" },
    {
      name: "journal-trust-reverify",
      data: { type: "journal-trust-reverify" as SchedulerJobType },
    }
  );

  // 6-19: 每日 05:30 BJ 期刊库衍生选题入库(选题库自动扩充)。错开生成/分发/爬虫。
  await crawlerQueue.upsertJobScheduler(
    "journal-topic-mining-schedule",
    { pattern: "30 5 * * *", tz: "Asia/Shanghai" },
    { name: "journal-topic-mining", data: { type: "journal-topic-mining" as SchedulerJobType } }
  );

  // PR #120 P5（5-14）：每月 1 号 00:00 BJ 4 行业 × 50 篇 article 自动生成
  await crawlerQueue.upsertJobScheduler(
    "industry-monthly-schedule",
    { pattern: "0 0 1 * *", tz: "Asia/Shanghai" },
    {
      name: "industry-monthly",
      data: { type: "industry-monthly" as SchedulerJobType },
    }
  );

  // PR #177：每月 1 日 04:00 BJ 月度期刊池刷新 + 异常值检测
  await crawlerQueue.upsertJobScheduler(
    "monthly-journal-refresh-schedule",
    { pattern: "0 4 1 * *", tz: "Asia/Shanghai" },
    {
      name: "monthly-journal-refresh",
      data: { type: "monthly-journal-refresh" as SchedulerJobType },
    }
  );

  // PR #178：每日 03:30 BJ 60 天保留清理
  /**
   * 8-26 每日 02:00 BJ 全库备份 → OSS(跨云)。
   *
   * 🔴 时点是刻意的: 必须早于 03:30 的 content-retention-cleanup。
   *   反过来的话备的是"已经删掉 60 天前内容"的库 —— 那正是最需要能回滚的那一刀。
   *
   * 与同在 02:00 的 stale-review-cleanup 同队列串行, 不冲突(BullMQ 按 concurrency 排队);
   * 两者都很轻, 真正吃时间的是 pg_dump(240MB 库, 实测量级几十秒)。
   */
  if (env.BACKUP_ENABLED) {
    await crawlerQueue.upsertJobScheduler(
      "daily-backup-schedule",
      { pattern: `${env.BACKUP_CRON_MINUTE} ${env.BACKUP_CRON_HOUR} * * *`, tz: "Asia/Shanghai" },
      { name: "daily-backup", data: { type: "daily-backup" as SchedulerJobType } }
    );
    // 每周恢复演练 —— 没验证过能恢复的备份不算备份
    if (env.BACKUP_DRILL_ENABLED) {
      await crawlerQueue.upsertJobScheduler(
        "backup-restore-drill-schedule",
        { pattern: env.BACKUP_DRILL_CRON, tz: "Asia/Shanghai" },
        { name: "backup-restore-drill", data: { type: "backup-restore-drill" as SchedulerJobType } }
      );
    } else {
      // 关掉时必须显式移除既有调度 —— BullMQ 的 job scheduler 存在 Redis 里,
      // 不再 upsert 不会让旧调度消失(与 wechat-stats-collect 8-20 同一个坑)。
      await crawlerQueue.removeJobScheduler("backup-restore-drill-schedule").catch(() => { /* 本就没有 */ });
    }
  } else {
    await crawlerQueue.removeJobScheduler("daily-backup-schedule").catch(() => { /* 本就没有 */ });
    await crawlerQueue.removeJobScheduler("backup-restore-drill-schedule").catch(() => { /* 本就没有 */ });
  }

  /**
   * 9-04 件 2: 每 5 分钟扫一次未落定的数字人任务。
   *
   * 为什么是独立的 cron 而不是塞进 service-health-probe(每 30 分钟):
   * 那条是"外部依赖恢复没有"的探测, 跑不跑取决于有没有积压;
   * 而付费任务的落定**不能**依赖于"当前有没有别的东西挂了"。
   */
  await crawlerQueue.upsertJobScheduler(
    "dvh-poll-schedule",
    { pattern: "*/5 * * * *", tz: "Asia/Shanghai" },
    { name: "dvh-poll", data: { type: "dvh-poll" as SchedulerJobType } }
  );

  await crawlerQueue.upsertJobScheduler(
    "content-retention-cleanup-schedule",
    { pattern: "30 3 * * *", tz: "Asia/Shanghai" },
    {
      name: "content-retention-cleanup",
      data: { type: "content-retention-cleanup" as SchedulerJobType },
    }
  );

  logger.info("📅 Cron 定时任务注册完成（含月度期刊更新 + 每日热度匹配 + 封面预抓取 + 超时审核清理 + 期刊治理 reverify + 行业月度 batch + 月度期刊刷新）");
}

// ============ 手动触发接口 ============

export async function triggerJob(data: SchedulerJobData) {
  const job = await crawlerQueue.add(data.type, data, {
    priority: 1,
  });
  logger.info({ jobId: job.id, type: data.type }, "手动触发调度任务");
  return { jobId: job.id };
}

export async function getJobStatus(jobId: string) {
  const job = await crawlerQueue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    id: job.id,
    type: job.data.type,
    state,
    progress: job.progress,
    result: job.returnvalue,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn,
  };
}

export async function getSchedulerStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    crawlerQueue.getWaitingCount(),
    crawlerQueue.getActiveCount(),
    crawlerQueue.getCompletedCount(),
    crawlerQueue.getFailedCount(),
    crawlerQueue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

// ============ 停止调度器 ============

export async function stopScheduler() {
  if (schedulerWorker) {
    await schedulerWorker.close();
    schedulerWorker = null;
    logger.info("调度器已停止");
  }
}
