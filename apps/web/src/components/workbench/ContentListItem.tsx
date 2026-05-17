/**
 * 5-18 P1 — Workbench 左列单个 item。选中态高亮，元数据简版（IF / 关键词等可有可无）。
 */
export interface WorkbenchListItem {
  id: string;
  title: string | null;
  metadata?: Record<string, unknown> | null;
  journal?: {
    name: string | null;
    impactFactor: number | null;
    partition: string | null;
  } | null;
}

export interface ContentListItemProps {
  item: WorkbenchListItem;
  selected: boolean;
  onClick: () => void;
}

export default function ContentListItem({ item, selected, onClick }: ContentListItemProps) {
  const j = item.journal;
  const keyword = (item.metadata as { keyword?: string } | null | undefined)?.keyword;
  const meta: string[] = [];
  if (j?.name) meta.push(j.name);
  if (j?.impactFactor != null) meta.push(`IF ${j.impactFactor}`);
  if (j?.partition) meta.push(j.partition);
  if (keyword) meta.push(`#${keyword}`);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
        selected
          ? "bg-blue-50 border-blue-300"
          : "bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50"
      }`}
    >
      <p className={`text-sm font-medium line-clamp-2 ${selected ? "text-blue-900" : "text-gray-900"}`}>
        {item.title || "(无标题)"}
      </p>
      {meta.length > 0 && (
        <p className="text-xs text-gray-500 mt-1 line-clamp-1">{meta.join(" · ")}</p>
      )}
    </button>
  );
}
