/**
 * 6-11 施工包C1-b (审计 1.2) — 统一"生成视频"弹窗。
 *
 * 三条后端链路不合并, 只统一入口 (三个选项卡):
 *  - 文章转数字人: articleId prop 锁定时 POST /articles/:id/generate-dvh-video { templateId }
 *                  (原详情页 / 工坊分发卡 / 推荐卡按钮的链路, 数据结构不变);
 *                  手填 ID 时 POST /admin/generate-video { source: "from_article", articleId, avatarTemplate }
 *                  (原 ManualGenerateVideoModal 链路, 数据结构不变);
 *  - 主题直生:     POST /admin/generate-video { source: "from_topic", topic, avatarTemplate }
 *                  → poll /batch/:id → POST /articles/:id/generate-dvh-video (原链路原样迁入);
 *  - 图片转视频:   /video/compose 三步向导太重不内嵌, 引导块 + 按钮跳 /video/create。
 *
 * 原 components/workbench/ManualGenerateVideoModal.tsx 逻辑迁入此处后已删除。
 */
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../utils/api";
import { toast } from "../Toast";
import { DVH_TEMPLATES } from "../RecommendationCard";

export type VideoModalTab = "article" | "topic" | "image";

const TAB_LABELS: { key: VideoModalTab; label: string }[] = [
  { key: "article", label: "文章转数字人" },
  { key: "topic", label: "主题直生" },
  { key: "image", label: "图片转视频" },
];

interface BatchRow {
  status: string;
  articleId: string | null;
  errorMessage: string | null;
}

export interface UnifiedVideoModalProps {
  open: boolean;
  onClose: () => void;
  /** 打开时预选 tab (传 articleId 时强制 article) */
  defaultTab?: VideoModalTab;
  /** 从详情页/推荐卡/分发卡打开时锁定文章 */
  articleId?: string;
  /** 默认主播模板 (推荐卡上已选的模板透传) */
  defaultAvatar?: string;
  onTriggered?: (info: { mode: "direct" | "pending_article"; articleId?: string; batchId?: string }) => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 120_000;

export default function UnifiedVideoModal({
  open,
  onClose,
  defaultTab,
  articleId: lockedArticleId,
  defaultAvatar,
  onTriggered,
}: UnifiedVideoModalProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<VideoModalTab>("article");
  const [articleIdInput, setArticleIdInput] = useState("");
  const [topic, setTopic] = useState("");
  const [avatar, setAvatar] = useState<string>(DVH_TEMPLATES[0].value);
  // PR-X2: 形象目录 — 从 /admin/dvh-catalog 拉, 失败回退默认 4 个
  const [avatarOptions, setAvatarOptions] = useState<Array<{ value: string; label: string }>>([...DVH_TEMPLATES]);
  useEffect(() => {
    if (!open) return;
    api.get("/admin/dvh-catalog")
      .then((r) => {
        const list = ((r.data as any)?.data?.catalog ?? (r.data as any)?.catalog ?? []) as Array<{ key: string; templateLabel?: string; avatarLabel?: string }>;
        if (Array.isArray(list) && list.length > 0) {
          setAvatarOptions(list.map((c) => ({ value: c.key, label: c.templateLabel || c.avatarLabel || c.key })));
        }
      })
      .catch(() => { /* 回退默认 */ });
  }, [open]);
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

  // 打开时按入口初始化 tab / 主播
  useEffect(() => {
    if (!open) return;
    setTab(lockedArticleId ? "article" : (defaultTab ?? "article"));
    if (defaultAvatar && (avatarOptions.some((t) => t.value === defaultAvatar) || DVH_TEMPLATES.some((t) => t.value === defaultAvatar))) {
      setAvatar(defaultAvatar);
    }
  }, [open, lockedArticleId, defaultTab, defaultAvatar]);

  // 主题直生: poll batch, article ready 后触发 DVH (原 ManualGenerateVideoModal 逻辑)
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
        const res = await api.get<{ batch: unknown; rows: BatchRow[] }>(`/batch/${batchId}`);
        const row = (res.data as any)?.rows?.[0];
        if (!row) return;
        if (row.status === "generated" && row.articleId) {
          cleanup();
          setPhase("triggering_video");
          try {
            await api.post(`/articles/${row.articleId}/generate-dvh-video`, { templateId: avatar });
            setSubmitting(false);
            onTriggered?.({ mode: "pending_article", batchId, articleId: row.articleId });
            doClose();
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

    // —— 文章转数字人 ——
    if (tab === "article") {
      // 锁定文章 (详情页/分发卡/推荐卡入口): 走原 /articles/:id/generate-dvh-video 链路
      if (lockedArticleId) {
        setSubmitting(true);
        try {
          await api.post(`/articles/${lockedArticleId}/generate-dvh-video`, { templateId: avatar });
          toast.success("数字人视频生成中，稍后在内容管理→视频类型查看");
          setSubmitting(false);
          onTriggered?.({ mode: "direct", articleId: lockedArticleId });
          doClose();
        } catch (err: any) {
          setError(err?.message || "生成失败");
          setSubmitting(false);
        }
        return;
      }
      // 手填 article ID: 走原 /admin/generate-video from_article 链路
      if (!articleIdInput.trim()) {
        setError("请填 article ID (UUID)");
        return;
      }
      setSubmitting(true);
      setElapsedMs(0);
      try {
        const res = await api.post<{ mode: "direct" | "pending_article"; articleId?: string; batchId?: string }>(
          "/admin/generate-video",
          { source: "from_article", articleId: articleIdInput.trim(), avatarTemplate: avatar }
        );
        const data = res.data as any;
        if (data?.mode === "direct" && data?.articleId) {
          setSubmitting(false);
          onTriggered?.({ mode: "direct", articleId: data.articleId });
          doClose();
        } else {
          throw new Error("response shape 异常");
        }
      } catch (err: any) {
        setError(err?.message || "请求失败");
        setSubmitting(false);
      }
      return;
    }

    // —— 主题直生 ——
    if (tab === "topic") {
      if (topic.trim().length < 2) {
        setError("topic 至少 2 个字符");
        return;
      }
      setSubmitting(true);
      setElapsedMs(0);
      try {
        const res = await api.post<{ mode: "direct" | "pending_article"; articleId?: string; batchId?: string }>(
          "/admin/generate-video",
          { source: "from_topic", topic: topic.trim(), avatarTemplate: avatar }
        );
        const data = res.data as any;
        if (data?.mode === "pending_article" && data?.batchId) {
          startPolling(data.batchId);
        } else if (data?.mode === "direct" && data?.articleId) {
          setSubmitting(false);
          onTriggered?.({ mode: "direct", articleId: data.articleId });
          doClose();
        } else {
          throw new Error("response shape 异常");
        }
      } catch (err: any) {
        setError(err?.message || "请求失败");
        setSubmitting(false);
      }
    }
  };

  // 重置内部状态并关闭 (不带 confirm)
  const doClose = () => {
    cleanup();
    setSubmitting(false);
    setPhase("idle");
    setArticleIdInput("");
    setTopic("");
    setError(null);
    setElapsedMs(0);
    onClose();
  };

  const handleClose = () => {
    if (submitting) {
      if (!confirm("处理中, 确认取消? (后台任务不会停)")) return;
    }
    doClose();
  };

  const elapsedSec = Math.floor(elapsedMs / 1000);
  const submitDisabled =
    submitting ||
    (tab === "article" && !lockedArticleId && !articleIdInput.trim()) ||
    (tab === "topic" && topic.trim().length < 2);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900">🎬 生成视频</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-4 border-b border-gray-100">
          {TAB_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => !submitting && setTab(key)}
              disabled={submitting}
              className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                tab === key
                  ? "border-blue-500 text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              } ${submitting ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "image" ? (
          /* 图片转视频: 三步向导太重, 不内嵌 — 引导跳 /video/create */
          <div className="px-4 py-6 bg-gray-50 border border-dashed border-gray-300 rounded-xl text-center space-y-3">
            <p className="text-3xl">🖼️</p>
            <p className="text-sm font-medium text-gray-700">图片转视频走三步向导</p>
            <p className="text-xs text-gray-400">传图 → 选音乐/转场 → 合成 MP4，在独立页面完成体验更好</p>
            <button
              onClick={() => { doClose(); navigate("/video/create"); }}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              前往图转视频向导 →
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {tab === "article" ? (
              lockedArticleId ? (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">文章</label>
                  <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm font-mono text-gray-600">
                    {lockedArticleId.slice(0, 8)}... (当前文章)
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">文章 ID (UUID)</label>
                  <input
                    type="text"
                    value={articleIdInput}
                    onChange={(e) => setArticleIdInput(e.target.value)}
                    placeholder="如 a061eb08-85e4-..."
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
                  />
                </div>
              )
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">主题 (topic)</label>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="如: Q1 心理学投稿"
                  disabled={submitting}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
                />
                <p className="text-[11px] text-gray-400 mt-1">topic → 先生成 article → 再转数字人视频</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">主播</label>
              <div className="grid grid-cols-4 gap-2">
                {avatarOptions.map((t) => (
                  <label
                    key={t.value}
                    className={`px-2 py-1.5 border rounded-lg cursor-pointer text-xs text-center ${
                      avatar === t.value ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:border-gray-300"
                    } ${submitting ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <input
                      type="radio"
                      name="avatar"
                      value={t.value}
                      checked={avatar === t.value}
                      onChange={() => setAvatar(t.value)}
                      disabled={submitting}
                      className="hidden"
                    />
                    {t.label}
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
        )}

        {tab !== "image" && (
          <div className="mt-5 flex items-center justify-end gap-2">
            <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
              {submitting ? "取消" : "关闭"}
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitDisabled}
              className={`px-4 py-2 text-sm font-medium rounded-lg ${
                submitDisabled ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {submitting ? "处理中..." : "生成"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
