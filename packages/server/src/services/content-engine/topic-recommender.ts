/**
 * 每日选题推荐引擎
 *
 * 数据来源：
 * 1. keyword_history 趋势数据（exploding/rising/new）
 * 2. journals 表匹配相关期刊
 * 3. AI 生成推荐理由
 *
 * 输出：每个租户的每日选题列表，存入 daily_recommendations 表
 */

import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals, dailyRecommendations, tenants, keywordHistory } from "../../models/schema.js";
import { eq, and, desc, or, ilike } from "drizzle-orm";
import { getTrendReport, type TrendLabel } from "../agents/keyword-trend.js";
import { chat } from "../ai/chat-service.js";
import { nanoid } from "nanoid";

// ============ 学科配置 ============

/** 所有可选学科 */
export const ALL_DISCIPLINES = [
  { code: "medicine", label: "医学" },
  { code: "education", label: "教育" },
  { code: "economics", label: "经济管理" },
  { code: "engineering", label: "工程技术" },
  { code: "computer", label: "计算机" },
  { code: "agriculture", label: "农林" },
  { code: "environment", label: "环境科学" },
  { code: "law", label: "法学" },
  { code: "psychology", label: "心理学" },
  { code: "biology", label: "生物" },
  { code: "chemistry", label: "化学" },
  { code: "physics", label: "物理" },
] as const;

/** 学科 → 受众和标题模板 */
const DISCIPLINE_TEMPLATES: Record<string, { audience: string; titleSuffix: string }> = {
  medicine:    { audience: "医学从业者及科研工作者", titleSuffix: "最新研究进展与临床应用" },
  education:   { audience: "教育工作者及高校教师", titleSuffix: "研究现状与教学应用" },
  economics:   { audience: "经济管理领域研究者", titleSuffix: "发展趋势与实践启示" },
  engineering: { audience: "工程技术领域研究人员", titleSuffix: "技术进展与应用前景" },
  computer:    { audience: "计算机及AI领域研究者", titleSuffix: "算法进展与应用探索" },
  agriculture: { audience: "农林科学研究人员", titleSuffix: "研究进展与产业应用" },
  environment: { audience: "环境科学领域学者", titleSuffix: "研究动态与政策启示" },
  law:         { audience: "法学研究者及法律从业者", titleSuffix: "理论探讨与制度完善" },
  psychology:  { audience: "心理学研究者及从业者", titleSuffix: "研究发现与干预策略" },
  biology:     { audience: "生物学科研究人员", titleSuffix: "前沿发现与机制解析" },
  chemistry:   { audience: "化学领域研究者", titleSuffix: "合成方法与应用研究" },
  physics:     { audience: "物理学科研究人员", titleSuffix: "理论突破与实验验证" },
};
const DEFAULT_TEMPLATE = { audience: "学术研究者及科研工作者", titleSuffix: "研究进展与发展趋势" };

// ============ 类型 ============

export interface TopicRecommendation {
  id: string;
  rank: number;
  keyword: string;
  trend: "exploding" | "rising" | "new" | "stable";
  trendScore: number;
  heatChange: string;
  relatedJournals: Array<{
    name: string;
    impactFactor: number | null;
    partition: string | null;
  }>;
  latestResearch?: {
    title: string;
    journal: string;
    pmid: string;
  };
  reason: string;
  createParams: {
    topic: string;
    keywords: string[];
    suggestedTitle: string;
    suggestedAudience: string;
    suggestedWordCount: number;
  };
}

export interface DailyRecommendationReport {
  date: string;
  tenantId: string;
  recommendations: TopicRecommendation[];
  generatedAt: string;
}

// ============ 核心 ============

export async function generateDailyRecommendations(
  tenantId: string
): Promise<DailyRecommendationReport> {
  const today = new Date().toISOString().slice(0, 10);
  logger.info({ tenantId, date: today }, "开始生成每日选题推荐");

  // 检查今天是否已生成
  const existing = await db
    .select()
    .from(dailyRecommendations)
    .where(
      and(
        eq(dailyRecommendations.tenantId, tenantId),
        eq(dailyRecommendations.date, today)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return {
      date: today,
      tenantId,
      recommendations: existing[0].recommendations as TopicRecommendation[],
      generatedAt: existing[0].generatedAt?.toISOString() || new Date().toISOString(),
    };
  }

  // Step 1: 读取租户学科偏好配置
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const tenantConfig = (tenant?.config || {}) as Record<string, any>;
  const automationConfig = tenantConfig.automationConfig || {};
  // focusDisciplines: 用户配置的关注学科列表，空数组 = 全学科
  const focusDisciplines: string[] = automationConfig.focusDisciplines || [];

  // Step 2: 获取趋势数据
  const trendReport = await getTrendReport(tenantId);

  let allCandidates = [
    ...trendReport.exploding.map((t) => ({ ...t, priority: 3 })),
    ...trendReport.rising.map((t) => ({ ...t, priority: 2 })),
    ...trendReport.newKeywords.map((t) => ({ ...t, priority: 1 })),
  ]
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.currentScore - a.currentScore;
    });

  // Fallback: 首日冷启动，无跨天对比数据 → 取当天 keyword_history heat_score 前 20
  // 触发条件：trendReport 三个分类合计为 0（意味着 keyword_history 只有 1 天快照，无法算 score7d）
  if (allCandidates.length === 0) {
    const seedRows = await db
      .select()
      .from(keywordHistory)
      .where(
        and(
          eq(keywordHistory.tenantId, tenantId),
          eq(keywordHistory.snapshotDate, today)
        )
      )
      .orderBy(desc(keywordHistory.heatScore))
      .limit(20);

    if (seedRows.length > 0) {
      logger.info(
        { tenantId, date: today, count: seedRows.length },
        "首日冷启动：用当天 keyword_history heat_score 前 20 作候选"
      );
      allCandidates = seedRows.map((k) => ({
        keyword: k.keyword,
        trend: "new" as const,
        score7d: 0,
        score30d: 0,
        currentScore: k.heatScore ?? 0,
        avgScore7d: k.heatScore ?? 0,
        avgScore30d: k.heatScore ?? 0,
        sparkline: [k.heatScore ?? 0],
        platforms: (k.platforms as string[]) ?? [],
        category: k.category ?? null,
        firstSeenDaysAgo: 0,
        priority: 1,
      }));
    }
  }

  // Step 3: 按学科偏好过滤
  let filteredCandidates = allCandidates;
  if (focusDisciplines.length > 0) {
    filteredCandidates = allCandidates.filter((t) => {
      const cat = t.category || inferCategoryFromKeyword(t.keyword);
      return !cat || focusDisciplines.includes(cat);
    });
    // 如果过滤后太少，补充未分类的
    if (filteredCandidates.length < 5) {
      const uncategorized = allCandidates.filter((t) => !t.category && !inferCategoryFromKeyword(t.keyword));
      filteredCandidates = [...filteredCandidates, ...uncategorized];
    }
  }

  // Step 4: 学科均衡分配（每个学科保证至少1-2个名额）
  const hotTopics = balancedSelect(filteredCandidates, 10);

  if (hotTopics.length === 0) {
    // 没有趋势数据，返回空推荐
    const emptyReport: DailyRecommendationReport = {
      date: today,
      tenantId,
      recommendations: [],
      generatedAt: new Date().toISOString(),
    };

    await db.insert(dailyRecommendations).values({
      tenantId,
      date: today,
      recommendations: [],
    }).onConflictDoNothing();

    return emptyReport;
  }

  // Step 5: 为每个热词匹配期刊 + 生成学科适配的标题和受众
  const recommendations: TopicRecommendation[] = [];

  for (let i = 0; i < hotTopics.length; i++) {
    const topic = hotTopics[i];
    const discipline = extractDiscipline(topic.keyword);
    const categoryCode = topic.category || inferCategoryFromKeyword(topic.keyword) || "general";
    const template = DISCIPLINE_TEMPLATES[categoryCode] || DEFAULT_TEMPLATE;

    // 先查本租户期刊，如果没有则查全局期刊
    let matchedJournals = await db
      .select()
      .from(journals)
      .where(
        and(
          eq(journals.tenantId, tenantId),
          or(
            ilike(journals.discipline, `%${discipline}%`),
            ilike(journals.name, `%${topic.keyword}%`)
          )
        )
      )
      .orderBy(desc(journals.impactFactor))
      .limit(3);

    if (matchedJournals.length === 0) {
      // Fallback: 查全局期刊（跨租户）
      matchedJournals = await db
        .select()
        .from(journals)
        .where(
          or(
            ilike(journals.discipline, `%${discipline}%`),
            ilike(journals.name, `%${topic.keyword}%`)
          )
        )
        .orderBy(desc(journals.impactFactor))
        .limit(3);
    }

    const heatChange =
      topic.score7d > 0
        ? `↑${Math.round(topic.score7d)}%`
        : topic.score7d < 0
          ? `↓${Math.abs(Math.round(topic.score7d))}%`
          : "→";

    recommendations.push({
      id: nanoid(12),
      rank: i + 1,
      keyword: topic.keyword,
      trend: topic.trend as TopicRecommendation["trend"],
      trendScore: topic.currentScore,
      heatChange,
      relatedJournals: matchedJournals.map((j) => ({
        name: j.name,
        impactFactor: j.impactFactor,
        partition: j.partition,
      })),
      reason: "", // 后面 AI 填充
      createParams: {
        topic: topic.keyword,
        keywords: [topic.keyword, ...(topic.platforms || [])],
        suggestedTitle: `${topic.keyword}：${template.titleSuffix}`,
        suggestedAudience: template.audience,
        suggestedWordCount: 1200,
      },
    });
  }

  // Step 3: AI 批量生成推荐理由
  try {
    const reasonPrompt = recommendations
      .map(
        (r, i) =>
          `${i + 1}. "${r.keyword}"（趋势：${r.trend}，7天变化：${r.heatChange}），相关期刊：${r.relatedJournals.map((j) => j.name).join("、") || "无"}`
      )
      .join("\n");

    const aiResult = await chat({
      tenantId,
      userId: "system",
      conversationId: "topic-recommend",
      message: `你是学术期刊选题顾问。为以下每个关键词生成一句话推荐理由（20字以内），说明为什么今天值得写这个主题。\n\n${reasonPrompt}\n\n每行输出格式：序号|理由`,
      skillType: "daily_chat",
    });

    const lines = aiResult.content.split("\n").filter((l) => l.includes("|"));
    for (const line of lines) {
      const parts = line.split("|");
      const idx = parseInt(parts[0]) - 1;
      if (idx >= 0 && idx < recommendations.length && parts[1]) {
        recommendations[idx].reason = parts[1].trim();
      }
    }
  } catch (err) {
    logger.warn({ err }, "AI 推荐理由生成失败");
  }

  // 没有 AI 理由的用默认值
  for (const rec of recommendations) {
    if (!rec.reason) {
      rec.reason =
        rec.trend === "exploding"
          ? "热度暴涨，抓紧追热点"
          : rec.trend === "rising"
            ? "持续升温，值得关注"
            : "新出现话题，抢先布局";
    }
  }

  // Step 4: 存入数据库（upsert 防止重复）
  await db.insert(dailyRecommendations).values({
    tenantId,
    date: today,
    recommendations: recommendations as any,
  }).onConflictDoUpdate({
    target: [dailyRecommendations.tenantId, dailyRecommendations.date],
    set: {
      recommendations: recommendations as any,
      generatedAt: new Date(),
    },
  });

  const report: DailyRecommendationReport = {
    date: today,
    tenantId,
    recommendations,
    generatedAt: new Date().toISOString(),
  };

  logger.info(
    { tenantId, date: today, count: recommendations.length },
    "每日选题推荐生成完成"
  );

  return report;
}

/**
 * 获取今日推荐（如果还没生成则自动生成）
 */
export async function getTodayRecommendations(
  tenantId: string
): Promise<DailyRecommendationReport> {
  return generateDailyRecommendations(tenantId);
}

/**
 * 获取历史推荐
 */
export async function getRecommendationHistory(
  tenantId: string,
  days: number = 7
): Promise<DailyRecommendationReport[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select()
    .from(dailyRecommendations)
    .where(eq(dailyRecommendations.tenantId, tenantId))
    .orderBy(desc(dailyRecommendations.date))
    .limit(days);

  return rows.map((r) => ({
    date: r.date,
    tenantId: r.tenantId,
    recommendations: r.recommendations as TopicRecommendation[],
    generatedAt: r.generatedAt?.toISOString() || "",
  }));
}

// ============ 工具 ============

function extractDiscipline(keyword: string): string {
  const disciplineMap: Record<string, string> = {
    "糖尿": "医学", "高血压": "医学", "肿瘤": "医学", "癌": "医学",
    "心血管": "医学", "神经": "医学", "免疫": "医学", "药": "医学",
    "临床": "医学", "护理": "医学", "中医": "医学",
    "教育": "教育", "教学": "教育", "课程": "教育", "学生": "教育",
    "高考": "教育", "考研": "教育",
    "AI": "计算机", "机器学习": "计算机", "深度学习": "计算机",
    "算法": "计算机", "人工智能": "计算机",
    "环境": "环境科学", "污染": "环境科学", "碳": "环境科学", "生态": "环境科学",
    "材料": "工程技术", "纳米": "工程技术", "机械": "工程技术",
    "经济": "经济管理", "管理": "经济管理", "金融": "经济管理",
    "农": "农林科学", "作物": "农林科学", "土壤": "农林科学",
    "能源": "工程技术", "电池": "工程技术", "光伏": "工程技术",
    "法学": "法学", "法律": "法学",
    "心理": "心理学",
    "生物": "生物", "基因": "生物", "细胞": "生物",
    "化学": "化学", "催化": "化学",
    "物理": "物理", "量子": "物理",
  };

  for (const [key, discipline] of Object.entries(disciplineMap)) {
    if (keyword.includes(key)) return discipline;
  }
  return keyword;
}

/**
 * 从关键词推断学科分类代码（与 keyword-analyzer.ts 的 inferCategory 对齐）
 */
function inferCategoryFromKeyword(keyword: string): string | null {
  const lower = keyword.toLowerCase();
  const categoryMap: Record<string, string[]> = {
    medicine: ["医学", "临床", "药", "基因", "细胞", "肿瘤", "心血管", "神经", "免疫", "护理", "中医", "康复", "糖尿", "lancet", "jama", "bmj", "pubmed"],
    education: ["教育", "教学", "课程", "学生", "教师", "高考", "考研", "保研", "高校"],
    economics: ["经济", "金融", "管理", "会计", "市场", "贸易"],
    engineering: ["工程", "机械", "材料", "能源", "建筑", "自动化", "电气"],
    computer: ["计算机", "人工智能", "ai", "机器学习", "深度学习", "大数据", "算法"],
    agriculture: ["农", "畜牧", "水产", "食品", "园艺", "作物", "土壤"],
    environment: ["环境", "污染", "生态", "碳", "气候"],
    law: ["法学", "法律", "司法"],
    psychology: ["心理", "认知", "行为"],
    biology: ["生物", "遗传", "分子", "微生物", "进化"],
    chemistry: ["化学", "催化", "合成"],
    physics: ["物理", "量子", "光学", "半导体"],
  };

  for (const [cat, terms] of Object.entries(categoryMap)) {
    if (terms.some((t) => lower.includes(t))) return cat;
  }
  return null;
}

/**
 * 学科均衡选择算法
 *
 * 策略：先每个学科各取1个最强的（保底），再从剩余池按分数排序补满总数。
 * 类似高考分省录取：每省至少有名额，剩余按分数全国竞争。
 */
function balancedSelect(
  candidates: Array<TrendLabel & { priority: number }>,
  maxTotal: number
): Array<TrendLabel & { priority: number }> {
  if (candidates.length <= maxTotal) return candidates;

  // 按学科分组
  const byCategory = new Map<string, Array<TrendLabel & { priority: number }>>();
  const uncategorized: Array<TrendLabel & { priority: number }> = [];

  for (const c of candidates) {
    const cat = c.category || inferCategoryFromKeyword(c.keyword);
    if (cat) {
      const list = byCategory.get(cat) || [];
      list.push(c);
      byCategory.set(cat, list);
    } else {
      uncategorized.push(c);
    }
  }

  const selected = new Set<string>(); // 用 keyword 去重
  const result: Array<TrendLabel & { priority: number }> = [];

  // Round 1: 每个学科取1个最强的（保底名额）
  for (const [, items] of byCategory) {
    if (result.length >= maxTotal) break;
    // items 已经按 priority+score 排序（继承自上游排序）
    const best = items[0];
    if (best && !selected.has(best.keyword)) {
      result.push(best);
      selected.add(best.keyword);
    }
  }

  // Round 2: 剩余名额按分数全局竞争
  const remaining = [...candidates, ...uncategorized]
    .filter((c) => !selected.has(c.keyword))
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.currentScore - a.currentScore;
    });

  for (const c of remaining) {
    if (result.length >= maxTotal) break;
    if (!selected.has(c.keyword)) {
      result.push(c);
      selected.add(c.keyword);
    }
  }

  return result;
}
