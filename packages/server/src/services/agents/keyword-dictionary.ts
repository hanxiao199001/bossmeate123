/**
 * 动态行业关键词词库管理服务
 *
 * 替代 keyword-analyzer.ts 中硬编码的 PRIMARY_KEYWORDS / SECONDARY_KEYWORDS / ACADEMIC_CONTEXT
 *
 * 功能：
 * 1. 词库 CRUD（运营后台可增删改查）
 * 2. 初始化预置词库（从硬编码迁移为数据库记录）
 * 3. 提供 getActiveWords() 给 analyzer 调用
 * 4. 命中计数（自动学习哪些词更有效）
 */

import { db } from "../../models/db.js";
import { industryKeywords } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { eq, and, sql } from "drizzle-orm";

// ========== 类型定义 ==========

export interface IndustryWord {
  id: string;
  word: string;
  level: "primary" | "secondary" | "context";
  category: string | null;
  weight: number;
  isSystem: boolean;
  isActive: boolean;
  source: string;
  hitCount: number;
}

export interface WordFilter {
  level?: string;
  category?: string;
  isActive?: boolean;
  source?: string;
}

// ========== 预置词库（从硬编码迁移）==========

const PRESET_PRIMARY: { word: string; category: string }[] = [
  // 期刊类型
  { word: "SCI", category: "期刊类型" },
  { word: "SSCI", category: "期刊类型" },
  { word: "EI", category: "期刊类型" },
  { word: "CSCD", category: "期刊类型" },
  { word: "CSSCI", category: "期刊类型" },
  { word: "核心期刊", category: "期刊类型" },
  { word: "北大核心", category: "期刊类型" },
  { word: "南大核心", category: "期刊类型" },
  { word: "学报", category: "期刊类型" },
  { word: "期刊", category: "期刊类型" },
  { word: "杂志", category: "期刊类型" },
  // 期刊指标
  { word: "影响因子", category: "期刊指标" },
  { word: "IF", category: "期刊指标" },
  { word: "分区", category: "期刊指标" },
  { word: "JCR", category: "期刊指标" },
  { word: "中科院分区", category: "期刊指标" },
  { word: "期刊预警", category: "期刊指标" },
  { word: "降区", category: "期刊指标" },
  { word: "升区", category: "期刊指标" },
  // 发表相关
  { word: "论文发表", category: "发表相关" },
  { word: "投稿", category: "发表相关" },
  { word: "审稿", category: "发表相关" },
  { word: "拒稿", category: "发表相关" },
  { word: "退修", category: "发表相关" },
  { word: "录用", category: "发表相关" },
  { word: "见刊", category: "发表相关" },
  { word: "检索", category: "发表相关" },
  { word: "论文代发", category: "发表相关" },
  { word: "论文润色", category: "发表相关" },
  { word: "英文润色", category: "发表相关" },
  { word: "选刊", category: "发表相关" },
  { word: "期刊推荐", category: "发表相关" },
  // 查重/学术规范
  { word: "查重", category: "学术规范" },
  { word: "重复率", category: "学术规范" },
  { word: "学术不端", category: "学术规范" },
  { word: "撤稿", category: "学术规范" },
  { word: "知网", category: "学术工具" },
  { word: "万方", category: "学术工具" },
  { word: "维普", category: "学术工具" },
  // 学术工具/平台
  { word: "LetPub", category: "学术工具" },
  { word: "小木虫", category: "学术工具" },
  { word: "Sci-Hub", category: "学术工具" },
  { word: "PubMed", category: "学术工具" },
  { word: "Web of Science", category: "学术工具" },
  { word: "WOS", category: "学术工具" },
  { word: "Google Scholar", category: "学术工具" },
  { word: "中国知网", category: "学术工具" },
  { word: "CNKI", category: "学术工具" },
  // 升学/科研
  { word: "考研", category: "升学科研" },
  { word: "考博", category: "升学科研" },
  { word: "保研", category: "升学科研" },
  { word: "硕士", category: "升学科研" },
  { word: "博士", category: "升学科研" },
  { word: "导师", category: "升学科研" },
  { word: "学位论文", category: "升学科研" },
  { word: "开题", category: "升学科研" },
  { word: "答辩", category: "升学科研" },
  { word: "毕业论文", category: "升学科研" },
  // 基金/课题
  { word: "国自然", category: "基金课题" },
  { word: "基金申请", category: "基金课题" },
  { word: "课题申报", category: "基金课题" },
  { word: "项目申请", category: "基金课题" },
  { word: "科研经费", category: "基金课题" },
  // 学术写作
  { word: "SCI写作", category: "学术写作" },
  { word: "论文写作", category: "学术写作" },
  { word: "文献综述", category: "学术写作" },
  { word: "Meta分析", category: "学术写作" },
  { word: "系统综述", category: "学术写作" },
  { word: "实验设计", category: "学术写作" },
  { word: "统计分析", category: "学术写作" },
  { word: "SPSS", category: "学术写作" },
  { word: "R语言", category: "学术写作" },
];

const PRESET_SECONDARY: { word: string; category: string }[] = [
  { word: "论文", category: "通用学术" },
  { word: "发表", category: "通用学术" },
  { word: "科研", category: "通用学术" },
  { word: "学术", category: "通用学术" },
  { word: "研究", category: "通用学术" },
  { word: "高校", category: "通用学术" },
  { word: "大学", category: "通用学术" },
  { word: "教授", category: "通用学术" },
  { word: "学科", category: "通用学术" },
  { word: "专业", category: "通用学术" },
  { word: "医学", category: "学科方向" },
  { word: "工程", category: "学科方向" },
  { word: "教育", category: "学科方向" },
  { word: "经济", category: "学科方向" },
  { word: "管理", category: "学科方向" },
  { word: "Nature", category: "顶刊" },
  { word: "Science", category: "顶刊" },
  { word: "Lancet", category: "顶刊" },
  { word: "Cell", category: "顶刊" },
  { word: "JAMA", category: "顶刊" },
  { word: "BMJ", category: "顶刊" },
  { word: "IEEE", category: "顶刊" },
  { word: "Springer", category: "出版商" },
  { word: "Elsevier", category: "出版商" },
  { word: "Wiley", category: "出版商" },
  { word: "OA", category: "出版模式" },
  { word: "开放获取", category: "出版模式" },
  { word: "预印本", category: "出版模式" },
  { word: "arXiv", category: "出版模式" },
  { word: "临床", category: "研究方法" },
  { word: "实验", category: "研究方法" },
  { word: "样本", category: "研究方法" },
  { word: "数据", category: "研究方法" },
  { word: "模型", category: "研究方法" },
  { word: "算法", category: "研究方法" },
];

const PRESET_CONTEXT: string[] = [
  "论文", "期刊", "发表", "投稿", "审稿", "引用", "索引", "检索",
  "研究", "学术", "科研", "课题", "基金", "实验", "数据",
  "综述", "分析", "方法", "结果", "结论",
];

// ========== 初始化预置词库 ==========

/**
 * 首次使用时，将预置词库写入数据库
 * 已存在的词不会重复插入
 */
export async function initPresetDictionary(tenantId: string): Promise<number> {
  let inserted = 0;

  // 写入一级关键词
  for (const item of PRESET_PRIMARY) {
    try {
      await db
        .insert(industryKeywords)
        .values({
          tenantId,
          word: item.word,
          level: "primary",
          category: item.category,
          weight: 3.0,
          isSystem: true,
          source: "system",
        })
        .onConflictDoNothing();
      inserted++;
    } catch {
      // 重复忽略
    }
  }

  // 写入二级关键词
  for (const item of PRESET_SECONDARY) {
    try {
      await db
        .insert(industryKeywords)
        .values({
          tenantId,
          word: item.word,
          level: "secondary",
          category: item.category,
          weight: 1.0,
          isSystem: true,
          source: "system",
        })
        .onConflictDoNothing();
      inserted++;
    } catch {
      // 重复忽略
    }
  }

  // 写入语境词
  for (const word of PRESET_CONTEXT) {
    try {
      await db
        .insert(industryKeywords)
        .values({
          tenantId,
          word,
          level: "context",
          category: "语境词",
          weight: 1.0,
          isSystem: true,
          source: "system",
        })
        .onConflictDoNothing();
      inserted++;
    } catch {
      // 重复忽略
    }
  }

  logger.info({ tenantId, inserted }, "📖 预置行业词库初始化完成");
  return inserted;
}

// ========== CRUD ==========

/**
 * 获取活跃词库（给 analyzer 使用）
 */
export async function getActiveWords(tenantId: string): Promise<{
  primary: string[];
  secondary: string[];
  context: string[];
}> {
  const words = await db
    .select()
    .from(industryKeywords)
    .where(
      and(
        eq(industryKeywords.tenantId, tenantId),
        eq(industryKeywords.isActive, true)
      )
    );

  return {
    primary: words.filter((w) => w.level === "primary").map((w) => w.word),
    secondary: words.filter((w) => w.level === "secondary").map((w) => w.word),
    context: words.filter((w) => w.level === "context").map((w) => w.word),
  };
}

/**
 * 获取词库列表（管理后台用）
 */
export async function getDictionaryWords(
  tenantId: string,
  filter: WordFilter = {}
): Promise<IndustryWord[]> {
  const conditions = [eq(industryKeywords.tenantId, tenantId)];

  if (filter.level) conditions.push(eq(industryKeywords.level, filter.level));
  if (filter.category) conditions.push(eq(industryKeywords.category, filter.category));
  if (filter.isActive !== undefined) conditions.push(eq(industryKeywords.isActive, filter.isActive));
  if (filter.source) conditions.push(eq(industryKeywords.source, filter.source));

  const results = await db
    .select()
    .from(industryKeywords)
    .where(and(...conditions))
    .orderBy(sql`${industryKeywords.hitCount} DESC, ${industryKeywords.word} ASC`);

  return results.map((r) => ({
    id: r.id,
    word: r.word,
    level: r.level as "primary" | "secondary" | "context",
    category: r.category,
    weight: r.weight || 1.0,
    isSystem: r.isSystem || false,
    isActive: r.isActive !== false,
    source: r.source || "system",
    hitCount: r.hitCount || 0,
  }));
}

/**
 * 获取词库分类列表
 */
export async function getDictionaryCategories(tenantId: string): Promise<string[]> {
  const results = await db
    .select({ category: industryKeywords.category })
    .from(industryKeywords)
    .where(eq(industryKeywords.tenantId, tenantId))
    .groupBy(industryKeywords.category);

  return results
    .map((r) => r.category)
    .filter((c): c is string => c !== null);
}

/**
 * 添加新词
 */
export async function addWord(
  tenantId: string,
  data: {
    word: string;
    level: "primary" | "secondary" | "context";
    category?: string;
    weight?: number;
  }
): Promise<IndustryWord> {
  const [result] = await db
    .insert(industryKeywords)
    .values({
      tenantId,
      word: data.word,
      level: data.level,
      category: data.category || null,
      weight: data.weight || (data.level === "primary" ? 3.0 : 1.0),
      isSystem: false,
      source: "manual",
    })
    .returning();

  logger.info({ tenantId, word: data.word, level: data.level }, "➕ 新增行业关键词");

  return {
    id: result.id,
    word: result.word,
    level: result.level as any,
    category: result.category,
    weight: result.weight || 1.0,
    isSystem: false,
    isActive: true,
    source: "manual",
    hitCount: 0,
  };
}

/**
 * 更新词（修改权重、分类、启用状态）
 */
export async function updateWord(
  tenantId: string,
  wordId: string,
  data: {
    category?: string;
    weight?: number;
    isActive?: boolean;
    level?: string;
  }
): Promise<void> {
  const updates: any = { updatedAt: new Date() };
  if (data.category !== undefined) updates.category = data.category;
  if (data.weight !== undefined) updates.weight = data.weight;
  if (data.isActive !== undefined) updates.isActive = data.isActive;
  if (data.level !== undefined) updates.level = data.level;

  await db
    .update(industryKeywords)
    .set(updates)
    .where(
      and(
        eq(industryKeywords.id, wordId),
        eq(industryKeywords.tenantId, tenantId)
      )
    );
}

/**
 * 删除词（只允许删除非系统预置的词）
 */
export async function deleteWord(tenantId: string, wordId: string): Promise<boolean> {
  const result = await db
    .delete(industryKeywords)
    .where(
      and(
        eq(industryKeywords.id, wordId),
        eq(industryKeywords.tenantId, tenantId),
        eq(industryKeywords.isSystem, false)
      )
    )
    .returning();

  if (result.length === 0) {
    return false; // 系统预置词不能删除
  }
  return true;
}

/**
 * 批量更新命中计数（每次分析完调用）
 */
export async function incrementHitCounts(
  tenantId: string,
  hitWords: string[]
): Promise<void> {
  if (hitWords.length === 0) return;

  for (const word of hitWords) {
    await db
      .update(industryKeywords)
      .set({
        hitCount: sql`${industryKeywords.hitCount} + 1`,
        lastHitAt: new Date(),
      })
      .where(
        and(
          eq(industryKeywords.tenantId, tenantId),
          sql`LOWER(${industryKeywords.word}) = LOWER(${word})`
        )
      );
  }
}
