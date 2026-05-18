/**
 * 5-23 PR #161 — Workbench 顶部工具栏 (在 ContentTabBar 之上).
 *
 * left: [+ 生成图文] [+ 生成视频] 2 个按钮 (admin only — 由父组件 role check 后才挂)
 * right: 已选 N 篇 badge (N>0 才显示)
 */
export interface WorkbenchTopBarProps {
  selectedCount: number;
  onClickGenerateArticle: () => void;
  onClickGenerateVideo: () => void;
  onClickClearSelection?: () => void;
}

export default function WorkbenchTopBar({
  selectedCount,
  onClickGenerateArticle,
  onClickGenerateVideo,
  onClickClearSelection,
}: WorkbenchTopBarProps) {
  return (
    <div className="bg-white border-b border-gray-100 px-4 py-2.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={onClickGenerateArticle}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
        >
          + 生成图文
        </button>
        <button
          onClick={onClickGenerateVideo}
          className="px-3 py-1.5 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 active:scale-95 transition-all"
        >
          🎬 生成视频
        </button>
      </div>

      {selectedCount > 0 && (
        <div className="flex items-center gap-2">
          <span className="px-3 py-1 bg-green-100 text-green-700 text-sm font-medium rounded-md">
            已选 {selectedCount} 篇 → 批量发布
          </span>
          {onClickClearSelection && (
            <button
              onClick={onClickClearSelection}
              className="text-xs text-gray-400 hover:text-red-500 px-2 py-1"
              title="清空多选"
            >
              清空
            </button>
          )}
        </div>
      )}
    </div>
  );
}
