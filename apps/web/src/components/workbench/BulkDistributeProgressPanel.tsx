/**
 * 5-23 PR #161 — 批量发布进度面板 (SSE 实时).
 *
 * EventSource 订阅 GET /admin/bulk-distribute/:batchId/stream
 * events: progress (实时计数) / done (含 durationMs)
 * 完成后 [关闭] 按钮, 失败 list 展开折叠.
 */
import { useEffect, useState, useRef } from "react";

interface ProgressData {
  batchId: string;
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  lastFailed?: { contentId: string; accountId: string; error: string };
}

interface DoneData {
  batchId: string;
  success: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface BulkDistributeProgressPanelProps {
  batchId: string | null;
  onClose: () => void;
}

export default function BulkDistributeProgressPanel({ batchId, onClose }: BulkDistributeProgressPanelProps) {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [done, setDone] = useState<DoneData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFailedList, setShowFailedList] = useState(false);
  const failuresRef = useRef<Array<{ contentId: string; accountId: string; error: string }>>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!batchId) return;
    setProgress(null);
    setDone(null);
    setError(null);
    failuresRef.current = [];

    // 用相对路径走 vite proxy / nginx
    const es = new EventSource(`/api/v1/admin/bulk-distribute/${batchId}/stream`, { withCredentials: true });
    esRef.current = es;

    es.addEventListener("progress", (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as ProgressData;
        setProgress(d);
        if (d.lastFailed && !failuresRef.current.some((f) => f.contentId === d.lastFailed!.contentId && f.accountId === d.lastFailed!.accountId)) {
          failuresRef.current.push(d.lastFailed);
        }
      } catch { /* parse 失败忽略 */ }
    });

    es.addEventListener("done", (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as DoneData;
        setDone(d);
        es.close();
      } catch { /* */ }
    });

    es.onerror = () => {
      setError("SSE 连接断开 (可能服务器重启或网络异常)");
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [batchId]);

  if (!batchId) return null;

  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const success = progress?.success ?? 0;
  const failed = progress?.failed ?? 0;
  const skipped = progress?.skipped ?? 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white flex items-center justify-between">
        <div>
          <div className="text-sm font-bold">📤 批量发布进度</div>
          <div className="text-[11px] text-blue-100 mt-0.5">{batchId}</div>
        </div>
        <button onClick={onClose} className="text-white/80 hover:text-white text-xl leading-none" title="关闭">×</button>
      </div>

      <div className="p-4 space-y-3">
        <div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${done ? "bg-green-500" : "bg-blue-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>{completed} / {total}</span>
            <span>{pct}%</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="px-2 py-2 bg-green-50 rounded-lg">
            <div className="text-lg font-bold text-green-600">{success}</div>
            <div className="text-[11px] text-gray-500">成功</div>
          </div>
          <div className="px-2 py-2 bg-red-50 rounded-lg">
            <div className="text-lg font-bold text-red-600">{failed}</div>
            <div className="text-[11px] text-gray-500">失败</div>
          </div>
          <div className="px-2 py-2 bg-gray-50 rounded-lg">
            <div className="text-lg font-bold text-gray-600">{skipped}</div>
            <div className="text-[11px] text-gray-500">已跳过</div>
          </div>
        </div>

        {failuresRef.current.length > 0 && (
          <div>
            <button
              onClick={() => setShowFailedList(!showFailedList)}
              className="text-xs text-red-600 hover:underline"
            >
              {showFailedList ? "▼" : "▶"} 失败详情 ({failuresRef.current.length})
            </button>
            {showFailedList && (
              <ul className="mt-2 max-h-32 overflow-y-auto text-[11px] space-y-1 bg-red-50 rounded p-2">
                {failuresRef.current.map((f, i) => (
                  <li key={i} className="text-red-700">
                    <span className="font-mono">{f.contentId.slice(0, 8)}.../{f.accountId.slice(0, 8)}...</span> — {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {done && (
          <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
            ✅ 完成! 用时 {(done.durationMs / 1000).toFixed(1)}s
          </div>
        )}

        {error && (
          <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}
      </div>
    </div>
  );
}
