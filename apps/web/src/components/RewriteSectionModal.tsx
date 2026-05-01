/**
 * AI 改段对话框（task #20，T4-2-2 frontend）。
 *
 * 流程：
 *  1. 选章节（从 currentBody 切出的 H2 列表）
 *  2. 输入指令（如"扩写到 300 字 / 改成更口语化 / 加一组数据例子"）
 *  3. 点"AI 预览" → 后端跑 deepseek-reasoner 重写 → 返 diff
 *  4. 行级 LCS 红绿色块展示原文 vs 新版
 *  5. 老板满意点"应用" → POST apply-rewrite → 更新 editBody + 触发 onApplied
 *
 * 不引新依赖（Modal / Diff 全自写）。
 */

import { useEffect, useState } from "react";
import { useSectionRewrite } from "../hooks/useSectionRewrite";
import { diffLines, type DiffSegment } from "../utils/lcs-diff";

interface Props {
  contentId: string;
  /** 当前编辑器中的 body（用来切 H2 + 应用后更新） */
  currentBody: string;
  /** 默认选中的章节 heading（如 user 在编辑器选中某行触发改段时透传） */
  defaultSectionHeading?: string;
  open: boolean;
  onClose: () => void;
  /** apply 成功后回调，把 server 返的 updatedBody 推回 ContentDetailPage */
  onApplied: (updatedBody: string) => void;
}

export default function RewriteSectionModal({
  contentId,
  currentBody,
  defaultSectionHeading,
  open,
  onClose,
  onApplied,
}: Props) {
  const { sections, preview, previewing, applying, requestPreview, applyRewrite, reset } =
    useSectionRewrite(contentId, currentBody);

  const [sectionHeading, setSectionHeading] = useState<string>("");
  const [instruction, setInstruction] = useState<string>("");

  // 打开时初始化默认章节 + 清状态
  useEffect(() => {
    if (!open) return;
    reset();
    setInstruction("");
    if (defaultSectionHeading && sections.some((s) => s.heading === defaultSectionHeading)) {
      setSectionHeading(defaultSectionHeading);
    } else {
      setSectionHeading(sections[0]?.heading ?? "");
    }
    // 仅依赖 open 与 defaultSectionHeading；sections 变化由父级 currentBody 驱动，重渲染时已最新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultSectionHeading]);

  if (!open) return null;

  const canPreview = sectionHeading && instruction.trim().length > 0 && !previewing;
  const canApply = preview && !applying;

  const handlePreview = async () => {
    if (!canPreview) return;
    await requestPreview(sectionHeading, instruction.trim());
  };

  const handleApply = async () => {
    if (!preview) return;
    const result = await applyRewrite(sectionHeading, preview.rewritten.body, instruction.trim());
    if (result?.updatedBody) {
      onApplied(result.updatedBody);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">✨ AI 改段</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">
            ×
          </button>
        </header>

        <div className="px-6 py-4 space-y-4">
          {/* 章节选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">章节</label>
            {sections.length === 0 ? (
              <p className="text-sm text-gray-500 bg-gray-50 px-3 py-2 rounded">
                正文没有 ## 章节，无法做章节重写
              </p>
            ) : (
              <select
                value={sectionHeading}
                onChange={(e) => setSectionHeading(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {sections.map((s) => (
                  <option key={s.heading} value={s.heading}>
                    {s.headingText}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* 指令输入 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">改段指令</label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="例如：扩写到 300 字 / 改成更口语化 / 加一组真实数据例子"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1">{instruction.length} / 500</p>
          </div>

          {/* 预览按钮 */}
          <div className="flex justify-end">
            <button
              onClick={handlePreview}
              disabled={!canPreview}
              className={`px-4 py-2 text-sm font-medium rounded transition-all ${
                canPreview
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {previewing ? "AI 重写中..." : preview ? "重新预览" : "AI 预览"}
            </button>
          </div>

          {/* Diff 预览 */}
          {preview && (
            <div className="border border-gray-200 rounded">
              <header className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-600">
                行级 diff 预览（耗时 {preview.durationMs}ms · {preview.tokensUsed} tokens）
              </header>
              <DiffView original={preview.original.body} rewritten={preview.rewritten.body} />
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-6 py-3 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleApply}
            disabled={!canApply}
            className={`px-4 py-1.5 text-sm font-medium rounded transition-all ${
              canApply ? "bg-green-600 text-white hover:bg-green-700" : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {applying ? "应用中..." : "应用"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DiffView({ original, rewritten }: { original: string; rewritten: string }) {
  const segments: DiffSegment[] = diffLines(original, rewritten);
  return (
    <div className="font-mono text-xs leading-5 max-h-80 overflow-y-auto">
      {segments.map((seg, i) => {
        const cls =
          seg.type === "added"
            ? "bg-green-50 text-green-800 border-l-4 border-green-400"
            : seg.type === "removed"
              ? "bg-red-50 text-red-800 border-l-4 border-red-400 line-through"
              : "text-gray-600 border-l-4 border-transparent";
        const prefix = seg.type === "added" ? "+ " : seg.type === "removed" ? "- " : "  ";
        return (
          <div key={i} className={`whitespace-pre-wrap px-2 py-0.5 ${cls}`}>
            <span className="select-none text-gray-400 mr-2">{prefix}</span>
            {seg.text || " "}
          </div>
        );
      })}
    </div>
  );
}
