/**
 * 5-23 PR #161 — Workbench 顶部工具栏 (在 ContentTabBar 之上).
 *
 * 6-11 施工包C2-b (审计1.1): 生成链路收敛 — ContentPage"高级模式"的 AI推荐/批量CSV 迁到这里,
 * 8步选题创作流水线降级为低调的「专家模式」链接。布局: 左=3主按钮+2次级按钮, 右=专家模式链接+已选badge。
 *
 * left: [生成图文][生成视频][多刊盘点] 主按钮 + [AI推荐][批量CSV] 次级按钮 (6-11 UI升级: emoji→SVG 图标)
 * right: [专家模式] 链接 + 已选 N 篇 badge (N>0 才显示)
 */
import { Link } from "react-router-dom";
import { IconPlus, IconVideo, IconFileText, IconSparkles, IconUpload, IconWand } from "../ui/Icons";

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
    <div className="bg-white border-b border-slate-200/70 px-4 py-2.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onClickGenerateArticle}
          className="inline-flex items-center gap-1.5 px-4 h-9 text-sm font-medium bg-indigo-600 text-white rounded-lg shadow-sm hover:bg-indigo-500 active:scale-95 transition-all"
        >
          <IconPlus size={14} />
          <span>生成图文</span>
        </button>
        <button
          onClick={onClickGenerateVideo}
          className="inline-flex items-center gap-1.5 px-4 h-9 text-sm font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:border-slate-300 active:scale-95 transition-all"
        >
          <IconVideo size={14} className="text-slate-400" />
          <span>生成视频</span>
        </button>
        <button
          onClick={onClickGenerateRoundup}
          className="inline-flex items-center gap-1.5 px-4 h-9 text-sm font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:border-slate-300 active:scale-95 transition-all"
        >
          <IconFileText size={14} className="text-slate-400" />
          <span>多刊盘点</span>
        </button>

        <span className="w-px h-5 bg-slate-200 mx-1" aria-hidden />

        <button
          onClick={onClickRecommend}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:border-slate-300 active:scale-95 transition-all"
          title="AI 按学科/期刊推荐选题并生成"
        >
          <IconSparkles size={13} className="text-indigo-500" />
          <span>AI 推荐</span>
        </button>
        <button
          onClick={onClickBatchCsv}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:border-slate-300 active:scale-95 transition-all"
          title="上传 CSV 批量生成文章"
        >
          <IconUpload size={13} className="text-slate-400" />
          <span>批量 CSV</span>
        </button>
      </div>

      <div className="flex items-center gap-3">
        {selectedCount > 0 && (
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 bg-emerald-50 text-emerald-700 text-sm font-medium rounded-full">
              已选 {selectedCount} 篇 → 批量发布
            </span>
            {onClickClearSelection && (
              <button
                onClick={onClickClearSelection}
                className="text-xs text-slate-400 hover:text-rose-500 px-2 py-1"
                title="清空多选"
              >
                清空
              </button>
            )}
          </div>
        )}
        <Link
          to="/workflow/article"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 whitespace-nowrap transition-colors"
          title="8步选题创作流水线"
        >
          <IconWand size={12} />
          <span>专家模式</span>
        </Link>
      </div>
    </div>
  );
}
