/**
 * Agent 2：关键词分析智能体
 *
 * 职责：
 * 1. 接收 Agent 1 的原始热点数据
 * 2. 去重 + 跨平台合并
 * 3. 行业相关性过滤
 * 4. 计算综合热度分
 * 5. 与历史关键词库交叉比对
 * 6. 输出今日关键词报告
 */

import { db } from "../../models/db.js";
import { keywords } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { eq, and, gte, sql } from "drizzle-orm";
import type { CrawlerResult } from "../crawler/types.js";

// 学术/期刊行业相关关键词 - 用于过滤
const INDUSTRY_KEYWORDS = [
  "论文", "期刊", "SCI", "SSCI", "EI", "核心", "发表", "投稿",
  "审稿", "影响因子", "分区", "学术", "研究", "科研", "博士",
  "硕士", "导师", "学位", "基金", "课题", "综述", "实验",
  "医学", "临床", "教育", "工程", "管理", "经济", "法学",
  "心理", "生物", "化学", "物理", "计算机", "人工智能", "AI",
  "大数据", "碳中和", "新能源", "量子", "芯片", "半导体",
  "考研", "考博", "保研", "高校", "大学", "院校",
  "Nature", "Science", "Lancet", "Cell", "JAMA", "BMJ",
  "预警", "降区", "黑名单", "撤稿", "学术不端", "查重",
  "中科院", "JCR", "LetPub", "知网", "万方", "维普",
];

interface AnalyzedKeyword {
  keyword: string;
  platforms: string[];
  totalHeatScore: number;
  compositeScore: number;
  category: string | null;
  isIndustryRelated: boolean;
}

interface KeywordReport {
  date: string;
  totalRawItems: number;
  afterDedup: number;
  industryRelated: number;
  topKeywords: AnalyzedKeyword[];
  newKeywords: string[];       // 今天新出现的
  sustainedKeywords: string[]; // 持续热门的（连续出现3天+）
}

/**
 * 分析原始热点数据，生成今日关键词报告
 */
export async function analyzeKeywords(
  crawlerResults: CrawlerResult[],
  tenantId: string
): Promise<KeywordReport> {
  const today = new Date().toISOString().split("T")[0];
  const totalRawItems = crawlerResults.reduce(
    (sum, r) => sum + r.items.length,
    0
  );

  logger.info(
    { totalRawItems, platforms: crawlerResults.length },
    "🔍 Agent 2 启动：开始关键词分析"
  );

  // Step 1: 去重 + 跨平台合并
  const keywordMap = new Map<string, AnalyzedKeyword>();

  for (const result of crawlerResults) {
    if (!result.success) continue;

    for (const item of result.items) {
      const normalized = item.keyword.trim().toLowerCase();
      const existing = keywordMap.get(normalized);

      if (existing) {
        // 合并：累加热度，记录平台来源
        existing.totalHeatScore += item.heatScore;
        if (!existing.platforms.includes(item.platform)) {
          existing.platforms.push(item.platform);
        }
      } else {
        keywordMap.set(normalized, {
          keyword: item.keyword.trim(), // 保留原始大小写
          platforms: [item.platform],
          totalHeatScore: item.heatScore,
          compositeScore: 0,
          category: null,
          isIndustryRelated: false,
        });
      }
    }
  }

  const afterDedup = keywordMap.size;

  // Step 2: 行业相关性过滤 + 分类
  for (const [, item] of keywordMap) {
    item.isIndustryRelated = checkIndustryRelevance(item.keyword);
    item.category = inferCategory(item.keyword);
  }

  // Step 3: 计算综合热度分
  // 跨平台出现的权重更高（每多出现一个平台，权重 ×1.5）
  for (const [, item] of keywordMap) {
    const platformMultiplier = 1 + (item.platforms.length - 1) * 0.5;
    item.compositeScore = item.totalHeatScore * platformMultiplier;
  }

  // Step 4: 按综合分排序，取 TOP 50
  const allKeywords = Array.from(keywordMap.values());
  allKeywords.sort((a, b) => b.compositeScore - a.compositeScore);

  const industryRelated = allKeywords.filter((k) => k.isIndustryRelated);
  const topKeywords = allKeywords.slice(0, 50);

  // Step 5: 入库 + 与历史比对
  const newKeywords: string[] = [];
  const sustainedKeywords: string[] = [];

  for (const kw of topKeywords) {
    try {
      // 检查是否已存在（同租户、同关键词）
      const existing = await db
        .select()
        .from(keywords)
        .where(
          and(
            eq(keywords.tenantId, tenantId),
            sql`LOWER(${keywords.keyword}) = LOWER(${kw.keyword})`
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // 已存在 → 更新热度和出现次数
        const record = existing[0];
        const newAppearCount = (record.appearCount || 0) + 1;

        await db
          .update(keywords)
          .set({
            heatScore: kw.totalHeatScore,
            compositeScore: kw.compositeScore,
            lastSeenAt: new Date(),
            appearCount: newAppearCount,
            category: kw.category || record.category,
          })
          .where(eq(keywords.id, record.id));

        if (newAppearCount >= 3) {
          sustainedKeywords.push(kw.keyword);
        }
      } else {
        // 新关键词 → 插入
        await db.insert(keywords).values({
          tenantId,
          keyword: kw.keyword,
          sourcePlatform: kw.platforms[0],
          heatScore: kw.totalHeatScore,
          compositeScore: kw.compositeScore,
          category: kw.category,
          crawlDate: today,
          metadata: {
            platforms: kw.platforms,
            isIndustryRelated: kw.isIndustryRelated,
          },
        });

        newKeywords.push(kw.keyword);
      }
    } catch (err) {
      logger.error(
        { keyword: kw.keyword, error: err },
        "关键词入库失败"
      );
    }
  }

  const report: KeywordReport = {
    date: today,
    totalRawItems,
    afterDedup,
    industryRelated: industryRelated.length,
    topKeywords,
    newKeywords,
    sustainedKeywords,
  };

  logger.info(
    {
      date: today,
      totalRaw: totalRawItems,
      deduped: afterDedup,
      industryHits: industryRelated.length,
      newCount: newKeywords.length,
      sustainedCount: sustainedKeywords.length,
    },
    "🔍 Agent 2 完成：关键词分析结束"
  );

  return report;
}

/**
 * 检查关键词是否与行业相关
 */
function checkIndustryRelevance(keyword: string): boolean {
  const lower = keyword.toLowerCase();
  return INDUSTRY_KEYWORDS.some(
    (ik) => lower.includes(ik.toLowerCase())
  );
}

/**
 * 推断学科分类（简单规则匹配，后续可用AI分类器替代）
 */
function inferCategory(keyword: string): string | null {
  const lower = keyword.toLowerCase();

  const categoryMap: Record<string, string[]> = {
    medicine: ["医学", "临床", "药物", "基因", "细胞", "肿瘤", "心血管", "神经", "免疫", "Lancet", "JAMA", "BMJ"],
    education: ["教育", "教学", "课程", "学生", "教师", "高考", "考研", "保研", "高校"],
    engineering: ["工程", "机械", "材料", "能源", "建筑", "制造", "自动化"],
    computer: ["计算机", "人工智能", "AI", "机器学习", "深度学习", "大数据", "算法", "软件"],
    economics: ["经济", "金融", "管理", "会计", "市场", "贸易", "投资"],
    law: ["法学", "法律", "司法", "立法", "宪法"],
    psychology: ["心理", "认知", "行为", "心理健康"],
    biology: ["生物", "生态", "进化", "遗传", "分子"],
    chemistry: ["化学", "催化", "合成", "分子", "材料"],
    physics: ["物理", "量子", "光学", "半导体", "芯片"],
  };

  for (const [cat, terms] of Object.entries(categoryMap)) {
    if (terms.some((t) => lower.includes(t.toLowerCase()))) {
      return cat;
    }
  }

  return null;
}

/**
 * 获取今日关键词报告（从数据库）
 */
export async function getTodayKeywords(
  tenantId: string,
  limit = 50
) {
  const today = new Date().toISOString().split("T")[0];

  const results = await db
    .select()
    .from(keywords)
    .where(
      and(
        eq(keywords.tenantId, tenantId),
        gte(keywords.lastSeenAt, new Date(today))
      )
    )
    .orderBy(sql`${keywords.compositeScore} DESC`)
    .limit(limit);

  return results;
}

/**
 * 获取所有关键词（分页 + 筛选）
 */
export async function getKeywords(
  tenantId: string,
  options: {
    page?: number;
    pageSize?: number;
    platform?: string;
    category?: string;
    status?: string;
  } = {}
) {
  const {
    page = 1,
    pageSize = 50,
    platform,
    category,
    status = "active",
  } = options;

  const conditions = [eq(keywords.tenantId, tenantId)];

  if (platform) conditions.push(eq(keywords.sourcePlatform, platform));
  if (category) conditions.push(eq(keywords.category, category));
  if (status) conditions.push(eq(keywords.status, status));

  const results = await db
    .select()
    .from(keywords)
    .where(and(...conditions))
    .orderBy(sql`${keywords.compositeScore} DESC`)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // 总数
  const countResult = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(keywords)
    .where(and(...conditions));

  return {
    items: results,
    total: Number(countResult[0]?.count || 0),
    page,
    pageSize,
  };
}
