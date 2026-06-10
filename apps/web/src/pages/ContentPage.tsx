import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "../components/Toast";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../utils/api";
import { STATUS_LABELS, STATUS_COLORS } from "../components/StatusBadge";

// ===== 类型定义 =====
interface ContentItem {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  status: string;
  // P0-B：失败原因（截断 500 字）
  errorMessage?: string | null;
  // P0-B：状态机变更时间（spinner / 卡死提示用）
  statusUpdatedAt?: string | null;
  platforms: Array<{ platform: string; status?: string; publishedAt?: string; mediaId?: string }>;
  tokensTotal: number;
  metadata?: Record<string, any>;
  pinned?: boolean; // PR #178
  createdAt: string;
  updatedAt: string;
}

interface ContentStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

// ===== P0-B 6 状态全集（spec 删 reviewing/approved 中间态）=====
const STATUS_TABS = ["draft", "generating", "failed", "generated", "published"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const TYPE_LABELS: Record<string, string> = {
  article: "图文",
  video_script: "视频脚本",
  video: "视频",
  reply: "客服回复",
};

const TYPE_ICONS: Record<string, string> = {
  article: "📝",
  video_script: "🎬",
  video: "🎥",
  reply: "💬",
};

export default function ContentPage() {
  const navigate = useNavigate();

  // 列表状态
  const [items, setItems] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // 统计
  const [stats, setStats] = useState<ContentStats | null>(null);

  // 筛选 — P0-B：filterStatus 用 URL ?status= 持久化（刷新保留）
  const [searchParams, setSearchParams] = useSearchParams();
  const [filterType, setFilterType] = useState("");
  const filterStatus = searchParams.get("status") || "";
  // PR #130 V2.5 (5-13): "📅 今日推荐" view mode — URL ?view=recommendation
  const viewMode = searchParams.get("view") === "recommendation" ? "recommendation" : "all";
  const setViewMode = useCallback((v: "all" | "recommendation") => {
    const next = new URLSearchParams(searchParams);
    if (v === "recommendation") next.set("view", "recommendation");
    else next.delete("view");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const setFilterStatus = useCallback(
    (s: string) => {
      const next = new URLSearchParams(searchParams);
      if (s) next.set("status", s);
      else next.delete("status");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  // 多版本：默认隐藏被弃用版本
  const [showRejected, setShowRejected] = useState(false);

  // 删除确认
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const pageSize = 20;
  const totalPages = Math.ceil(total / pageSize);

  // 多版本：默认过滤被弃用版本（仍想看可手动开 toggle）
  const filteredItems = useMemo(
    () =>
      showRejected
        ? items
        : items.filter((c) => !((c.metadata as any)?.userRejected === true)),
    [items, showRejected]
  );
  const hiddenRejected = useMemo(
    () => items.filter((c) => (c.metadata as any)?.userRejected === true).length,
    [items]
  );

  // 获取内容列表
  const fetchContents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (filterType) params.set("type", filterType);
      if (filterStatus) params.set("status", filterStatus);
      // PR #130 V2.5: "📅 今日推荐" → backend 切 system tenant
      if (viewMode === "recommendation") params.set("recommendation", "true");

      const res = await api.get<{
        items: ContentItem[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/content?${params.toString()}`);

      if (res.data) {
        setItems(res.data.items);
        setTotal(res.data.total);
      }
    } catch (err) {
      console.error("获取内容列表失败", err);
    } finally {
      setLoading(false);
    }
  }, [page, filterType, filterStatus, viewMode]);

  // 获取统计
  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get<ContentStats>("/content/stats");
      if (res.data) setStats(res.data);
    } catch (err) {
      console.error("获取统计失败", err);
    }
  }, []);

  useEffect(() => {
    fetchContents();
  }, [fetchContents]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // P0-B：当前在"生成中"tab 或列表含 generating 行时，每 5s polling 一次
  // 用户离开页面（visibilitychange hidden）停止 polling，避免后台滥发
  useEffect(() => {
    const hasGenerating = filterStatus === "generating" || items.some((it) => it.status === "generating");
    if (!hasGenerating) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (timer || document.hidden) return;
      timer = setInterval(() => {
        fetchContents();
        fetchStats();
      }, 5000);
    };
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) stopPolling();
      else startPolling();
    };
    startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [filterStatus, items, fetchContents, fetchStats]);

  // 删除内容
  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/content/${id}`);
      setDeletingId(null);
      fetchContents();
      fetchStats();
    } catch (err) {
      console.error("删除失败", err);
      toast.error((err as any)?.response?.data?.message || "删除失败，请稍后重试");
    }
  };

  // 更新状态
  const handleStatusChange = async (id: string, newStatus: string) => {
    try {
      await api.patch(`/content/${id}`, { status: newStatus });
      fetchContents();
      fetchStats();
    } catch (err) {
      console.error("状态更新失败", err);
      toast.error((err as any)?.response?.data?.message || "状态更新失败");
    }
  };

  // 截取正文摘要
  const getExcerpt = (body: string | null, maxLen = 80) => {
    if (!body) return "暂无内容";
    const plain = body.replace(/[#*`>\-\[\]()!]/g, "").replace(/\n+/g, " ").trim();
    return plain.length > maxLen ? plain.slice(0, maxLen) + "..." : plain;
  };

  // 格式化时间
  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin}分钟前`;
    if (diffHour < 24) return `${diffHour}小时前`;
    if (diffDay < 7) return `${diffDay}天前`;
    return d.toLocaleDateString("zh-CN");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 6-11 施工包C2-a (审计2.5): 手写顶栏已删, 导航统一走 MainLayout 侧边栏 (退出在 Sidebar 底部) */}
      <div className="max-w-7xl mx-auto py-6 px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">内容管理</h1>
        {/* P0-B：6 tabs（全部 + 5 状态，archived 默认不显示）*/}
        {stats && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-4 mb-6">
            <div
              className={`bg-white rounded-xl border border-gray-200 p-4 text-center cursor-pointer transition-all ${
                !filterStatus ? "ring-2 ring-blue-400" : "hover:shadow-md"
              }`}
              onClick={() => { setFilterStatus(""); setPage(1); }}
            >
              <div className="text-2xl font-bold text-gray-900">
                {stats.total - (stats.byStatus["archived"] || 0)}
              </div>
              <div className="text-xs text-gray-500">全部内容</div>
            </div>
            {STATUS_TABS.map((s: StatusTab) => (
              <div
                key={s}
                className={`bg-white rounded-xl border border-gray-200 p-4 text-center cursor-pointer transition-all ${
                  filterStatus === s ? "ring-2 ring-blue-400" : "hover:shadow-md"
                }`}
                onClick={() => { setFilterStatus(filterStatus === s ? "" : s); setPage(1); }}
              >
                <div className="text-2xl font-bold text-gray-900">
                  {stats.byStatus[s] || 0}
                </div>
                <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                  {s === "generating" && (
                    <span className="inline-block w-2 h-2 border border-blue-500 border-t-transparent rounded-full animate-spin" />
                  )}
                  {STATUS_LABELS[s]}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 操作栏 */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <select
              value={filterType}
              onChange={(e) => { setFilterType(e.target.value); setPage(1); }}
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
            >
              <option value="">全部类型</option>
              <option value="article">图文</option>
              <option value="video">视频</option>
              <option value="video_script">视频脚本</option>
              <option value="reply">客服回复</option>
            </select>
            <span className="text-sm text-gray-500">
              共 {total} 条内容
            </span>
            <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showRejected}
                onChange={(e) => setShowRejected(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
              />
              显示已弃用版本{hiddenRejected > 0 ? `（${hiddenRejected} 条已隐藏）` : ""}
            </label>
          </div>

          {/* 6-11 施工包C2-b (审计1.1): "⚙️高级模式"折叠区已收敛 — AI推荐/批量CSV/专家模式入口迁到内容工坊顶栏, AI对话走右下角悬浮球 */}
          <span className="text-xs text-gray-400">批量生成与高级创作已合并到「内容工坊」</span>
        </div>

        {/* PR #130 V2.5 (5-13): View mode tab — "📅 今日推荐" 默认显前一天 cron 10 篇 vs "全部" 我的全部 */}
        <div className="flex gap-2 border-b border-gray-200">
          <button
            onClick={() => setViewMode("recommendation")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${viewMode === "recommendation" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"}`}
          >📅 今日推荐</button>
          <button
            onClick={() => setViewMode("all")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${viewMode === "all" ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-700"}`}
          >📝 我的全部</button>
        </div>

        {/* PR #129 V2.5 提前: 友好 banner — 主流程"挑发布"叙事
            6-10 审计3.4: recommendation 视图已收敛到工坊(下方引导块), banner 只在 all 视图显示 */}
        {viewMode === "all" && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-900 flex items-center gap-2">
          <span className="text-lg">📅</span>
          <span><strong>BossMate 每天自动生成内容</strong>。您只需进来挑喜欢的，一键发布到公众号。批量生成与手动创作请去「内容工坊」。</span>
        </div>
        )}

        {/* 6-10 审计3.4 老韩同意: "今日推荐"收敛到内容工坊 — recommendation 视图不再渲染本页列表, 改为引导块跳 /workbench;
            原推荐列表渲染代码未删, 仍走下方 all 分支(数据请求逻辑也保留), 可随时恢复 */}
        {viewMode === "recommendation" ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <p className="text-4xl mb-3">📅</p>
            <p className="text-gray-800 font-medium mb-1">今日推荐已合并到「内容工坊」</p>
            <p className="text-sm text-gray-400 mb-5">挑选、预览、一键分发，都在工坊一站完成</p>
            <button
              onClick={() => navigate("/workbench")}
              className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              去工坊查看推荐 →
            </button>
          </div>
        ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="text-center py-16 text-gray-400">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              加载中...
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-4xl mb-4">📄</p>
              <p className="text-gray-500 mb-1">
                {items.length > 0 ? "本页内容均为已弃用版本（默认隐藏）" : "还没有内容"}
              </p>
              <p className="text-sm text-gray-400">
                {items.length > 0
                  ? "勾选上方「显示已弃用版本」可查看"
                  : "通过选题工坊或 AI 对话创作你的第一篇内容"}
              </p>
            </div>
          ) : (
            <>
              {/* 列表头 */}
              <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">
                <div className="col-span-5">标题</div>
                <div className="col-span-1 text-center">类型</div>
                <div className="col-span-2 text-center">状态</div>
                <div className="col-span-2 text-center">更新时间</div>
                <div className="col-span-2 text-center">操作</div>
              </div>

              {/* 列表项 */}
              {filteredItems.map((item) => {
                const isRejected = (item.metadata as any)?.userRejected === true;
                const isSelected = (item.metadata as any)?.userSelected === true;
                return (
                <div
                  key={item.id}
                  className={`grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 px-5 py-4 border-b border-gray-100 transition-colors items-center ${
                    isRejected ? "bg-gray-50/50 opacity-60" : "hover:bg-blue-50/50"
                  }`}
                >
                  {/* 标题和摘要 */}
                  <div className="col-span-5">
                    <div
                      className="font-medium text-gray-900 text-sm cursor-pointer hover:text-blue-600 transition-colors flex items-center gap-2"
                      onClick={() => navigate(`/content/${item.id}`)}
                    >
                      <span className="truncate">{item.title || "无标题"}</span>
                      {isSelected && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">
                          ✓ 已选定
                        </span>
                      )}
                      {isRejected && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 font-medium">
                          已弃用
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 mt-1 line-clamp-1">
                      {getExcerpt(item.body)}
                    </div>
                  </div>

                  {/* 类型 */}
                  <div className="col-span-1 text-center">
                    <span className="text-sm" title={TYPE_LABELS[item.type] || item.type}>
                      {TYPE_ICONS[item.type] || "📄"}{" "}
                      <span className="text-xs text-gray-500">{TYPE_LABELS[item.type] || item.type}</span>
                    </span>
                  </div>

                  {/* P0-B：状态特殊渲染（generating spinner / failed 错误+重试 / published 公众号链接）*/}
                  <div className="col-span-2 text-center">
                    <span
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium ${
                        STATUS_COLORS[item.status] || "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {item.status === "generating" && (
                        <span className="inline-block w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      )}
                      {STATUS_LABELS[item.status] || item.status}
                      {item.status === "generating" && <span className="text-[10px]">AI 生成中...</span>}
                    </span>
                    {item.status === "failed" && item.errorMessage && (
                      <div
                        className="text-[10px] text-red-600 mt-1 line-clamp-2 cursor-help"
                        title={item.errorMessage}
                      >
                        {item.errorMessage.slice(0, 100)}
                      </div>
                    )}
                    {item.status === "published" &&
                      item.platforms?.find((p) => p.platform === "wechat" && p.mediaId) && (
                        <div className="text-[10px] mt-1">
                          <a
                            href="https://mp.weixin.qq.com/cgi-bin/draftbox?t=draftbox/list"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-600 hover:underline"
                          >
                            在公众号查看
                          </a>
                        </div>
                      )}
                  </div>

                  {/* 时间 */}
                  <div className="col-span-2 text-center text-xs text-gray-500">
                    {formatTime(item.updatedAt)}
                  </div>

                  {/* 操作 */}
                  <div className="col-span-2 flex items-center justify-center gap-2">
                    {/* PR #178: pin toggle */}
                    <button
                      onClick={async () => {
                        try {
                          await api.post(`/content/${item.id}/pin`, { pinned: !item.pinned });
                          fetchContents();
                        } catch { /* ignore */ }
                      }}
                      className={`text-xs px-1.5 py-1 rounded ${item.pinned ? "text-amber-600 bg-amber-50" : "text-gray-400 hover:text-amber-500 hover:bg-amber-50"}`}
                      title={item.pinned ? "取消钉住" : "钉住 (防自动清理)"}
                    >
                      {item.pinned ? "📌" : "📍"}
                    </button>
                    <button
                      onClick={() => navigate(`/content/${item.id}`)}
                      className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
                      title="进入详情页（可编辑）"
                    >
                      👀 详情
                    </button>

                    {/* PR #129 V2.5 提前: ⏭ 跳过 - sessionStorage hide + toast (V2.5 backend 接 user_skip_log 后变持久化) */}
                    {item.status === "generated" && (
                      <button
                        onClick={() => {
                          const skipped = JSON.parse(sessionStorage.getItem("v25_skip") || "[]");
                          sessionStorage.setItem("v25_skip", JSON.stringify([...skipped, item.id]));
                          setItems((prev) => prev.filter((x) => x.id !== item.id));
                          toast.info("已跳过，本会话内不再显示");
                        }}
                        className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-50"
                        title="本会话隐藏 (V2.5 后接推荐算法)"
                      >
                        ⏭ 跳过
                      </button>
                    )}

                    {/* P0-B：6 状态流转按钮 */}
                    {item.status === "failed" && (
                      <button
                        onClick={() => handleStatusChange(item.id, "generating")}
                        className="text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50"
                        title="重新生成（failed → generating）"
                      >
                        🔄 重试
                      </button>
                    )}
                    {item.status === "generated" && (
                      <button
                        onClick={() => navigate(`/content/${item.id}?action=publish`)}
                        className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
                      >
                        📤 发布
                      </button>
                    )}
                    {/* 旧 enum 兼容：reviewing/approved 行视为 generated 显示发布按钮 */}
                    {(item.status === "reviewing" || item.status === "approved") && (
                      <button
                        onClick={() => navigate(`/content/${item.id}?action=publish`)}
                        className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
                      >
                        📤 发布
                      </button>
                    )}

                    {/* 删除 */}
                    {deletingId === item.id ? (
                      <span className="flex items-center gap-1">
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="text-xs text-red-600 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 font-medium"
                        >
                          确认
                        </button>
                        <button
                          onClick={() => setDeletingId(null)}
                          className="text-xs text-gray-500 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-50"
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setDeletingId(item.id)}
                        className="text-xs text-gray-400 hover:text-red-500 px-2 py-1 rounded hover:bg-red-50"
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
                );
              })}

              {/* 分页 */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200">
                  <span className="text-sm text-gray-500">
                    第 {page}/{totalPages} 页，共 {total} 条
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="px-3 py-1 text-sm border rounded disabled:opacity-50 hover:bg-gray-50"
                    >
                      上一页
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      className="px-3 py-1 text-sm border rounded disabled:opacity-50 hover:bg-gray-50"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
