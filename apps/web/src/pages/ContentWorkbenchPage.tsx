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
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";
import { toast } from "../components/Toast";
import ContentTabBar, { type WorkbenchTab } from "../components/workbench/ContentTabBar";
import ContentListItem, { type WorkbenchListItem } from "../components/workbench/ContentListItem";
import ContentPreviewPane, { type PreviewContent } from "../components/workbench/ContentPreviewPane";
import DistributionCard, { type WorkbenchAccount } from "../components/workbench/DistributionCard";

export default function ContentWorkbenchPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [tab, setTab] = useState<WorkbenchTab>("recommend");
  const [items, setItems] = useState<WorkbenchListItem[]>([]);
  const [counts, setCounts] = useState({ recommend: 0, draft: 0, published: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [accounts, setAccounts] = useState<WorkbenchAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [dvhTemplate, setDvhTemplate] = useState("A_academic");
  const [generatingDvh, setGeneratingDvh] = useState(false);

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

  const toggleAccount = useCallback((id: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const accountIdsArr = useMemo(() => [...selectedAccountIds], [selectedAccountIds]);

  const handlePublish = useCallback(async () => {
    if (!selectedId || accountIdsArr.length === 0) return;
    setPublishing(true);
    try {
      const res = await api.post<{ summary?: { success: number; failed: number } }>("/publish", { contentId: selectedId, accountIds: accountIdsArr });
      const s = (res as any).data?.summary;
      if (s) {
        const ok = s.success ?? 0; const fail = s.failed ?? 0;
        if (ok > 0 && fail === 0) toast.success(`已提交发布到 ${ok} 个账号`);
        else if (ok > 0) toast.success(`${ok} 个成功 / ${fail} 个失败`);
        else toast.error(`${fail} 个发布失败 (mock 账号 credentials 空属于预期)`);
        if (ok > 0) setTab("published"); // 自动跳已发布 tab
      } else {
        toast.success("发布请求已提交");
      }
    } catch (err) {
      toast.error("发布失败: " + (err instanceof Error ? err.message : "未知"));
    } finally {
      setPublishing(false);
    }
  }, [selectedId, accountIdsArr]);

  const handleGenerateDvh = useCallback(async () => {
    if (!selectedId) return;
    setGeneratingDvh(true);
    try {
      await api.post(`/articles/${selectedId}/generate-dvh-video`, { templateId: dvhTemplate });
      toast.success("数字人视频生成中, 稍后在内容管理→视频类型查看");
    } catch (err) {
      toast.error("生成失败: " + (err instanceof Error ? err.message : "未知"));
    } finally {
      setGeneratingDvh(false);
    }
  }, [selectedId, dvhTemplate]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      {/* 顶部 nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-5">
          <span className="text-lg font-bold text-blue-600">BossMate</span>
          <Link to="/" className="text-sm text-gray-600 hover:text-gray-900">首页</Link>
          <Link to="/workbench" className="text-sm font-medium text-blue-600">📝 内容工坊</Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">退出</button>
        </div>
      </nav>

      <ContentTabBar active={tab} counts={counts} onChange={setTab} />

      {/* 3 列布局 */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT 列表 */}
        <aside className="w-1/4 min-w-[240px] border-r border-gray-200 overflow-y-auto px-3 py-3 space-y-2 bg-white">
          {items.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">暂无内容</p>
          ) : (
            items.map((it) => (
              <ContentListItem key={it.id} item={it} selected={selectedId === it.id} onClick={() => setSelectedId(it.id)} />
            ))
          )}
        </aside>

        {/* MIDDLE preview */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <ContentPreviewPane content={preview} loading={previewLoading} />
        </main>

        {/* RIGHT 分发卡 sticky */}
        <aside className="w-1/4 min-w-[280px] border-l border-gray-200 overflow-y-auto px-4 py-4 bg-white">
          <DistributionCard
            accounts={accounts}
            selectedAccountIds={selectedAccountIds}
            onToggleAccount={toggleAccount}
            onPublish={handlePublish}
            publishing={publishing}
            dvhTemplate={dvhTemplate}
            onTemplateChange={setDvhTemplate}
            onGenerateDvh={handleGenerateDvh}
            generatingDvh={generatingDvh}
            disabled={!selectedId}
          />
        </aside>
      </div>
    </div>
  );
}
