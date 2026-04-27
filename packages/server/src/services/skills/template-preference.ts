/**
 * 模板偏好学习（T4-3-4）
 *
 * 用途：把 boss_edits 里 `select_variant` 信号统计成 per-tenant 模板权重，
 * 用于 variants > 1 时给副版本分配模板。
 *
 * 数据来源：boss_edits.patterns_extracted JSONB
 *   - selectedTemplateId: string  → 老板选中的版本所用模板
 *   - rejectedTemplateIds: string[] → 同组其他被拒版本的模板
 *
 * 权重算法（v1，T4-3-4）：
 *   weight(t) = selectedCount(t) / Σ selectedCount(*)
 *   - 偏好为空（新租户）→ 所有候选 weight=0 → 上层 fallback 到均匀随机
 *   - 暂不消费 rejectedCount，作为后续算法演进入口（4 阶段第 2 阶段会接入）
 *
 * 缓存：5 分钟 in-memory，key=tenantId。失效后重新查 DB。
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { bossEdits } from "../../models/schema.js";
import { listTemplates, getDefaultTemplateId } from "./template-registry.js";
import { logger } from "../../config/logger.js";

export interface TemplatePreference {
  templateId: string;
  selectedCount: number;
  rejectedCount: number;
  /** 0..1 normalized over selectedCount of all templates for this tenant. */
  weight: number;
}

interface CacheEntry {
  prefs: TemplatePreference[];
  ts: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export function clearTemplatePreferenceCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function getTemplatePreferences(
  tenantId: string
): Promise<TemplatePreference[]> {
  if (!tenantId) return [];

  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return hit.prefs;
  }

  try {
    // selectedCount: GROUP BY patterns_extracted->>'selectedTemplateId'
    const selectedRows = await db
      .select({
        tid: sql<string>`patterns_extracted->>'selectedTemplateId'`.as("tid"),
        cnt: sql<number>`COUNT(*)::int`.as("cnt"),
      })
      .from(bossEdits)
      .where(
        and(
          eq(bossEdits.tenantId, tenantId),
          eq(bossEdits.action, "select_variant"),
          sql`patterns_extracted->>'selectedTemplateId' IS NOT NULL`
        )
      )
      .groupBy(sql`patterns_extracted->>'selectedTemplateId'`);

    // rejectedCount: pull arrays then count in memory（jsonb_array_elements_text
    // 在 GROUP BY 里对 drizzle 不友好；体量小，内存累加足够）
    const rejectedRaw = await db
      .select({
        rejected: sql<unknown>`patterns_extracted->'rejectedTemplateIds'`.as("rejected"),
      })
      .from(bossEdits)
      .where(
        and(
          eq(bossEdits.tenantId, tenantId),
          eq(bossEdits.action, "select_variant")
        )
      );

    const rejectedCounts = new Map<string, number>();
    for (const r of rejectedRaw) {
      const arr = r.rejected;
      if (Array.isArray(arr)) {
        for (const tid of arr) {
          if (typeof tid === "string" && tid) {
            rejectedCounts.set(tid, (rejectedCounts.get(tid) || 0) + 1);
          }
        }
      }
    }

    const totalSelected = selectedRows.reduce((s, r) => s + (r.cnt || 0), 0);

    const idSet = new Set<string>();
    for (const r of selectedRows) if (r.tid) idSet.add(r.tid);
    for (const id of rejectedCounts.keys()) idSet.add(id);

    const prefs: TemplatePreference[] = [];
    for (const tid of idSet) {
      const sel = selectedRows.find((r) => r.tid === tid)?.cnt || 0;
      const rej = rejectedCounts.get(tid) || 0;
      prefs.push({
        templateId: tid,
        selectedCount: sel,
        rejectedCount: rej,
        weight: totalSelected > 0 ? sel / totalSelected : 0,
      });
    }

    cache.set(tenantId, { prefs, ts: Date.now() });
    return prefs;
  } catch (err) {
    logger.warn(
      { err, tenantId },
      "T4-3-4: getTemplatePreferences 查询失败，返回空（降级到均匀随机）"
    );
    return [];
  }
}

export interface SelectVariantTemplatesOptions {
  /** 主版本固定模板（默认 = getDefaultTemplateId()，'data-card'）。 */
  defaultId?: string;
  /** 注入随机源用于测试，签名 () => [0,1)。默认 Math.random。 */
  random?: () => number;
}

/**
 * 给 variants 个版本分配 templateId。
 *
 * - index 0（主版本）= options.defaultId ?? getDefaultTemplateId()
 * - index 1+（副版本）从 listTemplates() 中 != defaultId 的候选里按偏好权重 **不放回**抽样
 * - 偏好为空 / 全 0 权重 → 候选均匀随机
 * - 候选数不足 variants - 1 → 用 defaultId 补齐
 *
 * 总是返回长度 = variants 的数组。
 */
export async function selectVariantTemplates(
  tenantId: string,
  variants: number,
  options?: SelectVariantTemplatesOptions
): Promise<string[]> {
  const defaultId = options?.defaultId ?? getDefaultTemplateId();
  const rand = options?.random ?? Math.random;

  const v = Math.max(1, Math.floor(variants));
  if (v === 1) return [defaultId];

  const allTemplates = listTemplates();
  const nonDefault = allTemplates.filter((t) => t.id !== defaultId);

  if (nonDefault.length === 0) {
    return Array<string>(v).fill(defaultId);
  }

  const prefs = await getTemplatePreferences(tenantId);
  const prefMap = new Map(prefs.map((p) => [p.templateId, p.weight]));

  const remaining = nonDefault.map((t) => ({
    id: t.id,
    weight: prefMap.get(t.id) ?? 0,
  }));

  const result: string[] = [defaultId];
  for (let i = 1; i < v; i++) {
    if (remaining.length === 0) {
      result.push(defaultId);
      continue;
    }

    let total = remaining.reduce((s, c) => s + c.weight, 0);
    // 全 0 权重 → 均匀随机
    if (total === 0) {
      remaining.forEach((c) => (c.weight = 1));
      total = remaining.length;
    }

    let r = rand() * total;
    let pickedIdx = remaining.length - 1;
    for (let j = 0; j < remaining.length; j++) {
      r -= remaining[j].weight;
      if (r <= 0) {
        pickedIdx = j;
        break;
      }
    }

    result.push(remaining[pickedIdx].id);
    remaining.splice(pickedIdx, 1);
  }

  return result;
}
