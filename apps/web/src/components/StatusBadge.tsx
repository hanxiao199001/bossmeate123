/**
 * 6-11 施工包A(审计 2.3): 内容状态徽章统一组件。
 *
 * 7-28 阶段1-B: 本文件与 utils/i18n.ts 两份词表都漏了 needs_review(TodayPage 那份第三份倒是有),
 * 导致详情页把英文 `needs_review` 直接甩给运营。现已补齐并加前后端一致性守卫测试。
 *
 * 此前 3 个页面各写一份 STATUS_LABELS/STATUS_COLORS,且 ContentDetailPage/DataDashboardPage
 * 还是旧 4 状态表 → generated/generating/failed 直接显示英文原码(真 bug)。
 * 词表与配色现在都只认 utils/i18n.ts(7 状态全集), 本文件只加旧 enum 兼容。
 *
 * 6-11 UI 升级: 徽章改为 圆点+柔和底色 胶囊样式 (slate/indigo 体系), 语义映射不变。
 */
import { articleStatusLabel, articleStatusColor, articleStatusDotColor } from "../utils/i18n";

/**
 * 状态词表/配色全部来自 utils/i18n.ts(唯一真相源, 且以 Record<ArticleStatus,…> 类型强制齐全)。
 * 这里只做一件事: 叠加 P0 迁移期旧 enum 的兼容显示。别在这里新增状态。
 */
export const STATUS_LABELS: Record<string, string> = {
  ...articleStatusLabel,
  reviewing: "审核中（旧）",
  approved: "已通过（旧）",
};

export const STATUS_COLORS: Record<string, string> = {
  ...articleStatusColor,
  reviewing: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
};

export const STATUS_DOT_COLORS: Record<string, string> = {
  ...articleStatusDotColor,
  reviewing: "bg-amber-500",
  approved: "bg-emerald-500",
};

/** 未知状态兜底显示原值(与原各页 `LABELS[s] || s` 行为一致) */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600";
}

export function statusDotColor(status: string): string {
  return STATUS_DOT_COLORS[status] ?? "bg-slate-400";
}

export interface StatusBadgeProps {
  status: string;
  /** 布局类(尺寸/圆角等),不含颜色;默认为统一胶囊规格 */
  className?: string;
}

export default function StatusBadge({
  status,
  className = "rounded-full px-2.5 py-0.5 text-xs font-medium",
}: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className} ${statusColor(status)}`}>
      {status === "generating" ? (
        <span
          className={`h-1.5 w-1.5 rounded-full border border-current border-t-transparent animate-spin`}
          aria-hidden
        />
      ) : (
        <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor(status)}`} aria-hidden />
      )}
      {statusLabel(status)}
    </span>
  );
}
