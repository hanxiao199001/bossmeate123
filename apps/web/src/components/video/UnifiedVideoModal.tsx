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
 *  - 7-30 文字稿直生: POST /video/dvh-from-text { text, title?, templateId, voiceId?, backgroundUrl?, idempotencyKey }
 *                  运营自己写好口播稿直接出片, 不生成文章、不调 LLM。
 *                  形象/音色/背景三个选择器与其它 tab 完全共用(它们本来就与"文本从哪来"无关)。
 *
 * 原 components/workbench/ManualGenerateVideoModal.tsx 逻辑迁入此处后已删除。
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../utils/api";
import { toast } from "../Toast";
import { DVH_TEMPLATES } from "../RecommendationCard";

export type VideoModalTab = "article" | "topic" | "text" | "image";

const TAB_LABELS: { key: VideoModalTab; label: string }[] = [
  { key: "article", label: "文章转数字人" },
  { key: "topic", label: "主题直生" },
  { key: "text", label: "文字稿直生" },
  { key: "image", label: "图片转视频" },
];

interface BatchRow {
  status: string;
  articleId: string | null;
  errorMessage: string | null;
}

/** 7-30 文字稿直生: 口播稿字数闸(与服务端 routes/video.ts 的 zod 同值, 改一处必须改两处) */
const NARRATION_MIN = 50;
const NARRATION_MAX = 600;
const ESTIMATE_DEBOUNCE_MS = 400;

interface NarrationEstimate {
  chars: number;
  seconds: number;
  yuan: number;
  tooShort: boolean;
  tooLong: boolean;
  blocked: boolean;
  blockMessage?: string;
}

/** 幂等键: 让"网络超时后重试"不会变成两条视频。crypto.randomUUID 在老环境/非 https 下没有, 兜个底。 */
function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* 落到下面的兜底 */ }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  //   7-31 顺带带回每个形象**自带的音色名** + 后端的 audioDriven 开关(见下面音色选择器)
  const [avatarOptions, setAvatarOptions] = useState<Array<{ value: string; label: string; voiceLabel?: string }>>([...DVH_TEMPLATES]);
  /**
   * 7-31 音色能不能换, 取决于后端 DVH_AUDIO_DRIVEN:
   *   false(默认, 文字驱动) → 阿里云 AudioInfo.voice 只认平台发音人 code, 音色**只能跟随所选形象**,
   *     我们音色库里的 voice_id(TTS 命名空间)在这条路上塞不进去 → 选了也不生效。
   *   true(音频驱动)        → 先用所选音色 TTS 合成音频再驱动口型, 音色真生效。
   * 拉不到就按 false 处理: 宁可禁用一个其实能用的下拉, 也不让人选一个不生效的东西。
   */
  const [audioDriven, setAudioDriven] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.get("/admin/dvh-catalog")
      .then((r) => {
        const d = ((r.data as any)?.data ?? r.data) as { catalog?: Array<{ key: string; templateLabel?: string; avatarLabel?: string; voiceLabel?: string }>; audioDriven?: boolean };
        const list = (d?.catalog ?? []) as Array<{ key: string; templateLabel?: string; avatarLabel?: string; voiceLabel?: string }>;
        if (Array.isArray(list) && list.length > 0) {
          setAvatarOptions(list.map((c) => ({
            value: c.key,
            label: c.templateLabel || c.avatarLabel || c.key,
            ...(c.voiceLabel ? { voiceLabel: c.voiceLabel } : {}),
          })));
        }
        setAudioDriven(d?.audioDriven === true);
      })
      .catch(() => { /* 回退默认 */ });
  }, [open]);
  // 7-10 音色库: 单次生成可临时换音色(空=跟随账号绑定/系统默认, 不改账号绑定)
  const [voiceSel, setVoiceSel] = useState("");
  const [voiceOptions, setVoiceOptions] = useState<Array<{ id: string; name: string; voiceId: string; type: string }>>([]);
  useEffect(() => {
    if (!open) return;
    api.get("/voice-catalog")
      .then((r) => {
        const list = ((r.data as any)?.voices ?? (r.data as any)?.data?.voices ?? []) as Array<{ id: string; name: string; voiceId: string; type: string }>;
        if (Array.isArray(list)) setVoiceOptions(list);
      })
      .catch(() => { /* 拉不到就不显示下拉 */ });
  }, [open]);
  // 7-29 背景图: "" = 跟随形象/系统默认配置; "none" = 本次显式不要背景(黑底); 其它 = 图片公网 URL
  //   系统图库由管理员在 设置页→数字人背景图库 维护; 「上传本地图」默认只对本次生成有效,
  //   勾了「存入背景图库」才会进图库(运营也能存, 图库是共享的; 有 60 张上限 + 自动判重兜底)。
  const [bgSel, setBgSel] = useState("");
  const [bgList, setBgList] = useState<Array<{ id: string; name: string; url: string; thumbUrl?: string; orientation: string }>>([]);
  const [bgUploaded, setBgUploaded] = useState<Array<{ url: string; name: string }>>([]);
  const [bgUploading, setBgUploading] = useState(false);
  const [bgError, setBgError] = useState<string | null>(null);
  const [bgNotice, setBgNotice] = useState<string | null>(null);
  // 默认不勾 —— 临时用一次的图才是常态, 别把图库塞满
  const [bgSaveToLib, setBgSaveToLib] = useState(false);
  const bgFileRef = useRef<HTMLInputElement>(null);
  const loadBgList = useCallback(() => {
    return api.get("/admin/dvh-backgrounds")
      .then((r) => {
        const list = ((r.data as any)?.data?.backgrounds ?? (r.data as any)?.backgrounds ?? []) as typeof bgList;
        if (Array.isArray(list)) setBgList(list);
      })
      .catch(() => { /* 拉不到就只剩"默认/黑底/上传" 三个选项 */ });
  }, []);
  useEffect(() => { if (open) void loadBgList(); }, [open, loadBgList]);

  const uploadBg = useCallback(async (file: File) => {
    setBgUploading(true); setBgError(null); setBgNotice(null);
    const wantSave = bgSaveToLib;
    try {
      const fd = new FormData();
      // 字段放在文件之前 append, 后端两种顺序都兼容(它把 part 走完才决定), 这里只是更直观
      if (wantSave) fd.append("saveToLibrary", "1");
      fd.append("image", file);
      const r = await api.upload<{ url: string }>("/video/dvh-background", fd);
      const d = ((r.data as any)?.data ?? r.data) as {
        url?: string; savedToLibrary?: boolean; libraryStatus?: string; libraryMessage?: string;
      };
      const url = d?.url;
      if (!url) throw new Error("上传返回异常");
      if (wantSave && d.savedToLibrary) {
        // 进了图库就别在"本次上传"里再挂一张一模一样的; 拉一次图库让它以图库条目的身份出现
        await loadBgList();
        setBgNotice(d.libraryMessage || "已存入背景图库,下次直接选");
      } else {
        setBgUploaded((prev) => [...prev, { url, name: file.name.slice(0, 20) }]);
        // 勾了却没存进去(图库满了) → 必须说出来, 不能让人以为存好了
        if (wantSave) setBgError(d.libraryMessage || "没能存入图库(本次生成仍可用)");
      }
      setBgSel(url);
    } catch (e: any) {
      // 后端会说清"需要 9:16 竖版, 你传的是 4:3"之类, 原样展示
      setBgError(e?.message || "背景图上传失败");
    } finally {
      setBgUploading(false);
      if (bgFileRef.current) bgFileRef.current.value = "";
    }
  }, [bgSaveToLib, loadBgList]);

  // 7-30 文字稿直生
  const [narration, setNarration] = useState("");
  const [narrationTitle, setNarrationTitle] = useState("");
  const [estimate, setEstimate] = useState<NarrationEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  // 幂等键: 同一次"提交意图"复用一个 key(失败重试不会变成两条视频); 稿子/参数一改就换新的,
  //   因为那已经是另一条视频了 —— 换形象重做一条是正当需求, 不该被幂等挡住。
  const idemKeyRef = useRef<string>("");
  useEffect(() => { idemKeyRef.current = ""; }, [narration, narrationTitle, avatar, voiceSel, bgSel]);

  // 边打字边算钱(防抖 400ms)。顺带拿服务端的内容安全预检 —— 红线词在这里就变红,
  //   而不是点了生成才被 400 拒(那时候人已经等了半天)。
  useEffect(() => {
    if (!open || tab !== "text") return;
    const t = narration.trim();
    if (!t) { setEstimate(null); return; }
    // 服务端预估接口上限 5000 字; 再长就别发请求了(只会换来一串 toast), 本地直接判"超了"
    if (t.length > 5000) {
      setEstimate({ chars: t.length, seconds: 0, yuan: 0, tooShort: false, tooLong: true, blocked: false });
      return;
    }
    setEstimating(true);
    const timer = setTimeout(() => {
      api.post<NarrationEstimate>("/video/dvh-estimate", { text: t, ...(narrationTitle.trim() ? { title: narrationTitle.trim() } : {}) })
        .then((r) => setEstimate(((r.data as any)?.data ?? r.data) as NarrationEstimate))
        .catch(() => { /* 预估拿不到不挡生成, 服务端还有硬闸 */ })
        .finally(() => setEstimating(false));
    }, ESTIMATE_DEBOUNCE_MS);
    return () => { clearTimeout(timer); setEstimating(false); };
  }, [open, tab, narration, narrationTitle]);

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
            await api.post(`/articles/${row.articleId}/generate-dvh-video`, { templateId: avatar, ...(voiceSel && audioDriven ? { voiceId: voiceSel } : {}), ...(bgSel ? { backgroundUrl: bgSel } : {}) });
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
          await api.post(`/articles/${lockedArticleId}/generate-dvh-video`, { templateId: avatar, ...(voiceSel && audioDriven ? { voiceId: voiceSel } : {}), ...(bgSel ? { backgroundUrl: bgSel } : {}) });
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
          { source: "from_article", articleId: articleIdInput.trim(), avatarTemplate: avatar, ...(voiceSel && audioDriven ? { voiceId: voiceSel } : {}), ...(bgSel ? { backgroundUrl: bgSel } : {}) }
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

    // —— 7-30 文字稿直生 ——
    if (tab === "text") {
      const t = narration.trim();
      if (t.length < NARRATION_MIN) { setError(`口播稿至少 ${NARRATION_MIN} 字`); return; }
      if (t.length > NARRATION_MAX) { setError(`口播稿最多 ${NARRATION_MAX} 字, 当前 ${t.length} 字, 请拆成多条视频`); return; }
      if (estimate?.blocked) { setError(estimate.blockMessage || "口播稿未通过内容检查"); return; }
      // 二次确认必须**带上钱**: 这一步之后就是真扣费, 而运营在这个 tab 里是自己决定字数的
      const sec = estimate?.seconds ?? Math.max(30, Math.round(t.length / 3.3));
      const yuan = estimate?.yuan ?? Math.round(sec * 16.5) / 100;
      if (!confirm(`这条口播稿 ${t.length} 字, 约 ${sec} 秒, 预估 ¥${yuan.toFixed(2)}。\n生成即产生费用且不可撤销, 确认生成?`)) return;

      if (!idemKeyRef.current) idemKeyRef.current = newIdempotencyKey();
      setSubmitting(true);
      setElapsedMs(0);
      try {
        await api.post("/video/dvh-from-text", {
          text: t,
          templateId: avatar,
          idempotencyKey: idemKeyRef.current,
          ...(narrationTitle.trim() ? { title: narrationTitle.trim() } : {}),
          ...(voiceSel && audioDriven ? { voiceId: voiceSel } : {}),  // 7-31 文字驱动下音色不生效, 就别发 —— 发了只会在存证里留一条假线索
          ...(bgSel ? { backgroundUrl: bgSel } : {}),
        });
        toast.success("数字人视频生成中，稍后在内容管理→视频类型查看");
        setSubmitting(false);
        onTriggered?.({ mode: "direct" });
        doClose();
      } catch (err: any) {
        // 409 = 同稿在途(防双击), 文案由服务端给, 原样展示
        setError(err?.message || "生成失败");
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
    // 7-30 口播稿是运营手打的, 关窗就清掉 —— 与其它字段一致(单次生效), 别把上一条的稿子留给下一次
    setNarration("");
    setNarrationTitle("");
    setEstimate(null);
    idemKeyRef.current = "";
    setVoiceSel(""); // 7-10 临时音色只作用一次, 关窗即回默认
    setBgSel("");    // 7-29 背景图同理: 单次生效, 关窗回默认
    setBgUploaded([]);
    setBgError(null);
    setBgNotice(null);
    setBgSaveToLib(false); // 勾选也只作用于本次会话, 关窗回默认(不勾)
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
  const narrationLen = narration.trim().length;
  const narrationBad = narrationLen < NARRATION_MIN || narrationLen > NARRATION_MAX || !!estimate?.blocked;
  const submitDisabled =
    submitting ||
    (tab === "article" && !lockedArticleId && !articleIdInput.trim()) ||
    (tab === "topic" && topic.trim().length < 2) ||
    (tab === "text" && narrationBad);

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
            ) : tab === "topic" ? (
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
            ) : (
              /* 7-30 文字稿直生: 自己写稿 → 直接出片, 不生成文章、不调 LLM */
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    口播稿 <span className="text-gray-400 font-normal">(数字人一字不差照着念)</span>
                  </label>
                  <textarea
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    rows={7}
                    placeholder={`直接写你要让数字人说的话, ${NARRATION_MIN}-${NARRATION_MAX} 字。\n例: 很多老师问, 中文核心到底难在哪…`}
                    disabled={submitting}
                    className={`w-full px-3 py-2 border rounded-lg text-sm leading-relaxed focus:outline-none disabled:bg-gray-50 ${
                      narrationLen > NARRATION_MAX || estimate?.blocked
                        ? "border-red-400 focus:border-red-500"
                        : "border-gray-300 focus:border-blue-500"
                    }`}
                  />
                </div>

                {/* 费用条: 字数 / 秒数 / 钱。运营在这个 tab 里自己决定字数, 没有这行等于放任烧钱 */}
                <div
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs border ${
                    narrationLen > NARRATION_MAX
                      ? "bg-red-50 border-red-200 text-red-700"
                      : narrationLen > 0 && narrationLen < NARRATION_MIN
                        ? "bg-gray-50 border-gray-200 text-gray-500"
                        : narrationLen > 400
                          ? "bg-amber-50 border-amber-200 text-amber-800"
                          : "bg-blue-50 border-blue-200 text-blue-800"
                  }`}
                >
                  <span>
                    <b>{narrationLen}</b> / {NARRATION_MAX} 字
                    {narrationLen >= NARRATION_MIN && estimate && !estimate.tooLong && (
                      <> · 约 <b>{estimate.seconds}</b> 秒 · 预估 <b>¥{estimate.yuan.toFixed(2)}</b></>
                    )}
                  </span>
                  <span className="text-[11px] opacity-70">
                    {estimating
                      ? "计算中…"
                      : narrationLen === 0
                        ? "按 0.165 元/秒计费"
                        : narrationLen < NARRATION_MIN
                          ? `还差 ${NARRATION_MIN - narrationLen} 字`
                          : narrationLen > NARRATION_MAX
                            ? `超出 ${narrationLen - NARRATION_MAX} 字, 请拆成多条`
                            : narrationLen > 400
                              ? "偏长, 注意成本"
                              : ""}
                  </span>
                </div>

                {/* 内容安全预检: 红线词打字时就拦下来, 不等到花完钱 */}
                {estimate?.blocked && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 leading-relaxed">
                    ⚠️ {estimate.blockMessage}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    标题 <span className="text-gray-400 font-normal">(选填, 不填就取稿子开头)</span>
                  </label>
                  <input
                    type="text"
                    value={narrationTitle}
                    onChange={(e) => setNarrationTitle(e.target.value)}
                    placeholder="用于在内容管理里认出这条视频"
                    maxLength={60}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
                  />
                </div>
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

            {/* 7-29 背景图: 系统图库 + 上传本地图 + 不用背景(黑底), 只对本次生成生效 */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">背景(本次生成)</label>
              <div className="grid grid-cols-4 gap-2 max-h-44 overflow-y-auto pr-1">
                {/* 默认: 跟随形象/系统配置 */}
                <button
                  type="button"
                  onClick={() => setBgSel("")}
                  disabled={submitting}
                  className={`h-16 rounded-lg border text-[10px] leading-tight px-1 ${
                    bgSel === "" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500 hover:border-gray-300"
                  }`}
                >默认<br />(跟随形象配置)</button>
                {/* 显式黑底 */}
                <button
                  type="button"
                  onClick={() => setBgSel("none")}
                  disabled={submitting}
                  className={`h-16 rounded-lg border text-[10px] leading-tight px-1 bg-gray-900 text-white ${
                    bgSel === "none" ? "border-blue-500 ring-2 ring-blue-300" : "border-gray-700 hover:border-gray-500"
                  }`}
                >不用背景<br />(纯黑底)</button>
                {/* 系统图库 */}
                {bgList.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBgSel(b.url)}
                    disabled={submitting}
                    title={`${b.name} (${b.orientation === "portrait" ? "竖版" : "横版"})`}
                    className={`h-16 rounded-lg border overflow-hidden ${
                      bgSel === b.url ? "border-blue-500 ring-2 ring-blue-300" : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <img src={b.thumbUrl || b.url} alt={b.name} className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
                {/* 本次上传的本地图(不进系统图库) */}
                {bgUploaded.map((b) => (
                  <button
                    key={b.url}
                    type="button"
                    onClick={() => setBgSel(b.url)}
                    disabled={submitting}
                    title={`${b.name} (本次上传)`}
                    className={`h-16 rounded-lg border overflow-hidden relative ${
                      bgSel === b.url ? "border-blue-500 ring-2 ring-blue-300" : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <img src={b.url} alt={b.name} className="w-full h-full object-cover" />
                    <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] leading-none py-0.5">本次上传</span>
                  </button>
                ))}
                {/* 上传本地图 */}
                <button
                  type="button"
                  onClick={() => bgFileRef.current?.click()}
                  disabled={submitting || bgUploading}
                  className="h-16 rounded-lg border border-dashed border-gray-300 text-[10px] leading-tight text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50"
                >{bgUploading ? "上传中…" : <>＋<br />上传本地图</>}</button>
                <input
                  ref={bgFileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadBg(f); }}
                />
              </div>
              {/* 7-29 勾了就把这次上传的图存进系统图库(默认不勾: 临时用一次才是常态) */}
              <label className="flex items-start gap-1.5 mt-2 text-[11px] text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={bgSaveToLib}
                  onChange={(e) => setBgSaveToLib(e.target.checked)}
                  disabled={submitting || bgUploading}
                  className="mt-0.5"
                />
                <span>
                  存入背景图库,下次直接选
                  <span className="text-gray-400">(常用背景勾上,省得每次从电脑里翻;图库全员共用,最多 60 张)</span>
                </span>
              </label>
              {bgError && <p className="text-[11px] text-red-600 mt-1">{bgError}</p>}
              {bgNotice && <p className="text-[11px] text-green-600 mt-1">✓ {bgNotice}</p>}
              <p className="text-[11px] text-gray-400 mt-1">
                需 9:16 竖版(1080×1920)或 16:9 横版(1920×1080);不勾上面那项时,上传的图只用于本次生成。系统图库也可在「设置」页管理。
              </p>
            </div>

            {/* 7-10 音色库: 单次生成临时换音色, 不改账号绑定
                7-31 文字驱动(audioDriven=false, 生产默认)下整体禁用 —— 这条路的音色只能跟随形象,
                     以前是"能选、选了没用", 出片后只会被当成 bug 报上来。 */}
            {voiceOptions.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  音色(本次生成)
                  {!audioDriven && <span className="ml-1 text-[11px] font-normal text-amber-600">当前模式下音色跟随形象配置</span>}
                </label>
                <select
                  value={audioDriven ? voiceSel : ""}
                  onChange={(e) => setVoiceSel(e.target.value)}
                  disabled={submitting || !audioDriven}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 disabled:bg-gray-50"
                >
                  <option value="">默认(账号绑定音色/系统音色)</option>
                  {voiceOptions.some((v) => v.type === "cloned") && (
                    <optgroup label="我的克隆音">
                      {voiceOptions.filter((v) => v.type === "cloned").map((v) => (
                        <option key={v.id} value={v.voiceId}>{v.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {voiceOptions.some((v) => v.type === "preset") && (
                    <optgroup label="预置音色">
                      {voiceOptions.filter((v) => v.type === "preset").map((v) => (
                        <option key={v.id} value={v.voiceId}>{v.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {audioDriven ? (
                  <p className="text-[11px] text-gray-400 mt-1">只对本次生成生效; 想固定请到"账号管理"给账号绑音色</p>
                ) : (
                  <p className="text-[11px] text-amber-600 mt-1 leading-relaxed">
                    本条视频将使用<b>{avatarOptions.find((t) => t.value === avatar)?.voiceLabel || "所选形象自带的音色"}</b>。
                    数字人当前走「文字驱动」，声音由阿里云按形象配的发音人合成，换不了音色库里的声音；
                    要换请到「设置」页给这个形象改配音色，或联系技术开启音频驱动。
                  </p>
                )}
              </div>
            )}

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
