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

/**
 * 6-11 施工包A(审计 2.2): 发布平台 enum → 中文名/图标/颜色 集中表。
 * 原先 8 个文件各写一份(且 RiskAuditModal 那份缺百家号/头条/知乎),全部收口到这里。
 * - label: 全称(AccountsPage / ContentDetailPage 发布面板用)
 * - shortLabel: 简称(工坊卡片 / 推荐面板等紧凑场景用,仅 wechat 与全称不同)
 * 注意: KeywordsPage 的 PLATFORM_LABELS 是"爬虫数据源"标签,不属于发布平台,不在此表。
 */
export const PLATFORM_META: Record<
  string,
  { label: string; shortLabel?: string; icon?: string; color?: string }
> = {
  wechat: { label: "微信公众号", shortLabel: "公众号", icon: "💬", color: "bg-green-100 text-green-700" },
  baijiahao: { label: "百家号", icon: "📰", color: "bg-blue-100 text-blue-700" },
  toutiao: { label: "头条号", icon: "📱", color: "bg-red-100 text-red-700" },
  zhihu: { label: "知乎", icon: "🔍", color: "bg-blue-100 text-blue-600" },
  xiaohongshu: { label: "小红书", icon: "📕", color: "bg-pink-100 text-pink-700" },
  douyin: { label: "抖音", icon: "🎵", color: "bg-gray-100 text-gray-800" },
  wechat_video: { label: "视频号", icon: "📹", color: "bg-green-100 text-green-600" },
};

/** 平台全称(未知平台兜底显示原值) */
export function platformLabel(platform: string): string {
  return PLATFORM_META[platform]?.label ?? platform;
}

/** 平台简称(无简称时退全称,未知平台兜底显示原值) */
export function platformShortLabel(platform: string): string {
  const meta = PLATFORM_META[platform];
  return meta?.shortLabel ?? meta?.label ?? platform;
}
