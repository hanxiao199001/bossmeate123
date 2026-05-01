/**
 * useEditHistory hook（task #21，T4-2-3）。
 *
 * 拉 GET /content/:id/edits → 返回时间线列表 + loading/error。
 * 暴露 refetch 给 ContentDetailPage 在 applyRewrite 成功后立即刷新（task #20 衔接）。
 */

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../utils/api";

export interface BossEditRow {
  id: string;
  contentId: string;
  action: string; // select_variant | rewrite_section | approve | edit | reject
  originalTitle: string | null;
  editedTitle: string | null;
  originalBody: string | null;
  editedBody: string | null;
  rejectReason: string | null;
  editDistance: number | null;
  patternsExtracted: Record<string, unknown> | null;
  createdAt: string;
}

interface ListResponse {
  edits: BossEditRow[];
  total: number;
}

export function useEditHistory(contentId: string | undefined, enabled: boolean) {
  const [edits, setEdits] = useState<BossEditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!contentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ListResponse>(`/content/${contentId}/edits`);
      if (res.data) {
        setEdits(res.data.edits || []);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("编辑历史加载失败");
      }
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => {
    if (enabled && contentId) {
      fetchHistory();
    }
    // 关闭 Drawer 不清空 edits（避免重开闪烁，靠 fetchHistory 覆盖最新）
  }, [enabled, contentId, fetchHistory]);

  return { edits, loading, error, refetch: fetchHistory };
}
