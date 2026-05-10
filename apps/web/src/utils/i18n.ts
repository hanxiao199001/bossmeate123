/**
 * PR #124 V2 5-16 全 UI 中文化（5-22 demo 武器）。
 *
 * 集中管理 enum → 中文显示映射，避免散落 inline 字面。
 *
 * 红线：仅显示层。DB enum / API field / type / interface 不动。
 * csv 导出仍用英文 column 名，方便 analyst 工具兼容。
 */

/** journals.data_source enum → 中文 + emoji（用于 audit 页 / detail 页 badge） */
export const dataSourceLabel: Record<string, string> = {
  multi_source_verified: "✅ 多源核验",
  manual_seed_2024: "✅ 手动录入",
  letpub_only: "📚 单源 LetPub",
  token_fuzzy: "🟡 模糊匹配",
  ai_fabricated: "⚠️ AI 编造",
  legacy_unknown: "❓ 从未验证",
};

/** contents.status (P0 6 状态机) → 中文（用于 ContentPage tab + 列表 badge） */
export const articleStatusLabel: Record<string, string> = {
  draft: "草稿",
  generating: "生成中",
  generated: "已生成",
  published: "已发布",
  failed: "失败",
  archived: "归档",
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
