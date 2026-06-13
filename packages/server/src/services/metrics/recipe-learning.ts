/**
 * PR-FW 数据飞轮: 内容配方归因 + 加权学习。
 * 把 content_metrics(效果) 关联到 contents.metadata.variationRecipe(配方),
 * 统计每个配方组件(标题公式/钩子/CTA/脚本风格)的平均阅读, 算成权重供生成时加权抽取。
 * 数据不足(<阈值)→ 返回 undefined → 生成退回均匀随机(冷启动安全)。
 */
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import type { RecipeWeights } from "../skills/structure-variation.js";
import { logger } from "../../config/logger.js";

const MIN_SAMPLES = 10;       // 全局样本下限, 不够不学
const COMPONENTS: Array<keyof RecipeWeights> = ["titleFormula", "hook", "cta", "scriptStyle"];

// 简单内存缓存 (1h) — 飞轮不需要实时
const cache = new Map<string, { at: number; weights: RecipeWeights | undefined }>();
const TTL_MS = 3600_000;

/**
 * 算某租户的配方权重。权重 = 该组件值的平均阅读 / 全体平均阅读 (1.0=持平, >1 更好)。
 */
export async function getRecipeWeights(tenantId: string): Promise<RecipeWeights | undefined> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.weights;

  let weights: RecipeWeights | undefined;
  try {
    // 取该租户每篇内容的 recipe 各组件 + 最新阅读快照
    const rows = await db.execute(sql`
      SELECT
        c.metadata->'variationRecipe'->>'titleFormula' AS title_formula,
        c.metadata->'variationRecipe'->>'hook' AS hook,
        c.metadata->'variationRecipe'->>'cta' AS cta,
        c.metadata->'variationRecipe'->>'scriptStyle' AS script_style,
        cm.views AS views
      FROM contents c
      JOIN LATERAL (
        SELECT views FROM content_metrics m
        WHERE m.content_id = c.id ORDER BY m.snapshot_date DESC LIMIT 1
      ) cm ON true
      WHERE c.tenant_id = ${tenantId}
        AND c.metadata ? 'variationRecipe'
        AND cm.views > 0
    `);
    const list = ((rows as any).rows ?? []) as Array<Record<string, any>>;
    if (list.length >= MIN_SAMPLES) {
      const globalAvg = list.reduce((s, r) => s + Number(r.views || 0), 0) / list.length;
      if (globalAvg > 0) {
        const colMap: Record<keyof RecipeWeights, string> = {
          titleFormula: "title_formula", hook: "hook", cta: "cta", scriptStyle: "script_style",
        };
        weights = {};
        for (const comp of COMPONENTS) {
          const col = colMap[comp];
          const byKey = new Map<string, { sum: number; n: number }>();
          for (const r of list) {
            const k = r[col]; if (!k) continue;
            const cur = byKey.get(k) ?? { sum: 0, n: 0 };
            cur.sum += Number(r.views || 0); cur.n += 1;
            byKey.set(k, cur);
          }
          const w: Record<string, number> = {};
          for (const [k, { sum, n }] of byKey) {
            if (n < 2) continue; // 单样本噪声大, 跳过
            w[k] = (sum / n) / globalAvg; // 相对全体均值的倍数
          }
          if (Object.keys(w).length > 0) weights[comp] = w;
        }
        if (Object.keys(weights).length === 0) weights = undefined;
      }
    }
    logger.info({ tenantId, samples: list.length, learned: !!weights }, "PR-FW 配方权重计算");
  } catch (err) {
    logger.warn({ tenantId, err: err instanceof Error ? err.message : err }, "PR-FW 配方权重计算失败, 退回随机");
    weights = undefined;
  }
  cache.set(tenantId, { at: Date.now(), weights });
  return weights;
}
