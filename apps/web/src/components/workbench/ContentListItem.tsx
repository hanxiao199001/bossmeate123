/**
 * 5-18 P1 — Workbench 左列单个 item。选中态高亮，元数据简版（IF / 关键词等可有可无）。
 * 5-23 PR #161: 加 always-on checkbox (Gmail 风) + multiSelected ring 高亮.
 *   selected (单选高亮, 现有) 与 multiSelected (多选 checkbox 勾) 区分 — 命名不重叠.
 */
export interface WorkbenchListItem {
  id: string;
  title: string | null;
  type?: string | null; // article=图文 / video=视频, 用于列表类型标
  status?: string | null; // 老韩6-15: needs_review 标'待审'
  metadata?: Record<string, unknown> | null;
  operatorPublished?: boolean; // 7-06 ②: 回流确认被运营从草稿箱群发 (市场选择信号)
  createdAt?: string | null; // PR #186: 生成时间 (列表项显示相对时间)
  journal?: {
    name: string | null;
    impactFactor: number | null;
    partition: string | null;
  } | null;
}

// PR #186: 相对时间格式化 (与 ContentPage 同逻辑)
function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString("zh-CN");
}

export interface ContentListItemProps {
  item: WorkbenchListItem;
  selected: boolean;       // 单选高亮 (preview pane 跟着切)
  multiSelected?: boolean; // 5-23 PR #161: 多选模式勾中 (批量发布)
  onClick: () => void;
  onToggleSelect?: () => void; // 5-23 PR #161: 复选框 onChange
}

export default function ContentListItem({
  item,
  selected,
  multiSelected = false,
  onClick,
  onToggleSelect,
}: ContentListItemProps) {
  const j = item.journal;
  const keyword = (item.metadata as { keyword?: string } | null | undefined)?.keyword;
  const meta: string[] = [];
  if (j?.name) meta.push(j.name);
  if (j?.impactFactor != null) meta.push(`IF ${j.impactFactor}`);
  if (j?.partition) meta.push(j.partition);
  if (keyword) meta.push(`#${keyword}`);

  // 单选 selected → 蓝色填充, 多选勾 → 紫色 ring (不冲突, 可叠加)
  // 边框逻辑: multiSelected 加 ring, selected 加 bg
  const borderClass = multiSelected
    ? "ring-2 ring-purple-300 border-purple-200"
    : selected
      ? "border-blue-300"
      : "border-gray-200 hover:border-gray-300";
  const bgClass = selected ? "bg-blue-50" : multiSelected ? "bg-purple-50/30" : "bg-white hover:bg-gray-50";

  return (
    <div className={`w-full flex items-start gap-2 px-3 py-2.5 rounded-lg border transition-colors ${borderClass} ${bgClass}`}>
      {/* 5-23 PR #161: Gmail 风 always-on checkbox; 始终可见但点击 onChange 仅触发多选, 不影响单选 */}
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={multiSelected}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 shrink-0 cursor-pointer"
          aria-label={`多选 ${item.title || ""}`}
        />
      )}
      <button onClick={onClick} className="flex-1 min-w-0 text-left">
        <p className={`text-sm font-medium line-clamp-2 ${selected ? "text-blue-900" : "text-gray-900"}`}>
          {item.type === "video" ? (
            <span className="inline-block align-middle mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-100 text-rose-700">🎬 视频</span>
          ) : (
            <span className="inline-block align-middle mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-100 text-sky-700">📄 图文</span>
          )}
          {item.status === "needs_review" && (
            <span className="inline-block align-middle mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">待审</span>
          )}
          {(item.metadata as { hasWarnings?: boolean } | null | undefined)?.hasWarnings && (
            <span className="inline-block align-middle mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-700">⚠️校验</span>
          )}
          {/* 7-06 ②: 回流确认被运营从公众号后台群发 — 市场选择正信号 */}
          {item.operatorPublished && (
            <span className="inline-block align-middle mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700" title="效果回流发现该文已被运营群发">✅ 运营已选发</span>
          )}
          {item.title || "(无标题)"}
        </p>
        {meta.length > 0 && (
          <p className="text-xs text-gray-500 mt-1 line-clamp-1">{meta.join(" · ")}</p>
        )}
        {/* PR #186: 生成时间 — 解决"分不清哪篇何时生成" */}
        {item.createdAt && (
          <p className="text-xs text-gray-400 mt-1">🕐 {relativeTime(item.createdAt)}</p>
        )}
      </button>
    </div>
  );
}
