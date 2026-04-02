/**
 * LanceDB 向量存储服务
 * 统一向量表 + category 字段分区 10 个子库
 */

import * as lancedb from "@lancedb/lancedb";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getEmbeddingDimension } from "./embedding-service.js";

// ============ 10 个子库分区（V4 架构）============
export const VECTOR_CATEGORIES = [
  "term",              // 1. 术语库
  "redline",           // 2. 红线规则库
  "audience",          // 3. 目标人群画像（含B2B）
  "content_format",    // 4. 内容拆解（8种形式）
  "keyword",           // 5. 关键词语义库
  "style",             // 6. IP风格模板库
  "platform_rule",     // 7. 平台规则库（5大平台）
  "insight",           // 8. 洞察策略库（8类洞察）
  "hot_event",         // 9. 热点事件库（V4新增）
  "domain_knowledge",  // 10. 领域知识库（V4新增）
] as const;

export type VectorCategory = (typeof VECTOR_CATEGORIES)[number];

// ============ 向量表行结构 ============
export interface VectorRecord {
  id: string;                 // 唯一ID (nanoid)
  tenantId: string;           // 租户隔离
  category: VectorCategory;   // 子库分区
  title: string;              // 标题/摘要
  content: string;            // 原文内容
  source: string;             // 来源
  vector: number[];           // embedding 向量
  metadata: string;           // JSON 序列化的元数据
  createdAt: string;          // ISO 时间戳
  updatedAt: string;          // ISO 时间戳
}

const TABLE_NAME = "knowledge_vectors";

/** 转义 LanceDB where 子句中的字符串值，防止注入 */
function escapeFilterValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ============ 连接管理（单例）============

let dbInstance: lancedb.Connection | null = null;

export async function getConnection(): Promise<lancedb.Connection> {
  if (dbInstance) return dbInstance;

  dbInstance = await lancedb.connect(env.LANCEDB_PATH);
  logger.info(`✅ LanceDB 已连接: ${env.LANCEDB_PATH}`);
  return dbInstance;
}

/**
 * 获取或创建向量表
 */
export async function getTable(): Promise<lancedb.Table> {
  const conn = await getConnection();
  const tableNames = await conn.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    return conn.openTable(TABLE_NAME);
  }

  // 首次创建表 — 插入一条占位记录然后删除
  logger.info(`📦 创建向量表: ${TABLE_NAME}`);
  const initRecord: VectorRecord = {
    id: "__init__",
    tenantId: "__init__",
    category: "term",
    title: "",
    content: "",
    source: "",
    vector: new Array(getEmbeddingDimension()).fill(0), // 动态维度，匹配当前 embedding 后端
    metadata: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const table = await conn.createTable(
    TABLE_NAME,
    [initRecord] as unknown as Record<string, unknown>[]
  );
  await table.delete('id = "__init__"');
  return table;
}

// ============ CRUD 操作 ============

/**
 * 插入向量记录（支持批量）
 */
export async function addVectors(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const table = await getTable();
  await table.add(records as unknown as Record<string, unknown>[]);
  logger.debug(`向量写入 ${records.length} 条`);
}

/**
 * 向量相似度检索
 */
export async function searchVectors(params: {
  vector: number[];
  tenantId: string;
  category?: VectorCategory;
  limit?: number;
  minScore?: number;
}): Promise<(VectorRecord & { _distance: number })[]> {
  const { vector, tenantId, category, limit = 10, minScore } = params;
  const table = await getTable();

  const safeTenantId = escapeFilterValue(tenantId);
  let filter = `tenantId = '${safeTenantId}'`;
  if (category) {
    const safeCategory = escapeFilterValue(category);
    filter = `tenantId = '${safeTenantId}' AND category = '${safeCategory}'`;
  }

  let query = table
    .search(vector)
    .limit(limit)
    .where(filter);

  const results = await query.toArray();

  // _distance 越小越相似 (L2)，转为相似度分数过滤
  const typed = results as unknown as (VectorRecord & { _distance: number })[];
  if (minScore !== undefined) {
    return typed.filter((r) => 1 / (1 + r._distance) >= minScore);
  }

  return typed;
}

/**
 * 按 ID 删除向量
 */
export async function deleteVectors(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const table = await getTable();
  const inClause = ids.map((id) => `'${escapeFilterValue(id)}'`).join(", ");
  await table.delete(`id IN (${inClause})`);
  logger.debug(`向量删除 ${ids.length} 条`);
}

/**
 * 按 ID 更新向量（LanceDB 不支持原地更新，先删后加）
 */
export async function updateVectors(records: VectorRecord[]): Promise<void> {
  if (records.length === 0) return;
  const ids = records.map((r) => r.id);
  await deleteVectors(ids);
  await addVectors(records);
  logger.debug(`向量更新 ${records.length} 条`);
}

/**
 * 按租户+分区统计条目数
 */
export async function countVectors(
  tenantId: string,
  category?: VectorCategory
): Promise<number> {
  const table = await getTable();
  const safeTid = escapeFilterValue(tenantId);
  let countFilter = `tenantId = '${safeTid}'`;
  if (category) {
    countFilter += ` AND category = '${escapeFilterValue(category)}'`;
  }
  const rows = await table.query().where(countFilter).toArray();
  return rows.length;
}

/**
 * 关闭连接（优雅退出时调用）
 */
export async function closeVectorStore(): Promise<void> {
  if (dbInstance) {
    dbInstance = null;
    logger.info("LanceDB 连接已释放");
  }
}
