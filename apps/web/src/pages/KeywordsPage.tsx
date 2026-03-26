import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

interface KeywordItem {
  id: string;
  keyword: string;
  sourcePlatform: string;
  heatScore: number;
  compositeScore: number;
  category: string | null;
  status: string;
  appearCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  crawlDate: string;
  metadata: Record<string, unknown>;
}

interface CrawlReport {
  date: string;
  totalRawItems: number;
  afterDedup: number;
  industryRelated: number;
  newKeywords: string[];
  sustainedKeywords: string[];
  crawlerSummary?: Array<{
    platform: string;
    success: boolean;
    itemCount: number;
    error?: string;
  }>;
  durationMs?: number;
}

const PLATFORM_LABELS: Record<string, string> = {
  baidu: "百度热搜",
  weibo: "微博热搜",
  zhihu: "知乎热榜",
  toutiao: "头条热榜",
  wechat: "微信指数",
  douyin: "抖音",
  xiaohongshu: "小红书",
  baijiahao: "百家号",
};

const CATEGORY_LABELS: Record<string, string> = {
  medicine: "医学",
  education: "教育",
  engineering: "工程",
  computer: "计算机",
  economics: "经济管理",
  law: "法学",
  psychology: "心理学",
  biology: "生物",
  chemistry: "化学",
  physics: "物理",
};

export default function KeywordsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [keywords, setKeywords] = useState<KeywordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [crawlReport, setCrawlReport] = useState<CrawlReport | null>(null);
  const [filterPlatform, setFilterPlatform] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  const fetchKeywords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", "30");
      if (filterPlatform) params.set("platform", filterPlatform);
      if (filterCategory) params.set("category", filterCategory);

      const res = await api.get<{
        items: KeywordItem[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/keywords?${params.toString()}`);

      if (res.data) {
        setKeywords(res.data.items);
        setTotal(res.data.total);
      }
    } catch (err) {
      console.error("获取关键词失败", err);
    } finally {
      setLoading(false);
    }
  }, [page, filterPlatform, filterCategory]);

  useEffect(() => {
    fetchKeywords();
  }, [fetchKeywords]);

  const handleCrawl = async () => {
    setCrawling(true);
    setCrawlReport(null);
    try {
      const res = await api.post<CrawlReport>("/keywords/crawl", {});
      if (res.data) {
        setCrawlReport(res.data);
        // 刷新关键词列表
        fetchKeywords();
      }
    } catch (err) {
      console.error("抓取失败", err);
    } finally {
      setCrawling(false);
    }
  };

  const totalPages = Math.ceil(total / 30);

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
          <span className="text-sm font-medium text-gray-700">
            关键词中心
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button
            onClick={logout}
            className="text-sm text-gray-500 hover:text-red-500"
          >
            退出
          </button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto py-6 px-6">
        {/* 操作栏 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              关键词中心
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              共 {total} 个关键词 · 支持百度/微博/知乎/头条 4大平台实时抓取
            </p>
          </div>
          <button
            onClick={handleCrawl}
            disabled={crawling}
            className={`px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${
              crawling
                ? "bg-gray-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700 active:scale-95"
            }`}
          >
            {crawling ? "抓取中..." : "立即抓取全平台热点"}
          </button>
        </div>

        {/* 抓取报告 */}
        {crawlReport && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-5 mb-6">
            <h3 className="text-sm font-bold text-green-800 mb-3">
              抓取完成 ({crawlReport.durationMs ? `${(crawlReport.durationMs / 1000).toFixed(1)}s` : ""})
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {crawlReport.totalRawItems}
                </div>
                <div className="text-xs text-gray-500">原始数据</div>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-gray-900">
                  {crawlReport.afterDedup}
                </div>
                <div className="text-xs text-gray-500">去重后</div>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {crawlReport.industryRelated}
                </div>
                <div className="text-xs text-gray-500">行业相关</div>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-green-600">
                  {crawlReport.newKeywords.length}
                </div>
                <div className="text-xs text-gray-500">新增关键词</div>
              </div>
            </div>
            {/* 各平台状态 */}
            {crawlReport.crawlerSummary && (
              <div className="flex gap-2 flex-wrap">
                {crawlReport.crawlerSummary.map((s) => (
                  <span
                    key={s.platform}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${
                      s.success
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                  >
                    {s.success ? "✓" : "✗"}{" "}
                    {PLATFORM_LABELS[s.platform] || s.platform}: {s.itemCount}条
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 筛选栏 */}
        <div className="flex gap-3 mb-4">
          <select
            value={filterPlatform}
            onChange={(e) => {
              setFilterPlatform(e.target.value);
              setPage(1);
            }}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
          >
            <option value="">全部平台</option>
            {Object.entries(PLATFORM_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            value={filterCategory}
            onChange={(e) => {
              setFilterCategory(e.target.value);
              setPage(1);
            }}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
          >
            <option value="">全部学科</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>

        {/* 关键词表格 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  关键词
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  来源平台
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  学科
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">
                  综合热度
                </th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">
                  出现天数
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">
                  最近出现
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    加载中...
                  </td>
                </tr>
              ) : keywords.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    暂无关键词数据，点击上方按钮抓取
                  </td>
                </tr>
              ) : (
                keywords.map((kw, idx) => (
                  <tr
                    key={kw.id}
                    className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${
                      idx < 3 ? "bg-yellow-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">
                        {idx < 3 && (
                          <span className="inline-block w-5 h-5 text-xs text-center leading-5 rounded bg-red-500 text-white mr-2">
                            {idx + 1}
                          </span>
                        )}
                        {kw.keyword}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {PLATFORM_LABELS[kw.sourcePlatform] || kw.sourcePlatform}
                      {kw.metadata &&
                        Array.isArray((kw.metadata as Record<string, unknown>).platforms) &&
                        ((kw.metadata as Record<string, string[]>).platforms).length > 1 && (
                          <span className="ml-1 text-xs text-blue-500">
                            +{((kw.metadata as Record<string, string[]>).platforms).length - 1}平台
                          </span>
                        )}
                    </td>
                    <td className="px-4 py-3">
                      {kw.category ? (
                        <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                          {CATEGORY_LABELS[kw.category] || kw.category}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-700">
                      {kw.compositeScore > 10000
                        ? `${(kw.compositeScore / 10000).toFixed(1)}万`
                        : Math.round(kw.compositeScore).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {kw.appearCount}天
                      {kw.appearCount >= 3 && (
                        <span className="ml-1 text-xs text-orange-500">
                          持续热门
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(kw.lastSeenAt).toLocaleDateString("zh-CN")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <span className="text-sm text-gray-500">
                第 {page}/{totalPages} 页，共 {total} 条
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                >
                  上一页
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1 text-sm border rounded disabled:opacity-50"
                >
                  下一页
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
