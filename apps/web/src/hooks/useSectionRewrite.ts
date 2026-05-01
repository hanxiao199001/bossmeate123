/**
 * useSectionRewrite hook（task #20，T4-2-2）。
 *
 * 把 rewrite-section / apply-rewrite API 流程 + H2 章节解析包装一层，
 * RewriteSectionModal 用它取章节列表 + 触发预览 + 提交应用。
 *
 * 后端契约（PR #19 已实现）：
 *  - POST /content/:id/rewrite-section { sectionHeading, instruction }
 *      → { original: {heading,body,startLine,endLine}, rewritten: {heading,body}, ... }
 *  - POST /content/:id/apply-rewrite { sectionHeading, newSectionBody, instruction }
 *      → { contentId, updatedBody, bossEditId }
 */

import { useMemo, useState, useCallback } from "react";
import { api, ApiError } from "../utils/api";
import { toast } from "../components/Toast";

export interface H2Section {
  /** "## 章节标题" 完整行 */
  heading: string;
  /** 标题去 # 后的纯文本 */
  headingText: string;
  /** 正文（不含 heading 行） */
  content: string;
}

export interface PreviewResult {
  original: { heading: string; body: string; startLine: number; endLine: number };
  rewritten: { heading: string; body: string };
  durationMs: number;
  tokensUsed: number;
}

export interface ApplyResult {
  contentId: string;
  updatedBody: string;
  bossEditId: string | null;
}

const H2_REGEX = /^##\s+(.+)$/;

/** 前端切 H2 章节（与 server splitByH2 行为对齐）：仅取 heading 用于下拉。 */
export function splitH2Sections(body: string): H2Section[] {
  const lines = body.split("\n");
  const result: H2Section[] = [];
  let current: { heading: string; headingText: string; startIdx: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = H2_REGEX.exec(lines[i]);
    if (m) {
      if (current) {
        const content = lines.slice(current.startIdx + 1, i).join("\n");
        result.push({ heading: current.heading, headingText: current.headingText, content });
      }
      current = { heading: lines[i], headingText: m[1].trim(), startIdx: i };
    }
  }
  if (current) {
    const content = lines.slice(current.startIdx + 1).join("\n");
    result.push({ heading: current.heading, headingText: current.headingText, content });
  }
  return result;
}

export function useSectionRewrite(contentId: string | undefined, body: string) {
  const sections = useMemo(() => splitH2Sections(body), [body]);

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [applying, setApplying] = useState(false);

  const requestPreview = useCallback(
    async (sectionHeading: string, instruction: string): Promise<PreviewResult | null> => {
      if (!contentId) return null;
      setPreviewing(true);
      setPreview(null);
      try {
        const res = await api.post<PreviewResult>(`/content/${contentId}/rewrite-section`, {
          sectionHeading,
          instruction,
        });
        if (res.data) setPreview(res.data);
        return res.data ?? null;
      } catch (err) {
        // ApiError 已在 api.ts 弹 toast；此处仅返 null 让调用方处理 UI
        if (!(err instanceof ApiError)) toast.error("预览失败，请稍后重试");
        return null;
      } finally {
        setPreviewing(false);
      }
    },
    [contentId],
  );

  const applyRewrite = useCallback(
    async (sectionHeading: string, newSectionBody: string, instruction: string): Promise<ApplyResult | null> => {
      if (!contentId) return null;
      setApplying(true);
      try {
        const res = await api.post<ApplyResult>(`/content/${contentId}/apply-rewrite`, {
          sectionHeading,
          newSectionBody,
          instruction,
        });
        if (res.data) toast.success("章节已更新");
        return res.data ?? null;
      } catch (err) {
        if (!(err instanceof ApiError)) toast.error("应用失败，请稍后重试");
        return null;
      } finally {
        setApplying(false);
      }
    },
    [contentId],
  );

  const reset = useCallback(() => {
    setPreview(null);
    setPreviewing(false);
    setApplying(false);
  }, []);

  return { sections, preview, previewing, applying, requestPreview, applyRewrite, reset };
}
