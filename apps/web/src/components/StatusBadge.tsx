/**
 * 6-11 施工包A(审计 2.3): 内容状态徽章统一组件。
 *
 * 此前 3 个页面各写一份 STATUS_LABELS/STATUS_COLORS,且 ContentDetailPage/DataDashboardPage
 * 还是旧 4 状态表 → generated/generating/failed 直接显示英文原码(真 bug)。
 * 词表只认 utils/i18n.ts 的 articleStatusLabel(6 状态全集),颜色只在这里定义一份。
 *
 * 6-11 UI 升级: 徽章改为 圆点+柔和底色 胶囊样式 (slate/indigo 体系), 语义映射不变。
 */
import { articleStatusLabel } from "../utils/i18n";

/** 6 状态全集 + P0 迁移期旧 enum 兼容 */
export const STATUS_LABELS: Record<string, string> = {
  ...articleStatusLabel,
  // P0 迁移期兼容：旧 enum 显示标签
  reviewing: "审核中（旧）",
  approved: "已通过（旧）",
};

/** 柔和系配色 (底色+文字), 语义不变; 供徽章及个别页面直接引用 */
export const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  generating: "bg-amber-50 text-amber-700",
  failed: "bg-rose-50 text-rose-700",
  generated: "bg-emerald-50 text-emerald-700",
  published: "bg-sky-50 text-sky-700",
  archived: "bg-slate-100 text-slate-500",
  reviewing: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
};

/** 前置小圆点颜色 (与底色同语义) */
export const STATUS_DOT_COLORS: Record<string, string> = {
  draft: "bg-slate-400",
  generating: "bg-amber-500",
  failed: "bg-rose-500",
  generated: "bg-emerald-500",
  published: "bg-sky-500",
  archived: "bg-slate-400",
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
