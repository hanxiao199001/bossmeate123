/**
 * Agent 2：关键词分析智能体 —— 期刊行业专用版
 *
 * 职责：
 * 1. 接收 Agent 1 的原始热点数据
 * 2. 去重 + 跨平台合并
 * 3. 严格行业相关性过滤（只保留期刊代发行业相关的）
 * 4. 计算综合热度分
 * 5. 与历史关键词库交叉比对
 * 6. 输出今日关键词报告
 *
 * 核心原则：宁可漏掉，不要混入无关内容
 */

import { db } from "../../models/db.js";
import { keywords } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { eq, and, gte, sql } from "drizzle-orm";
import type { CrawlerResult } from "../crawler/types.js";
import { getActiveWords, incrementHitCounts } from "./keyword-dictionary.js";
import { takeKeywordSnapshot } from "./keyword-trend.js";

// ========== 动态词库缓存（避免每次分析都查库）==========

let cachedWords: { primary: string[]; secondary: string[]; context: string[] } | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 硬编码 fallback（首次未初始化词库时使用）
const FALLBACK_PRIMARY = [
  "SCI", "SSCI", "EI", "CSCD", "CSSCI", "核心期刊", "北大核心", "南大核心",
  "学报", "期刊", "杂志", "影响因子", "IF", "分区", "JCR", "中科院分区",
  "期刊预警", "降区", "升区", "论文发表", "投稿", "审稿", "拒稿", "退修",
  "录用", "见刊", "检索", "论文代发", "论文润色", "英文润色", "选刊", "期刊推荐",
  "查重", "重复率", "学术不端", "撤稿", "知网", "万方", "维普",
  "LetPub", "小木虫", "Sci-Hub", "PubMed", "Web of Science", "WOS",
  "Google Scholar", "中国知网", "CNKI", "考研", "考博", "保研", "硕士", "博士",
  "导师", "学位论文", "开题", "答辩", "毕业论文", "国自然", "基金申请", "课题申报",
  "项目申请", "科研经费", "SCI写作", "论文写作", "文献综述", "Meta分析", "系统综述",
  "实验设计", "统计分析", "SPSS", "R语言",
];
const FALLBACK_SECONDARY = [
  "论文", "发表", "科研", "学术", "研究", "高校", "大学", "教授",
  "学科", "专业", "医学", "工程", "教育", "经济", "管理",
  "Nature", "Science", "Lancet", "Cell", "JAMA", "BMJ", "IEEE",
  "Springer", "Elsevier", "Wiley", "OA", "开放获取", "预印本", "arXiv",
  "临床", "实验", "样本", "数据", "模型", "算法",
];
const FALLBACK_CONTEXT = [
  "论文", "期刊", "发表", "投稿", "审稿", "引用", "索引", "检索",
  "研究", "学术", "科研", "课题", "基金", "实验", "数据",
  "综述", "分析", "方法", "结果", "结论",
];

/**
 * 获取词库（带缓存），如果数据库词库为空则用 fallback
 */
async function getWordLists(tenantId: string) {
  if (cachedWords && Date.now() < cacheExpiry) {
    return cachedWords;
  }

  try {
    const words = await getActiveWords(tenantId);
    if (words.primary.length > 0) {
      cachedWords = words;
      cacheExpiry = Date.now() + CACHE_TTL;
      return words;
    }
  } catch (err) {
    logger.warn({ error: err }, "获取动态词库失败，使用 fallback");
  }

  // Fallback 到硬编码
  return {
    primary: FALLBACK_PRIMARY,
    secondary: FALLBACK_SECONDARY,
    context: FALLBACK_CONTEXT,
  };
}

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
  newKeywords: string[];
  sustainedKeywords: string[];
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
    (sum, r) => sum + r.keywords.length + r.journals.length,
    0
  );

  logger.info(
    { totalRawItems, platforms: crawlerResults.length },
    "🔍 Agent 2 启动：开始关键词分析（期刊行业专用）"
  );

  // Step 1: 按平台收集原始分数（用于归一化）
  const platformScores = new Map<string, number[]>();

  for (const result of crawlerResults) {
    if (!result.success) continue;
    const scores: number[] = [];
    for (const item of result.keywords) scores.push(item.heatScore);
    for (const journal of result.journals) scores.push(journal.annualVolume || journal.impactFactor || 100);
    if (scores.length > 0) platformScores.set(result.platform, scores);
  }

  // 计算每个平台的 max 值，用于归一化到 0-100
  const platformMax = new Map<string, number>();
  for (const [platform, scores] of platformScores) {
    platformMax.set(platform, Math.max(...scores, 1)); // 避免除以0
  }

  /** 将原始热度分归一化到 0-100 范围 */
  function normalizeScore(rawScore: number, platform: string): number {
    const max = platformMax.get(platform) || 1;
    return Math.round((rawScore / max) * 100);
  }

  // Step 2: 去重 + 跨平台合并（使用归一化分数）
  const keywordMap = new Map<string, AnalyzedKeyword>();

  for (const result of crawlerResults) {
    if (!result.success) continue;

    // 处理国内核心线的热词
    for (const item of result.keywords) {
      const normalized = item.keyword.trim().toLowerCase();
      const normScore = normalizeScore(item.heatScore, item.platform);
      const existing = keywordMap.get(normalized);

      if (existing) {
        existing.totalHeatScore += normScore;
        if (!existing.platforms.includes(item.platform)) {
          existing.platforms.push(item.platform);
        }
      } else {
        keywordMap.set(normalized, {
          keyword: item.keyword.trim(),
          platforms: [item.platform],
          totalHeatScore: normScore,
          compositeScore: 0,
          category: item.discipline || null,
          isIndustryRelated: true, // 国内核心线的关键词已经过定向搜索，默认行业相关
        });
      }
    }

    // 处理SCI线的期刊数据（将期刊名转为关键词入库）
    for (const journal of result.journals) {
      const normalized = journal.name.trim().toLowerCase();
      if (keywordMap.has(normalized)) continue;

      const rawScore = journal.annualVolume || journal.impactFactor || 100;
      const normScore = normalizeScore(rawScore, journal.platform);

      keywordMap.set(normalized, {
        keyword: journal.name.trim(),
        platforms: [journal.platform],
        totalHeatScore: normScore,
        compositeScore: 0,
        category: journal.discipline || null,
        isIndustryRelated: true, // SCI线的期刊数据本身就是行业数据
      });
    }
  }

  const afterDedup = keywordMap.size;

  // Step 3: 严格行业相关性过滤 + 分类（使用动态词库）
  const wordLists = await getWordLists(tenantId);
  const hitWords: string[] = []; // 记录命中的词，用于更新命中计数

  for (const [, item] of keywordMap) {
    const { isRelated, hitWord } = checkIndustryRelevanceDynamic(
      item.keyword,
      wordLists.primary,
      wordLists.secondary,
      wordLists.context
    );
    item.isIndustryRelated = isRelated;
    item.category = inferCategory(item.keyword);
    if (hitWord) hitWords.push(hitWord);
  }

  // Step 4: 计算综合热度分（跨平台权重更高）
  for (const [, item] of keywordMap) {
    const platformMultiplier = 1 + (item.platforms.length - 1) * 0.5;
    // 行业相关的权重 ×3
    const industryMultiplier = item.isIndustryRelated ? 3 : 1;
    item.compositeScore = item.totalHeatScore * platformMultiplier * industryMultiplier;
  }

  // Step 5: 只保留行业相关的关键词入库
  const allKeywords = Array.from(keywordMap.values());
  allKeywords.sort((a, b) => b.compositeScore - a.compositeScore);

  // 核心变更：只入库行业相关的关键词
  const industryKeywords = allKeywords.filter((k) => k.isIndustryRelated);
  const topKeywords = industryKeywords.slice(0, 100); // 最多入库100个

  // Step 6: 入库 + 与历史比对
  const newKeywords: string[] = [];
  const sustainedKeywords: string[] = [];

  for (const kw of topKeywords) {
    try {
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
    industryRelated: industryKeywords.length,
    topKeywords,
    newKeywords,
    sustainedKeywords,
  };

  logger.info(
    {
      date: today,
      totalRaw: totalRawItems,
      deduped: afterDedup,
      industryHits: industryKeywords.length,
      saved: topKeywords.length,
      newCount: newKeywords.length,
      sustainedCount: sustainedKeywords.length,
    },
    "🔍 Agent 2 完成：关键词分析结束（仅入库行业相关关键词）"
  );

  // Step 7: 写入每日快照（供趋势分析用）
  try {
    await takeKeywordSnapshot(tenantId);
  } catch (err) {
    logger.warn({ error: err }, "每日快照写入失败（不影响主流程）");
  }

  // Step 8: 更新动态词库命中计数
  try {
    await incrementHitCounts(tenantId, hitWords);
  } catch (err) {
    logger.warn({ error: err }, "词库命中计数更新失败（不影响主流程）");
  }

  return report;
}

/**
 * 使用动态词库检查关键词是否与期刊代发行业相关
 * 返回是否相关 + 命中的词（用于更新命中计数）
 */
function checkIndustryRelevanceDynamic(
  keyword: string,
  primaryWords: string[],
  secondaryWords: string[],
  contextWords: string[]
): { isRelated: boolean; hitWord: string | null } {
  const lower = keyword.toLowerCase();

  // 一级关键词：直接命中即相关
  const primaryHit = primaryWords.find((pk) => lower.includes(pk.toLowerCase()));
  if (primaryHit) {
    return { isRelated: true, hitWord: primaryHit };
  }

  // 二级关键词 + 学术语境 = 行业相关
  const secondaryHit = secondaryWords.find((sk) => lower.includes(sk.toLowerCase()));
  const contextHit = contextWords.some((ac) => lower.includes(ac.toLowerCase()));

  if (secondaryHit && contextHit) {
    return { isRelated: true, hitWord: secondaryHit };
  }

  // 特殊模式匹配（保留硬编码兜底）
  if (/期刊|学报|影响因子|分区|投稿|审稿|查重|发表/.test(lower)) {
    return { isRelated: true, hitWord: null };
  }

  // 学术数据源的关键词默认视为行业相关
  if (lower.includes("投稿热点") || lower.includes("热门方向") ||
      lower.includes("期刊：") || lower.includes("（if趋势）")) {
    return { isRelated: true, hitWord: null };
  }

  return { isRelated: false, hitWord: null };
}

/**
 * 推断学科分类
 */
function inferCategory(keyword: string): string | null {
  const lower = keyword.toLowerCase();

  const categoryMap: Record<string, string[]> = {
    medicine: [
      "医学", "临床", "药物", "基因", "细胞", "肿瘤", "心血管", "神经",
      "免疫", "护理", "康复", "外科", "内科", "中医", "药学",
      "Lancet", "JAMA", "BMJ", "PubMed", "pubmed",
    ],
    education: ["教育", "教学", "课程", "学生", "教师", "高考", "考研", "保研", "高校"],
    engineering: ["工程", "机械", "材料", "能源", "建筑", "制造", "自动化"],
    computer: ["计算机", "人工智能", "AI", "机器学习", "深度学习", "大数据", "算法", "软件"],
    economics: ["经济", "金融", "管理", "会计", "市场", "贸易", "投资"],
    law: ["法学", "法律", "司法", "立法"],
    psychology: ["心理", "认知", "行为", "心理健康"],
    biology: ["生物", "生态", "进化", "遗传", "分子", "微生物"],
    chemistry: ["化学", "催化", "合成", "材料"],
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
