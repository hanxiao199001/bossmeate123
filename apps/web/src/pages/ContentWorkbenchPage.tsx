/**
 * 5-18 P1 — 内容工坊: 左 list + 中 preview + 右分发卡。
 * 替代 /recommendations 主战场, 一站式 "看 → 挑 → 发"。/recommendations 保留 redirect。
 *
 * 数据复用 (无新 API):
 *  - GET /content/recommendations (PR #133)  [今日推荐]
 *  - GET /content?status=draft|published     [草稿] [已发布]
 *  - GET /content/:id                         preview body
 *  - GET /accounts?status=active              account checkboxes
 *  - POST /publish (PR #143)                  发布到选中账号
 *  - POST /articles/:id/generate-dvh-video (PR #144/#145)  数字人
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../utils/api";
import { toast } from "../components/Toast";
import ContentTabBar, { type WorkbenchTab } from "../components/workbench/ContentTabBar";
import ContentListItem, { type WorkbenchListItem } from "../components/workbench/ContentListItem";
import ContentPreviewPane, { type PreviewContent } from "../components/workbench/ContentPreviewPane";
import DistributionCard, { type WorkbenchAccount } from "../components/workbench/DistributionCard";
import RiskAuditModal, { type AuditResult } from "../components/workbench/RiskAuditModal";
// 5-23 PR #161 — Workbench v2: 多选 + 手动生成 + 批量发布
import WorkbenchTopBar from "../components/workbench/WorkbenchTopBar";
import ManualGenerateModal from "../components/workbench/ManualGenerateModal";
import UnifiedVideoModal from "../components/video/UnifiedVideoModal";
import RoundupGenerateModal from "../components/workbench/RoundupGenerateModal";
import BatchPreviewSummary from "../components/workbench/BatchPreviewSummary";
// 6-11 施工包C2-b (审计1.1): AI推荐/批量CSV 从 ContentPage"高级模式"迁来 (modal 与提交链路原样复用)
import RecommendationModal from "../components/RecommendationModal";
import BatchUploadModal from "../components/BatchUploadModal";
import BulkDistributeCard from "../components/workbench/BulkDistributeCard";
import BulkDistributeProgressPanel from "../components/workbench/BulkDistributeProgressPanel";
import { useAuthStore } from "../hooks/useAuthStore";

export default function ContentWorkbenchPage() {
  // 5-21 P0: user/logout 已搬 sidebar (MainLayout), 本页不再用
  const navigate = useNavigate();

  const [tab, setTab] = useState<WorkbenchTab>("all");
  const [items, setItems] = useState<WorkbenchListItem[]>([]);
  const [counts, setCounts] = useState({ all: 0, recommend: 0, draft: 0, published: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [accounts, setAccounts] = useState<WorkbenchAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  // 6-11 施工包C1-b: 生成视频统一弹 UnifiedVideoModal; 分发卡入口锁定当前文章, 顶栏入口不锁
  const [videoArticleId, setVideoArticleId] = useState<string | undefined>(undefined);

  // 5-20 P2 风控: audit modal state
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  // 5-19 PR #171: 砍 admin role 限制 — 生成按钮 + checkbox 对所有 authenticated user 开放
  // 老 isAdmin 仍保留 (未来 admin-only UI 元素可复用 — 如 bulk-distribute 按钮 admin only)
  const userRole = useAuthStore((s) => s.user?.role);
  const isAdmin = userRole === "owner" || userRole === "admin";
  void isAdmin; // 留 dormant 防 lint 警告 (未来 bulk UI 可启用)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [generateModal, setGenerateModal] = useState<"article" | "video" | "roundup" | null>(null);
  // 6-11 施工包C2-b: AI推荐 / 批量CSV modal 状态 (原 ContentPage 高级模式)
  const [recommendOpen, setRecommendOpen] = useState(false);
  const [batchUploadOpen, setBatchUploadOpen] = useState(false);
  const toggleMultiSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handleGenerateComplete = useCallback((newContentId: string) => {
    // 跳 draft tab + 自动 select 新文章
    setTab("draft");
    setSelectedId(newContentId);
    setGenerateModal(null);
    toast.success(`生成完成: ${newContentId.slice(0, 8)}...`);
  }, []);

  // 5-23 PR #161 — bulk distribute state
  const [bulkBatchId, setBulkBatchId] = useState<string | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const handleBulkSubmit = useCallback(async () => {
    if (selectedIds.size === 0 || selectedAccountIds.size === 0) return;
    setBulkSubmitting(true);
    try {
      // 手动选号 = 尊重用户明确选择, 直接发到所选账号(不走智能配对/每日上限, 那些只管自动分发)
      const res = await api.post<{ batchId: string; total: number; skipped: number; queued: number }>(
        "/admin/bulk-distribute",
        { articleIds: [...selectedIds], accountIds: [...selectedAccountIds] }
      );
      const data = (res.data as any);
      if (!data?.batchId) throw new Error("无 batchId 返回");
      setBulkBatchId(data.batchId);
      toast.success(`已入队 ${data.queued} 个发布任务 (${data.skipped} 重复跳过)`);
    } catch (err: any) {
      toast.error(err?.message || "批量发布请求失败");
    } finally {
      setBulkSubmitting(false);
    }
  }, [selectedIds, selectedAccountIds]);
  const isMultiSelectMode = selectedIds.size > 0;

  // 拉账号 (一次) + 默认勾 isVerified
  useEffect(() => {
    api.get<WorkbenchAccount[]>("/accounts?status=active")
      .then((r) => {
        const arr = (Array.isArray(r.data) ? r.data : []).filter((a) => a.platform);
        setAccounts(arr);
        setSelectedAccountIds(new Set(arr.filter((a) => a.isVerified).map((a) => a.id)));
      })
      .catch(() => setAccounts([]));
  }, []);

  // 拉 tab 数据 + 实时 count (count 来源: 该 tab 的 items 长度，未严格全表 count 节省 query)
  const loadTab = useCallback((t: WorkbenchTab) => {
    const url = t === "recommend"
      ? "/content/recommendations?limit=20"
      : t === "all"
        ? "/content?pageSize=100"
        : `/content?status=${t === "draft" ? "draft" : "published"}&pageSize=50`;
    api.get<{ data?: { items?: WorkbenchListItem[] } } | { items?: WorkbenchListItem[] }>(url)
      .then((r) => {
        // /content/recommendations 返回 { data: { items } }，/content 返回 { data: { items } } 也是
        const items = ((r as any).data?.items ?? (r as any).data ?? []) as WorkbenchListItem[];
        const arr = Array.isArray(items) ? items : [];
        setItems(arr);
        setCounts((prev) => ({ ...prev, [t]: arr.length }));
        // 自动选第一篇
        if (arr.length > 0 && !arr.find((i) => i.id === selectedId)) setSelectedId(arr[0].id);
        if (arr.length === 0) { setSelectedId(null); setPreview(null); }
      })
      .catch(() => { setItems([]); setSelectedId(null); setPreview(null); });
  }, [selectedId]);

  useEffect(() => { loadTab(tab); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [tab]);

  // selectedId 变 → 拉 preview body
  useEffect(() => {
    if (!selectedId) { setPreview(null); return; }
    setPreviewLoading(true);
    api.get<PreviewContent>(`/content/${selectedId}`)
      .then((r) => setPreview((r.data ?? null) as PreviewContent | null))
      .catch(() => setPreview(null))
      .finally(() => setPreviewLoading(false));
  }, [selectedId]);

  // 6-11 施工包C1: AccountSelector 受控 onChange (整组 id 数组) 替代逐个 toggle
  const handleAccountIdsChange = useCallback((ids: string[]) => {
    setSelectedAccountIds(new Set(ids));
  }, []);

  const accountIdsArr = useMemo(() => [...selectedAccountIds], [selectedAccountIds]);

  // 真发请求 (audit 通过 or forceOverride or 跳过风险后调) — 独立 helper 给 modal 回调用
  const submitPublish = useCallback(async (accountIds: string[], opts?: { forceOverride?: boolean; overrideReason?: string }) => {
    if (!selectedId || accountIds.length === 0) return;
    setPublishing(true);
    try {
      const res = await api.post<{ summary?: { success: number; failed: number } }>("/publish", {
        contentId: selectedId, accountIds,
        ...(opts?.forceOverride ? { forceOverride: true, overrideReason: opts.overrideReason } : {}),
      });
      const s = (res as any).data?.summary;
      const ok = s?.success ?? 0; const fail = s?.failed ?? 0;
      if (opts?.forceOverride) {
        toast.success(`⚠️ 强制放行: ${ok} 成功 / ${fail} 失败`);
      } else if (ok > 0 && fail === 0) {
        toast.success(`已提交发布到 ${ok} 个账号`);
      } else if (ok > 0) {
        toast.success(`${ok} 个成功 / ${fail} 个失败`);
      } else {
        toast.error(`${fail} 个发布失败 (mock 账号 credentials 空属于预期)`);
      }
      if (ok > 0) setTab("published");
    } catch (err) {
      toast.error("发布失败: " + (err instanceof Error ? err.message : "未知"));
    } finally {
      setPublishing(false);
    }
  }, [selectedId]);

  // 5-20 P2: 发布按钮 onClick → 先 audit → 命中弹 modal / 否则直发
  const handlePublish = useCallback(async () => {
    if (!selectedId || accountIdsArr.length === 0) return;
    const platforms = [...new Set(accounts.filter((a) => selectedAccountIds.has(a.id)).map((a) => a.platform))];
    try {
      const auditRes = await api.post<AuditResult>(`/content/${selectedId}/audit`, { platforms });
      const audit = (auditRes as any).data as AuditResult;
      if (audit && audit.summary && audit.summary.totalHits > 0) {
        setAuditResult(audit);
        setShowAudit(true);
        return; // 弹 modal, 等用户 3 选 1
      }
      // audit 干净 → 直接发
      await submitPublish(accountIdsArr);
    } catch {
      // audit 接口失败不阻塞 demo (老链路保留): 退化为直发, 由 backend gate 兜底
      toast.error("风控审核接口异常, 走 backend gate 兜底");
      await submitPublish(accountIdsArr);
    }
  }, [selectedId, accountIdsArr, accounts, selectedAccountIds, submitPublish]);

  // [改文案] → 跳详情页
  const handleAuditEdit = useCallback(() => {
    if (!selectedId) return;
    setShowAudit(false);
    navigate(`/content/${selectedId}`);
  }, [selectedId, navigate]);

  // [跳过有风险的账号] → deselect 命中 platform 的账号, 用剩余账号 publish
  const handleAuditSkipRisky = useCallback(async () => {
    if (!auditResult) return;
    const riskyPlatforms = new Set(Object.keys(auditResult.summary.byPlatform));
    const cleanAccountIds = accounts
      .filter((a) => selectedAccountIds.has(a.id) && !riskyPlatforms.has(a.platform))
      .map((a) => a.id);
    setShowAudit(false);
    if (cleanAccountIds.length === 0) {
      toast.error("所有选中账号均有风险, 无干净账号可发");
      return;
    }
    // 同步 UI: deselect risky
    setSelectedAccountIds(new Set(cleanAccountIds));
    await submitPublish(cleanAccountIds);
  }, [auditResult, accounts, selectedAccountIds, submitPublish]);

  // [强制放行] → backend 跳 audit gate, 真发
  const handleAuditForceOverride = useCallback(async (reason: string) => {
    setShowAudit(false);
    await submitPublish(accountIdsArr, { forceOverride: true, overrideReason: reason });
  }, [accountIdsArr, submitPublish]);

  return (
    <div className="min-h-screen flex flex-col bg-[#F6F7F9]">
      {/* PR-U1 操作收口: 一句话定位 */}
      <div className="bg-white px-4 pt-2.5 text-xs text-gray-400 border-b border-slate-100">
        运营生产线 — 在这里挑选题、生成、预览、配账号发布。看效果去「今日」，查旧内容去「内容管理」。
      </div>
      {/* 5-21 P0: 顶部 nav 已搬 sidebar (MainLayout), 此处只剩业务 tab */}
      {/* 5-19 PR #171: 砍 isAdmin gate — 生成按钮全 user 开放 (PR #161 admin only 过严, 韩宵也看不到) */}
      <WorkbenchTopBar
        selectedCount={selectedIds.size}
        onClickGenerateArticle={() => setGenerateModal("article")}
        onClickGenerateVideo={() => { setVideoArticleId(undefined); setGenerateModal("video"); }}
        onClickGenerateRoundup={() => setGenerateModal("roundup")}
        onClickRecommend={() => setRecommendOpen(true)}
        onClickBatchCsv={() => setBatchUploadOpen(true)}
        onClickClearSelection={() => setSelectedIds(new Set())}
      />
      <ContentTabBar active={tab} counts={counts} onChange={setTab} />

      {/* 3 列布局 */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT 列表 */}
        <aside className="w-1/4 min-w-[240px] border-r border-gray-200 overflow-y-auto px-3 py-3 space-y-2 bg-white">
          {items.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">暂无内容</p>
          ) : (
            items.map((it) => (
              <ContentListItem
                key={it.id}
                item={it}
                selected={selectedId === it.id}
                multiSelected={selectedIds.has(it.id)}
                onClick={() => setSelectedId(it.id)}
                onToggleSelect={() => toggleMultiSelect(it.id)} // PR #171: checkbox 全 user 开放
              />
            ))
          )}
        </aside>

        {/* MIDDLE — 5-23 PR #161 dual mode: 多选 → 批量预览 / 单选 → 文章预览 */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {isMultiSelectMode ? (
            <BatchPreviewSummary selectedIds={selectedIds} items={items} onItemClick={(id) => navigate(`/content/${id}`)} />
          ) : (
            <ContentPreviewPane content={preview} loading={previewLoading} />
          )}
        </main>

        {/* RIGHT — 5-23 PR #161 dual mode: 多选 → 批量发布卡 / 单选 → 单文章 DistributionCard */}
        <aside className="w-1/4 min-w-[280px] border-l border-gray-200 overflow-y-auto px-4 py-4 bg-white">
          {isMultiSelectMode ? (
            <BulkDistributeCard
              selectedArticleIds={selectedIds}
              accounts={accounts}
              selectedAccountIds={selectedAccountIds}
              onChangeAccountIds={handleAccountIdsChange}
              onSubmit={handleBulkSubmit}
              submitting={bulkSubmitting}
            />
          ) : (
            <DistributionCard
              accounts={accounts}
              selectedAccountIds={selectedAccountIds}
              onChangeAccountIds={handleAccountIdsChange}
              onPublish={handlePublish}
              publishing={publishing}
              onOpenVideoModal={() => {
                if (!selectedId) return;
                setVideoArticleId(selectedId);
                setGenerateModal("video");
              }}
              disabled={!selectedId}
            />
          )}
        </aside>
      </div>

      {/* 5-20 P2 风控 modal */}
      <RiskAuditModal
        open={showAudit}
        audit={auditResult}
        contentId={selectedId}
        onClose={() => setShowAudit(false)}
        onEdit={handleAuditEdit}
        onSkipRiskyPlatforms={handleAuditSkipRisky}
        onForceOverride={handleAuditForceOverride}
      />

      {/* 5-23 PR #161 — 手动生成 modal (admin only) */}
      <ManualGenerateModal
        open={generateModal === "article"}
        onClose={() => setGenerateModal(null)}
        onComplete={handleGenerateComplete}
      />
      <RoundupGenerateModal
        open={generateModal === "roundup"}
        onClose={() => setGenerateModal(null)}
        onComplete={handleGenerateComplete}
      />
      {/* 6-11 施工包C2-b: AI推荐 / 批量CSV modal (原 ContentPage 高级模式, 提交链路不变) */}
      <RecommendationModal open={recommendOpen} onClose={() => setRecommendOpen(false)} />
      <BatchUploadModal open={batchUploadOpen} onClose={() => setBatchUploadOpen(false)} />
      <UnifiedVideoModal
        open={generateModal === "video"}
        onClose={() => setGenerateModal(null)}
        articleId={videoArticleId}
        defaultTab="article"
        onTriggered={(info) => {
          setGenerateModal(null);
          if (info.mode === "direct" && info.articleId) {
            toast.success(`视频任务已触发 (article ${info.articleId.slice(0, 8)}...)`);
          } else if (info.mode === "pending_article" && info.articleId) {
            toast.success(`视频任务已触发 (新生成 article ${info.articleId.slice(0, 8)}...)`);
            setTab("draft");
            setSelectedId(info.articleId);
          }
        }}
      />

      {/* 5-23 PR #161 — bulk distribute SSE progress panel (浮右下) */}
      <BulkDistributeProgressPanel
        batchId={bulkBatchId}
        onClose={() => {
          setBulkBatchId(null);
          setSelectedIds(new Set()); // 关 panel 时清多选 (typical flow: 发完 → 清)
        }}
      />
    </div>
  );
}
