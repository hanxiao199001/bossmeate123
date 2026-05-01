/**
 * 编辑历史 Drawer（task #21，T4-2-3）。
 *
 * 自写 Drawer（同 T4-2-2 Modal 模式，不引 shadcn / Radix）：
 *   - 右侧滑入 480px；移动端 max-w-[90vw] 自适应
 *   - 蒙层 click-关闭 + ESC 关闭
 *   - 内嵌 EditHistoryCard 时间线，loading / error / empty 三态
 */

import { useEffect } from "react";
import { useEditHistory } from "../hooks/useEditHistory";
import EditHistoryCard from "./EditHistoryCard";

interface Props {
  contentId: string;
  open: boolean;
  onClose: () => void;
  /** templateId → 模板中文名 */
  resolveTemplateName?: (id: string) => string | undefined;
  /** 父级触发刷新的 nonce（task #20 onApplied 后递增触发 refetch） */
  refreshNonce?: number;
}

export default function EditTimelineDrawer({
  contentId,
  open,
  onClose,
  resolveTemplateName,
  refreshNonce,
}: Props) {
  const { edits, loading, error, refetch } = useEditHistory(contentId, open);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 应用改段成功后立即刷新（task #20 衔接）
  useEffect(() => {
    if (open && refreshNonce !== undefined) {
      refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce]);

  return (
    <>
      {/* 蒙层 */}
      <div
        className={`fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden
      />
      {/* Drawer 容器 */}
      <aside
        className={`fixed right-0 top-0 z-50 h-full w-[480px] max-w-[90vw] bg-white shadow-2xl transform transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="编辑历史"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900">
            📝 编辑历史
            {edits.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">· {edits.length} 次</span>
            )}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-4 overflow-y-auto h-[calc(100%-64px)]">
          {loading && edits.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              加载中...
            </div>
          )}
          {error && (
            <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
              {error}
              <button onClick={refetch} className="ml-2 text-blue-600 underline text-xs">
                重试
              </button>
            </div>
          )}
          {!loading && !error && edits.length === 0 && (
            <p className="text-sm text-gray-500 italic">暂无编辑历史</p>
          )}
          <div className="space-y-3">
            {edits.map((e) => (
              <EditHistoryCard key={e.id} edit={e} resolveTemplateName={resolveTemplateName} />
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
