/**
 * PR #124 V2 5-16 全 UI 中文化（5-22 demo 武器）。
 *
 * 集中管理 enum → 中文显示映射，避免散落 inline 字面。
 *
 * 红线：仅显示层。DB enum / API field / type / interface 不动。
 * csv 导出仍用英文 column 名，方便 analyst 工具兼容。
 */
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_IDS,
  platformLabel,
  platformShortLabel,
} from "./platforms";

/** journals.data_source enum → 中文 + emoji（用于 audit 页 / detail 页 badge） */
export const dataSourceLabel: Record<string, string> = {
  multi_source_verified: "✅ 多源核验",
  manual_seed_2024: "✅ 手动录入",
  letpub_only: "📚 单源 LetPub",
  token_fuzzy: "🟡 模糊匹配",
  ai_fabricated: "⚠️ AI 编造",
  legacy_unknown: "❓ 从未验证",
};

/**
 * contents.status 全集 —— **前端唯一真相源**, 必须与后端
 * `packages/server/src/services/articles/state-machine.ts` 的 `ARTICLE_STATUSES` 逐个一致
 * (由 `packages/server/src/__tests__/content-status-vocabulary.test.ts` 守卫)。
 *
 * 7-28 阶段1-B 修的事故: 前端曾有 3 份各写各的状态词表, 其中 i18n / StatusBadge 两份都漏了
 * `needs_review`(PR-U2 加的"质检未过, 待人工复核")—— 于是内容详情页对待审内容直接把英文原码
 * `needs_review` 甩给运营看。漏一个状态不会报错、不会 404, 只会静默显示英文, 所以必须靠守卫测试。
 */
export const ARTICLE_STATUSES = [
  "draft",
  "generating",
  "failed",
  "generated",
  "needs_review",
  "published",
  "archived",
] as const;

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/**
 * contents.status → 中文（用于 ContentPage tab + 列表 badge）。
 * 类型写成 `Record<ArticleStatus, …>` 是刻意的 —— 漏一个状态编译期就红,
 * 不用等运营在页面上看见英文原码才发现(比测试更早一步)。
 */
export const articleStatusLabel: Record<ArticleStatus, string> = {
  draft: "草稿",
  generating: "生成中",
  failed: "失败",
  generated: "已生成",
  needs_review: "待审·质检未过",
  published: "已发布",
  archived: "归档",
};

/** contents.status → 徽章配色 (底色+文字)。同样是 Record<ArticleStatus,…>, 漏一个编译期红。 */
export const articleStatusColor: Record<ArticleStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  generating: "bg-amber-50 text-amber-700",
  failed: "bg-rose-50 text-rose-700",
  generated: "bg-emerald-50 text-emerald-700",
  needs_review: "bg-amber-50 text-amber-700", // PR-U2 质检未过, 待人工复核
  published: "bg-sky-50 text-sky-700",
  archived: "bg-slate-100 text-slate-500",
};

/** contents.status → 前置小圆点颜色 (与底色同语义) */
export const articleStatusDotColor: Record<ArticleStatus, string> = {
  draft: "bg-slate-400",
  generating: "bg-amber-500",
  failed: "bg-rose-500",
  generated: "bg-emerald-500",
  needs_review: "bg-amber-500",
  published: "bg-sky-500",
  archived: "bg-slate-400",
};

/** batch_rows.status (P4 4 状态) → 中文（BatchProgressPage 行 badge） */
export const batchRowStatusLabel: Record<string, string> = {
  pending: "等待中",
  generating: "生成中",
  generated: "已生成",
  failed: "失败",
};

/** batches.status (P4 5 状态 — 批次顶层) → 中文 */
export const batchStatusLabel: Record<string, string> = {
  pending: "待处理",
  running: "进行中",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
};

/** journals 审计常用字段名 → 中文（替代 audit 页 column header 直贴 db 列名） */
export const journalAuditFieldLabel: Record<string, string> = {
  data_source: "数据来源",
  confidence: "可信度",
  last_verified_at: "最后验证",
  last_verified: "最后验证",
  source_url: "数据源验证",
};

/** unknown enum 兜底 — 拿不到 mapping 时显示原值，避免空白 */
export function labelOr(map: Record<string, string>, value: string | null | undefined): string {
  if (value == null) return "—";
  return map[value] ?? value;
}

/**
 * 6-11 施工包A(审计 2.2): 发布平台 enum → 中文名/图标/颜色 集中表。
 * 7-28 阶段1-B: 表本身已上移到 utils/platforms.ts(与后端 capabilities 表对齐并有一致性守卫),
 *   本文件只保留显示层视图 + 再导出, 让既有的 `import { PLATFORM_META } from "../utils/i18n"`
 *   继续可用。**不要在这里改平台数据** —— 改 utils/platforms.ts。
 * 注意: KeywordsPage 的 PLATFORM_LABELS 是"爬虫数据源"标签,不属于发布平台,不在此表。
 */
export const PLATFORM_META: Record<
  string,
  { label: string; shortLabel?: string; icon?: string; color?: string }
> = Object.fromEntries(
  PLATFORM_IDS.map((id) => {
    const c = PLATFORM_CAPABILITIES[id]!;
    return [id, { label: c.label, shortLabel: c.shortLabel, icon: c.icon, color: c.color }];
  }),
);

export { platformLabel, platformShortLabel };
