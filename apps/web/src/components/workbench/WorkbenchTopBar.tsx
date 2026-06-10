/**
 * 5-23 PR #161 — Workbench 顶部工具栏 (在 ContentTabBar 之上).
 *
 * 6-11 施工包C2-b (审计1.1): 生成链路收敛 — ContentPage"⚙️高级模式"的 AI推荐/批量CSV 迁到这里,
 * 8步选题创作流水线降级为低调的「专家模式」链接。布局: 左=3主按钮+2次级按钮, 右=专家模式链接+已选badge。
 *
 * left: [+ 生成图文][🎬 生成视频][📚 多刊盘点] 主按钮 + [🤖 AI推荐][📤 批量CSV] 次级按钮
 * right: [专家模式] 链接 + 已选 N 篇 badge (N>0 才显示)
 */
import { Link } from "react-router-dom";

export interface WorkbenchTopBarProps {
  selectedCount: number;
  onClickGenerateArticle: () => void;
  onClickGenerateVideo: () => void;
  onClickGenerateRoundup: () => void;
  /** 6-11 C2-b: AI 推荐 modal (原 ContentPage 高级模式) */
  onClickRecommend: () => void;
  /** 6-11 C2-b: 批量 CSV 导入 modal (原 ContentPage 高级模式) */
  onClickBatchCsv: () => void;
  onClickClearSelection?: () => void;
}

export default function WorkbenchTopBar({
  selectedCount,
  onClickGenerateArticle,
  onClickGenerateVideo,
  onClickGenerateRoundup,
  onClickRecommend,
  onClickBatchCsv,
  onClickClearSelection,
}: WorkbenchTopBarProps) {
  return (
    <div className="bg-white border-b border-gray-100 px-4 py-2.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
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
        <button
          onClick={onClickGenerateRoundup}
          className="px-3 py-1.5 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 active:scale-95 transition-all"
        >
          📚 多刊盘点
        </button>

        <span className="w-px h-5 bg-gray-200 mx-1" aria-hidden />

        <button
          onClick={onClickRecommend}
          className="px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 active:scale-95 transition-all"
          title="AI 按学科/期刊推荐选题并生成"
        >
          🤖 AI 推荐
        </button>
        <button
          onClick={onClickBatchCsv}
          className="px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 active:scale-95 transition-all"
          title="上传 CSV 批量生成文章"
        >
          📤 批量 CSV
        </button>
      </div>

      <div className="flex items-center gap-3">
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
        <Link
          to="/workflow/article"
          className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap"
          title="8步选题创作流水线"
        >
          🛠 专家模式
        </Link>
      </div>
    </div>
  );
}
