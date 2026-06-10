/**
 * 6-11 施工包A(审计 2.3): 内容状态徽章统一组件。
 *
 * 此前 3 个页面各写一份 STATUS_LABELS/STATUS_COLORS,且 ContentDetailPage/DataDashboardPage
 * 还是旧 4 状态表 → generated/generating/failed 直接显示英文原码(真 bug)。
 * 词表只认 utils/i18n.ts 的 articleStatusLabel(6 状态全集),颜色只在这里定义一份。
 */
import { articleStatusLabel } from "../utils/i18n";

/** 6 状态全集 + P0 迁移期旧 enum 兼容 */
export const STATUS_LABELS: Record<string, string> = {
  ...articleStatusLabel,
  // P0 迁移期兼容：旧 enum 显示标签
  reviewing: "审核中（旧）",
  approved: "已通过（旧）",
};

/** 配色以 ContentPage 原配色为准,补齐所有状态 */
export const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  generating: "bg-blue-100 text-blue-700",
  failed: "bg-red-100 text-red-700",
  generated: "bg-green-100 text-green-700",
  published: "bg-sky-100 text-sky-700",
  archived: "bg-gray-100 text-gray-500",
  reviewing: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
};

/** 未知状态兜底显示原值(与原各页 `LABELS[s] || s` 行为一致) */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "bg-gray-100 text-gray-600";
}

export interface StatusBadgeProps {
  status: string;
  /** 布局类(尺寸/圆角等),不含颜色;默认为详情页头部徽章规格 */
  className?: string;
}

export default function StatusBadge({
  status,
  className = "inline-block text-xs px-2.5 py-1 rounded-full font-medium",
}: StatusBadgeProps) {
  return (
    <span className={`${className} ${statusColor(status)}`}>
      {statusLabel(status)}
    </span>
  );
}
