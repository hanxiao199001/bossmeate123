import { useState, useEffect, useCallback } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../utils/api";
import { toast } from "../components/Toast";
import { escapeHtml, isSafeUrl, sanitizeHtml } from "../utils/sanitize";
import RewriteSectionModal from "../components/RewriteSectionModal";
import EditTimelineDrawer from "../components/EditTimelineDrawer";

// ===== 类型定义 =====
interface VariantSibling {
  id: string;
  title: string | null;
  status: string;
  variantIndex: number;
  userSelected: boolean;
  userRejected: boolean;
  templateId?: string; // T4-3-5: 该变体所用模板（无 metadata.templateId 时为 undefined）
  createdAt: string;
}

// T4-3-5: 模板元信息（启动时一次拉取并缓存）
interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

interface ContentItem {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  status: string;
  platforms: Array<{ platform: string; status?: string; mediaId?: string; publishedAt?: string }>;
  tokensTotal: number;
  conversationId: string | null;
  metadata?: Record<string, any>;
  siblings?: VariantSibling[];
  // 5-23 PR #159: 后端 GET /:id 注入 journal (join journals 表), 详情页用于渲染封面 hero
  // 老 article body HTML 是 frozen 的, 不能回填 cover; 通过 journal 字段独立注入图
  journal?: {
    id: string;
    nameEn: string | null;
    coverImageUrl: string | null;
    impactFactor: number | null;
    partition: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

// 5-23 PR #159 — 期刊封面 hero (frozen body 不动, 详情页前端注入)
// 命名: JournalCoverHero 区别于 wechat-article-template 里的 renderCoverHero (server-side string)
function JournalCoverHero({ coverUrl, journalName }: { coverUrl?: string | null; journalName?: string | null }) {
  if (!coverUrl) return null;
  return (
    <div className="mb-4">
      <img
        src={coverUrl}
        alt={journalName ? `${journalName} 封面` : "期刊封面"}
        className="w-full max-h-60 object-cover rounded-lg border border-gray-200"
        onError={(e) => { e.currentTarget.style.display = "none"; }}
        loading="lazy"
      />
    </div>
  );
}

interface Account {
  id: string;
  platform: string;
  accountName: string;
  groupName?: string;
  status: string;
  isVerified: boolean;
  lastPublishAt?: string;
}

interface PublishResult {
  accountId: string;
  accountName: string;
  platform: string;
  success: boolean;
  /** full = 自动群发已发出；draft_only = 仅在草稿箱，需手动发送 */
  mode?: "full" | "draft_only";
  message?: string;
  draftUrl?: string;
  mediaId?: string;
  error?: string;
}

// ===== 常量 =====
const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  reviewing: "审核中",
  approved: "已通过",
  published: "已发布",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  reviewing: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  published: "bg-blue-100 text-blue-700",
};

const STATUS_FLOW: Record<string, { next: string; label: string; color: string }[]> = {
  draft: [
    { next: "reviewing", label: "提交审核", color: "bg-yellow-500 hover:bg-yellow-600" },
  ],
  reviewing: [
    { next: "approved", label: "审核通过", color: "bg-green-500 hover:bg-green-600" },
    { next: "draft", label: "退回修改", color: "bg-gray-500 hover:bg-gray-600" },
  ],
  approved: [
    { next: "draft", label: "退回修改", color: "bg-gray-500 hover:bg-gray-600" },
  ],
  published: [],
};

const TYPE_LABELS: Record<string, string> = {
  article: "图文",
  video_script: "视频脚本",
  reply: "客服回复",
};

// T4-3-5: 模板 badge —— 优雅降级（无 templateId 隐藏；模板未加载时仍显示 templateId 文本）
function TemplateBadge({
  templateId,
  templates,
}: {
  templateId?: string;
  templates: Map<string, TemplateInfo>;
}) {
  if (!templateId) return null;
  const t = templates.get(templateId);
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">
      <span>{t?.icon ?? "📄"}</span>
      <span>{t?.name ?? templateId}</span>
    </span>
  );
}

export default function ContentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 5-21 P0: user/logout 已搬 sidebar (MainLayout)

  // 内容数据
  const [content, setContent] = useState<ContentItem | null>(null);
  // 多版本对比：副版本完整内容（并行 GET 拿 body）
  const [secondaries, setSecondaries] = useState<ContentItem[]>([]);
  // PR 1：期刊数据可信度（用于 AI 警告横幅）
  const [journalDataSource, setJournalDataSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // 编辑状态
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // 预览/编辑切换
  const [viewMode, setViewMode] = useState<"edit" | "preview" | "split">("split");

  // 发布相关
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState("");
  const [showPublishPanel, setShowPublishPanel] = useState(
    searchParams.get("action") === "publish"
  );
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [publishResults, setPublishResults] = useState<PublishResult[]>([]);

  // PR #264/#266: 抖音半自动发布助手 (多号差异化文案 + 复制 + 发布勾选)
  type DyVariant = { hookTitle: string; hashtags: string[]; lead: string; fullText: string };
  const [douyinVariants, setDouyinVariants] = useState<DyVariant[] | null>(null);
  const [douyinLoading, setDouyinLoading] = useState(false);
  const [variantCount, setVariantCount] = useState(3);
  const [douyinPosted, setDouyinPosted] = useState<boolean[]>([]);
  const [showDouyinQr, setShowDouyinQr] = useState(false); // PR #267: 扫码下载视频到手机
  // PR-M2: 视频平台文案切换 (抖音/视频号同一助手通吃)
  const [captionPlatform, setCaptionPlatform] = useState<"douyin" | "wechat_video">("douyin");

  // T4-2-2: AI 改段 Modal 开关（task #20）
  const [showRewriteModal, setShowRewriteModal] = useState(false);
  // T4-2-3: 编辑历史 Drawer（task #21）+ refresh nonce 在 applyRewrite 后递增触发刷新
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);

  // 5-15 PR #141: 数字人视频模板选择（替代 PR Q.0 的 video_script 老按钮）
  const [dvhTemplate, setDvhTemplate] = useState<string>("A_academic");

  // T4-3-5: 模板元信息缓存（id → {name, icon, description}），首次挂载时拉一次
  const [templates, setTemplates] = useState<Map<string, TemplateInfo>>(new Map());
  useEffect(() => {
    api
      .get<{ templates: TemplateInfo[] }>("/content-engine/templates")
      .then((res) => {
        if (res.data?.templates) {
          setTemplates(new Map(res.data.templates.map((t) => [t.id, t])));
        }
      })
      .catch(() => {
        /* badge 优雅降级到 templateId 文本 */
      });
  }, []);

  // 获取内容
  const fetchContent = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.get<ContentItem>(`/content/${id}`);
      if (res.data) {
        setContent(res.data);
        setEditTitle(res.data.title || "");
        setEditBody(res.data.body || "");

        // PR 1：拿 article.metadata.journalId 后查 /journals/:id 看 data_source
        const journalId = (res.data.metadata as Record<string, unknown> | undefined)?.journalId;
        if (typeof journalId === "string" && journalId) {
          api
            .get<{ dataSource?: string | null }>(`/journals/${journalId}`)
            .then((jr) => setJournalDataSource(jr.data?.dataSource ?? null))
            .catch(() => setJournalDataSource(null));
        }

        // 多版本：并行 GET 每个 sibling 拿 body 用于双栏对比
        if (res.data.siblings && res.data.siblings.length > 0) {
          try {
            const siblingResults = await Promise.all(
              res.data.siblings.map((s) => api.get<ContentItem>(`/content/${s.id}`))
            );
            setSecondaries(
              siblingResults
                .map((r) => r.data)
                .filter((d): d is ContentItem => !!d)
            );
          } catch (sibErr) {
            console.error("获取副版本失败", sibErr);
            setSecondaries([]);
          }
        } else {
          setSecondaries([]);
        }
      }
    } catch (err) {
      console.error("获取内容失败", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  // 检测修改
  useEffect(() => {
    if (!content) return;
    const titleChanged = editTitle !== (content.title || "");
    const bodyChanged = editBody !== (content.body || "");
    setHasChanges(titleChanged || bodyChanged);
  }, [editTitle, editBody, content]);

  // 5-15 PR #141: 触发数字人视频生成（DVH_REAL_MODE=false 时走 mock fixture）
  const handleGenerateDvhVideo = useCallback(async () => {
    if (!content || content.type !== "article") return;
    try {
      await api.post(`/articles/${content.id}/generate-dvh-video`, { templateId: dvhTemplate });
      toast.success("数字人视频生成中，稍后在内容管理→视频类型查看");
    } catch (err) {
      toast.error("生成失败：" + (err instanceof Error ? err.message : "未知错误"));
    }
  }, [content, dvhTemplate]);

  // 保存
  const handleSave = async () => {
    if (!id || !hasChanges) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const payload: Record<string, string> = {};
      if (editTitle !== (content?.title || "")) payload.title = editTitle;
      if (editBody !== (content?.body || "")) payload.body = editBody;

      const res = await api.patch<ContentItem>(`/content/${id}`, payload);
      if (res.data) {
        setContent(res.data);
        setHasChanges(false);
        setSaveMsg("已保存");
        setTimeout(() => setSaveMsg(""), 2000);
      }
    } catch (err) {
      setSaveMsg("保存失败");
      console.error("保存失败", err);
    } finally {
      setSaving(false);
    }
  };

  // 状态变更
  const handleStatusChange = async (newStatus: string) => {
    if (!id) return;
    try {
      const res = await api.patch<ContentItem>(`/content/${id}`, { status: newStatus });
      if (res.data) {
        setContent(res.data);
        setSaveMsg(`状态已更新为「${STATUS_LABELS[newStatus]}」`);
        setTimeout(() => setSaveMsg(""), 3000);
      }
    } catch (err) {
      console.error("状态更新失败", err);
    }
  };

  // 获取账号列表
  const fetchAccounts = useCallback(async () => {
    setAccountsLoading(true);
    try {
      const res = await api.get<Account[]>("/accounts");
      if (res.data) {
        setAccounts(Array.isArray(res.data) ? res.data : []);
      }
    } catch (err) {
      console.error("获取账号列表失败", err);
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  // 打开发布面板时获取账号列表
  useEffect(() => {
    if (showPublishPanel) {
      fetchAccounts();
    }
  }, [showPublishPanel, fetchAccounts]);

  // 切换账号选择
  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccountIds(prev =>
      prev.includes(accountId)
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId]
    );
  };

  // 全选某个平台的账号
  const togglePlatformAll = (platform: string) => {
    const platformAccountIds = accounts
      .filter(acc => acc.platform === platform)
      .map(acc => acc.id);

    const allSelected = platformAccountIds.every(id => selectedAccountIds.includes(id));

    if (allSelected) {
      setSelectedAccountIds(prev =>
        prev.filter(id => !platformAccountIds.includes(id))
      );
    } else {
      setSelectedAccountIds(prev =>
        Array.from(new Set([...prev, ...platformAccountIds]))
      );
    }
  };

  // PR #266: 生成 N 套差异化抖音文案 (发 N 个矩阵号, 防同质化降权)
  const handleGenerateDouyinCaption = async (force = false) => {
    if (!content) return;
    setDouyinLoading(true);
    try {
      const res = await api.post<DyVariant[]>(
        `/content/${content.id}/douyin-caption-variants?count=${variantCount}&platform=${captionPlatform}${force ? "&force=true" : ""}`,
        {}
      );
      if (res.data) {
        setDouyinVariants(res.data);
        setDouyinPosted(new Array(res.data.length).fill(false));
        if (force) toast.success("已重新生成文案");
      }
    } catch {
      toast.error("文案生成失败，请重试");
    } finally {
      setDouyinLoading(false);
    }
  };

  // 复制文本到剪贴板
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  };

  // 发布到选中的账号
  const handlePublish = async () => {
    if (!id || selectedAccountIds.length === 0) return;
    setPublishing(true);
    setPublishMsg("");
    setPublishResults([]);
    try {
      const res = await api.post<{ results: PublishResult[]; summary: { total: number; success: number; failed: number } }>("/publish", {
        contentId: id,
        accountIds: selectedAccountIds,
      });

      if (res.data) {
        const results = res.data.results || [];
        setPublishResults(results);
        const s = res.data.summary;
        // 精细文案：失败优先暴露，draft_only 用独立词避免"成功"歧义
        const fullOk = results.filter((r) => r.success && r.mode === "full").length;
        const draftOnly = results.filter((r) => r.success && r.mode === "draft_only").length;
        const failed = s.failed;
        const parts: string[] = [];
        if (fullOk > 0) parts.push(`${fullOk} 个已群发`);
        if (draftOnly > 0) parts.push(`${draftOnly} 个进草稿箱待人工发送`);
        if (failed > 0) parts.push(`${failed} 个失败`);
        setPublishMsg(parts.length > 0 ? parts.join("，") : "无发布结果");

        // 仅当有账号"真正群发"(mode=full)才把内容标 published；draft_only 保留原状态
        if (fullOk > 0) {
          await api.patch(`/content/${id}`, { status: "published" });
          fetchContent();
        }
      }
    } catch (err) {
      setPublishMsg(`发布出错：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setPublishing(false);
    }
  };

  // Markdown → HTML（先转义再匹配语法，避免 XSS；HTML 分支走 DOMParser 白名单清洗）
  const renderMarkdown = (md: string) => {
    const trimmed = md.trim();

    // 后端期刊推荐模板等场景返回的是 HTML；用白名单 sanitizer 清洗后渲染，
    // script/iframe/on*/javascript: 等危险内容会被剥离。
    // PR Q.8 hotfix：article body 现在以 <article class="bm-template-{styleTag}"> 开头（PR Q.4
    // CSS 主题包裹）。原识别只 <div/<section/<!，<article 走错 markdown 分支被 escapeHtml 转义
    // → 浏览器渲染 raw 字符（5-7 user 验收预览 tab 看到 raw HTML）。加 <article 识别。
    if (trimmed.startsWith("<div") || trimmed.startsWith("<section") || trimmed.startsWith("<article") || trimmed.startsWith("<!")) {
      return sanitizeHtml(trimmed);
    }

    // 第一步：把用户正文里任何原始 HTML 都先转义，防止注入。
    const safe = escapeHtml(md);

    // 第二步：对转义后的安全字符串做 Markdown 语法替换。
    // 链接单独处理，校验 URL 协议，拒绝 javascript:/data: 等。
    let html = safe
      // 标题
      .replace(/^### (.+)$/gm, '<h3 class="text-base font-bold text-gray-800 mt-4 mb-2">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-gray-900 mt-5 mb-2">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-gray-900 mt-6 mb-3">$1</h1>')
      // 粗体和斜体
      .replace(/\*\*(.+?)\*\*/g, '<strong class="font-bold">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
      // 行内代码
      .replace(/`([^`]+)`/g, '<code class="bg-gray-100 text-red-600 px-1.5 py-0.5 rounded text-sm">$1</code>')
      // 引用（注意：escapeHtml 已把 > 转成 &gt;）
      .replace(/^&gt; (.+)$/gm, '<blockquote class="border-l-4 border-blue-300 pl-4 py-1 my-2 text-gray-600 italic">$1</blockquote>')
      // 无序列表
      .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-gray-700">$1</li>')
      // 有序列表
      .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal text-gray-700">$1</li>')
      // 分割线
      .replace(/^---$/gm, '<hr class="my-4 border-gray-200" />')
      // 链接：校验协议，不安全则以纯文本形式保留
      .replace(/\[(.+?)\]\((.+?)\)/g, (_m, text, url) => {
        if (!isSafeUrl(url)) return `[${text}](${url})`;
        // text / url 已经经过 escapeHtml 处理，可以安全拼入属性
        return `<a href="${url}" class="text-blue-600 underline" target="_blank" rel="noopener noreferrer">${text}</a>`;
      })
      // 段落（空行分隔）
      .replace(/\n\n/g, '</p><p class="text-gray-700 leading-relaxed mb-3">')
      // 单换行
      .replace(/\n/g, "<br />");

    return `<p class="text-gray-700 leading-relaxed mb-3">${html}</p>`;
  };

  // Ctrl+S 快捷保存
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasChanges) handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasChanges, handleSave]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!content) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4">
        <p className="text-gray-500">内容不存在</p>
        <Link to="/content" className="text-blue-600 hover:text-blue-700 text-sm">
          返回内容列表
        </Link>
      </div>
    );
  }

  // ===== 多版本推导 =====
  const getVariantInfo = (c: ContentItem) => ({
    variantIndex: typeof c.metadata?.variantIndex === "number" ? c.metadata.variantIndex : 0,
    userSelected: c.metadata?.userSelected === true,
    userRejected: c.metadata?.userRejected === true,
  });

  const isMultiVariant = (content.siblings?.length ?? 0) > 0;
  const allVariants = isMultiVariant
    ? [content, ...secondaries].sort(
        (a, b) => getVariantInfo(a).variantIndex - getVariantInfo(b).variantIndex
      )
    : [content];
  const someoneSelected = allVariants.some((v) => getVariantInfo(v).userSelected);
  // 双栏对比期：多版本但还没人选定
  const showVariantCompare = isMultiVariant && !someoneSelected;
  const currentInfo = getVariantInfo(content);
  const currentIsRejected = isMultiVariant && currentInfo.userRejected;

  // 选定一版（其他自动标记 rejected）
  const handleSelectVariant = async (selectedId: string) => {
    if (!window.confirm("选定这版后，另一版会被标记为已弃用（数据保留可恢复）。继续？")) return;
    try {
      await api.post(`/content/${selectedId}/select-variant`, {});
      toast.success("已选定，进入审核");
      if (selectedId !== id) {
        navigate(`/content/${selectedId}`);
      } else {
        await fetchContent();
      }
    } catch (err) {
      toast.error("选定失败：" + (err instanceof Error ? err.message : "未知错误"));
    }
  };

  // 双栏对比期 + 当前版本已被弃用 时，禁用编辑/发布
  const canEdit =
    !showVariantCompare &&
    !currentIsRejected &&
    (content.status === "draft" || content.status === "reviewing");
  // 5-9 PR P0 state-machine: 旧 'approved' → 新 'generated'. canPublish 加 'generated'
  // 让推荐池文章 (system tenant cron 产出 status='generated') 能直接发, 不再灰按钮.
  // 'approved' 保留作历史兼容 (老数据未 migration 过).
  const canPublish =
    !showVariantCompare &&
    !currentIsRejected &&
    (content.status === "generated" ||
      content.status === "approved" ||
      content.status === "draft");

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* 顶部导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          {/* 5-23 hotfix: navigate(-1) 自动回上一页 (/workbench 或 /content), Link 写死 /content 是 bug */}
          <button
            onClick={() => navigate(-1)}
            className="text-blue-600 hover:text-blue-700 text-sm bg-transparent border-none p-0 cursor-pointer"
          >
            ← 返回
          </button>
          <span className="text-gray-300">|</span>
          <span className="text-sm text-gray-500">
            {TYPE_LABELS[content.type] || content.type}
          </span>
          <span
            className={`inline-block text-xs px-2.5 py-1 rounded-full font-medium ${
              STATUS_COLORS[content.status] || "bg-gray-100 text-gray-600"
            }`}
          >
            {STATUS_LABELS[content.status] || content.status}
          </span>
          {/* T4-3-5: 当前内容所用模板 badge（无 templateId 时优雅隐藏） */}
          <TemplateBadge
            templateId={content.metadata?.templateId as string | undefined}
            templates={templates}
          />
          {/* PR D6 sprint B: aiScore + 4 维度 hardMetrics 浮窗展示（5-13 demo 老板信任感）*/}
          {typeof content.metadata?.aiScore === "number" && (
            <div className="flex items-center gap-1.5 ml-2 text-xs">
              <span className={`px-2 py-1 rounded-md font-bold ${
                (content.metadata.aiScore as number) >= 85 ? "bg-green-100 text-green-700"
                : (content.metadata.aiScore as number) >= 70 ? "bg-blue-100 text-blue-700"
                : "bg-orange-100 text-orange-700"
              }`} title="AI 综合评分（85+ 优秀 / 70-84 良好 / <70 待优化）">
                AI {Math.round(content.metadata.aiScore as number)}/100
              </span>
              {content.metadata.hardMetrics && (
                <span className="text-xs text-gray-500" title="硬指标：字数偏差 / 段落数 / 关键点覆盖">
                  字 {Math.round((content.metadata.hardMetrics as any)?.wordDeviationScore ?? 0)}
                  · 段 {Math.round((content.metadata.hardMetrics as any)?.paragraphScore ?? 0)}
                  · 关键 {Math.round((content.metadata.hardMetrics as any)?.keyPointScore ?? 0)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* 保存提示 */}
          {saveMsg && (
            <span className="text-xs text-green-600 animate-pulse">{saveMsg}</span>
          )}

          {/* T4-2-2: AI 改段（task #20）— 仅在可编辑且正文有 ## 章节时启用 */}
          {canEdit && /^##\s+/m.test(editBody) && (
            <button
              onClick={() => setShowRewriteModal(true)}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
              title="按章节调用 AI 重写（不直接落库，先预览 diff）"
            >
              ✨ 改段
            </button>
          )}

          {/* T4-2-3: 编辑历史（task #21） */}
          <button
            onClick={() => setShowHistoryDrawer(true)}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100"
            title="查看老板对这条内容的所有编辑动作"
          >
            📝 历史
          </button>


          {/* 保存按钮 */}
          {canEdit && (
            <button
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                hasChanges
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {saving ? "保存中..." : hasChanges ? "保存" : "已保存"}
            </button>
          )}

          {/* 状态流转按钮（双栏对比期 / 已弃用版本上禁用，强制走 select-variant） */}
          {!showVariantCompare && !currentIsRejected && (STATUS_FLOW[content.status] || []).map((action) => (
            <button
              key={action.next}
              onClick={() => handleStatusChange(action.next)}
              className={`px-4 py-1.5 text-sm font-medium text-white rounded-lg transition-all ${action.color}`}
            >
              {action.label}
            </button>
          ))}

          {/* 发布按钮 */}
          {canPublish && (
            <button
              onClick={() => setShowPublishPanel(!showPublishPanel)}
              className="px-4 py-1.5 text-sm font-medium text-white rounded-lg bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 transition-all"
            >
              发布
            </button>
          )}

          {/* 5-21 P0: user/logout 已搬 sidebar (MainLayout), 此处保留 action 行 (Save/改段/History/发布) */}
        </div>
      </nav>

      {/* PR 1：AI 编造期刊警告横幅（data_source='ai_fabricated' 时） */}
      {journalDataSource === "ai_fabricated" && (
        <div className="bg-yellow-50 border-b-2 border-yellow-300 px-6 py-3 shrink-0">
          <div className="max-w-6xl mx-auto flex items-start gap-2 text-sm text-yellow-900">
            <span className="text-lg shrink-0">⚠️</span>
            <span>
              <strong>本期刊数据为 AI 推测，未经官方核验</strong>
              ，请审慎使用。建议在 LetPub / 中科院分区表 / 期刊官网交叉验证后再发布。
            </span>
          </div>
        </div>
      )}

      {/* 图文 article 快捷操作（5-15 PR #141: 老 video_script 按钮已下线，换数字人视频） */}
      {content.type === "article" && (
        <div className="bg-gradient-to-r from-blue-50 to-purple-50 border-b border-blue-100 px-6 py-3 shrink-0">
          <div className="max-w-6xl mx-auto flex items-center gap-3 flex-wrap">
            <span className="text-xs text-gray-500 mr-2">下一步：</span>
            <button
              onClick={() => setShowRewriteModal(true)}
              disabled={!canEdit || !/^##\s+/m.test(editBody)}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              ✏️ 编辑此文
            </button>
            {/* 5-15 PR #141: 数字人视频 — inline select 选 4 套主播模板 */}
            <select
              value={dvhTemplate}
              onChange={(e) => setDvhTemplate(e.target.value)}
              className="px-2 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-700"
              aria-label="数字人模板"
            >
              <option value="A_academic">A 学术</option>
              <option value="B_marketing">B 营销</option>
              <option value="C_popular">C 科普</option>
              <option value="E_industry">E 行业</option>
            </select>
            <button
              onClick={handleGenerateDvhVideo}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-pink-600 text-white hover:bg-pink-700"
            >
              🎬 生成数字人视频
            </button>
            <button
              onClick={() => setShowPublishPanel(true)}
              disabled={!canPublish}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              📤 发布到公众号
            </button>
          </div>
        </div>
      )}

      {/* 发布面板 */}
      {showPublishPanel && canPublish && (
        <div className="bg-green-50 border-b border-green-200 px-6 py-4 shrink-0">
          <div className="max-w-6xl mx-auto">
            <h3 className="text-sm font-bold text-green-800 mb-4">发布到平台账号</h3>

            {accountsLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                加载账号中...
              </div>
            ) : accounts.length === 0 ? (
              <div className="text-sm text-gray-600">
                暂无账号。请先前往
                <Link to="/accounts" className="text-blue-600 underline">
                  平台账号管理
                </Link>
                添加账号。
              </div>
            ) : (
              <>
                {/* 按平台分组显示账号 */}
                <div className="space-y-3 mb-4">
                  {Array.from(
                    new Set(accounts.map(acc => acc.platform))
                  ).map(platform => {
                    const platformAccounts = accounts.filter(
                      acc => acc.platform === platform
                    );
                    const platformIcons: Record<string, string> = {
                      wechat: "💬",
                      baijiahao: "📰",
                      toutiao: "📱",
                      zhihu: "🔍",
                      xiaohongshu: "📕",
                    };
                    const platformNames: Record<string, string> = {
                      wechat: "微信公众号",
                      baijiahao: "百家号",
                      toutiao: "头条号",
                      zhihu: "知乎",
                      xiaohongshu: "小红书",
                    };

                    const allSelected = platformAccounts.every(acc =>
                      selectedAccountIds.includes(acc.id)
                    );

                    return (
                      <div
                        key={platform}
                        className="bg-white rounded-lg border border-green-200 p-3"
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => togglePlatformAll(platform)}
                            className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                          />
                          <span className="text-lg">
                            {platformIcons[platform] || "🌐"}
                          </span>
                          <span className="text-sm font-medium text-gray-700">
                            {platformNames[platform] || platform}
                          </span>
                          <span className="text-xs text-gray-500">
                            ({platformAccounts.length})
                          </span>
                        </div>
                        <div className="space-y-2 ml-6">
                          {platformAccounts.map(account => (
                            <label
                              key={account.id}
                              className="flex items-center gap-2 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={selectedAccountIds.includes(
                                  account.id
                                )}
                                onChange={() =>
                                  toggleAccountSelection(account.id)
                                }
                                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                              />
                              <span className="text-sm text-gray-700">
                                {account.accountName}
                              </span>
                              <span
                                className={`text-xs px-1.5 py-0.5 rounded ${
                                  account.isVerified
                                    ? "bg-green-100 text-green-700"
                                    : "bg-yellow-100 text-yellow-700"
                                }`}
                              >
                                {account.isVerified
                                  ? "已验证"
                                  : "待验证"}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 发布按钮和结果 */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handlePublish}
                    disabled={
                      publishing ||
                      selectedAccountIds.length === 0
                    }
                    className={`px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${
                      publishing || selectedAccountIds.length === 0
                        ? "bg-gray-400 cursor-not-allowed"
                        : "bg-green-600 hover:bg-green-700 active:scale-95"
                    }`}
                  >
                    {publishing
                      ? "发布中..."
                      : `发布到 ${selectedAccountIds.length} 个账号`}
                  </button>
                </div>

                {/* 发布结果 — 4 态：full 绿 / draft_only 蓝 / failed-with-draft 橙 / failed 红 */}
                {publishResults.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm font-medium text-gray-700 mb-2">
                      发布结果：
                    </p>
                    {publishResults.map(result => {
                      const isFull = result.success && result.mode === "full";
                      const isDraftOnly = result.success && result.mode === "draft_only";
                      const isFailedWithDraft = !result.success && !!result.mediaId;
                      const isFailedHard = !result.success && !result.mediaId;

                      let toneClass: string;
                      let icon: string;
                      let fallbackText: string;
                      let btnClass: string;
                      let btnLabel: string;

                      if (isFull) {
                        toneClass = "bg-green-100 text-green-700";
                        icon = "✓";
                        fallbackText = "已群发";
                        btnClass = "";
                        btnLabel = "";
                      } else if (isDraftOnly) {
                        toneClass = "bg-blue-50 text-blue-700 border border-blue-200";
                        icon = "📝";
                        fallbackText = "草稿已创建";
                        btnClass = "bg-blue-600 hover:bg-blue-700";
                        btnLabel = "前往公众号后台发送 →";
                      } else if (isFailedWithDraft) {
                        toneClass = "bg-orange-50 text-orange-700 border border-orange-200";
                        icon = "⚠";
                        fallbackText = "发布失败但草稿已保存";
                        btnClass = "bg-orange-600 hover:bg-orange-700";
                        btnLabel = "前往公众号后台查看草稿 →";
                      } else {
                        toneClass = "bg-red-100 text-red-700";
                        icon = "✗";
                        fallbackText = "失败";
                        btnClass = "";
                        btnLabel = "";
                      }

                      const text = isFailedHard
                        ? (result.error || fallbackText)
                        : (result.message || result.error || fallbackText);
                      const showBtn = (isDraftOnly || isFailedWithDraft) && !!result.draftUrl;

                      return (
                        <div
                          key={result.accountId}
                          className={`text-sm p-2 rounded flex items-center justify-between gap-3 ${toneClass}`}
                        >
                          <span className="flex-1">
                            {icon} <span className="font-medium">{result.accountName}</span>：{text}
                          </span>
                          {showBtn && (
                            <a
                              href={result.draftUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`shrink-0 px-3 py-1 rounded text-white text-xs font-medium ${btnClass}`}
                            >
                              {btnLabel}
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {publishMsg && (
                  <p
                    className={`mt-3 text-sm ${
                      // 按 results 实际状态判色，不做字符串匹配
                      publishResults.some((r) => !r.success)
                        ? "text-red-600"
                        : publishResults.some((r) => r.success && r.mode === "draft_only")
                          ? "text-blue-700"
                          : "text-green-700"
                    }`}
                  >
                    {publishMsg}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col max-w-6xl w-full mx-auto py-6 px-6">
        {/* 标题编辑 */}
        {canEdit ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="输入标题..."
            className="text-2xl font-bold text-gray-900 bg-transparent border-none outline-none mb-4 w-full placeholder-gray-300"
          />
        ) : (
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            {content.title || "无标题"}
          </h1>
        )}

        {/* 元信息 */}
        <div className="flex items-center gap-4 text-xs text-gray-400 mb-4">
          <span>创建于 {new Date(content.createdAt).toLocaleString("zh-CN")}</span>
          <span>更新于 {new Date(content.updatedAt).toLocaleString("zh-CN")}</span>
          {content.tokensTotal > 0 && (
            <span>消耗 {content.tokensTotal.toLocaleString()} tokens</span>
          )}
          {content.conversationId && (
            <Link
              to={`/chat/${content.conversationId}`}
              className="text-blue-500 hover:text-blue-600"
            >
              查看原始对话 →
            </Link>
          )}
        </div>

        {/* 多版本横幅 */}
        {isMultiVariant && (
          <div
            className={`mb-4 px-4 py-3 rounded-lg border text-sm ${
              showVariantCompare
                ? "bg-blue-50 border-blue-200 text-blue-800"
                : currentIsRejected
                  ? "bg-gray-50 border-gray-200 text-gray-600"
                  : "bg-green-50 border-green-200 text-green-800"
            }`}
          >
            {showVariantCompare && (
              <span>📑 共 {allVariants.length} 个版本，请对比后选定一版（另一版会标记为已弃用，数据保留可恢复）</span>
            )}
            {!showVariantCompare && currentInfo.userSelected && (
              <span>✓ 当前为已选定版本（共 {allVariants.length} 个版本）</span>
            )}
            {!showVariantCompare && currentIsRejected && (
              <span>⚠ 当前版本已被弃用，请前往选定版本查看</span>
            )}
          </div>
        )}

        {showVariantCompare ? (
          // ============ 双栏对比视图 ============
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {allVariants.map((v, idx) => {
              const info = getVariantInfo(v);
              const isSelected = info.userSelected;
              const isRejected = info.userRejected;
              return (
                <div
                  key={v.id}
                  className={`flex flex-col bg-white border rounded-xl p-4 ${
                    isSelected
                      ? "border-green-400 ring-2 ring-green-100"
                      : isRejected
                        ? "border-gray-200 opacity-60"
                        : "border-gray-200"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-500">
                        版本 {idx + 1}（variantIndex={info.variantIndex}）
                      </span>
                      {/* T4-3-5: 该版本所用模板 badge */}
                      <TemplateBadge
                        templateId={v.metadata?.templateId as string | undefined}
                        templates={templates}
                      />
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        STATUS_COLORS[v.status] || "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {STATUS_LABELS[v.status] || v.status}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-gray-900 mb-2 line-clamp-2">
                    {v.title || "无标题"}
                  </h3>
                  <div
                    className="flex-1 min-h-[400px] max-h-[600px] overflow-y-auto p-3 bg-gray-50 border border-gray-100 rounded-lg text-sm prose-sm"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(v.body || "暂无内容"),
                    }}
                  />
                  <button
                    onClick={() => handleSelectVariant(v.id)}
                    disabled={isSelected || isRejected}
                    className={`mt-3 w-full py-2.5 rounded-lg text-sm font-medium transition-all ${
                      isSelected
                        ? "bg-green-100 text-green-700 cursor-not-allowed"
                        : isRejected
                          ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                          : "bg-blue-600 text-white hover:bg-blue-700 active:scale-95"
                    }`}
                  >
                    {isSelected ? "✓ 已选定" : isRejected ? "已弃用" : "选这版"}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {/* ============ 单版本 / 已选定 视图（保持原编辑器逻辑） ============ */}

            {/* 视图模式切换 */}
            {canEdit && (
              <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-fit">
                {(["edit", "split", "preview"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      viewMode === mode
                        ? "bg-white text-blue-600 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {{ edit: "编辑", split: "分屏", preview: "预览" }[mode]}
                  </button>
                ))}
              </div>
            )}

            {/* 编辑器区域 */}
            <div className="flex-1 flex gap-4 min-h-0">
              {/* 编辑面板 */}
              {canEdit && (viewMode === "edit" || viewMode === "split") && (
                <div className={`${viewMode === "split" ? "w-1/2" : "w-full"} flex flex-col`}>
                  <div className="text-xs text-gray-400 mb-2">Markdown 编辑</div>
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    placeholder="在这里编写内容，支持 Markdown 格式..."
                    className="flex-1 min-h-[500px] p-4 bg-white border border-gray-200 rounded-xl text-sm text-gray-800 leading-relaxed font-mono resize-none outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>
              )}

              {/* 预览面板 */}
              {(viewMode === "preview" || viewMode === "split" || !canEdit) && (
                <div className={`${viewMode === "split" ? "w-1/2" : "w-full"} flex flex-col`}>
                  <div className="text-xs text-gray-400 mb-2">
                    {canEdit ? "预览" : "内容"}
                  </div>
                  {content.type === "video" ? (
                    <div className="flex-1 min-h-[300px] p-6 bg-black rounded-xl flex items-center justify-center">
                      <div className="w-full max-w-lg">
                        <video
                          src={content.body || ""}
                          controls
                          poster={(content.metadata as any)?.coverUrl}
                          className="w-full rounded-lg"
                        />
                        <div className="mt-3 flex justify-center gap-3">
                          <a href={content.body || ""} download className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                            ⬇ 下载视频
                          </a>
                        </div>
                        {(content.metadata as any)?.durationMs && (
                          <p className="text-center text-xs text-gray-400 mt-2">
                            时长 {Math.round(((content.metadata as any).durationMs || 0) / 1000)}s ·
                            大小 {((content.metadata as any).sizeBytes ? ((content.metadata as any).sizeBytes / 1024 / 1024).toFixed(1) + "MB" : "未知")}
                          </p>
                        )}
                        {/* PR #264/#266: 抖音半自动发布助手 — 多号差异化文案 + 复制 + 发布勾选 */}
                        <div className="mt-4 p-4 bg-white rounded-lg text-left">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-semibold text-gray-800">
                              {captionPlatform === "wechat_video" ? "📹 视频号发布助手" : "🎵 抖音发布助手"}
                            </span>
                            <div className="flex items-center gap-1.5">
                              {/* PR-M2: 平台切换 — 切到哪个用哪个平台文案风格 */}
                              {([["douyin", "🎵 抖音"], ["wechat_video", "📹 视频号"]] as const).map(([p, lbl]) => (
                                <button key={p}
                                  onClick={() => { if (captionPlatform !== p) { setCaptionPlatform(p); setDouyinVariants(null); setDouyinPosted([]); } }}
                                  className={`text-xs px-2 py-0.5 rounded ${captionPlatform === p ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                                >{lbl}</button>
                              ))}
                              {douyinVariants && (
                                <button
                                  onClick={() => handleGenerateDouyinCaption(true)}
                                  disabled={douyinLoading}
                                  className="text-xs text-blue-600 hover:underline disabled:opacity-50 ml-1"
                                >🔄 重新生成</button>
                              )}
                            </div>
                          </div>
                          {!douyinVariants ? (
                            <div className="flex items-center gap-2">
                              <label className="text-sm text-gray-600">发</label>
                              <input
                                type="number"
                                min={1}
                                max={10}
                                value={variantCount}
                                onChange={(e) => setVariantCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
                                className="w-14 px-2 py-1 text-sm border border-gray-200 rounded"
                              />
                              <label className="text-sm text-gray-600">个号</label>
                              <button
                                onClick={() => handleGenerateDouyinCaption(false)}
                                disabled={douyinLoading}
                                className="ml-auto px-4 py-2 text-sm bg-pink-600 text-white rounded-lg hover:bg-pink-700 disabled:opacity-50"
                              >{douyinLoading ? "生成中…" : "✨ 生成差异化文案"}</button>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-gray-500">{douyinVariants.length} 套互不雷同文案，每个号用一套（防同质化降权）</span>
                                <div className="flex gap-1.5">
                                  <button
                                    onClick={() => copyToClipboard(content.body || "", "视频链接")}
                                    className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                                  >🔗 复制视频链接</button>
                                  <button
                                    onClick={() => setShowDouyinQr((v) => !v)}
                                    className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                                  >📱 {showDouyinQr ? "收起" : "扫码下载"}</button>
                                </div>
                              </div>
                              {showDouyinQr && content.body && (
                                <div className="mb-3 flex flex-col items-center gap-1 p-3 bg-gray-50 rounded-lg">
                                  <img
                                    src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(content.body)}`}
                                    alt="视频下载二维码"
                                    width={180}
                                    height={180}
                                    className="rounded bg-white p-1"
                                  />
                                  <span className="text-xs text-gray-500">手机扫码打开视频 → 长按/下载保存到相册</span>
                                </div>
                              )}
                              <div className="space-y-3 max-h-[420px] overflow-y-auto">
                                {douyinVariants.map((v, i) => (
                                  <div key={i} className={`border rounded-lg p-3 ${douyinPosted[i] ? "border-green-300 bg-green-50" : "border-gray-200"}`}>
                                    <div className="flex items-center justify-between mb-1">
                                      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
                                        <input
                                          type="checkbox"
                                          checked={douyinPosted[i] || false}
                                          onChange={(e) => setDouyinPosted((prev) => prev.map((f, k) => (k === i ? e.target.checked : f)))}
                                        />
                                        号 {i + 1}{douyinPosted[i] ? " · 已发" : ""}
                                      </label>
                                      <button
                                        onClick={() => copyToClipboard(v.fullText, `号${i + 1}文案`)}
                                        className="text-xs px-2.5 py-1 bg-pink-600 text-white rounded hover:bg-pink-700"
                                      >📋 复制</button>
                                    </div>
                                    <textarea
                                      readOnly
                                      value={v.fullText}
                                      rows={4}
                                      className="w-full text-xs p-2 border border-gray-100 rounded bg-gray-50 resize-none"
                                    />
                                  </div>
                                ))}
                              </div>
                              <ol className="mt-3 text-xs text-gray-500 list-decimal list-inside space-y-0.5">
                                <li>下载视频到手机（上方「下载视频」或复制链接在手机打开）</li>
                                <li>每个号：打开{captionPlatform === "wechat_video" ? "视频号" : "抖音"} → ＋ → 选视频 → 复制对应「号N文案」粘贴 → 发布</li>
                                <li>发完一个勾一个，避免漏发 / 重发</li>
                              </ol>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col min-h-[500px]">
                      {/* 5-23 PR #159: 期刊封面 hero (frozen body 不动, 详情页注入) */}
                      <JournalCoverHero
                        coverUrl={content.journal?.coverImageUrl}
                        journalName={content.journal?.nameEn}
                      />
                      <div
                        // PR Q.8 hotfix：去 prose-sm（Tailwind typography 覆盖 4 套模板 inline CSS），
                        // 加 bossmate-article-preview wrapper（global.css 内重置 box-sizing 防干扰）。
                        // 4 套主题靠内层 <article class="bm-template-{styleTag}"> CSS 命中。
                        className="bossmate-article-preview flex-1 p-6 bg-white border border-gray-200 rounded-xl overflow-y-auto"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(canEdit ? editBody : (content.body || "暂无内容")),
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* 平台发布记录 */}
        {content.platforms && Array.isArray(content.platforms) && content.platforms.length > 0 && (
          <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-700 mb-3">发布记录</h3>
            <div className="space-y-2">
              {content.platforms.map((p, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="text-gray-400">
                    {{ wechat: "💬", douyin: "🎵", xiaohongshu: "📱" }[p.platform] || "🌐"}
                  </span>
                  <span className="font-medium text-gray-700">
                    {{ wechat: "微信公众号", douyin: "抖音", xiaohongshu: "小红书" }[p.platform] || p.platform}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    p.status === "published" ? "bg-green-100 text-green-700" :
                    p.status === "draft" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-600"
                  }`}>
                    {p.status || "pending"}
                  </span>
                  {p.publishedAt && (
                    <span className="text-xs text-gray-400">
                      {new Date(p.publishedAt).toLocaleString("zh-CN")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* T4-2-2: AI 改段 Modal（task #20） */}
      {id && (
        <RewriteSectionModal
          contentId={id}
          currentBody={editBody}
          open={showRewriteModal}
          onClose={() => setShowRewriteModal(false)}
          onApplied={(updatedBody) => {
            setEditBody(updatedBody);
            // server 已落库，本地 content 同步刷新（避免 hasChanges 误判脏）
            setContent((c) => (c ? { ...c, body: updatedBody } : c));
            // T4-2-3: 触发历史侧栏刷新（如已开着 Drawer 立刻显示新 rewrite_section 卡）
            setHistoryRefreshNonce((n) => n + 1);
          }}
        />
      )}

      {/* T4-2-3: 编辑历史 Drawer（task #21） */}
      {id && (
        <EditTimelineDrawer
          contentId={id}
          open={showHistoryDrawer}
          onClose={() => setShowHistoryDrawer(false)}
          resolveTemplateName={(tid) => templates.get(tid)?.name}
          refreshNonce={historyRefreshNonce}
        />
      )}
    </div>
  );
}
