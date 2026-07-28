/**
 * 5-23 PR #161 — 批量发布进度面板.
 * PR #219 (5-23): 从 SSE(EventSource) 改为轮询 —— EventSource 不能带 Authorization 头,
 *   而后端 @fastify/jwt 只认 Bearer 头, 导致 SSE 必 401 断连("SSE 连接断开")。
 *   改用 api.get 轮询 GET /admin/bulk-distribute/:batchId (走 Bearer 头), 1.5s 一次, 完成即停。
 */
import { useEffect, useState, useRef } from "react";
import { api } from "../../utils/api";
import { platformShortLabel } from "../../utils/platforms";

interface ItemResult {
  contentId: string;
  accountId: string;
  accountName: string;
  platform: string;
  status: "pending" | "success" | "failed" | "skipped" | "dispatched";
  error?: string;
}

interface ProgressData {
  batchId: string;
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  dispatched?: number;
  lastFailed?: { contentId: string; accountId: string; error: string };
  items?: ItemResult[];
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

const STATUS_META: Record<string, { label: string; badge: string; row: string }> = {
  success: { label: "成功", badge: "bg-green-100 text-green-700", row: "bg-green-50" },
  failed:  { label: "失败", badge: "bg-red-100 text-red-700", row: "bg-red-50" },
  dispatched: { label: "已派单", badge: "bg-amber-100 text-amber-700", row: "bg-amber-50" },
  skipped: { label: "跳过", badge: "bg-gray-200 text-gray-600", row: "bg-gray-50" },
  pending: { label: "进行中", badge: "bg-blue-100 text-blue-700", row: "bg-blue-50" },
};

export default function BulkDistributeProgressPanel({ batchId, onClose }: BulkDistributeProgressPanelProps) {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [done, setDone] = useState<DoneData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFailedList, setShowFailedList] = useState(true);
  const failuresRef = useRef<Array<{ contentId: string; accountId: string; error: string }>>([]);

  useEffect(() => {
    if (!batchId) return;
    setProgress(null);
    setDone(null);
    setError(null);
    failuresRef.current = [];

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let errCount = 0;

    const poll = async () => {
      try {
        const res = await api.get<ProgressData & { finished: boolean; durationMs: number | null }>(
          `/admin/bulk-distribute/${batchId}`,
        );
        const d = res.data;
        if (!d) throw new Error("无进度数据");
        errCount = 0;
        setProgress(d);
        if (d.lastFailed && !failuresRef.current.some((f) => f.contentId === d.lastFailed!.contentId && f.accountId === d.lastFailed!.accountId)) {
          failuresRef.current.push(d.lastFailed);
        }
        if (d.finished) {
          setDone({ batchId, success: d.success, failed: d.failed, skipped: d.skipped, durationMs: d.durationMs ?? 0 });
          return; // 完成, 停止轮询
        }
      } catch {
        errCount += 1;
        // 容忍偶发抖动; 连续 5 次失败才报错 (batch 过期 10 分钟也会落这里)
        if (errCount >= 5) { setError("无法获取批量发布进度 (请刷新页面重试)"); return; }
      }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId]);

  if (!batchId) return null;

  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const success = progress?.success ?? 0;
  const failed = progress?.failed ?? 0;
  const skipped = progress?.skipped ?? 0;
  const dispatched = progress?.dispatched ?? 0;
  const items = progress?.items ?? [];

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

        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="px-1 py-2 bg-green-50 rounded-lg">
            <div className="text-lg font-bold text-green-600">{success}</div>
            <div className="text-[11px] text-gray-500">成功</div>
          </div>
          <div className="px-1 py-2 bg-amber-50 rounded-lg">
            <div className="text-lg font-bold text-amber-600">{dispatched}</div>
            <div className="text-[11px] text-gray-500">已派单</div>
          </div>
          <div className="px-1 py-2 bg-red-50 rounded-lg">
            <div className="text-lg font-bold text-red-600">{failed}</div>
            <div className="text-[11px] text-gray-500">失败</div>
          </div>
          <div className="px-1 py-2 bg-gray-50 rounded-lg">
            <div className="text-lg font-bold text-gray-600">{skipped}</div>
            <div className="text-[11px] text-gray-500">已跳过</div>
          </div>
        </div>

        {dispatched > 0 && (
          <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-800 leading-relaxed">
            ⚠️ <b>已派单 ≠ 已发布</b>：抖音/视频号是派给客户电脑上的发布客户端，需该账号<b>已在客户电脑登录</b>且客户端在线领取后才会真正发布。请确认对应账号已扫码登录。
          </div>
        )}

        {items.length > 0 && (
          <div>
            <button
              onClick={() => setShowFailedList(!showFailedList)}
              className="text-xs text-gray-600 hover:underline"
            >
              {showFailedList ? "▼" : "▶"} 各账号明细 ({items.length})
            </button>
            {showFailedList && (
              <ul className="mt-2 max-h-48 overflow-y-auto text-xs space-y-1">
                {items.map((it, i) => {
                  const meta = STATUS_META[it.status];
                  return (
                    <li key={i} className={`flex items-center gap-2 px-2 py-1.5 rounded ${meta.row}`}>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${meta.badge}`}>{meta.label}</span>
                      <span className="flex-1 min-w-0 truncate text-gray-800">
                        {platformShortLabel(it.platform)} · {it.accountName}
                      </span>
                      {it.status === "failed" && it.error && (
                        <span className="text-red-600 truncate max-w-[120px]" title={it.error}>{it.error}</span>
                      )}
                    </li>
                  );
                })}
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
