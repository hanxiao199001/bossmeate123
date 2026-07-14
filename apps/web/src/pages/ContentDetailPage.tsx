import { useState, useEffect, useCallback } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../utils/api";
import { toast } from "../components/Toast";
import StatusBadge, { statusLabel } from "../components/StatusBadge";
import { PLATFORM_META, platformLabel } from "../utils/i18n";
import { escapeHtml, isSafeUrl, sanitizeHtml } from "../utils/sanitize";
import RewriteSectionModal from "../components/RewriteSectionModal";
import EditTimelineDrawer from "../components/EditTimelineDrawer";
import AccountSelector from "../components/AccountSelector";
import UnifiedVideoModal from "../components/video/UnifiedVideoModal";
import ConfirmModal from "../components/ui/ConfirmModal";

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
  createdAt?: string;
  // PR-S4: 浏览器登录态 (扫码登录后可自动推草稿箱)
  loginStatus?: "none" | "logged_in" | "expired";
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
  /** Agent-3: 本地 Agent 任务尚未到终态 (pending/claimed), 渲染为进行中而非失败 */
  pending?: boolean;
}

// Agent-3: GET /agent-admin/tasks 返回的任务 (status: pending|claimed|success|failed|login_expired|canceled|manual_pending)
interface AgentTask {
  id: string;
  accountId: string;
  accountName: string;
  platform: string;
  status: string;
  error?: string | null;
}

// ===== 常量 =====
// 6-11 施工包A(审计 2.3): 旧 4 状态表删除——它缺 generated/generating/failed,
// 导致详情页直接显示英文原码;词表/配色统一走 components/StatusBadge。

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
  // 发布二次确认(防误发): 点「发布」先弹确认, 确认才真发
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [showPublishPanel, setShowPublishPanel] = useState(
    searchParams.get("action") === "publish"
  );
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  // 6-11 抖音合规「是否同步」: 选中抖音账号时显示明确告知+可取消勾选(使用规范硬要求)
  const [syncToDouyin, setSyncToDouyin] = useState(true);
  // Agent-3: 发布通道 — server=服务器直发(浏览器推草稿箱) / agent=派发给本地 Agent(客户电脑本机浏览器)
  const [publishChannel, setPublishChannel] = useState<"server" | "agent">("server");
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
  // PR-P1: 矩阵账号联动 — 助手读真实抖音/视频号账号, 每套文案绑定账号, "已发"写 content_publish_log
  const [matrixAccounts, setMatrixAccounts] = useState<Account[]>([]);
  const [matrixPosted, setMatrixPosted] = useState<Record<string, boolean>>({});
  // PR-S4: 推草稿箱 — 已推草稿映射 + 异步任务进度
  const [matrixDrafted, setMatrixDrafted] = useState<Record<string, boolean>>({});
  const [matrixRefreshNonce, setMatrixRefreshNonce] = useState(0);
  const [pushJob, setPushJob] = useState<{ jobId: string; accounts: Array<{ accountId: string; accountName: string; status: string; error?: string }> } | null>(null);
  const [pushing, setPushing] = useState(false);

  // T4-2-2: AI 改段 Modal 开关（task #20）
  const [showRewriteModal, setShowRewriteModal] = useState(false);
  // T4-2-3: 编辑历史 Drawer（task #21）+ refresh nonce 在 applyRewrite 后递增触发刷新
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);

  // 6-11 施工包C1-b (审计 1.2): 数字人视频改弹统一 UnifiedVideoModal (原 inline 模板下拉 + dvhTemplate state 下线)
  const [showVideoModal, setShowVideoModal] = useState(false);

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
        setSaveMsg(`状态已更新为「${statusLabel(newStatus)}」`);
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

  // 7-05 ⑤: 文章类内容 → 拉"已推草稿箱→某号"记录 (draft_dist 推的 status=draft_pushed; 浏览器推的 status=draft)
  // 7-06 ②: 同一接口顺带识别 published_by_operator (回流确认运营已群发 — 市场选择信号)
  const [draftPushedTo, setDraftPushedTo] = useState<string[]>([]);
  const [operatorPublishedTo, setOperatorPublishedTo] = useState<string[]>([]);
  // 7-06 ①: 公众号回流指标 (累计快照: 阅读/分享/收藏 + 截至日期)
  const [reflowStats, setReflowStats] = useState<{ views: number; shares: number; saves: number; snapshotDate: string; source: string | null } | null>(null);
  useEffect(() => {
    if (!id || !content || content.type === "video") return;
    (async () => {
      try {
        const res = await api.get<Array<{ accountId: string; status: string; accountName?: string | null }>>(
          `/content/${id}/manual-publish-log`
        );
        const rows = res.data || [];
        const names = rows
          .filter((r) => r.status === "draft_pushed" || r.status === "draft")
          .map((r) => r.accountName || "未知账号");
        setDraftPushedTo([...new Set(names)]);
        const opNames = rows
          .filter((r) => r.status === "published_by_operator")
          .map((r) => r.accountName || "未知账号");
        setOperatorPublishedTo([...new Set(opNames)]);
      } catch { /* 无记录/接口失败不阻塞详情页 */ }
      try {
        const m = await api.get<Array<{ platform: string; views: number; shares: number; saves: number; snapshotDate: string; source: string | null }>>(
          `/content/${id}/metrics`
        );
        const wx = (m.data || []).find((r) => r.platform === "wechat" && (r.views > 0 || r.shares > 0 || r.saves > 0));
        setReflowStats(wx ? { views: wx.views, shares: wx.shares, saves: wx.saves, snapshotDate: String(wx.snapshotDate ?? "").slice(0, 10), source: wx.source } : null);
      } catch { /* 无回流数据不阻塞 */ }
    })();
  }, [id, content?.type]);

  // PR-P1: 视频内容 → 拉当前平台矩阵账号 + 已发记录 (刷新不丢)
  useEffect(() => {
    if (!id || content?.type !== "video") return;
    (async () => {
      try {
        const [accRes, logRes] = await Promise.all([
          api.get<Account[]>(`/accounts?platform=${captionPlatform}`),
          api.get<{ accountId: string; status: string }[]>(`/content/${id}/manual-publish-log`),
        ]);
        const accs = (Array.isArray(accRes.data) ? accRes.data : [])
          .filter((a) => a.status !== "disabled")
          .sort((a, b) =>
            (a.createdAt || "").localeCompare(b.createdAt || "") ||
            a.accountName.localeCompare(b.accountName)
          );
        setMatrixAccounts(accs);
        const map: Record<string, boolean> = {};
        const drafts: Record<string, boolean> = {};
        for (const row of logRes.data || []) {
          if (row.status === "success") map[row.accountId] = true;
          if (row.status === "draft") drafts[row.accountId] = true;
        }
        setMatrixPosted(map);
        setMatrixDrafted(drafts);
      } catch (err) {
        console.error("获取矩阵账号失败", err);
      }
    })();
  }, [id, content?.type, captionPlatform, matrixRefreshNonce]);

  // PR-S4: 一键推送草稿箱 (已登录账号)
  const handlePushDraft = async () => {
    const targets = matrixAccounts.filter((a) => a.loginStatus === "logged_in");
    if (!id || targets.length === 0) return;
    setPushing(true);
    try {
      const res = await api.post<{ jobId: string }>(`/content/${id}/push-draft`, {
        accountIds: targets.map((a) => a.id),
      });
      if (res.data?.jobId) {
        setPushJob({
          jobId: res.data.jobId,
          accounts: targets.map((a) => ({ accountId: a.id, accountName: a.accountName, status: "queued" })),
        });
      }
    } catch (err) {
      toast.error((err as any)?.response?.data?.message || "发起推送失败");
    } finally {
      setPushing(false);
    }
  };

  // PR-S4: 轮询推送任务进度
  useEffect(() => {
    if (!pushJob?.jobId) return;
    const terminal = new Set(["success", "failed", "login_expired"]);
    if (pushJob.accounts.every((a) => terminal.has(a.status))) return;
    const t = setInterval(async () => {
      try {
        const res = await api.get<{ accounts: Array<{ accountId: string; accountName: string; status: string; error?: string }> }>(
          `/content/push-draft/${pushJob.jobId}`
        );
        if (res.data?.accounts) {
          setPushJob((j) => j && { ...j, accounts: res.data!.accounts });
          if (res.data.accounts.every((a) => terminal.has(a.status))) {
            setMatrixRefreshNonce((n) => n + 1); // 刷已推草稿标记/登录态
          }
        }
      } catch { /* 任务过期等, 停轮询 */ }
    }, 3000);
    return () => clearInterval(t);
  }, [pushJob?.jobId, pushJob?.accounts]);

  // PR-P1: 勾/取消"已发" — 落库, 失败回滚
  const toggleMatrixPosted = async (accountId: string, posted: boolean) => {
    setMatrixPosted((prev) => ({ ...prev, [accountId]: posted }));
    try {
      await api.post(`/content/${id}/manual-publish-log`, { accountId, posted });
    } catch {
      setMatrixPosted((prev) => ({ ...prev, [accountId]: !posted }));
      toast.error("记录失败，请重试");
    }
  };

  // PR #266: 生成 N 套差异化抖音文案 (发 N 个矩阵号, 防同质化降权)
  const handleGenerateDouyinCaption = async (force = false) => {
    if (!content) return;
    setDouyinLoading(true);
    try {
      // PR-P1: 有矩阵账号 → 每个账号一套文案; 无账号回退手填数量
      const effectiveCount = matrixAccounts.length > 0 ? Math.min(matrixAccounts.length, 10) : variantCount;
      const res = await api.post<DyVariant[]>(
        `/content/${content.id}/douyin-caption-variants?count=${effectiveCount}&platform=${captionPlatform}${force ? "&force=true" : ""}`,
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
      // PR-S6: 统一入口 — 抖音/视频号走"推草稿箱"(浏览器登录态, 不要 API 凭证), 其余平台走 /publish
      const SEMI = ["douyin", "wechat_video"];
      // 6-11 合规: 取消「同步到抖音」勾选 → 本次发布剔除抖音账号
      const effectiveIds = syncToDouyin
        ? selectedAccountIds
        : selectedAccountIds.filter((aid) => accounts.find((a) => a.id === aid)?.platform !== "douyin");
      const selected = accounts.filter((a) => effectiveIds.includes(a.id));
      const draftAccts = selected.filter((a) => SEMI.includes(a.platform));
      const apiAccts = selected.filter((a) => !SEMI.includes(a.platform));
      const collected: PublishResult[] = [];

      // Agent-3: 「本地 Agent」通道 — SEMI 账号改派发给本地 Agent (POST /agent-admin/dispatch),
      // 其余平台(公众号等)不受影响照旧走 /publish; syncToDouyin 剔除在 effectiveIds 已生效。
      let agentPendingCount = 0;
      let agentTimedOut = false;
      if (publishChannel === "agent" && draftAccts.length > 0) {
        const toResult = (t: AgentTask): PublishResult => {
          const base = { accountId: t.accountId, accountName: t.accountName, platform: t.platform };
          if (t.status === "success")
            return { ...base, success: true, mode: "draft_only" as const, message: "已进草稿箱（经本地 Agent）— 到平台后台确认发布" };
          if (t.status === "failed") return { ...base, success: false, error: t.error || "Agent 发布失败" };
          if (t.status === "login_expired")
            return { ...base, success: false, error: "Agent 上该账号未登录 — 在 Agent 电脑运行 bossmate-agent login" };
          if (t.status === "canceled") return { ...base, success: false, error: "任务已取消" };
          if (t.status === "manual_pending")
            return { ...base, success: true, mode: "draft_only" as const, message: "已在 Agent 电脑填好并停在发布页 — 请到该浏览器点「发布」(抖音网页发布需人工过一次验证)" };
          return { ...base, success: false, pending: true, message: t.status === "claimed" ? "Agent 执行中…" : "等待 Agent 领取…" };
        };
        const dr = await api.post<{ tasks: AgentTask[] }>("/agent-admin/dispatch", {
          contentId: id,
          accountIds: draftAccts.map((a) => a.id),
        });
        const dispatched = dr.data?.tasks || [];
        const taskIds = new Set(dispatched.map((t) => t.id));
        const terminal = new Set(["success", "failed", "login_expired", "canceled", "manual_pending"]);
        let snapshot = dispatched;
        setPublishMsg(`已派发 ${dispatched.length} 个任务给本地 Agent, 等待领取…（Agent 需已配对并在线）`);
        setPublishResults([...collected, ...snapshot.map(toResult)]);
        // 轮询 GET /agent-admin/tasks?contentId= : 5s 间隔 × 36 次 = 最多 3 分钟, 全部终态即提前停
        let allDone = snapshot.length > 0 && snapshot.every((t) => terminal.has(t.status));
        for (let i = 0; i < 36 && !allDone; i++) {
          await new Promise((res) => setTimeout(res, 5000));
          const tr = await api.get<{ tasks: AgentTask[] }>(`/agent-admin/tasks?contentId=${id}`);
          const mine = (tr.data?.tasks || []).filter((t) => taskIds.has(t.id));
          if (mine.length > 0) snapshot = mine;
          const doneCount = snapshot.filter((t) => terminal.has(t.status)).length;
          setPublishMsg(`本地 Agent 发布中… ${doneCount}/${snapshot.length}（视频下载+上传需数分钟，请勿关闭）`);
          setPublishResults([...collected, ...snapshot.map(toResult)]);
          allDone = snapshot.length > 0 && snapshot.every((t) => terminal.has(t.status));
        }
        collected.push(...snapshot.map(toResult));
        agentPendingCount = snapshot.filter((t) => !terminal.has(t.status)).length;
        agentTimedOut = !allDone && agentPendingCount > 0;
        if (collected.some((r) => r.success)) setMatrixRefreshNonce((n) => n + 1);
      }
      // Agent 通道下 SEMI 账号已派发, 不再走服务器推草稿
      const serverDraftAccts = publishChannel === "agent" ? [] : draftAccts;

      // 1) 抖音/视频号 → 推草稿箱
      const loggedIn = serverDraftAccts.filter((a) => a.loginStatus === "logged_in");
      for (const a of serverDraftAccts.filter((a) => a.loginStatus !== "logged_in")) {
        collected.push({ accountId: a.id, accountName: a.accountName, platform: a.platform, success: false, error: "未扫码登录 — 请到账号管理扫码登录后再推送" });
      }
      if (loggedIn.length > 0) {
        const r = await api.post<{ jobId: string }>(`/content/${id}/push-draft`, { accountIds: loggedIn.map((a) => a.id) });
        const jobId = r.data?.jobId;
        if (jobId) {
          const terminal = new Set(["success", "failed", "login_expired"]);
          for (let i = 0; i < 160; i++) {
            await new Promise((res) => setTimeout(res, 3000));
            const jr = await api.get<{ accounts: Array<{ accountId: string; accountName: string; platform?: string; status: string; error?: string }> }>(`/content/push-draft/${jobId}`);
            const accs = jr.data?.accounts || [];
            const doneCount = accs.filter((a) => terminal.has(a.status)).length;
            setPublishMsg(`抖音/视频号 推送草稿箱中… ${doneCount}/${accs.length}（上传+转码需数分钟，请勿关闭）`);
            // 实时把已完成的并入结果展示
            const liveDone: PublishResult[] = accs.filter((a) => terminal.has(a.status)).map((x) => ({
              accountId: x.accountId, accountName: x.accountName,
              platform: loggedIn.find((l) => l.id === x.accountId)?.platform || "",
              success: x.status === "success", mode: "draft_only" as const,
              message: x.status === "success" ? "已进草稿箱 — 到平台后台审核后发布" : undefined,
              error: x.status === "login_expired" ? "登录态失效，请重新扫码登录" : x.status === "failed" ? (x.error || "推送失败") : undefined,
            }));
            setPublishResults([...collected, ...liveDone]);
            if (accs.length > 0 && accs.every((a) => terminal.has(a.status))) {
              collected.push(...liveDone);
              break;
            }
          }
          setMatrixRefreshNonce((n) => n + 1);
        }
      }

      // 2) 其余平台 → /publish (API 发布)
      if (apiAccts.length > 0) {
        const res = await api.post<{ results: PublishResult[]; summary: { total: number; success: number; failed: number } }>("/publish", {
          contentId: id,
          accountIds: apiAccts.map((a) => a.id),
        });
        if (res.data?.results) collected.push(...res.data.results);
      }

      setPublishResults(collected);
      const fullOk = collected.filter((r) => r.success && r.mode === "full").length;
      const draftOk = collected.filter((r) => r.success && r.mode === "draft_only").length;
      const failed = collected.filter((r) => !r.success && !r.pending).length;
      const parts: string[] = [];
      if (fullOk > 0) parts.push(`${fullOk} 个已群发`);
      if (draftOk > 0) parts.push(`${draftOk} 个进草稿箱待审核发布`);
      if (failed > 0) parts.push(`${failed} 个失败`);
      if (agentPendingCount > 0)
        parts.push(
          agentTimedOut
            ? `${agentPendingCount} 个仍在 Agent 处理中(已超 3 分钟停止刷新, 稍后重开本页查看)`
            : `${agentPendingCount} 个进行中`
        );
      setPublishMsg(parts.length > 0 ? parts.join("，") : "无发布结果");

      if (fullOk > 0) {
        await api.patch(`/content/${id}`, { status: "published" });
        fetchContent();
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
        <Link to="/workbench" className="text-blue-600 hover:text-blue-700 text-sm">
          返回内容工坊
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
  // PR-U2 质检前置: 只有 generated/approved 可发; draft 与 needs_review(质检未过)不可直接发
  const canPublish =
    !showVariantCompare &&
    !currentIsRejected &&
    (content.status === "generated" ||
      content.status === "approved");

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* 6-11 施工包C2-a (审计2.5): 双层导航删内层 — 原 <nav> 顶栏降级为内容区操作工具条 (返回链接+状态+操作按钮全保留), 全局导航走 MainLayout 侧边栏 */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
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
          <StatusBadge status={content.status} />
          {/* T4-3-5: 当前内容所用模板 badge（无 templateId 时优雅隐藏） */}
          <TemplateBadge
            templateId={content.metadata?.templateId as string | undefined}
            templates={templates}
          />
          {/* 7-05 ④: AI 审稿建议徽章 (metadata.aiReview — 影子模式记录, 人工终审时参考) */}
          {(content.metadata?.aiReview as any)?.verdict && (
            <span
              className={`px-2 py-1 rounded-md text-xs ${
                (content.metadata!.aiReview as any).verdict === "approve" ? "bg-emerald-50 text-emerald-700"
                : (content.metadata!.aiReview as any).verdict === "reject" ? "bg-rose-50 text-rose-600"
                : "bg-gray-100 text-gray-500"
              }`}
              title={`AI 建议(仅参考): ${(content.metadata!.aiReview as any).reason ?? ""} · confidence ${Math.round(((content.metadata!.aiReview as any).confidence ?? 0) * 100)}%`}
            >
              🤖 AI建议：{(content.metadata!.aiReview as any).verdict === "approve" ? "采用" : (content.metadata!.aiReview as any).verdict === "reject" ? "驳回" : "存疑"}
              {(content.metadata!.aiReview as any).reason ? ` · ${String((content.metadata!.aiReview as any).reason).slice(0, 20)}` : ""}
            </span>
          )}
          {/* 7-05 ⑤: 已推草稿箱标记 (draft-distributor 推的, 运营去公众号后台发) */}
          {draftPushedTo.length > 0 && (
            <span className="px-2 py-1 rounded-md text-xs bg-indigo-50 text-indigo-600" title="已推入公众号草稿箱, 到 mp.weixin.qq.com 草稿箱确认发布">
              📥 已推草稿箱 → {draftPushedTo.join("、")}
            </span>
          )}
          {/* 7-06 ②: 运营已选发 (回流数据确认草稿被运营群发 — 市场选择正信号) */}
          {operatorPublishedTo.length > 0 && (
            <span className="px-2 py-1 rounded-md text-xs bg-emerald-50 text-emerald-700" title="效果回流发现该文已被运营从公众号后台群发 — 运营的市场选择信号">
              ✅ 运营已选发 → {operatorPublishedTo.join("、")}
            </span>
          )}
          {/* 7-06 ①: 公众号阅读数据回流 (T+1; datacube 无"在看"字段, 用收藏) */}
          {reflowStats && (
            <span className="px-2 py-1 rounded-md text-xs bg-sky-50 text-sky-700" title={`公众号数据回流 (${reflowStats.source === "api" ? "微信数据接口 T+1 自动回流" : "运营手填"})`}>
              📊 阅读 {reflowStats.views.toLocaleString()} · 分享 {reflowStats.shares.toLocaleString()} · 收藏 {reflowStats.saves.toLocaleString()}（截至 {reflowStats.snapshotDate || "昨日"}）
            </span>
          )}
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
      </div>

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
            {/* 7-05 老韩: 详情页读全文后直接裁决(原来只有 Today 卡片有, 读文的地方反而没有)。复用 /today 校准端点, 裁决同时落校准样本 */}
            {content.status === "needs_review" && (
              <>
                <button
                  onClick={async () => {
                    try {
                      await api.post(`/today/approve/${content.id}`, {});
                      toast.success("已采用，转为可发（已记入校准样本）");
                      fetchContent();
                    } catch { toast.error("采用失败"); }
                  }}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                  title="质检未过但你读过没问题 → 放行并记为'评分器偏严'校准样本"
                >
                  ✅ 采用
                </button>
                <button
                  onClick={async () => {
                    const reason = window.prompt("驳回理由(可选, 会记入校准样本):") ?? undefined;
                    try {
                      await api.post(`/today/reject/${content.id}`, reason ? { reason } : {});
                      toast.success("已驳回（已记入校准样本）");
                      fetchContent();
                    } catch { toast.error("驳回失败"); }
                  }}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 text-white hover:bg-red-600"
                >
                  ❌ 驳回
                </button>
                <span className="w-px h-5 bg-gray-300" />
              </>
            )}
            <button
              onClick={() => setShowRewriteModal(true)}
              disabled={!canEdit || !/^##\s+/m.test(editBody)}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              ✏️ 编辑此文
            </button>
            {/* 6-11 施工包C1-b: 弹统一生成视频弹窗 (锁定本文, 主播模板在弹窗里选) */}
            <button
              onClick={() => setShowVideoModal(true)}
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
                {/* 6-11 施工包C1 (审计 2.1): 平台分组勾选收口统一 AccountSelector
                    — 默认勾选已验证账号(行为变化, 老韩已确认) + 平台全选 + 抖音/视频号登录态徽标 */}
                <div className="bg-white rounded-lg border border-green-200 p-3 mb-4">
                  <AccountSelector
                    accounts={accounts}
                    value={selectedAccountIds}
                    onChange={setSelectedAccountIds}
                    defaultVerifiedChecked
                    showGroupSelectAll
                  />
                </div>

                {/* Agent-3: 发布通道切换 — 仅选中抖音/视频号账号时显示 */}
                {(() => {
                  const SEMI = ["douyin", "wechat_video"];
                  const semiSelected = accounts.filter(
                    (a) => SEMI.includes(a.platform) && selectedAccountIds.includes(a.id)
                  );
                  if (semiSelected.length === 0) return null;
                  return (
                    <div className="mb-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                        <span className="font-medium text-slate-700">发布通道:</span>
                        {([["server", "服务器直发"], ["agent", "本地 Agent"]] as const).map(([v, lbl]) => (
                          <label key={v} className="flex items-center gap-1.5 cursor-pointer text-slate-600">
                            <input
                              type="radio"
                              name="publish-channel"
                              className="accent-indigo-600"
                              checked={publishChannel === v}
                              onChange={() => setPublishChannel(v)}
                            />
                            {lbl}
                          </label>
                        ))}
                        <span className="text-[11px] text-slate-400">
                          Agent = 在你电脑上用本机浏览器发布, 需先在
                          <Link to="/settings" className="text-indigo-600 hover:underline">设置页</Link>
                          配对并运行
                        </span>
                      </div>
                    </div>
                  );
                })()}

                {/* 6-11 抖音合规告知: 明确同步到哪个抖音号 + 可勾选「是否同步」(使用规范硬要求) */}
                {(() => {
                  const douyinSelected = accounts.filter(
                    (a) => a.platform === "douyin" && selectedAccountIds.includes(a.id)
                  );
                  if (douyinSelected.length === 0) return null;
                  return (
                    <label className="flex items-start gap-2 mb-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncToDouyin}
                        onChange={(e) => setSyncToDouyin(e.target.checked)}
                        className="accent-indigo-600 mt-0.5"
                      />
                      <span className="text-xs text-slate-600 leading-relaxed">
                        本内容(含视频、标题、话题)将同步发布到抖音账号:
                        <span className="font-medium text-slate-800"> {douyinSelected.map((a) => `@${a.accountName}`).join("、")}</span>
                        。取消勾选则本次不同步到抖音。在内容列表删除该内容时,可选择同步删除抖音侧视频。
                      </span>
                    </label>
                  );
                })()}

                {/* 发布按钮和结果 */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowPublishConfirm(true)}
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
                      const isPending = !result.success && !!result.pending; // Agent-3: 等待领取/执行中
                      const isFull = result.success && result.mode === "full";
                      const isDraftOnly = result.success && result.mode === "draft_only";
                      const isFailedWithDraft = !result.success && !isPending && !!result.mediaId;
                      const isFailedHard = !result.success && !isPending && !result.mediaId;

                      let toneClass: string;
                      let icon: string;
                      let fallbackText: string;
                      let btnClass: string;
                      let btnLabel: string;

                      if (isPending) {
                        toneClass = "bg-indigo-50 text-indigo-700 border border-indigo-200";
                        icon = "⏳";
                        fallbackText = "等待本地 Agent…";
                        btnClass = "";
                        btnLabel = "";
                      } else if (isFull) {
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
                    <StatusBadge status={v.status} className="text-xs px-2 py-0.5 rounded-full" />
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
                          {/* PR-S4: 一键推送草稿箱 (浏览器自动化, 需账号已扫码登录) */}
                          {matrixAccounts.length > 0 && (() => {
                            const loggedIn = matrixAccounts.filter((a) => a.loginStatus === "logged_in");
                            const PUSH_LABEL: Record<string, string> = {
                              queued: "⏳ 排队中", running: "🔄 推送中…", success: "✅ 已进草稿箱",
                              failed: "❌ 失败", login_expired: "🔑 登录失效",
                            };
                            return (
                              <div className="mb-3 p-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-gray-600">
                                    {loggedIn.length > 0
                                      ? `${loggedIn.length}/${matrixAccounts.length} 个账号已登录,可自动推送视频+文案到平台草稿箱`
                                      : <>账号未扫码登录 — 先到 <Link to="/accounts" className="text-blue-600 underline">账号管理</Link> 扫码,即可一键推草稿箱</>}
                                  </span>
                                  <button
                                    onClick={handlePushDraft}
                                    disabled={pushing || loggedIn.length === 0 || (pushJob?.accounts.some((a) => a.status === "queued" || a.status === "running") ?? false)}
                                    className="shrink-0 px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40"
                                  >🚀 推送草稿箱</button>
                                </div>
                                {pushJob && (
                                  <div className="mt-2 space-y-1">
                                    {pushJob.accounts.map((a) => (
                                      <div key={a.accountId} className="flex items-center justify-between text-xs">
                                        <span className="text-gray-700">{a.accountName}</span>
                                        <span className={a.status === "success" ? "text-green-600" : a.status === "failed" || a.status === "login_expired" ? "text-red-500" : "text-gray-500"}>
                                          {PUSH_LABEL[a.status] || a.status}{a.error ? ` · ${a.error}` : ""}
                                        </span>
                                      </div>
                                    ))}
                                    <p className="text-[11px] text-gray-400 mt-1">进草稿箱后,到对应平台 App/后台审核确认即可发布</p>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          {!douyinVariants ? (
                            matrixAccounts.length > 0 ? (
                              /* PR-P1: 已加账号 → 按账号数生成, 每号一套 */
                              <div>
                                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                                  <span className="text-sm text-gray-600">
                                    {matrixAccounts.length} 个{captionPlatform === "wechat_video" ? "视频号" : "抖音"}账号:
                                  </span>
                                  {matrixAccounts.map((a) => (
                                    <span key={a.id} className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full">
                                      {a.accountName}
                                    </span>
                                  ))}
                                  <Link to="/accounts" className="text-xs text-blue-600 hover:underline">管理</Link>
                                </div>
                                <button
                                  onClick={() => handleGenerateDouyinCaption(false)}
                                  disabled={douyinLoading}
                                  className="w-full px-4 py-2 text-sm bg-pink-600 text-white rounded-lg hover:bg-pink-700 disabled:opacity-50"
                                >{douyinLoading ? "生成中…" : `✨ 为 ${Math.min(matrixAccounts.length, 10)} 个账号生成差异化文案`}</button>
                              </div>
                            ) : (
                              <div>
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
                                <p className="mt-1.5 text-xs text-gray-400">
                                  提示: 到 <Link to="/accounts" className="text-blue-600 hover:underline">账号管理</Link> 添加{captionPlatform === "wechat_video" ? "视频号" : "抖音"}矩阵号后, 文案会自动绑定账号、"已发"状态永久保存
                                </p>
                              </div>
                            )
                          ) : (
                            <>
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-gray-500">{douyinVariants.length} 套互不雷同文案{matrixAccounts.length > 0 ? "，已按账号一一绑定" : "，每个号用一套"}（防同质化降权）</span>
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
                                {douyinVariants.map((v, i) => {
                                  // PR-P1: 第 i 套文案绑定第 i 个矩阵账号; 无账号回退"号 N"(本地勾选)
                                  const acct = matrixAccounts[i];
                                  const label = acct ? acct.accountName : `号 ${i + 1}`;
                                  const posted = acct ? !!matrixPosted[acct.id] : douyinPosted[i] || false;
                                  return (
                                  <div key={acct?.id ?? i} className={`border rounded-lg p-3 ${posted ? "border-green-300 bg-green-50" : "border-gray-200"}`}>
                                    <div className="flex items-center justify-between mb-1">
                                      <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
                                        <input
                                          type="checkbox"
                                          checked={posted}
                                          onChange={(e) =>
                                            acct
                                              ? toggleMatrixPosted(acct.id, e.target.checked)
                                              : setDouyinPosted((prev) => prev.map((f, k) => (k === i ? e.target.checked : f)))
                                          }
                                        />
                                        {label}{posted ? " · 已发" : matrixDrafted[acct?.id ?? ""] ? " · 📥 已推草稿" : ""}
                                      </label>
                                      <button
                                        onClick={() => copyToClipboard(v.fullText, `「${label}」文案`)}
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
                                  );
                                })}
                              </div>
                              <ol className="mt-3 text-xs text-gray-500 list-decimal list-inside space-y-0.5">
                                <li>下载视频到手机（上方「下载视频」或复制链接在手机打开）</li>
                                <li>每个号：打开{captionPlatform === "wechat_video" ? "视频号" : "抖音"} → ＋ → 选视频 → 复制对应账号的文案粘贴 → 发布</li>
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
                    {PLATFORM_META[p.platform]?.icon || "🌐"}
                  </span>
                  <span className="font-medium text-gray-700">
                    {platformLabel(p.platform)}
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

      {/* 发布二次确认(防误发) — 确认发布《标题》到 N 个账号, 不可逆提示 */}
      <ConfirmModal
        open={showPublishConfirm}
        title="确认发布"
        danger
        confirmText="确认发布"
        irreversibleNote="发布到真实平台后不可撤回，请确认账号与内容无误"
        loading={publishing}
        onCancel={() => setShowPublishConfirm(false)}
        onConfirm={() => {
          setShowPublishConfirm(false);
          handlePublish();
        }}
        message={
          <div className="space-y-2">
            <p>
              确认发布《<span className="font-semibold text-gray-900">{content.title || "无标题"}</span>》到{" "}
              <span className="font-semibold text-gray-900">{selectedAccountIds.length}</span> 个账号：
            </p>
            <ul className="list-disc pl-5 space-y-0.5">
              {accounts
                .filter((a) => selectedAccountIds.includes(a.id))
                .map((a) => (
                  <li key={a.id}>
                    {a.accountName}
                    <span className="text-gray-400"> · {platformLabel(a.platform)}</span>
                  </li>
                ))}
            </ul>
          </div>
        }
      />

      {/* 6-11 施工包C1-b: 统一生成视频弹窗 (文章锁定为当前内容) */}
      <UnifiedVideoModal
        open={showVideoModal}
        onClose={() => setShowVideoModal(false)}
        articleId={content.id}
        defaultTab="article"
      />

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
