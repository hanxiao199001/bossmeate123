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

interface CrawlerSummaryItem {
  platform: string;
  track?: string;
  success: boolean;
  keywordCount?: number;
  journalCount?: number;
  error?: string;
}

interface CrawlReport {
  date: string;
  totalRawItems: number;
  afterDedup: number;
  industryRelated: number;
  newKeywords: string[];
  sustainedKeywords: string[];
  crawlerSummary?: CrawlerSummaryItem[];
  durationMs?: number;
  track?: string;
}

interface KeywordCluster {
  id: string;
  keywords: string[];
  discipline: string;
  track: "domestic" | "sci";
  heatScore: number;
  suggestedTitles: string[];
  reasoning: string;
  createdAt: string;
}

interface ClusterResult {
  clusters: KeywordCluster[];
  rawKeywordCount: number;
  clusterCount: number;
  durationMs: number;
}

// ===== 新版平台标签 =====
const PLATFORM_LABELS: Record<string, string> = {
  "baidu-academic": "百度学术",
  "wechat-index": "微信热词",
  "policy-monitor": "政策监控",
  letpub: "LetPub期刊库",
  openalex: "OpenAlex",
  pubmed: "PubMed",
  arxiv: "arXiv",
};

const PLATFORM_TRACK: Record<string, "domestic" | "sci"> = {
  "baidu-academic": "domestic",
  "wechat-index": "domestic",
  "policy-monitor": "domestic",
  letpub: "sci",
  openalex: "sci",
  pubmed: "sci",
  arxiv: "sci",
};

const TRACK_LABELS: Record<string, string> = {
  domestic: "国内核心",
  sci: "国际SCI",
};

const TRACK_COLORS: Record<string, string> = {
  domestic: "bg-orange-100 text-orange-700",
  sci: "bg-purple-100 text-purple-700",
};

const CATEGORY_LABELS: Record<string, string> = {
  medicine: "医学",
  education: "教育",
  engineering: "工程技术",
  computer: "计算机",
  economics: "经济管理",
  law: "法学",
  psychology: "心理学",
  biology: "生物",
  chemistry: "化学",
  physics: "物理",
  energy: "能源",
  environment: "环境科学",
  agriculture: "农林",
  materials: "材料科学",
  math: "数学",
};

// 聚类可选学科
const CLUSTER_DISCIPLINES = [
  { value: "", label: "全部学科" },
  { value: "教育", label: "教育" },
  { value: "经济管理", label: "经济管理" },
  { value: "医学", label: "医学" },
  { value: "农林", label: "农林" },
  { value: "工程技术", label: "工程技术" },
  { value: "法学", label: "法学" },
  { value: "心理学", label: "心理学" },
];

// 趋势标签配置
const TREND_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  exploding: { label: "爆发", color: "bg-red-100 text-red-700", icon: "🔥" },
  rising: { label: "上升", color: "bg-orange-100 text-orange-700", icon: "📈" },
  stable: { label: "平稳", color: "bg-gray-100 text-gray-700", icon: "➡️" },
  cooling: { label: "下降", color: "bg-blue-100 text-blue-700", icon: "📉" },
  new: { label: "新词", color: "bg-green-100 text-green-700", icon: "✨" },
};

const LEVEL_CONFIG: Record<string, { label: string; color: string }> = {
  primary: { label: "一级（直接命中）", color: "bg-red-100 text-red-700" },
  secondary: { label: "二级（需组合）", color: "bg-yellow-100 text-yellow-700" },
  context: { label: "语境词", color: "bg-gray-100 text-gray-600" },
};

interface TrendLabel {
  keyword: string;
  trend: string;
  score7d: number;
  score30d: number;
  currentScore: number;
  avgScore7d: number;
  avgScore30d: number;
  sparkline: number[];
  platforms: string[];
  category: string | null;
  firstSeenDaysAgo: number;
}

interface TrendReport {
  date: string;
  exploding: TrendLabel[];
  rising: TrendLabel[];
  stable: TrendLabel[];
  cooling: TrendLabel[];
  newKeywords: TrendLabel[];
}

interface DictWord {
  id: string;
  word: string;
  level: string;
  category: string | null;
  weight: number;
  isSystem: boolean;
  isActive: boolean;
  source: string;
  hitCount: number;
}

type CrawlMode = "all" | "domestic" | "sci";
type TabType = "keywords" | "clusters" | "trends" | "dictionary";

export default function KeywordsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  // Tab 切换
  const [activeTab, setActiveTab] = useState<TabType>("clusters");

  // ===== 关键词列表 state =====
  const [keywords, setKeywords] = useState<KeywordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [crawlReport, setCrawlReport] = useState<CrawlReport | null>(null);
  const [filterPlatform, setFilterPlatform] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterTrack, setFilterTrack] = useState("");

  // ===== 关键词聚类 state =====
  const [clustering, setClustering] = useState(false);
  const [clusterResult, setClusterResult] = useState<ClusterResult | null>(null);
  const [clusterTrack, setClusterTrack] = useState<"all" | "domestic" | "sci">("domestic");
  const [clusterDiscipline, setClusterDiscipline] = useState("");

  // ===== 趋势分析 state =====
  const [trendReport, setTrendReport] = useState<TrendReport | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendFilter, setTrendFilter] = useState<string>("all");

  // ===== 动态词库 state =====
  const [dictWords, setDictWords] = useState<DictWord[]>([]);
  const [dictLoading, setDictLoading] = useState(false);
  const [dictFilter, setDictFilter] = useState<string>(""); // level filter
  const [dictCategories, setDictCategories] = useState<string[]>([]);
  const [dictCatFilter, setDictCatFilter] = useState<string>("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newWord, setNewWord] = useState({ word: "", level: "primary", category: "" });
  const [dictIniting, setDictIniting] = useState(false);

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
    if (activeTab === "keywords") fetchKeywords();
  }, [fetchKeywords, activeTab]);

  const handleCrawl = async (mode: CrawlMode = "all") => {
    setCrawling(true);
    setCrawlReport(null);
    try {
      const endpoint =
        mode === "domestic"
          ? "/keywords/crawl/domestic"
          : mode === "sci"
            ? "/keywords/crawl/sci"
            : "/keywords/crawl";
      const res = await api.post<CrawlReport>(endpoint, {});
      if (res.data) {
        setCrawlReport(res.data);
        fetchKeywords();
      }
    } catch (err) {
      console.error("抓取失败", err);
    } finally {
      setCrawling(false);
    }
  };

  // 关键词聚类
  const handleCluster = async () => {
    setClustering(true);
    setClusterResult(null);
    try {
      const body: Record<string, string> = { track: clusterTrack };
      if (clusterDiscipline) body.discipline = clusterDiscipline;

      const res = await api.post<ClusterResult>("/keywords/clusters", body);
      if (res.data) {
        setClusterResult(res.data);
      }
    } catch (err) {
      console.error("聚类失败", err);
    } finally {
      setClustering(false);
    }
  };

  // ===== 趋势相关 =====
  const fetchTrends = useCallback(async () => {
    setTrendLoading(true);
    try {
      const res = await api.get<TrendReport>("/keywords/trends?limit=100");
      if (res.data) setTrendReport(res.data);
    } catch (err) {
      console.error("获取趋势报告失败", err);
    } finally {
      setTrendLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "trends") fetchTrends();
  }, [activeTab, fetchTrends]);

  const getTrendItems = (): TrendLabel[] => {
    if (!trendReport) return [];
    if (trendFilter === "all") {
      return [
        ...trendReport.exploding,
        ...trendReport.newKeywords,
        ...trendReport.rising,
        ...trendReport.stable,
        ...trendReport.cooling,
      ];
    }
    if (trendFilter === "new") return trendReport.newKeywords;
    return (trendReport as any)[trendFilter] || [];
  };

  // ===== 词库相关 =====
  const fetchDictionary = useCallback(async () => {
    setDictLoading(true);
    try {
      const params = new URLSearchParams();
      if (dictFilter) params.set("level", dictFilter);
      if (dictCatFilter) params.set("category", dictCatFilter);
      const res = await api.get<DictWord[]>(`/keywords/dictionary?${params.toString()}`);
      if (res.data) setDictWords(res.data);
    } catch (err) {
      console.error("获取词库失败", err);
    } finally {
      setDictLoading(false);
    }
  }, [dictFilter, dictCatFilter]);

  const fetchDictCategories = useCallback(async () => {
    try {
      const res = await api.get<string[]>("/keywords/dictionary/categories");
      if (res.data) setDictCategories(res.data);
    } catch (err) {
      console.error("获取分类失败", err);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "dictionary") {
      fetchDictionary();
      fetchDictCategories();
    }
  }, [activeTab, fetchDictionary, fetchDictCategories]);

  const handleInitDict = async () => {
    setDictIniting(true);
    try {
      await api.post("/keywords/dictionary/init", {});
      await fetchDictionary();
      await fetchDictCategories();
    } catch (err) {
      console.error("初始化词库失败", err);
    } finally {
      setDictIniting(false);
    }
  };

  const handleAddWord = async () => {
    if (!newWord.word.trim()) return;
    try {
      await api.post("/keywords/dictionary", {
        word: newWord.word.trim(),
        level: newWord.level,
        category: newWord.category || undefined,
      });
      setNewWord({ word: "", level: "primary", category: "" });
      setShowAddForm(false);
      fetchDictionary();
    } catch (err) {
      console.error("添加失败", err);
    }
  };

  const handleToggleWord = async (id: string, isActive: boolean) => {
    try {
      await api.patch(`/keywords/dictionary/${id}`, { isActive: !isActive });
      fetchDictionary();
    } catch (err) {
      console.error("更新失败", err);
    }
  };

  const handleDeleteWord = async (id: string) => {
    if (!confirm("确定删除此关键词？")) return;
    try {
      await api.delete(`/keywords/dictionary/${id}`);
      fetchDictionary();
    } catch (err) {
      console.error("删除失败", err);
    }
  };

  // 迷你 sparkline 渲染（纯CSS）
  const renderSparkline = (data: number[]) => {
    const max = Math.max(...data, 1);
    return (
      <div className="flex items-end gap-px h-6">
        {data.map((v, i) => (
          <div
            key={i}
            className="w-1.5 bg-blue-400 rounded-t-sm"
            style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
          />
        ))}
      </div>
    );
  };

  const filteredPlatforms = filterTrack
    ? Object.entries(PLATFORM_LABELS).filter(
        ([k]) => PLATFORM_TRACK[k] === filterTrack
      )
    : Object.entries(PLATFORM_LABELS);

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
          <span className="text-sm font-medium text-gray-700">关键词中心</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">
            退出
          </button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto py-6 px-6">
        {/* Tab 切换 */}
        <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
          <button
            onClick={() => setActiveTab("clusters")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === "clusters"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            关键词聚类 + 标题生成
          </button>
          <button
            onClick={() => setActiveTab("trends")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === "trends"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            热度趋势
          </button>
          <button
            onClick={() => setActiveTab("keywords")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === "keywords"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            关键词库 ({total})
          </button>
          <button
            onClick={() => setActiveTab("dictionary")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
              activeTab === "dictionary"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            行业词库
          </button>
        </div>

        {/* ========== Tab 1: 关键词聚类 ========== */}
        {activeTab === "clusters" && (
          <div>
            {/* 操作栏 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h2 className="text-lg font-bold text-gray-900 mb-1">
                关键词聚类 + AI标题生成
              </h2>
              <p className="text-sm text-gray-500 mb-4">
                自动抓取热门关键词 → DeepSeek AI 聚类成2-3个关联词组合 → 生成引流标题
              </p>

              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">业务线</label>
                  <select
                    value={clusterTrack}
                    onChange={(e) => setClusterTrack(e.target.value as "all" | "domestic" | "sci")}
                    className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
                  >
                    <option value="domestic">国内核心</option>
                    <option value="sci">国际SCI</option>
                    <option value="all">全部</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">学科</label>
                  <select
                    value={clusterDiscipline}
                    onChange={(e) => setClusterDiscipline(e.target.value)}
                    className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
                  >
                    {CLUSTER_DISCIPLINES.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleCluster}
                  disabled={clustering}
                  className={`px-6 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                    clustering
                      ? "bg-gray-400 cursor-not-allowed"
                      : "bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:scale-95"
                  }`}
                >
                  {clustering ? "AI分析中..." : "开始聚类分析"}
                </button>
              </div>

              {clustering && (
                <div className="mt-4 flex items-center gap-2 text-sm text-blue-600">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  正在抓取热词 + DeepSeek AI 聚类分析，预计30-60秒...
                </div>
              )}
            </div>

            {/* 聚类结果 */}
            {clusterResult && (
              <div>
                {/* 统计卡片 */}
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="text-2xl font-bold text-gray-900">{clusterResult.rawKeywordCount}</div>
                    <div className="text-xs text-gray-500">原始热词</div>
                  </div>
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="text-2xl font-bold text-blue-600">{clusterResult.clusterCount}</div>
                    <div className="text-xs text-gray-500">聚类组合</div>
                  </div>
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="text-2xl font-bold text-green-600">
                      {(clusterResult.durationMs / 1000).toFixed(1)}s
                    </div>
                    <div className="text-xs text-gray-500">处理耗时</div>
                  </div>
                </div>

                {/* 聚类卡片列表 */}
                <div className="space-y-4">
                  {clusterResult.clusters.map((cluster, idx) => (
                    <div
                      key={cluster.id}
                      className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-500 text-white text-xs font-bold">
                            {idx + 1}
                          </span>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${TRACK_COLORS[cluster.track]}`}
                          >
                            {TRACK_LABELS[cluster.track]}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                            {cluster.discipline}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-gray-400">
                          热度 {cluster.heatScore}
                        </div>
                      </div>

                      {/* 关键词组合 */}
                      <div className="flex gap-2 mb-3">
                        {cluster.keywords.map((kw, i) => (
                          <span
                            key={i}
                            className="inline-block px-3 py-1.5 rounded-lg bg-gray-100 text-sm font-medium text-gray-800 border border-gray-200"
                          >
                            {kw}
                          </span>
                        ))}
                      </div>

                      {/* AI分析原因 */}
                      <p className="text-xs text-gray-500 mb-3">
                        {cluster.reasoning}
                      </p>

                      {/* 推荐标题 */}
                      <div className="space-y-2">
                        {cluster.suggestedTitles.map((title, i) => (
                          <div
                            key={i}
                            className="flex items-start gap-2 p-3 rounded-lg bg-gradient-to-r from-orange-50 to-yellow-50 border border-orange-100"
                          >
                            <span className="shrink-0 mt-0.5 text-orange-500 text-sm">
                              {i === 0 ? "A" : "B"}
                            </span>
                            <span className="text-sm font-medium text-gray-900">
                              {title}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 空状态 */}
            {!clusterResult && !clustering && (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <div className="text-4xl mb-3">&#x1F50D;</div>
                <h3 className="text-lg font-medium text-gray-700 mb-2">
                  选择业务线和学科，点击"开始聚类分析"
                </h3>
                <p className="text-sm text-gray-400">
                  AI会自动抓取热门关键词，聚类成2-3个关联组合，并生成引流标题
                </p>
              </div>
            )}
          </div>
        )}

        {/* ========== Tab 2: 关键词库 ========== */}
        {activeTab === "keywords" && (
          <div>
            {/* 操作栏 */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-gray-900">关键词库</h2>
                <p className="text-sm text-gray-500 mt-1">
                  共 {total} 个关键词 · 国内核心3平台 + SCI 4平台
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleCrawl("domestic")}
                  disabled={crawling}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    crawling
                      ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                      : "bg-orange-500 hover:bg-orange-600 text-white active:scale-95"
                  }`}
                >
                  {crawling ? "抓取中..." : "国内核心"}
                </button>
                <button
                  onClick={() => handleCrawl("sci")}
                  disabled={crawling}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    crawling
                      ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                      : "bg-purple-500 hover:bg-purple-600 text-white active:scale-95"
                  }`}
                >
                  {crawling ? "抓取中..." : "SCI期刊"}
                </button>
                <button
                  onClick={() => handleCrawl("all")}
                  disabled={crawling}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    crawling
                      ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                      : "bg-blue-600 hover:bg-blue-700 text-white active:scale-95"
                  }`}
                >
                  {crawling ? "抓取中..." : "全部抓取"}
                </button>
              </div>
            </div>

            {/* 抓取报告 */}
            {crawlReport && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-5 mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-bold text-green-800">
                    抓取完成
                    {crawlReport.durationMs
                      ? ` (${(crawlReport.durationMs / 1000).toFixed(1)}s)`
                      : ""}
                  </h3>
                  {crawlReport.track && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${TRACK_COLORS[crawlReport.track] || ""}`}>
                      {TRACK_LABELS[crawlReport.track] || crawlReport.track}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  <div className="bg-white rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-gray-900">{crawlReport.totalRawItems}</div>
                    <div className="text-xs text-gray-500">原始数据</div>
                  </div>
                  <div className="bg-white rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-gray-900">{crawlReport.afterDedup}</div>
                    <div className="text-xs text-gray-500">去重后</div>
                  </div>
                  <div className="bg-white rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-blue-600">{crawlReport.industryRelated}</div>
                    <div className="text-xs text-gray-500">行业相关</div>
                  </div>
                  <div className="bg-white rounded-lg p-3 text-center">
                    <div className="text-2xl font-bold text-green-600">{crawlReport.newKeywords.length}</div>
                    <div className="text-xs text-gray-500">新增关键词</div>
                  </div>
                </div>
                {crawlReport.crawlerSummary && (
                  <div className="flex gap-2 flex-wrap">
                    {crawlReport.crawlerSummary.map((s) => {
                      const count = (s.keywordCount || 0) + (s.journalCount || 0);
                      const track = s.track || PLATFORM_TRACK[s.platform];
                      return (
                        <span
                          key={s.platform}
                          className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full ${
                            s.success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}
                        >
                          {s.success ? "✓" : "✗"} {PLATFORM_LABELS[s.platform] || s.platform}
                          {track && <span className="opacity-60">[{TRACK_LABELS[track] || track}]</span>}
                          : {count}条
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 筛选栏 */}
            <div className="flex gap-3 mb-4">
              <select value={filterTrack} onChange={(e) => { setFilterTrack(e.target.value); setFilterPlatform(""); setPage(1); }} className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
                <option value="">全部业务线</option>
                <option value="domestic">国内核心</option>
                <option value="sci">国际SCI</option>
              </select>
              <select value={filterPlatform} onChange={(e) => { setFilterPlatform(e.target.value); setPage(1); }} className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
                <option value="">全部平台</option>
                {filteredPlatforms.map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
              </select>
              <select value={filterCategory} onChange={(e) => { setFilterCategory(e.target.value); setPage(1); }} className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
                <option value="">全部学科</option>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
              </select>
            </div>

            {/* 关键词表格 */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">关键词</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">业务线</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">来源平台</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">学科</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">综合热度</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">出现天数</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">最近出现</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="text-center py-12 text-gray-400">加载中...</td></tr>
                  ) : keywords.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-12 text-gray-400">暂无关键词数据，点击上方按钮抓取</td></tr>
                  ) : (
                    keywords.map((kw, idx) => {
                      const track = PLATFORM_TRACK[kw.sourcePlatform];
                      return (
                        <tr key={kw.id} className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${idx < 3 ? "bg-yellow-50" : ""}`}>
                          <td className="px-4 py-3">
                            <span className="font-medium text-gray-900">
                              {idx < 3 && <span className="inline-block w-5 h-5 text-xs text-center leading-5 rounded bg-red-500 text-white mr-2">{idx + 1}</span>}
                              {kw.keyword}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {track && <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${TRACK_COLORS[track] || ""}`}>{TRACK_LABELS[track] || track}</span>}
                          </td>
                          <td className="px-4 py-3 text-gray-600">
                            {PLATFORM_LABELS[kw.sourcePlatform] || kw.sourcePlatform}
                          </td>
                          <td className="px-4 py-3">
                            {kw.category ? (
                              <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{CATEGORY_LABELS[kw.category] || kw.category}</span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-gray-700">
                            {kw.compositeScore > 10000 ? `${(kw.compositeScore / 10000).toFixed(1)}万` : Math.round(kw.compositeScore).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600">
                            {kw.appearCount}天
                            {kw.appearCount >= 3 && <span className="ml-1 text-xs text-orange-500">持续热门</span>}
                          </td>
                          <td className="px-4 py-3 text-gray-500">
                            {new Date(kw.lastSeenAt).toLocaleDateString("zh-CN")}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
                  <span className="text-sm text-gray-500">第 {page}/{totalPages} 页，共 {total} 条</span>
                  <div className="flex gap-2">
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50">上一页</button>
                    <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-3 py-1 text-sm border rounded disabled:opacity-50">下一页</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {/* ========== Tab 3: 热度趋势 ========== */}
        {activeTab === "trends" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-gray-900">关键词热度趋势</h2>
                <p className="text-sm text-gray-500 mt-1">
                  基于每日快照数据，识别爆发、上升、平稳、下降的关键词
                </p>
              </div>
              <button
                onClick={fetchTrends}
                disabled={trendLoading}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400"
              >
                {trendLoading ? "加载中..." : "刷新趋势"}
              </button>
            </div>

            {/* 趋势统计卡片 */}
            {trendReport && (
              <div className="grid grid-cols-5 gap-3 mb-6">
                {(["exploding", "new", "rising", "stable", "cooling"] as const).map((key) => {
                  const items = key === "new" ? trendReport.newKeywords : (trendReport as any)[key];
                  const cfg = TREND_CONFIG[key === "new" ? "new" : key];
                  return (
                    <button
                      key={key}
                      onClick={() => setTrendFilter(trendFilter === key ? "all" : key)}
                      className={`rounded-xl border p-4 text-center transition-all ${
                        trendFilter === key ? "border-blue-500 ring-2 ring-blue-200" : "border-gray-200 hover:border-gray-300"
                      } bg-white`}
                    >
                      <div className="text-2xl mb-1">{cfg.icon}</div>
                      <div className="text-2xl font-bold text-gray-900">{items.length}</div>
                      <div className="text-xs text-gray-500">{cfg.label}</div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* 趋势列表 */}
            {trendLoading ? (
              <div className="bg-white rounded-xl border p-12 text-center text-gray-400">加载趋势数据中...</div>
            ) : getTrendItems().length === 0 ? (
              <div className="bg-white rounded-xl border p-12 text-center">
                <div className="text-4xl mb-3">📊</div>
                <h3 className="text-lg font-medium text-gray-700 mb-2">暂无趋势数据</h3>
                <p className="text-sm text-gray-400">需要至少2天的关键词快照数据才能生成趋势分析</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">关键词</th>
                      <th className="text-center px-4 py-3 font-medium text-gray-600">趋势</th>
                      <th className="text-center px-4 py-3 font-medium text-gray-600">7日迷你图</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">7天变化</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">当前热度</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">7日均值</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-600">学科</th>
                      <th className="text-right px-4 py-3 font-medium text-gray-600">出现天数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getTrendItems().map((item) => {
                      const cfg = TREND_CONFIG[item.trend] || TREND_CONFIG.stable;
                      return (
                        <tr key={item.keyword} className="border-b border-gray-100 hover:bg-blue-50 transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-900">{item.keyword}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${cfg.color}`}>
                              {cfg.icon} {cfg.label}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-center">{renderSparkline(item.sparkline)}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            <span className={item.score7d > 0 ? "text-red-600" : item.score7d < 0 ? "text-green-600" : "text-gray-400"}>
                              {item.score7d > 0 ? "+" : ""}{item.score7d}%
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-gray-700">
                            {item.currentScore > 10000 ? `${(item.currentScore / 10000).toFixed(1)}万` : Math.round(item.currentScore).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-gray-500">
                            {Math.round(item.avgScore7d).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            {item.category ? (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                                {CATEGORY_LABELS[item.category] || item.category}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-600">{item.firstSeenDaysAgo}天</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ========== Tab 4: 行业词库管理 ========== */}
        {activeTab === "dictionary" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-bold text-gray-900">行业关键词词库</h2>
                <p className="text-sm text-gray-500 mt-1">
                  管理一级/二级/语境关键词，运营可增删改查，替代硬编码词库
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleInitDict}
                  disabled={dictIniting}
                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {dictIniting ? "初始化中..." : "初始化预置词库"}
                </button>
                <button
                  onClick={() => setShowAddForm(!showAddForm)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
                >
                  + 添加关键词
                </button>
              </div>
            </div>

            {/* 添加表单 */}
            {showAddForm && (
              <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
                <h3 className="text-sm font-bold text-gray-700 mb-3">添加新关键词</h3>
                <div className="flex items-end gap-3">
                  <div className="flex-1">
                    <label className="block text-xs text-gray-500 mb-1">关键词</label>
                    <input
                      type="text"
                      value={newWord.word}
                      onChange={(e) => setNewWord({ ...newWord, word: e.target.value })}
                      placeholder="输入关键词..."
                      className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">级别</label>
                    <select
                      value={newWord.level}
                      onChange={(e) => setNewWord({ ...newWord, level: e.target.value })}
                      className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
                    >
                      <option value="primary">一级关键词</option>
                      <option value="secondary">二级关键词</option>
                      <option value="context">语境词</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">分类</label>
                    <input
                      type="text"
                      value={newWord.category}
                      onChange={(e) => setNewWord({ ...newWord, category: e.target.value })}
                      placeholder="如: 期刊类型"
                      className="text-sm border border-gray-300 rounded-lg px-3 py-2 w-36"
                    />
                  </div>
                  <button
                    onClick={handleAddWord}
                    className="px-5 py-2 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700"
                  >
                    添加
                  </button>
                  <button
                    onClick={() => setShowAddForm(false)}
                    className="px-4 py-2 rounded-lg text-sm border border-gray-300 text-gray-600 hover:bg-gray-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* 筛选栏 */}
            <div className="flex gap-3 mb-4">
              <select
                value={dictFilter}
                onChange={(e) => setDictFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
              >
                <option value="">全部级别</option>
                <option value="primary">一级关键词</option>
                <option value="secondary">二级关键词</option>
                <option value="context">语境词</option>
              </select>
              <select
                value={dictCatFilter}
                onChange={(e) => setDictCatFilter(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
              >
                <option value="">全部分类</option>
                {dictCategories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <span className="text-sm text-gray-500 leading-9">
                共 {dictWords.length} 个关键词
              </span>
            </div>

            {/* 词库表格 */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">关键词</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">级别</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">分类</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">权重</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600">命中次数</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600">来源</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600">状态</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {dictLoading ? (
                    <tr><td colSpan={8} className="text-center py-12 text-gray-400">加载中...</td></tr>
                  ) : dictWords.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center py-12 text-gray-400">
                        词库为空，点击"初始化预置词库"导入系统预置关键词
                      </td>
                    </tr>
                  ) : (
                    dictWords.map((w) => {
                      const levelCfg = LEVEL_CONFIG[w.level] || LEVEL_CONFIG.context;
                      return (
                        <tr key={w.id} className={`border-b border-gray-100 hover:bg-blue-50 transition-colors ${!w.isActive ? "opacity-50" : ""}`}>
                          <td className="px-4 py-3 font-medium text-gray-900">{w.word}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${levelCfg.color}`}>
                              {levelCfg.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-600">{w.category || "—"}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-700">{w.weight}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-700">
                            {w.hitCount}
                            {w.hitCount > 10 && <span className="ml-1 text-xs text-orange-500">热</span>}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              w.isSystem ? "bg-gray-100 text-gray-500" : "bg-green-100 text-green-700"
                            }`}>
                              {w.isSystem ? "系统" : "手动"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              onClick={() => handleToggleWord(w.id, w.isActive)}
                              className={`text-xs px-3 py-1 rounded-full transition-colors ${
                                w.isActive
                                  ? "bg-green-100 text-green-700 hover:bg-green-200"
                                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                              }`}
                            >
                              {w.isActive ? "启用" : "禁用"}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {!w.isSystem && (
                              <button
                                onClick={() => handleDeleteWord(w.id)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                删除
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
