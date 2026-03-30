/**
 * 关键词热度趋势分析服务
 *
 * 职责：
 * 1. 每日快照：将当日关键词热度写入 keyword_history 表
 * 2. 趋势计算：7天/30天热度曲线，识别"爆发"和"持续上升"的关键词
 * 3. 趋势标签：rising / exploding / stable / cooling
 */

import { db } from "../../models/db.js";
import { keywords, keywordHistory } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";

// ========== 类型定义 ==========

export interface TrendLabel {
  keyword: string;
  trend: "exploding" | "rising" | "stable" | "cooling" | "new";
  score7d: number;        // 7天变化率（百分比）
  score30d: number;       // 30天变化率
  currentScore: number;   // 最新综合分
  avgScore7d: number;     // 7天均分
  avgScore30d: number;    // 30天均分
  sparkline: number[];    // 最近7天热度数组（用于前端迷你图）
  platforms: string[];    // 当前出现平台
  category: string | null;
  firstSeenDaysAgo: number;
}

export interface TrendReport {
  date: string;
  exploding: TrendLabel[];  // 突然爆发（7天涨幅>200%）
  rising: TrendLabel[];     // 持续上升（7天涨幅>50%）
  stable: TrendLabel[];     // 平稳
  cooling: TrendLabel[];    // 下降
  newKeywords: TrendLabel[]; // 最近3天新出现
}

// ========== 每日快照 ==========

/**
 * 将今日所有 active 关键词写入 keyword_history
 * 建议在每日抓取分析完成后调用
 */
export async function takeKeywordSnapshot(tenantId: string): Promise<number> {
  const today = new Date().toISOString().split("T")[0];

  // 获取所有活跃关键词
  const activeKeywords = await db
    .select()
    .from(keywords)
    .where(
      and(
        eq(keywords.tenantId, tenantId),
        eq(keywords.status, "active")
      )
    );

  let inserted = 0;

  for (const kw of activeKeywords) {
    try {
      // upsert：同一天同一关键词只保留一条
      await db
        .insert(keywordHistory)
        .values({
          tenantId,
          keyword: kw.keyword,
          snapshotDate: today,
          heatScore: kw.heatScore,
          compositeScore: kw.compositeScore || 0,
          platforms: kw.metadata && typeof kw.metadata === "object" && "platforms" in kw.metadata
            ? (kw.metadata as any).platforms
            : [kw.sourcePlatform],
          platformCount: kw.metadata && typeof kw.metadata === "object" && "platforms" in kw.metadata
            ? ((kw.metadata as any).platforms as string[]).length
            : 1,
          category: kw.category,
        })
        .onConflictDoUpdate({
          target: [keywordHistory.tenantId, keywordHistory.keyword, keywordHistory.snapshotDate],
          set: {
            heatScore: kw.heatScore,
            compositeScore: kw.compositeScore || 0,
            platforms: kw.metadata && typeof kw.metadata === "object" && "platforms" in kw.metadata
              ? (kw.metadata as any).platforms
              : [kw.sourcePlatform],
            platformCount: kw.metadata && typeof kw.metadata === "object" && "platforms" in kw.metadata
              ? ((kw.metadata as any).platforms as string[]).length
              : 1,
          },
        });

      inserted++;
    } catch (err) {
      logger.error({ keyword: kw.keyword, error: err }, "快照写入失败");
    }
  }

  logger.info(
    { tenantId, date: today, total: activeKeywords.length, inserted },
    "📸 关键词每日快照完成"
  );

  return inserted;
}

// ========== 趋势计算 ==========

/**
 * 获取单个关键词的趋势数据
 */
export async function getKeywordTrend(
  tenantId: string,
  keyword: string,
  days: number = 30
): Promise<{
  keyword: string;
  history: { date: string; heatScore: number; compositeScore: number; platforms: string[] }[];
  trend: TrendLabel;
}> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split("T")[0];

  const history = await db
    .select()
    .from(keywordHistory)
    .where(
      and(
        eq(keywordHistory.tenantId, tenantId),
        sql`LOWER(${keywordHistory.keyword}) = LOWER(${keyword})`,
        gte(keywordHistory.snapshotDate, startStr)
      )
    )
    .orderBy(keywordHistory.snapshotDate);

  const historyData = history.map((h) => ({
    date: String(h.snapshotDate),
    heatScore: h.heatScore,
    compositeScore: h.compositeScore || 0,
    platforms: (h.platforms as string[]) || [],
  }));

  const trend = computeTrendLabel(keyword, historyData);

  return { keyword, history: historyData, trend };
}

/**
 * 获取全量趋势报告（Top关键词的趋势分析）
 */
export async function getTrendReport(
  tenantId: string,
  limit: number = 100
): Promise<TrendReport> {
  const today = new Date().toISOString().split("T")[0];
  const day30Ago = new Date();
  day30Ago.setDate(day30Ago.getDate() - 30);
  const day30Str = day30Ago.toISOString().split("T")[0];

  // 获取最近30天有记录的关键词（按最新综合分排序取top N）
  const topKeywords = await db
    .select()
    .from(keywords)
    .where(
      and(
        eq(keywords.tenantId, tenantId),
        eq(keywords.status, "active")
      )
    )
    .orderBy(desc(keywords.compositeScore))
    .limit(limit);

  // 批量获取这些关键词的30天历史
  const keywordNames = topKeywords.map((k) => k.keyword);

  const allHistory = keywordNames.length > 0
    ? await db
        .select()
        .from(keywordHistory)
        .where(
          and(
            eq(keywordHistory.tenantId, tenantId),
            gte(keywordHistory.snapshotDate, day30Str),
            sql`${keywordHistory.keyword} = ANY(${keywordNames})`
          )
        )
        .orderBy(keywordHistory.snapshotDate)
    : [];

  // 按关键词分组
  const historyMap = new Map<string, typeof allHistory>();
  for (const h of allHistory) {
    const key = h.keyword.toLowerCase();
    if (!historyMap.has(key)) historyMap.set(key, []);
    historyMap.get(key)!.push(h);
  }

  // 计算每个关键词的趋势
  const trendLabels: TrendLabel[] = [];

  for (const kw of topKeywords) {
    const history = historyMap.get(kw.keyword.toLowerCase()) || [];
    const historyData = history.map((h) => ({
      date: String(h.snapshotDate),
      heatScore: h.heatScore,
      compositeScore: h.compositeScore || 0,
      platforms: (h.platforms as string[]) || [],
    }));

    const trend = computeTrendLabel(kw.keyword, historyData, kw);
    trendLabels.push(trend);
  }

  // 分类
  const report: TrendReport = {
    date: today,
    exploding: trendLabels.filter((t) => t.trend === "exploding"),
    rising: trendLabels.filter((t) => t.trend === "rising"),
    stable: trendLabels.filter((t) => t.trend === "stable"),
    cooling: trendLabels.filter((t) => t.trend === "cooling"),
    newKeywords: trendLabels.filter((t) => t.trend === "new"),
  };

  logger.info(
    {
      date: today,
      total: trendLabels.length,
      exploding: report.exploding.length,
      rising: report.rising.length,
      new: report.newKeywords.length,
    },
    "📈 关键词趋势报告生成完成"
  );

  return report;
}

// ========== 内部工具函数 ==========

function computeTrendLabel(
  keyword: string,
  history: { date: string; heatScore: number; compositeScore: number; platforms: string[] }[],
  kwRecord?: any
): TrendLabel {
  const now = new Date();
  const day7Ago = new Date();
  day7Ago.setDate(now.getDate() - 7);
  const day7Str = day7Ago.toISOString().split("T")[0];

  // 分出 7天内 vs 7天前的数据
  const recent7d = history.filter((h) => h.date >= day7Str);
  const older = history.filter((h) => h.date < day7Str);

  // 7天 sparkline
  const sparkline: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const point = recent7d.find((h) => h.date === dateStr);
    sparkline.push(point ? point.compositeScore : 0);
  }

  const avgScore7d =
    recent7d.length > 0
      ? recent7d.reduce((s, h) => s + h.compositeScore, 0) / recent7d.length
      : 0;
  const avgScore30d =
    history.length > 0
      ? history.reduce((s, h) => s + h.compositeScore, 0) / history.length
      : 0;
  const avgOlder =
    older.length > 0
      ? older.reduce((s, h) => s + h.compositeScore, 0) / older.length
      : 0;

  const currentScore = recent7d.length > 0 ? recent7d[recent7d.length - 1].compositeScore : 0;

  // 计算变化率
  let score7d = 0;
  if (avgOlder > 0) {
    score7d = ((avgScore7d - avgOlder) / avgOlder) * 100;
  } else if (avgScore7d > 0) {
    score7d = 999; // 从无到有
  }

  const day14Ago = new Date();
  day14Ago.setDate(now.getDate() - 14);
  const day14Str = day14Ago.toISOString().split("T")[0];
  const older30d = history.filter((h) => h.date < day14Str);
  const avgOlder30d =
    older30d.length > 0
      ? older30d.reduce((s, h) => s + h.compositeScore, 0) / older30d.length
      : 0;
  let score30d = 0;
  if (avgOlder30d > 0) {
    score30d = ((avgScore30d - avgOlder30d) / avgOlder30d) * 100;
  } else if (avgScore30d > 0) {
    score30d = 999;
  }

  // 计算首次出现天数
  const firstSeenDaysAgo = kwRecord?.firstSeenAt
    ? Math.floor((now.getTime() - new Date(kwRecord.firstSeenAt).getTime()) / (86400000))
    : history.length > 0
    ? Math.floor((now.getTime() - new Date(history[0].date).getTime()) / (86400000))
    : 0;

  // 趋势标签
  let trend: TrendLabel["trend"] = "stable";
  if (firstSeenDaysAgo <= 3 && history.length <= 3) {
    trend = "new";
  } else if (score7d >= 200) {
    trend = "exploding";
  } else if (score7d >= 50) {
    trend = "rising";
  } else if (score7d <= -30) {
    trend = "cooling";
  }

  // 获取当前平台
  const latestPlatforms = recent7d.length > 0
    ? (recent7d[recent7d.length - 1].platforms || [])
    : [];

  return {
    keyword,
    trend,
    score7d: Math.round(score7d * 10) / 10,
    score30d: Math.round(score30d * 10) / 10,
    currentScore,
    avgScore7d: Math.round(avgScore7d * 10) / 10,
    avgScore30d: Math.round(avgScore30d * 10) / 10,
    sparkline,
    platforms: latestPlatforms,
    category: kwRecord?.category || null,
    firstSeenDaysAgo,
  };
}
