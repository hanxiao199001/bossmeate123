/**
 * P4 BatchProgressPage（5-13 frontend Day 2）。
 * URL: /batch/:id
 *
 * 功能：
 * - 顶部 stats: 总 / 完成 / 失败 / 预计剩
 * - 进度条
 * - 列表 (table): row / topic / status / article / 操作
 * - 失败行 [🔄 重试] 按钮 → POST /batch/:id/retry/:rowId
 * - 完成后顶部 [📥 下载 CSV 报告]
 * - 5s polling（status='running' 时；完成后停）
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../utils/api";
import { toast } from "../components/Toast";
import PageHeader from "../components/ui/PageHeader";

interface BatchRow {
  id: string;
  rowIndex: number;
  topic: string;
  status: "pending" | "generating" | "generated" | "failed";
  articleId: string | null;
  errorMessage: string | null;
  retryCount: number;
}

interface BatchData {
  batch: {
    id: string;
    filename: string;
    total: number;
    completed: number;
    failed: number;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    createdAt: string;
    updatedAt: string;
  };
  rows: BatchRow[];
}

const STATUS_BADGE: Record<string, { color: string; label: string }> = {
  pending: { color: "bg-gray-100 text-gray-600", label: "等待中" },
  generating: { color: "bg-blue-100 text-blue-700", label: "生成中..." },
  generated: { color: "bg-green-100 text-green-700", label: "✅ 完成" },
  failed: { color: "bg-red-100 text-red-700", label: "❌ 失败" },
};

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.ceil(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}min`;
}

export default function BatchProgressPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<BatchData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const fetchData = () => {
    if (!id) return;
    api.get<BatchData>(`/batch/${id}`)
      .then((r) => r.data && setData(r.data))
      .catch((e) => setErr((e as Error).message || "加载失败"));
  };

  useEffect(() => { fetchData(); }, [id]);

  // 5s polling — status='running' 时；完成后停（spec）
  useEffect(() => {
    if (!data || (data.batch.status !== "running" && data.batch.status !== "pending")) return;
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [data?.batch.status]);

  const retryRow = async (rowId: string) => {
    if (!id) return;
    setRetryingId(rowId);
    try {
      await api.post(`/batch/${id}/retry/${rowId}`, {});
      fetchData();
    } catch (e) {
      toast.error((e as Error).message || "重试失败");
    } finally {
      setRetryingId(null);
    }
  };

  const downloadReport = () => {
    if (!id) return;
    // 6-11 施工包A(审计 5.1): 收编进 api.download(自动带 token,401/失败提示走 api 层统一 toast)
    api.download(`/batch/${id}/report`)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `batch-${id}-report.csv`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => { /* api.download 已统一弹 toast */ });
  };

  if (err) return <div className="min-h-screen bg-[#F6F7F9] flex items-center justify-center text-red-600">❌ {err}</div>;
  if (!data) return <div className="min-h-screen bg-[#F6F7F9] flex items-center justify-center text-gray-400">⏳ 加载中...</div>;

  const { batch, rows } = data;
  const pending = batch.total - batch.completed - batch.failed;
  const progressPct = batch.total > 0 ? Math.round(((batch.completed + batch.failed) / batch.total) * 100) : 0;
  const estRemaining = formatTime(Math.ceil(pending * 30 / 5)); // concurrency 5
  const isDone = batch.status === "completed" || batch.status === "failed";

  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      {/* 6-11 施工包C2-a (审计2.5): 手写顶栏已删, 导航走 MainLayout 侧边栏; 返回链接+标题+下载按钮迁到内容区顶部 */}
      <div className="max-w-6xl mx-auto py-6 px-6">
        <div className="mb-6">
          <Link to="/content" className="text-indigo-600 hover:text-indigo-500 text-sm font-medium">← 返回内容列表</Link>
          <PageHeader
            className="mt-2"
            title="批量生成进度"
            subtitle={<span className="truncate max-w-xs inline-block align-bottom">{batch.filename || batch.id}</span>}
            actions={isDone ? (
              <button onClick={downloadReport} className="px-4 h-9 text-sm font-medium bg-indigo-600 text-white rounded-lg shadow-sm hover:bg-indigo-500 transition-all">
                下载 CSV 报告
              </button>
            ) : undefined}
          />
        </div>
        {/* 4 Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-white rounded-xl border p-4">
            <div className="text-2xl font-bold text-gray-900">{batch.total}</div>
            <div className="text-xs text-gray-500 mt-1">总篇数</div>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <div className="text-2xl font-bold text-green-700">{batch.completed}</div>
            <div className="text-xs text-gray-500 mt-1">✅ 已完成</div>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <div className="text-2xl font-bold text-red-700">{batch.failed}</div>
            <div className="text-xs text-gray-500 mt-1">❌ 失败</div>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <div className="text-2xl font-bold text-blue-700">{isDone ? "—" : estRemaining}</div>
            <div className="text-xs text-gray-500 mt-1">{isDone ? `已 ${batch.status}` : "预计剩余"}</div>
          </div>
        </div>

        {/* 进度条 */}
        <div className="bg-white rounded-xl border p-4 mb-6">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-gray-600">{batch.completed + batch.failed} / {batch.total}</span>
            <span className="font-medium text-gray-900">{progressPct}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${isDone ? "bg-green-500" : "bg-blue-500"}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {!isDone && <div className="text-xs text-gray-400 mt-2">5s 自动刷新中...</div>}
        </div>

        {/* 列表 */}
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="grid grid-cols-12 gap-3 px-4 py-2.5 bg-gray-50 border-b text-xs font-medium text-gray-500">
            <div className="col-span-1 text-center">#</div>
            <div className="col-span-5">topic</div>
            <div className="col-span-2 text-center">状态</div>
            <div className="col-span-2 text-center">article</div>
            <div className="col-span-2 text-center">操作</div>
          </div>
          {rows.map((r) => {
            const badge = STATUS_BADGE[r.status] ?? { color: "bg-gray-100 text-gray-600", label: r.status };
            return (
              <div key={r.id} className="grid grid-cols-12 gap-3 px-4 py-3 border-b items-center hover:bg-blue-50/30">
                <div className="col-span-1 text-center text-xs text-gray-500">{r.rowIndex}</div>
                <div className="col-span-5 text-sm">
                  <div className="text-gray-900 truncate" title={r.topic}>{r.topic}</div>
                  {r.errorMessage && (
                    <div className="text-[10px] text-red-600 mt-0.5 line-clamp-2" title={r.errorMessage}>
                      {r.errorMessage.slice(0, 100)}
                    </div>
                  )}
                </div>
                <div className="col-span-2 text-center">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded ${badge.color}`}>{badge.label}</span>
                  {r.retryCount > 0 && <div className="text-[10px] text-gray-400 mt-0.5">retry × {r.retryCount}</div>}
                </div>
                <div className="col-span-2 text-center text-xs">
                  {r.articleId ? (
                    <Link to={`/content/${r.articleId}`} className="text-blue-600 hover:underline">查看</Link>
                  ) : <span className="text-gray-300">—</span>}
                </div>
                <div className="col-span-2 text-center">
                  {r.status === "failed" && (
                    <button
                      onClick={() => retryRow(r.id)}
                      disabled={retryingId === r.id}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded disabled:opacity-50"
                    >
                      {retryingId === r.id ? "⏳" : "🔄 重试"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
