/**
 * 5-18 P1 — Workbench 顶部 tab 栏。3 个 tab + 实时 count。
 */
export type WorkbenchTab = "recommend" | "draft" | "published";

export interface ContentTabBarProps {
  active: WorkbenchTab;
  counts: { recommend: number; draft: number; published: number };
  onChange: (tab: WorkbenchTab) => void;
}

const TABS: Array<{ key: WorkbenchTab; label: string }> = [
  { key: "recommend", label: "📅 今日推荐" },
  { key: "draft", label: "✏️ 草稿" },
  { key: "published", label: "✅ 已发布" },
];

export default function ContentTabBar({ active, counts, onChange }: ContentTabBarProps) {
  return (
    <div className="flex items-center gap-1 px-4 py-2 bg-white border-b border-gray-200">
      {TABS.map((t) => {
        const isActive = active === t.key;
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
              isActive ? "bg-blue-50 text-blue-700" : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 text-xs ${isActive ? "text-blue-500" : "text-gray-400"}`}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}
