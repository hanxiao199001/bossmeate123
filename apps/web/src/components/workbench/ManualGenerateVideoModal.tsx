/**
 * 5-23 PR #161 — admin 手动生成视频 modal (双 source).
 *
 * source=from_article: 选已有 article ID → 直接调 POST /admin/generate-video
 *                       → 后台触发 DVH 任务, modal 关掉 (用户去 /videos 看进度)
 * source=from_topic:   填 topic → POST /admin/generate-video → batchId
 *                       → poll /batch/:id 拿 articleId → 调 POST /articles/:id/generate-dvh-video
 *                       → modal 关掉
 *
 * 4 主播 (per memory bossmate_digital_human_avatars):
 *   A_academic / B_marketing / C_popular / E_industry
 */
import { useState, useEffect, useRef } from "react";
import { api } from "../../utils/api";

type Source = "from_article" | "from_topic";
type AvatarTemplate = "A_academic" | "B_marketing" | "C_popular" | "E_industry";

const AVATAR_LABELS: Record<AvatarTemplate, string> = {
  A_academic: "A 学术",
  B_marketing: "B 营销",
  C_popular: "C 大众",
  E_industry: "E 行业",
};

interface BatchRow {
  status: string;
  articleId: string | null;
  errorMessage: string | null;
}

interface ManualGenerateVideoModalProps {
  open: boolean;
  onClose: () => void;
  onTriggered: (info: { mode: "direct" | "pending_article"; articleId?: string; batchId?: string }) => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 120_000;

export default function ManualGenerateVideoModal({ open, onClose, onTriggered }: ManualGenerateVideoModalProps) {
  const [source, setSource] = useState<Source>("from_article");
  const [articleId, setArticleId] = useState("");
  const [topic, setTopic] = useState("");
  const [avatar, setAvatar] = useState<AvatarTemplate>("A_academic");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "generating_article" | "triggering_video">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const cleanup = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => cleanup, []);

  // poll batch for from_topic (待 article ready 后调 generate-dvh-video)
  const startPolling = (batchId: string) => {
    setPhase("generating_article");
    startedAtRef.current = Date.now();
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed > MAX_WAIT_MS) {
        cleanup();
        setError("article 生成超时 (120s)");
        setSubmitting(false);
        return;
      }
      try {
        const res = await api.get<{ batch: any; rows: BatchRow[] }>(`/batch/${batchId}`);
        const row = (res.data as any)?.rows?.[0];
        if (!row) return;
        if (row.status === "generated" && row.articleId) {
          cleanup();
          setPhase("triggering_video");
          // 链 2: 拿 articleId 触发 video
          try {
            await api.post(`/articles/${row.articleId}/generate-dvh-video`, { templateId: avatar });
            setSubmitting(false);
            onTriggered({ mode: "pending_article", batchId, articleId: row.articleId });
            handleClose();
          } catch (err: any) {
            setError("视频触发失败: " + (err?.message || "unknown"));
            setSubmitting(false);
          }
        } else if (row.status === "failed") {
          cleanup();
          setError(row.errorMessage || "article 生成失败");
          setSubmitting(false);
        }
      } catch { /* 轮询单次失败不中断 */ }
    }, POLL_INTERVAL_MS);
  };

  if (!open) return null;

  const handleSubmit = async () => {
    setError(null);
    if (source === "from_article" && !articleId.trim()) {
      setError("请填 article ID (UUID)");
      return;
    }
    if (source === "from_topic" && topic.trim().length < 2) {
      setError("topic 至少 2 个字符");
      return;
    }
    setSubmitting(true);
    setElapsedMs(0);
    try {
      const body: Record<string, unknown> = { source, avatarTemplate: avatar };
      if (source === "from_article") body.articleId = articleId.trim();
      else body.topic = topic.trim();
      const res = await api.post<{ mode: "direct" | "pending_article"; articleId?: string; batchId?: string }>(
        "/admin/generate-video",
        body
      );
      const data = res.data as any;
      if (data?.mode === "direct" && data?.articleId) {
        setSubmitting(false);
        onTriggered({ mode: "direct", articleId: data.articleId });
        handleClose();
      } else if (data?.mode === "pending_article" && data?.batchId) {
        startPolling(data.batchId);
      } else {
        throw new Error("response shape 异常");
      }
    } catch (err: any) {
      setError(err?.message || "请求失败");
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) {
      if (!confirm("处理中, 确认取消? (后台任务不会停)")) return;
    }
    cleanup();
    setSubmitting(false);
    setPhase("idle");
    setSource("from_article");
    setArticleId("");
    setTopic("");
    setError(null);
    setElapsedMs(0);
    onClose();
  };

  const elapsedSec = Math.floor(elapsedMs / 1000);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-900">🎬 生成视频</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">数据源</label>
            <div className="grid grid-cols-2 gap-2">
              {(["from_article", "from_topic"] as Source[]).map((s) => (
                <label key={s}
                  className={`px-3 py-2 border rounded-lg cursor-pointer text-sm ${
                    source === s ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:border-gray-300"
                  } ${submitting ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <input type="radio" name="source" value={s} checked={source === s}
                    onChange={() => setSource(s)} disabled={submitting} className="hidden" />
                  <div className="font-medium">{s === "from_article" ? "现有文章" : "新主题"}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    {s === "from_article" ? "已生成 article → 视频" : "topic → article → 视频"}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {source === "from_article" ? (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">文章 ID (UUID)</label>
              <input type="text" value={articleId} onChange={(e) => setArticleId(e.target.value)}
                placeholder="如 a061eb08-85e4-..." disabled={submitting}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500 disabled:bg-gray-50" />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">主题 (topic)</label>
              <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
                placeholder="如: Q1 心理学投稿" disabled={submitting}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 disabled:bg-gray-50" />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">主播</label>
            <div className="grid grid-cols-4 gap-2">
              {(Object.keys(AVATAR_LABELS) as AvatarTemplate[]).map((a) => (
                <label key={a}
                  className={`px-2 py-1.5 border rounded-lg cursor-pointer text-xs text-center ${
                    avatar === a ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:border-gray-300"
                  } ${submitting ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <input type="radio" name="avatar" value={a} checked={avatar === a}
                    onChange={() => setAvatar(a)} disabled={submitting} className="hidden" />
                  {AVATAR_LABELS[a]}
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          {submitting && (
            <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span>
                {phase === "generating_article" && `生成 article 中... (${elapsedSec}s)`}
                {phase === "triggering_video" && "触发视频任务中..."}
                {phase === "idle" && "提交中..."}
              </span>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            {submitting ? "取消" : "关闭"}
          </button>
          <button onClick={handleSubmit}
            disabled={submitting || (source === "from_article" && !articleId.trim()) || (source === "from_topic" && topic.trim().length < 2)}
            className={`px-4 py-2 text-sm font-medium rounded-lg ${
              submitting ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {submitting ? "处理中..." : "生成"}
          </button>
        </div>
      </div>
    </div>
  );
}
