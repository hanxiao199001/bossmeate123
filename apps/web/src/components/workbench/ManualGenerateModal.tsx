/**
 * 5-23 PR #161 — admin 手动生成图文 modal.
 *
 * 调 POST /admin/generate-article → 拿 batchId → poll GET /batch/:id 至 row[0].status='generated' → onComplete(contentId)
 * 失败 / 超时 (>120s) 显示 error + retry 按钮.
 *
 * UX: 单字段表单 (topic + template radio + 可选 journalId), 极简上线 v1.
 * v2 加 journal autocomplete (post-demo backlog).
 */
import { useState, useEffect, useRef } from "react";
import { api } from "../../utils/api";

type Template = "A" | "B" | "C" | "E";

const TEMPLATE_LABELS: Record<Template, { name: string; desc: string }> = {
  A: { name: "A 学术", desc: "适合 SCI/SSCI 期刊推荐" },
  B: { name: "B 营销", desc: "适合公众号引流文" },
  C: { name: "C 解读", desc: "深度论文解读" },
  E: { name: "E 行业", desc: "适合产业研究" },
};

interface BatchRow {
  status: string;
  articleId: string | null;
  errorMessage: string | null;
}

interface ManualGenerateModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (contentId: string) => void; // 文章生成完跳工坊
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 120_000;

export default function ManualGenerateModal({ open, onClose, onComplete }: ManualGenerateModalProps) {
  const [topic, setTopic] = useState("");
  const [template, setTemplate] = useState<Template>("A");
  const [journalId, setJournalId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  // 清理 timer
  const cleanup = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => cleanup, []);

  // poll batch status
  useEffect(() => {
    if (!batchId || !generating) return;
    startedAtRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed > MAX_WAIT_MS) {
        cleanup();
        setError("生成超时 (120s), 请重试");
        setGenerating(false);
        return;
      }
      try {
        const res = await api.get<{ batch: any; rows: BatchRow[] }>(`/batch/${batchId}`);
        const row = (res.data as any)?.rows?.[0];
        if (!row) return;
        if (row.status === "generated" && row.articleId) {
          cleanup();
          setGenerating(false);
          onComplete(row.articleId);
        } else if (row.status === "failed") {
          cleanup();
          setError(row.errorMessage || "生成失败");
          setGenerating(false);
        }
      } catch {
        // 单次轮询失败不中断 (网络抖动)
      }
    }, POLL_INTERVAL_MS);
    return cleanup;
  }, [batchId, generating, onComplete]);

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    if (topic.trim().length < 2) {
      setError("topic 至少 2 个字符");
      return;
    }
    setGenerating(true);
    setElapsedMs(0);
    try {
      const body: Record<string, unknown> = { topic: topic.trim(), template };
      if (journalId.trim()) body.journalId = journalId.trim();
      const res = await api.post<{ batchId: string }>("/admin/generate-article", body);
      const id = (res.data as any)?.batchId;
      if (!id) throw new Error("无 batchId 返回");
      setBatchId(id);
    } catch (err: any) {
      setError(err?.message || "请求失败");
      setGenerating(false);
    }
  };

  const handleCancel = () => {
    if (generating) {
      if (!confirm("生成中, 确认取消? (后台 batch 不会停)")) return;
    }
    cleanup();
    setGenerating(false);
    setBatchId(null);
    setTopic("");
    setJournalId("");
    setError(null);
    setElapsedMs(0);
    onClose();
  };

  const elapsedSec = Math.floor(elapsedMs / 1000);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">+ 生成图文</h2>
          <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">主题 (topic)</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="如: Q1 心理学投稿指南"
              disabled={generating}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">模板</label>
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

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">期刊 ID (可选, 留空则自动匹配)</label>
            <input
              type="text"
              value={journalId}
              onChange={(e) => setJournalId(e.target.value)}
              placeholder="UUID, 留空让系统推荐 top1"
              disabled={generating}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
            />
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {generating && (
            <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span>生成中... ({elapsedSec}s / 60s 预计)</span>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={handleCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            {generating ? "取消" : "关闭"}
          </button>
          <button
            onClick={handleSubmit}
            disabled={generating || topic.trim().length < 2}
            className={`px-4 py-2 text-sm font-medium rounded-lg ${
              generating || topic.trim().length < 2
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {generating ? "生成中..." : "生成"}
          </button>
        </div>
      </div>
    </div>
  );
}
