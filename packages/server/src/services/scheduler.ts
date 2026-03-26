/**
 * 定时任务调度器
 *
 * 负责每日定时触发 Agent 1（爬虫）+ Agent 2（分析）
 * 使用简单的 setInterval 实现，后续可升级为 node-cron
 */

import { logger } from "../config/logger.js";
import { crawlAll } from "./crawler/index.js";
import { analyzeKeywords } from "./agents/keyword-analyzer.js";
import { db } from "../models/db.js";
import { tenants } from "../models/schema.js";
import { eq } from "drizzle-orm";

// 每日任务执行时间：早上 7:00
const DAILY_HOUR = 7;
const DAILY_MINUTE = 0;

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 计算距离下次执行时间的毫秒数
 */
function msUntilNextRun(): number {
  const now = new Date();
  const next = new Date();
  next.setHours(DAILY_HOUR, DAILY_MINUTE, 0, 0);

  // 如果今天的时间已过，设为明天
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * 执行每日抓取任务
 */
async function runDailyCrawl() {
  logger.info("⏰ 定时任务触发：开始每日热点抓取");

  try {
    // 获取所有活跃租户
    const activeTenants = await db
      .select()
      .from(tenants)
      .where(eq(tenants.status, "active"));

    if (activeTenants.length === 0) {
      logger.warn("没有活跃租户，跳过每日抓取");
      return;
    }

    // Step 1: 全平台爬虫（所有租户共享爬虫结果）
    const crawlerResults = await crawlAll();

    // Step 2: 为每个租户运行关键词分析
    for (const tenant of activeTenants) {
      try {
        await analyzeKeywords(crawlerResults, tenant.id);
        logger.info({ tenantId: tenant.id, tenantName: tenant.name }, "租户关键词分析完成");
      } catch (err) {
        logger.error({ tenantId: tenant.id, err }, "租户关键词分析失败");
      }
    }

    logger.info(
      { tenantCount: activeTenants.length },
      "⏰ 每日热点抓取全部完成"
    );
  } catch (err) {
    logger.error({ err }, "每日抓取任务执行失败");
  }
}

/**
 * 启动调度器
 */
export function startScheduler() {
  const delay = msUntilNextRun();
  const nextRunTime = new Date(Date.now() + delay);

  logger.info(
    {
      nextRun: nextRunTime.toISOString(),
      delayMinutes: Math.round(delay / 60000),
    },
    "📅 调度器启动：每日热点抓取已注册"
  );

  // 首次执行
  schedulerTimer = setTimeout(async () => {
    await runDailyCrawl();

    // 之后每24小时执行一次
    setInterval(runDailyCrawl, 24 * 60 * 60 * 1000);
  }, delay);
}

/**
 * 停止调度器
 */
export function stopScheduler() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
    logger.info("调度器已停止");
  }
}
