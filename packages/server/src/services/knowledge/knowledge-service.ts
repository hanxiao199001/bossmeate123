/**
 * 知识库统一服务
 * 16 子库的 CRUD + 向量检索接口
 * PG (knowledgeEntries) 存元数据，LanceDB 存向量
 */

import { eq, and, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../models/db.js";
import { knowledgeEntries } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import {
  addVectors,
  searchVectors,
  deleteVectors,
  updateVectors,
  countVectors,
  type VectorCategory,
  type VectorRecord,
  VECTOR_CATEGORIES,
} from "./vector-store.js";
import { getEmbedding, getEmbeddings } from "./embedding-service.js";

// ============ 16 子库映射（V4 架构）============
// 10 个向量分区 + 6 个 PG-only 分区（结构化表，不需要向量检索）

/** 需要向量化的分区 = vector-store 中的 10 个 category */
export const VECTORIZED_CATEGORIES = VECTOR_CATEGORIES;

/** 仅存 PG 的分区（已有或新增独立表） */
export const PG_ONLY_CATEGORIES = [
  "competitor_account",    // 4. 竞品账号库（competitors 表增强标签）
  "competitor_content",    // 5. 竞品内容库（competitors 表原始内容）
  "tenant_ip",             // 10. 租户IP定位（tenant_ip_profiles 表）
  "production",            // 11. 生产记录+衍生追踪（contents + production_records 表）
  "content_metric",        // 12. 数据表现（distributionRecords + content_metrics 表）
  "column_calendar",       // 16. 栏目规划日历（column_calendars 表）
] as const;

export type PgOnlyCategory = (typeof PG_ONLY_CATEGORIES)[number];
export type KnowledgeCategory = VectorCategory | PgOnlyCategory;

const ALL_CATEGORIES = [...VECTORIZED_CATEGORIES, ...PG_ONLY_CATEGORIES];

function isVectorized(category: string): category is VectorCategory {
  return (VECTORIZED_CATEGORIES as readonly string[]).includes(category);
}

// ============ 入参/出参类型 ============

export interface CreateKnowledgeInput {
  tenantId: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateKnowledgeInput {
  title?: string;
  content?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchInput {
  tenantId: string;
  query: string;
  category?: VectorCategory;
  limit?: number;
  minScore?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  source: string | null;
  score: number;           // 0~1，越大越相似
  metadata: Record<string, unknown>;
}

export interface KnowledgeEntry {
  id: string;
  tenantId: string;
  category: string;
  title: string | null;
  content: string;
  source: string | null;
  vectorId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

// ============ CRUD ============

/**
 * 创建知识条目（自动向量化）
 */
export async function createEntry(
  input: CreateKnowledgeInput
): Promise<KnowledgeEntry> {
  const vectorId = nanoid();
  const now = new Date();

  // 向量化分区：生成 embedding 并写入 LanceDB
  if (isVectorized(input.category)) {
    const embeddingText = `${input.title}\n${input.content}`;
    const { vector } = await getEmbedding(embeddingText);

    await addVectors([
      {
        id: vectorId,
        tenantId: input.tenantId,
        category: input.category,
        title: input.title,
        content: input.content,
        source: input.source || "",
        vector,
        metadata: JSON.stringify(input.metadata || {}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  }

  // PG 写入元数据
  const [row] = await db
    .insert(knowledgeEntries)
    .values({
      tenantId: input.tenantId,
      category: input.category,
      title: input.title,
      content: input.content,
      source: input.source || null,
      vectorId: isVectorized(input.category) ? vectorId : null,
      metadata: input.metadata || {},
    })
    .returning();

  logger.info(
    { id: row.id, category: input.category, vectorId },
    "知识条目创建"
  );

  return row as KnowledgeEntry;
}

/**
 * 批量创建（自动分批向量化）
 */
export async function createEntries(
  inputs: CreateKnowledgeInput[]
): Promise<KnowledgeEntry[]> {
  if (inputs.length === 0) return [];

  const vectorInputs = inputs.filter((i) => isVectorized(i.category));
  const pgOnlyInputs = inputs.filter((i) => !isVectorized(i.category));

  // 批量 embedding
  let embeddingMap = new Map<number, number[]>();
  if (vectorInputs.length > 0) {
    const texts = vectorInputs.map((i) => `${i.title}\n${i.content}`);
    const results = await getEmbeddings(texts);
    vectorInputs.forEach((_, idx) => {
      embeddingMap.set(idx, results[idx].vector);
    });
  }

  const now = new Date();
  const vectorRecords: VectorRecord[] = [];
  const pgValues: Array<{
    tenantId: string;
    category: string;
    title: string;
    content: string;
    source: string | null;
    vectorId: string | null;
    metadata: Record<string, unknown>;
  }> = [];

  // 构建向量化条目
  vectorInputs.forEach((input, idx) => {
    const vectorId = nanoid();
    vectorRecords.push({
      id: vectorId,
      tenantId: input.tenantId,
      category: input.category as VectorCategory,
      title: input.title,
      content: input.content,
      source: input.source || "",
      vector: embeddingMap.get(idx)!,
      metadata: JSON.stringify(input.metadata || {}),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    pgValues.push({
      tenantId: input.tenantId,
      category: input.category,
      title: input.title,
      content: input.content,
      source: input.source || null,
      vectorId,
      metadata: input.metadata || {},
    });
  });

  // 构建 PG-only 条目
  pgOnlyInputs.forEach((input) => {
    pgValues.push({
      tenantId: input.tenantId,
      category: input.category,
      title: input.title,
      content: input.content,
      source: input.source || null,
      vectorId: null,
      metadata: input.metadata || {},
    });
  });

  // 写入 LanceDB
  if (vectorRecords.length > 0) {
    await addVectors(vectorRecords);
  }

  // 写入 PG
  const rows = await db
    .insert(knowledgeEntries)
    .values(pgValues)
    .returning();

  logger.info(
    { total: rows.length, vectorized: vectorRecords.length },
    "批量知识条目创建"
  );

  return rows as KnowledgeEntry[];
}

/**
 * 更新知识条目（内容变化时重新向量化）
 */
export async function updateEntry(
  id: string,
  tenantId: string,
  input: UpdateKnowledgeInput
): Promise<KnowledgeEntry | null> {
  // 查出原记录
  const [existing] = await db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.tenantId, tenantId)));

  if (!existing) return null;

  const newTitle = input.title ?? existing.title ?? "";
  const newContent = input.content ?? existing.content;

  // 内容变化且是向量化分区 → 重新 embedding
  const contentChanged = input.content && input.content !== existing.content;
  const titleChanged = input.title && input.title !== existing.title;

  if (
    (contentChanged || titleChanged) &&
    isVectorized(existing.category) &&
    existing.vectorId
  ) {
    const embeddingText = `${newTitle}\n${newContent}`;
    const { vector } = await getEmbedding(embeddingText);
    const now = new Date();

    await updateVectors([
      {
        id: existing.vectorId,
        tenantId,
        category: existing.category as VectorCategory,
        title: newTitle,
        content: newContent,
        source: input.source ?? existing.source ?? "",
        vector,
        metadata: JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        createdAt: existing.createdAt.toISOString(),
        updatedAt: now.toISOString(),
      },
    ]);
  }

  // 更新 PG
  const [updated] = await db
    .update(knowledgeEntries)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.content !== undefined && { content: input.content }),
      ...(input.source !== undefined && { source: input.source }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      updatedAt: new Date(),
    })
    .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.tenantId, tenantId)))
    .returning();

  logger.info({ id, contentChanged, titleChanged }, "知识条目更新");
  return updated as KnowledgeEntry;
}

/**
 * 删除知识条目（同步删 LanceDB）
 */
export async function deleteEntry(
  id: string,
  tenantId: string
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.tenantId, tenantId)));

  if (!existing) return false;

  // 删除向量
  if (existing.vectorId) {
    await deleteVectors([existing.vectorId]);
  }

  // 删除 PG
  await db
    .delete(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.tenantId, tenantId)));

  logger.info({ id, category: existing.category }, "知识条目删除");
  return true;
}

/**
 * 按 ID 查询
 */
export async function getEntry(
  id: string,
  tenantId: string
): Promise<KnowledgeEntry | null> {
  const [row] = await db
    .select()
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.id, id), eq(knowledgeEntries.tenantId, tenantId)));

  return (row as KnowledgeEntry) || null;
}

/**
 * 按分区列表查询
 */
export async function listEntries(params: {
  tenantId: string;
  category?: KnowledgeCategory;
  keyword?: string;
  limit?: number;
  offset?: number;
}): Promise<KnowledgeEntry[]> {
  const { tenantId, category, keyword, limit = 50, offset = 0 } = params;

  let query = db
    .select()
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.tenantId, tenantId))
    .limit(limit)
    .offset(offset);

  if (category) {
    query = db
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.tenantId, tenantId),
          eq(knowledgeEntries.category, category)
        )
      )
      .limit(limit)
      .offset(offset);
  }

  if (keyword) {
    query = db
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.tenantId, tenantId),
          ...(category ? [eq(knowledgeEntries.category, category)] : []),
          like(knowledgeEntries.content, `%${keyword}%`)
        )
      )
      .limit(limit)
      .offset(offset);
  }

  const rows = await query;
  return rows as KnowledgeEntry[];
}

// ============ 向量检索 ============

/**
 * 语义搜索（仅向量化分区可用）
 */
export async function semanticSearch(
  input: SearchInput
): Promise<SearchResult[]> {
  const { query, tenantId, category, limit = 10, minScore } = input;

  // 生成查询向量
  const { vector } = await getEmbedding(query);

  const results = await searchVectors({
    vector,
    tenantId,
    category,
    limit,
    minScore,
  });

  return results.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    category: r.category,
    source: r.source || null,
    score: 1 / (1 + r._distance), // L2 距离转相似度
    metadata: JSON.parse(r.metadata || "{}"),
  }));
}

/**
 * 混合搜索：向量检索 + 关键词过滤
 */
export async function hybridSearch(params: {
  tenantId: string;
  query: string;
  keywords?: string[];
  category?: VectorCategory;
  limit?: number;
}): Promise<SearchResult[]> {
  const { tenantId, query, keywords, category, limit = 10 } = params;

  // 先做向量检索，取更多候选
  const candidates = await semanticSearch({
    tenantId,
    query,
    category,
    limit: limit * 3,
  });

  // 关键词加权
  if (keywords && keywords.length > 0) {
    const boosted = candidates.map((c) => {
      const text = `${c.title} ${c.content}`.toLowerCase();
      const keywordHits = keywords.filter((kw) =>
        text.includes(kw.toLowerCase())
      ).length;
      const boost = 1 + keywordHits * 0.1; // 每命中一个关键词加 10% 分
      return { ...c, score: c.score * boost };
    });
    boosted.sort((a, b) => b.score - a.score);
    return boosted.slice(0, limit);
  }

  return candidates.slice(0, limit);
}

/**
 * 获取各子库统计
 */
export async function getStats(tenantId: string): Promise<
  Record<string, { pgCount: number; vectorCount: number }>
> {
  const stats: Record<string, { pgCount: number; vectorCount: number }> = {};

  for (const cat of ALL_CATEGORIES) {
    const pgRows = await db
      .select()
      .from(knowledgeEntries)
      .where(
        and(
          eq(knowledgeEntries.tenantId, tenantId),
          eq(knowledgeEntries.category, cat)
        )
      );

    let vectorCount = 0;
    if (isVectorized(cat)) {
      vectorCount = await countVectors(tenantId, cat);
    }

    stats[cat] = { pgCount: pgRows.length, vectorCount };
  }

  return stats;
}
