/**
 * PR #173 — "一键 N 篇" 生成 modal.
 *
 * 砍掉 topic input + journal dropdown, 改为选数量 (3/5/10/自定义) + 模板.
 * 系统自动选 keyword + journal (复用 daily-cron 多样性逻辑).
 *
 * POST /admin/generate-article { count, template }
 * 返回 { batchIds: [...N], estimatedSeconds }
 * poll 所有 batch 至全完成 → 跳 /workbench?tab=draft
 */
import { useState, useEffect, useRef } from "react";
import { api } from "../../utils/api";

type Template = "A" | "B" | "C" | "E";
type CountOption = 3 | 5 | 10 | "custom";

const TEMPLATE_LABELS: Record<Template, { name: string; desc: string }> = {
  A: { name: "A 学术", desc: "适合 SCI/SSCI 期刊推荐" },
  B: { name: "B 营销", desc: "适合公众号引流文" },
  C: { name: "C 解读", desc: "深度论文解读" },
  E: { name: "E 行业", desc: "适合产业研究" },
};

const COUNT_OPTIONS: { value: CountOption; label: string; time: string }[] = [
  { value: 3, label: "3 篇", time: "~20 秒" },
  { value: 5, label: "5 篇", time: "~30 秒" },
  { value: 10, label: "10 篇", time: "~60 秒" },
  { value: "custom", label: "自定义", time: "" },
];

interface ManualGenerateModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (contentId: string) => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 300_000; // 5 分钟

export default function ManualGenerateModal({ open, onClose, onComplete }: ManualGenerateModalProps) {
  const [countOption, setCountOption] = useState<CountOption>(5);
  const [customCount, setCustomCount] = useState(5);
  const [template, setTemplate] = useState<Template>("A");
  const [generating, setGenerating] = useState(false);
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const actualCount = countOption === "custom" ? customCount : countOption;

  const cleanup = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => cleanup, []);

  // poll all batch statuses
  useEffect(() => {
    if (batchIds.length === 0 || !generating) return;
    startedAtRef.current = Date.now();
    const doneSet = new Set<string>();

    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed > MAX_WAIT_MS) {
        cleanup();
        setError(`生成超时 (${Math.floor(MAX_WAIT_MS / 1000)}s), 已完成 ${doneSet.size}/${batchIds.length} 篇`);
        setGenerating(false);
        return;
      }
      for (const bid of batchIds) {
        if (doneSet.has(bid)) continue;
        try {
          const res = await api.get<{ batch: any; rows: any[] }>(`/batch/${bid}`);
          const row = (res.data as any)?.rows?.[0];
          if (row?.status === "generated" || row?.status === "failed") {
            doneSet.add(bid);
            setCompletedCount(doneSet.size);
          }
        } catch { /* ignore single poll failure */ }
      }
      if (doneSet.size >= batchIds.length) {
        cleanup();
        setGenerating(false);
        // 找任意一个成功的 articleId 跳转
        onComplete(""); // 空串触发刷新 workbench
      }
    }, POLL_INTERVAL_MS);
    return cleanup;
  }, [batchIds, generating, onComplete]);

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    if (actualCount < 1 || actualCount > 20) {
      setError("数量需在 1-20 之间");
      return;
    }
    setGenerating(true);
    setElapsedMs(0);
    setCompletedCount(0);
    try {
      const res = await api.post<{ data: { batchIds: string[]; estimatedSeconds: number } }>(
        "/admin/generate-article",
        { count: actualCount, template },
      );
      const ids = (res.data as any)?.data?.batchIds ?? (res.data as any)?.batchIds ?? [];
      if (!ids.length) throw new Error("无 batchId 返回");
      setBatchIds(ids);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "请求失败");
      setGenerating(false);
    }
  };

  const handleCancel = () => {
    if (generating) {
      if (!confirm("生成中, 确认取消? (后台 batch 不会停)")) return;
    }
    cleanup();
    setGenerating(false);
    setBatchIds([]);
    setCompletedCount(0);
    setError(null);
    setElapsedMs(0);
    onClose();
  };

  const elapsedSec = Math.floor(elapsedMs / 1000);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">+ 一键生成图文</h2>
          <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="space-y-4">
          {/* 生成数量 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">生成数量</label>
            <div className="grid grid-cols-2 gap-2">
              {COUNT_OPTIONS.map((opt) => (
                <label
                  key={String(opt.value)}
                  className={`px-3 py-2 border rounded-lg cursor-pointer text-sm ${
                    countOption === opt.value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:border-gray-300"
                  } ${generating ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <input
                    type="radio"
                    name="count"
                    checked={countOption === opt.value}
                    onChange={() => setCountOption(opt.value)}
                    disabled={generating}
                    className="hidden"
                  />
                  <div className="font-medium">{opt.label}</div>
                  {opt.time && <div className="text-[11px] text-gray-400">{opt.time}</div>}
                </label>
              ))}
            </div>
            {countOption === "custom" && (
              <input
                type="number"
                min={1}
                max={20}
                value={customCount}
                onChange={(e) => setCustomCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                disabled={generating}
                className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
                placeholder="1-20"
              />
            )}
          </div>

          {/* 模板风格 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">模板风格</label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => (
                <label
                  key={t}
                  className={`px-3 py-2 border rounded-lg cursor-pointer text-sm ${
                    template === t ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:border-gray-300"
                  } ${generating ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t}
                    checked={template === t}
                    onChange={() => setTemplate(t)}
                    disabled={generating}
                    className="hidden"
                  />
                  <div className="font-medium">{TEMPLATE_LABELS[t].name}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{TEMPLATE_LABELS[t].desc}</div>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {generating && (
            <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
                <span>生成中... {completedCount}/{batchIds.length} 篇完成 ({elapsedSec}s)</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-1.5">
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all"
                  style={{ width: `${batchIds.length > 0 ? (completedCount / batchIds.length) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={handleCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            {generating ? "取消" : "关闭"}
          </button>
          <button
            onClick={handleSubmit}
            disabled={generating}
            className={`px-4 py-2 text-sm font-medium rounded-lg ${
              generating
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {generating ? "生成中..." : `一键生成 ${actualCount} 篇`}
          </button>
        </div>
      </div>
    </div>
  );
}
