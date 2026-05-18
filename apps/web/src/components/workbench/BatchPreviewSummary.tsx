/**
 * 5-23 PR #161 — 多选模式下中间区显示 "批量预览" 摘要 (代替单文章 preview).
 */
import type { WorkbenchListItem } from "./ContentListItem";

export interface BatchPreviewSummaryProps {
  selectedIds: Set<string>;
  items: WorkbenchListItem[];
}

export default function BatchPreviewSummary({ selectedIds, items }: BatchPreviewSummaryProps) {
  const selected = items.filter((it) => selectedIds.has(it.id));

  return (
    <div className="flex-1 p-6 bg-white border border-gray-200 rounded-xl overflow-y-auto m-2">
      <div className="mb-4">
        <h2 className="text-base font-bold text-gray-900">📋 批量预览 {selectedIds.size} 篇</h2>
        <p className="text-xs text-gray-500 mt-1">右侧选 平台账号 后批量发布. 已发过的对会跳过.</p>
      </div>
      {selected.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">列表中无可显示项 (可能 tab 切换后没刷新)</p>
      ) : (
        <ol className="space-y-2 list-decimal list-inside text-sm">
          {selected.map((it) => {
            const j = it.journal;
            const meta = [j?.name, j?.impactFactor != null ? `IF ${j.impactFactor}` : null, j?.partition]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={it.id} className="text-gray-900 py-1">
                <span className="font-medium">{it.title || "(无标题)"}</span>
                {meta && <span className="text-xs text-gray-500 ml-2">{meta}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
