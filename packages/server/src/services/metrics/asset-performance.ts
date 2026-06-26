/**
 * PR-FW3 飞轮下一环: 模板/数字人形象效果统计。
 * 把 content_metrics 按 资产维度(文章模板 / 视频形象)聚合, 成熟窗口(发布满7天)同龄比,
 * 算出每个模板/形象的"平均阅读/播放", 用于: ① 效果榜展示 ② 生成时推荐高效资产。
 * 混剪风格统计等混剪化(需新服务器)上线后同法接入。
 */
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { logger } from "../../config/logger.js";

const MATURE_DAYS = 7;
const MIN_SAMPLES = 3; // 单资产至少3篇才纳入(少了噪声大)

export interface AssetStat {
  key: string;
  label: string;
  count: number;
  avgViews: number;
}

async function aggregateByMetaKey(tenantId: string, contentType: "article" | "video", metaKey: string): Promise<AssetStat[]> {
  try {
    const rows = await db.execute(sql`
      SELECT
        c.metadata->>${metaKey} AS asset_key,
        AVG(cm.views) AS avg_views,
        COUNT(*) AS n
      FROM contents c
      JOIN LATERAL (
        -- PR-B2 轻量信号: 阅读为0时用互动代理
        SELECT GREATEST(m.views, m.likes*10 + m.comments*15 + m.shares*20) AS views
        FROM content_metrics m
        WHERE m.content_id = c.id
          AND m.snapshot_date <= (c.created_at::date + (${MATURE_DAYS})::int)
        ORDER BY m.snapshot_date DESC LIMIT 1
      ) cm ON true
      WHERE c.tenant_id = ${tenantId}
        AND c.type = ${contentType}
        AND c.metadata->>${metaKey} IS NOT NULL
        AND c.created_at <= NOW() - INTERVAL '${sql.raw(String(MATURE_DAYS))} days'
        AND cm.views > 0
      GROUP BY c.metadata->>${metaKey}
      HAVING COUNT(*) >= ${MIN_SAMPLES}
      ORDER BY AVG(cm.views) DESC
    `);
    return (((rows as any).rows ?? []) as Array<Record<string, any>>).map((r) => ({
      key: String(r.asset_key),
      label: String(r.asset_key),
      count: Number(r.n || 0),
      avgViews: Math.round(Number(r.avg_views || 0)),
    }));
  } catch (err) {
    logger.warn({ tenantId, contentType, metaKey, err: err instanceof Error ? err.message : err }, "PR-FW3 资产统计失败");
    return [];
  }
}

const TEMPLATE_LABEL: Record<string, string> = {
  "shunshi-style": "A 学术", "marketing-conversion": "B 营销", "popular-science": "C 解读", "industry-vertical": "E 行业",
};

export interface AssetPerformance {
  templates: AssetStat[]; // 文章模板效果
  avatars: AssetStat[];   // 视频形象效果
}

export async function getAssetPerformance(tenantId: string): Promise<AssetPerformance> {
  const [templates, avatars] = await Promise.all([
    aggregateByMetaKey(tenantId, "article", "templateId"),
    aggregateByMetaKey(tenantId, "video", "templateId"),
  ]);
  return {
    templates: templates.map((t) => ({ ...t, label: TEMPLATE_LABEL[t.key] ?? t.key })),
    avatars,
  };
}

/** 给视频生成推荐表现最好的形象 key (无足够数据返回 null) */
export async function recommendBestAvatar(tenantId: string): Promise<string | null> {
  const { avatars } = await getAssetPerformance(tenantId);
  return avatars[0]?.key ?? null;
}
