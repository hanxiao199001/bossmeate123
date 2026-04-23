import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ===== 类型定义 =====
interface ContentItem {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  status: string;
  platforms: Array<{ platform: string; status?: string; publishedAt?: string }>;
  tokensTotal: number;
  createdAt: string;
  updatedAt: string;
}

interface ContentStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
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
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  // 列表状态
  const [items, setItems] = useState<ContentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // 统计
  const [stats, setStats] = useState<ContentStats | null>(null);

  // 筛选
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  // 删除确认
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const pageSize = 20;
  const totalPages = Math.ceil(total / pageSize);

  // 获取内容列表
  const fetchContents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (filterType) params.set("type", filterType);
      if (filterStatus) params.set("status", filterStatus);

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
  }, [page, filterType, filterStatus]);

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

  // 删除内容
  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/content/${id}`);
      setDeletingId(null);
      fetchContents();
      fetchStats();
    } catch (err) {
      console.error("删除失败", err);
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
      {/* 顶部导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-blue-600">BossMate</span>
            <span className="text-xs text-gray-400">AI超级员工</span>
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-sm font-medium text-gray-700">内容管理</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">
            退出
          </button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto py-6 px-6">
        {/* 统计卡片 */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <div
              className={`bg-white rounded-xl border border-gray-200 p-4 text-center cursor-pointer transition-all ${
                !filterStatus ? "ring-2 ring-blue-400" : "hover:shadow-md"
              }`}
              onClick={() => { setFilterStatus(""); setPage(1); }}
            >
              <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
              <div className="text-xs text-gray-500">全部内容</div>
            </div>
            {(["draft", "reviewing", "approved", "published"] as const).map((s) => (
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
                <div className="text-xs text-gray-500">{STATUS_LABELS[s]}</div>
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
          </div>

          <div className="flex gap-2">
            <Link
              to="/workflow/article"
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              + 选题创作
            </Link>
            <Link
              to="/chat?skill=article"
              className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors"
            >
              + AI对话创作
            </Link>
          </div>
        </div>

        {/* 内容列表 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {loading ? (
            <div className="text-center py-16 text-gray-400">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              加载中...
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-4xl mb-4">📄</p>
              <p className="text-gray-500 mb-1">还没有内容</p>
              <p className="text-sm text-gray-400">
                通过选题工坊或 AI 对话创作你的第一篇内容
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
              {items.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 px-5 py-4 border-b border-gray-100 hover:bg-blue-50/50 transition-colors items-center"
                >
                  {/* 标题和摘要 */}
                  <div className="col-span-5">
                    <div
                      className="font-medium text-gray-900 text-sm cursor-pointer hover:text-blue-600 transition-colors"
                      onClick={() => navigate(`/content/${item.id}`)}
                    >
                      {item.title || "无标题"}
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

                  {/* 状态 */}
                  <div className="col-span-2 text-center">
                    <span
                      className={`inline-block text-xs px-2.5 py-1 rounded-full font-medium ${
                        STATUS_COLORS[item.status] || "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {STATUS_LABELS[item.status] || item.status}
                    </span>
                  </div>

                  {/* 时间 */}
                  <div className="col-span-2 text-center text-xs text-gray-500">
                    {formatTime(item.updatedAt)}
                  </div>

                  {/* 操作 */}
                  <div className="col-span-2 flex items-center justify-center gap-2">
                    <button
                      onClick={() => navigate(`/content/${item.id}`)}
                      className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
                    >
                      编辑
                    </button>

                    {/* 状态流转按钮 */}
                    {item.status === "draft" && (
                      <button
                        onClick={() => handleStatusChange(item.id, "reviewing")}
                        className="text-xs text-yellow-600 hover:text-yellow-700 px-2 py-1 rounded hover:bg-yellow-50"
                      >
                        提审
                      </button>
                    )}
                    {item.status === "reviewing" && (
                      <button
                        onClick={() => handleStatusChange(item.id, "approved")}
                        className="text-xs text-green-600 hover:text-green-700 px-2 py-1 rounded hover:bg-green-50"
                      >
                        通过
                      </button>
                    )}
                    {item.status === "approved" && (
                      <button
                        onClick={() => navigate(`/content/${item.id}?action=publish`)}
                        className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50"
                      >
                        发布
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
              ))}

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
      </div>
    </div>
  );
}
