/**
 * 单条编辑历史卡片（task #21，T4-2-3）。
 *
 * 5 类 action 分支渲染：
 *   select_variant 🎯 — "选了 [模板] 版本"（patternsExtracted.templateId）
 *   rewrite_section ✨ — "改了 [章节标题]"，可展开 LCS diff
 *   approve         ✅ — "批准发布"
 *   edit            ✏️ — "编辑（差异 N 字）"（editDistance）
 *   reject          ❌ — "拒绝：{rejectReason}"
 *
 * TODO(i18n)：所有中文文案 hardcode，phase 6 加 i18n 框架时统一抽 key。
 */

import { useState } from "react";
import type { BossEditRow } from "../hooks/useEditHistory";
import { diffLines, type DiffSegment } from "../utils/lcs-diff";

interface Props {
  edit: BossEditRow;
  /** templateId → 模板中文名（来自 ContentDetailPage 的 templates Map） */
  resolveTemplateName?: (id: string) => string | undefined;
}

export default function EditHistoryCard({ edit, resolveTemplateName }: Props) {
  const [expanded, setExpanded] = useState(false);
  const ago = formatRelativeTime(edit.createdAt);

  const { icon, title, body } = renderByAction(edit, resolveTemplateName, expanded, () => setExpanded(!expanded));

  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      <div className="flex items-start gap-2">
        <span className="text-lg leading-none mt-0.5" aria-hidden>
          {icon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-800 leading-relaxed break-words">{title}</p>
          {body && <div className="mt-2">{body}</div>}
          <p className="text-xs text-gray-400 mt-1.5">{ago}</p>
        </div>
      </div>
    </div>
  );
}

function renderByAction(
  edit: BossEditRow,
  resolveTemplateName: ((id: string) => string | undefined) | undefined,
  expanded: boolean,
  toggle: () => void,
): { icon: string; title: React.ReactNode; body?: React.ReactNode } {
  const patterns = (edit.patternsExtracted ?? {}) as Record<string, unknown>;

  switch (edit.action) {
    case "select_variant": {
      const templateId = typeof patterns.templateId === "string" ? patterns.templateId : undefined;
      const name = (templateId && resolveTemplateName?.(templateId)) || templateId || "未知模板";
      return { icon: "🎯", title: <>选了 <strong className="text-blue-700">{name}</strong> 版本</> };
    }
    case "rewrite_section": {
      const heading =
        (typeof patterns.sectionHeading === "string" ? patterns.sectionHeading : edit.originalTitle) || "未命名章节";
      const instruction = typeof patterns.instruction === "string" ? patterns.instruction : null;
      return {
        icon: "✨",
        title: <>改了 <strong className="text-purple-700">{heading.replace(/^#+\s*/, "")}</strong></>,
        body: (
          <>
            {instruction && <p className="text-xs text-gray-500 mb-2 italic">指令："{instruction}"</p>}
            <button
              onClick={toggle}
              className="text-xs text-blue-600 hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? "▼ 收起 diff" : "▶ 展开 diff"}
            </button>
            {expanded && edit.originalBody != null && edit.editedBody != null && (
              <RewriteDiff original={edit.originalBody} rewritten={edit.editedBody} />
            )}
          </>
        ),
      };
    }
    case "approve":
      return { icon: "✅", title: <span className="text-green-700">批准发布</span> };
    case "edit": {
      const dist = typeof edit.editDistance === "number" ? edit.editDistance : 0;
      return { icon: "✏️", title: <>编辑（差异 <strong>{dist}</strong> 字）</> };
    }
    case "reject":
      return {
        icon: "❌",
        title: (
          <>
            <span className="text-red-700">拒绝</span>
            {edit.rejectReason ? <span className="text-gray-600">：{edit.rejectReason}</span> : null}
          </>
        ),
      };
    default:
      // 未来新增 action 类型时优雅降级（不 throw）
      return { icon: "📝", title: <>{edit.action}</> };
  }
}

function RewriteDiff({ original, rewritten }: { original: string; rewritten: string }) {
  const segments: DiffSegment[] = diffLines(original, rewritten);
  return (
    <div className="mt-2 font-mono text-[11px] leading-5 max-h-60 overflow-y-auto border border-gray-200 rounded">
      {segments.map((seg, i) => {
        const cls =
          seg.type === "added"
            ? "bg-green-50 text-green-800"
            : seg.type === "removed"
              ? "bg-red-50 text-red-800 line-through"
              : "text-gray-600";
        const prefix = seg.type === "added" ? "+ " : seg.type === "removed" ? "- " : "  ";
        return (
          <div key={i} className={`whitespace-pre-wrap px-2 ${cls}`}>
            <span className="select-none text-gray-400 mr-1">{prefix}</span>
            {seg.text || " "}
          </div>
        );
      })}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  // 自写相对时间（避免 Intl.RelativeTimeFormat 在 Safari < 14 / 旧浏览器的兼容差异）
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}
