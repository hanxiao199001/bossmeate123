import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ============ 类型 ============

interface KnowledgeEntry {
  id: string;
  tenantId: string;
  category: string;
  title: string | null;
  content: string;
  source: string | null;
  vectorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface SearchResult {
  id: string;
  title: string;
  content: string;
  category: string;
  source: string | null;
  score: number;
  metadata: Record<string, unknown>;
}

interface AuditStage {
  pass: boolean;
  stage: string;
  reason: string;
  score?: number;
}

interface AuditResult {
  accepted: boolean;
  stages: AuditStage[];
  entry?: { id: string };
  timeliness?: string;
}

interface ColdStartStep {
  step: number;
  name: string;
  status: string;
  itemCount?: number;
  message?: string;
}

interface ColdStartProgress {
  tenantId: string;
  currentStep: number;
  totalSteps: number;
  steps: ColdStartStep[];
  status: string;
  error?: string;
}

interface SubStats { pgCount: number; vectorCount: number }

// ============ 常量 ============

const VECTOR_CATEGORIES = [
  { key: "term", label: "术语库", icon: "📖", color: "bg-blue-50 text-blue-600 border-blue-200" },
  { key: "redline", label: "红线规则", icon: "🚫", color: "bg-red-50 text-red-600 border-red-200" },
  { key: "audience", label: "人群画像", icon: "👥", color: "bg-amber-50 text-amber-600 border-amber-200" },
  { key: "content_format", label: "内容拆解", icon: "📐", color: "bg-cyan-50 text-cyan-600 border-cyan-200" },
  { key: "keyword", label: "关键词", icon: "🔑", color: "bg-green-50 text-green-600 border-green-200" },
  { key: "style", label: "IP风格", icon: "🎨", color: "bg-pink-50 text-pink-600 border-pink-200" },
  { key: "platform_rule", label: "平台规则", icon: "📱", color: "bg-violet-50 text-violet-600 border-violet-200" },
  { key: "insight", label: "洞察策略", icon: "💡", color: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  { key: "hot_event", label: "热点事件", icon: "🔥", color: "bg-orange-50 text-orange-600 border-orange-200" },
  { key: "domain_knowledge", label: "领域知识", icon: "🎓", color: "bg-indigo-50 text-indigo-600 border-indigo-200" },
];

const PG_CATEGORIES = [
  { key: "competitor_account", label: "竞品账号", icon: "🏢", color: "bg-slate-50 text-slate-600 border-slate-200" },
  { key: "competitor_content", label: "竞品内容", icon: "📄", color: "bg-slate-50 text-slate-600 border-slate-200" },
  { key: "tenant_ip", label: "IP定位", icon: "🎯", color: "bg-slate-50 text-slate-600 border-slate-200" },
  { key: "production", label: "生产记录", icon: "🏭", color: "bg-slate-50 text-slate-600 border-slate-200" },
  { key: "content_metric", label: "数据表现", icon: "📊", color: "bg-slate-50 text-slate-600 border-slate-200" },
  { key: "column_calendar", label: "栏目日历", icon: "📅", color: "bg-slate-50 text-slate-600 border-slate-200" },
];

const ALL_CATEGORIES = [...VECTOR_CATEGORIES, ...PG_CATEGORIES];

const STAGE_LABELS: Record<string, string> = {
  relevance: "相关度检测", quality: "质量评估", reason: "入库原因", dedup: "向量去重", timeliness: "时效标记",
};

const STAGE_ICONS: Record<string, string> = {
  relevance: "🎯", quality: "✨", reason: "📋", dedup: "🔍", timeliness: "⏰",
};

// ============ 主页面 ============

type Tab = "overview" | "browse" | "search" | "audit" | "coldstart";

export default function KnowledgePage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [tab, setTab] = useState<Tab>("overview");

  const tabs: { key: Tab; label: string; icon: string; desc: string }[] = [
    { key: "overview", label: "总览", icon: "📊", desc: "子库数据概览" },
    { key: "browse", label: "浏览", icon: "📋", desc: "查看编辑条目" },
    { key: "search", label: "语义搜索", icon: "🔍", desc: "自然语言检索" },
    { key: "audit", label: "审核入库", icon: "🛡️", desc: "5-Gate 管线" },
    { key: "coldstart", label: "冷启动", icon: "🚀", desc: "一键初始化" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-gray-400 hover:text-blue-600 transition-colors">
            ← 首页
          </Link>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-lg font-bold text-gray-900">知识库引擎</span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">V4</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-400 hover:text-red-500 transition-colors">退出</button>
        </div>
      </header>

      {/* Tab Bar */}
      <nav className="bg-white border-b border-gray-100 px-6 flex gap-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`
              group relative px-5 py-3.5 text-sm font-medium transition-all
              ${tab === t.key
                ? "text-blue-600"
                : "text-gray-400 hover:text-gray-600"
              }
            `}
          >
            <span className="flex items-center gap-2">
              <span className="text-base">{t.icon}</span>
              {t.label}
            </span>
            {tab === t.key && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-blue-600 rounded-full" />
            )}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="max-w-[1280px] mx-auto px-6 py-6">
        {tab === "overview" && <OverviewPanel />}
        {tab === "browse" && <BrowsePanel />}
        {tab === "search" && <SearchPanel />}
        {tab === "audit" && <AuditPanel />}
        {tab === "coldstart" && <ColdStartPanel />}
      </main>
    </div>
  );
}

// ============ 总览 ============

function OverviewPanel() {
  const [stats, setStats] = useState<Record<string, SubStats>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<any>("/knowledge/stats");
      setStats(res.data || res);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalPg = Object.values(stats).reduce((s, v) => s + (v.pgCount || 0), 0);
  const totalVec = Object.values(stats).reduce((s, v) => s + (v.vectorCount || 0), 0);

  return (
    <div className="space-y-8">
      {/* 顶部统计 */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
          <div className="text-xs text-gray-400 mb-1">总条目数</div>
          <div className="text-3xl font-bold text-gray-900">{totalPg}</div>
          <div className="mt-2 h-1 rounded-full bg-gray-100">
            <div className="h-1 rounded-full bg-blue-500" style={{ width: `${Math.min(totalPg / 2, 100)}%` }} />
          </div>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
          <div className="text-xs text-gray-400 mb-1">向量化条目</div>
          <div className="text-3xl font-bold text-blue-600">{totalVec}</div>
          <div className="text-xs text-gray-400 mt-2">
            覆盖率 {totalPg ? Math.round((totalVec / totalPg) * 100) : 0}%
          </div>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
          <div className="text-xs text-gray-400 mb-1">活跃子库</div>
          <div className="text-3xl font-bold text-emerald-600">
            {Object.values(stats).filter((v) => v.pgCount > 0).length}
            <span className="text-base font-normal text-gray-400"> / 16</span>
          </div>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex items-center justify-center">
          <button
            onClick={load}
            disabled={loading}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50 flex items-center gap-2"
          >
            <span className={loading ? "animate-spin" : ""}>{loading ? "⏳" : "🔄"}</span>
            {loading ? "刷新中" : "刷新数据"}
          </button>
        </div>
      </div>

      {/* 向量子库 */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-1 h-5 rounded-full bg-blue-500" />
          <h3 className="text-sm font-semibold text-gray-700">向量子库</h3>
          <span className="text-[11px] text-gray-400">LanceDB · 语义检索</span>
        </div>
        <div className="grid grid-cols-5 gap-3">
          {VECTOR_CATEGORIES.map((c) => {
            const s = stats[c.key];
            const count = s?.pgCount ?? 0;
            return (
              <div
                key={c.key}
                className={`rounded-xl p-4 border transition-all hover:shadow-md cursor-default ${c.color}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xl">{c.icon}</span>
                  {(s?.vectorCount ?? 0) > 0 && (
                    <span className="w-2 h-2 rounded-full bg-green-400" title="已向量化" />
                  )}
                </div>
                <div className="text-xs font-semibold opacity-80 mb-1">{c.label}</div>
                <div className="text-2xl font-bold">{count}</div>
                <div className="text-[10px] opacity-60 mt-1">
                  {s?.vectorCount ?? 0} 条向量
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* PG 子库 */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-1 h-5 rounded-full bg-violet-500" />
          <h3 className="text-sm font-semibold text-gray-700">结构化子库</h3>
          <span className="text-[11px] text-gray-400">PostgreSQL · 关系查询</span>
        </div>
        <div className="grid grid-cols-6 gap-3">
          {PG_CATEGORIES.map((c) => {
            const s = stats[c.key];
            return (
              <div
                key={c.key}
                className="rounded-xl p-4 bg-white border border-gray-100 transition-all hover:shadow-md cursor-default"
              >
                <span className="text-xl">{c.icon}</span>
                <div className="text-xs font-semibold text-gray-500 mt-2 mb-1">{c.label}</div>
                <div className="text-2xl font-bold text-gray-800">{s?.pgCount ?? 0}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============ 浏览 ============

function BrowsePanel() {
  const [category, setCategory] = useState("term");
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await api.get(`/knowledge?category=${category}&limit=50`);
      setEntries(res.data || res.entries || []);
    } catch { /* */ }
    setLoading(false);
  }, [category]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除这条记录？")) return;
    await api.delete(`/knowledge/${id}`);
    load();
  };

  const handleSave = async () => {
    if (!editId) return;
    await api.put(`/knowledge/${editId}`, { title: editTitle, content: editContent });
    setEditId(null);
    load();
  };

  const catInfo = ALL_CATEGORIES.find((c) => c.key === category);

  return (
    <div className="flex gap-6">
      {/* 左侧分区导航 */}
      <div className="w-48 shrink-0 space-y-1">
        <div className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider mb-2 px-3">
          向量子库
        </div>
        {VECTOR_CATEGORIES.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all flex items-center gap-2 ${
              category === c.key
                ? "bg-blue-50 text-blue-700 font-semibold"
                : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
            }`}
          >
            <span>{c.icon}</span> {c.label}
          </button>
        ))}
        <div className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider mt-4 mb-2 px-3">
          结构化子库
        </div>
        {PG_CATEGORIES.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all flex items-center gap-2 ${
              category === c.key
                ? "bg-violet-50 text-violet-700 font-semibold"
                : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
            }`}
          >
            <span>{c.icon}</span> {c.label}
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <span className="text-xl">{catInfo?.icon}</span> {catInfo?.label}
            <span className="text-sm font-normal text-gray-400 ml-1">{entries.length} 条</span>
          </h3>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-gray-400 hover:text-blue-600 transition-colors disabled:opacity-50"
          >
            {loading ? "加载中..." : "🔄 刷新"}
          </button>
        </div>

        {entries.length === 0 && !loading && (
          <div className="text-center py-20 text-gray-300">
            <div className="text-5xl mb-3">{catInfo?.icon}</div>
            <div className="text-sm">暂无数据</div>
          </div>
        )}

        <div className="space-y-2">
          {entries.map((e) => (
            <div key={e.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-shadow">
              {editId === e.id ? (
                <div className="space-y-3">
                  <input
                    value={editTitle}
                    onChange={(ev) => setEditTitle(ev.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                    placeholder="标题"
                  />
                  <textarea
                    value={editContent}
                    onChange={(ev) => setEditContent(ev.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 resize-y"
                  />
                  <div className="flex gap-2">
                    <button onClick={handleSave} className="px-4 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors">
                      保存
                    </button>
                    <button onClick={() => setEditId(null)} className="px-4 py-1.5 text-gray-500 text-xs font-medium rounded-lg hover:bg-gray-100 transition-colors">
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-800 text-sm truncate">{e.title || "(无标题)"}</div>
                      <div className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">{e.content}</div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => { setEditId(e.id); setEditTitle(e.title || ""); setEditContent(e.content); }}
                        className="px-2.5 py-1 text-[11px] text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                      >
                        编辑
                      </button>
                      <button
                        onClick={() => handleDelete(e.id)}
                        className="px-2.5 py-1 text-[11px] text-red-500 hover:bg-red-50 rounded-md transition-colors"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-50">
                    <span className="text-[11px] text-gray-400">
                      {e.vectorId
                        ? <><span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1" />向量化</>
                        : <><span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-300 mr-1" />仅PG</>
                      }
                    </span>
                    <span className="text-[11px] text-gray-300">·</span>
                    <span className="text-[11px] text-gray-400">{e.source || "无来源"}</span>
                    <span className="text-[11px] text-gray-300">·</span>
                    <span className="text-[11px] text-gray-400">{new Date(e.createdAt).toLocaleString("zh-CN")}</span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============ 语义搜索 ============

function SearchPanel() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTime, setSearchTime] = useState(0);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);
    const t0 = Date.now();
    try {
      const res: any = await api.post("/knowledge/search", {
        query: query.trim(),
        category: category || undefined,
        limit: 20,
      });
      setResults(res.results || res.data || []);
      setSearchTime(Date.now() - t0);
    } catch { setResults([]); }
    setLoading(false);
  };

  const quickQueries = [
    "学术论文写作规范",
    "内容审核规则",
    "教育关键词趋势",
    "目标受众分析",
  ];

  return (
    <div className="max-w-4xl mx-auto">
      {/* 搜索区域 */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-lg">🔍</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="输入自然语言查询..."
              className="w-full pl-11 pr-4 py-3.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-200 min-w-[130px]"
          >
            <option value="">全部子库</option>
            {VECTOR_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.icon} {c.label}</option>
            ))}
          </select>
          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-6 py-3 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0"
          >
            {loading ? "搜索中..." : "搜索"}
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <span className="text-[11px] text-gray-400">快速试试</span>
          {quickQueries.map((q) => (
            <button
              key={q}
              onClick={() => setQuery(q)}
              className="text-[11px] px-2.5 py-1 rounded-full bg-gray-50 text-gray-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* 搜索结果 */}
      {results.length > 0 && (
        <div className="text-xs text-gray-400 mb-3 px-1">
          {results.length} 条结果 · {searchTime}ms
        </div>
      )}

      <div className="space-y-3">
        {results.map((r, i) => {
          const catInfo = ALL_CATEGORIES.find((c) => c.key === r.category);
          const pct = Math.round(r.score * 100);
          const ring = pct > 70 ? "text-emerald-500" : pct > 40 ? "text-amber-500" : "text-gray-400";
          return (
            <div key={r.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-shadow flex gap-4">
              {/* 相似度环 */}
              <div className="shrink-0 w-14 flex flex-col items-center justify-center">
                <svg viewBox="0 0 36 36" className="w-12 h-12">
                  <circle cx="18" cy="18" r="16" fill="none" stroke="#f1f5f9" strokeWidth="3" />
                  <circle
                    cx="18" cy="18" r="16" fill="none"
                    className={ring}
                    stroke="currentColor" strokeWidth="3"
                    strokeDasharray={`${pct} ${100 - pct}`}
                    strokeDashoffset="25"
                    strokeLinecap="round"
                  />
                </svg>
                <span className={`text-xs font-bold mt-0.5 ${ring}`}>{pct}%</span>
              </div>

              {/* 内容 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-300 font-mono">#{i + 1}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${catInfo?.color || "bg-gray-50 text-gray-500"}`}>
                    {catInfo?.icon} {catInfo?.label}
                  </span>
                </div>
                <div className="text-sm font-semibold text-gray-800 mb-1">{r.title}</div>
                <div className="text-xs text-gray-500 leading-relaxed line-clamp-2">{r.content}</div>
              </div>
            </div>
          );
        })}
      </div>

      {searched && results.length === 0 && !loading && (
        <div className="text-center py-20">
          <div className="text-4xl mb-3 opacity-30">🔍</div>
          <div className="text-sm text-gray-400">无匹配结果，试试其他关键词</div>
        </div>
      )}

      {!searched && (
        <div className="text-center py-20">
          <div className="text-4xl mb-3 opacity-20">✨</div>
          <div className="text-sm text-gray-300">输入问题，知识库将返回语义最相关的内容</div>
        </div>
      )}
    </div>
  );
}

// ============ 审核入库 ============

function AuditPanel() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("term");
  const [source, setSource] = useState("manual");
  const [result, setResult] = useState<AuditResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleAudit = async () => {
    if (!title.trim() || !content.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post<any>("/knowledge/audit", {
        title: title.trim(), content: content.trim(), category, source,
      });
      setResult(res.data || res);
    } catch (err: any) {
      setResult({ accepted: false, stages: [{ pass: false, stage: "error", reason: err.message }] });
    }
    setLoading(false);
  };

  return (
    <div className="grid grid-cols-2 gap-8">
      {/* 左侧输入 */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-5 flex items-center gap-2">
          <span className="w-1.5 h-5 rounded-full bg-blue-500 inline-block" />
          提交知识条目
        </h3>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">分区</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              {VECTOR_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>{c.icon} {c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">标题</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="如: SCI影响因子解读"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">内容</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={7}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 resize-y"
              placeholder="审核管线将自动判断相关度、质量、去重和时效性..."
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">来源</label>
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="manual / crawl:xxx / http://..."
            />
          </div>

          <button
            onClick={handleAudit}
            disabled={loading || !title.trim() || !content.trim()}
            className="w-full py-3 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {loading ? "⏳ 审核中..." : "🛡️ 提交 5 道审核"}
          </button>
        </div>
      </div>

      {/* 右侧结果 */}
      <div>
        <h3 className="text-base font-semibold text-gray-800 mb-5 flex items-center gap-2">
          <span className="w-1.5 h-5 rounded-full bg-emerald-500 inline-block" />
          审核管线
        </h3>

        {!result && !loading && (
          <div className="bg-gray-50 rounded-2xl border border-dashed border-gray-200 p-8 text-center">
            <div className="flex justify-center gap-3 mb-4 text-xl opacity-50">
              {["🎯", "✨", "📋", "🔍", "⏰"].map((icon, i) => (
                <span key={i}>{icon}</span>
              ))}
            </div>
            <div className="text-sm text-gray-400">
              相关度 → 质量 → 入库原因 → 向量去重 → 时效标记
            </div>
            <div className="text-xs text-gray-300 mt-2">提交内容后自动执行</div>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            {/* 总结 */}
            <div className={`rounded-2xl p-5 flex items-center justify-between ${
              result.accepted
                ? "bg-emerald-50 border border-emerald-200"
                : "bg-red-50 border border-red-200"
            }`}>
              <div className="flex items-center gap-3">
                <span className="text-3xl">{result.accepted ? "✅" : "❌"}</span>
                <div>
                  <div className={`font-bold text-base ${result.accepted ? "text-emerald-700" : "text-red-700"}`}>
                    {result.accepted ? "审核通过，已入库" : "审核未通过"}
                  </div>
                  <div className="text-xs opacity-60 mt-0.5">
                    通过 {result.stages.filter((s) => s.pass).length}/{result.stages.length} 道
                  </div>
                </div>
              </div>
              {result.timeliness && (
                <span className="text-[11px] font-medium px-3 py-1 rounded-full bg-white/80 text-blue-600 border border-blue-100">
                  ⏰ {result.timeliness}
                </span>
              )}
            </div>

            {/* 各 Gate */}
            <div className="space-y-2">
              {result.stages.map((s, i) => (
                <div key={i} className={`rounded-xl p-4 flex items-center gap-3 border transition-all ${
                  s.pass ? "bg-white border-gray-100" : "bg-red-50/50 border-red-100"
                }`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-base ${
                    s.pass ? "bg-emerald-50" : "bg-red-50"
                  }`}>
                    {s.pass ? "✅" : "❌"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                      <span>{STAGE_ICONS[s.stage] || "•"}</span>
                      Gate {i + 1}: {STAGE_LABELS[s.stage] || s.stage}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5 truncate">{s.reason}</div>
                  </div>
                  {s.score !== undefined && (
                    <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                      {(s.score * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 冷启动 ============

function ColdStartPanel() {
  const [industry, setIndustry] = useState("医学");
  const [competitors, setCompetitors] = useState("学术圈日报");
  const [progress, setProgress] = useState<ColdStartProgress | null>(null);
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    setLoading(true);
    setProgress(null);
    try {
      const res = await api.post<any>("/knowledge/cold-start", {
        industry,
        seedCompetitors: competitors.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setProgress(res.data || res);
    } catch (err: any) {
      setProgress({ tenantId: "", currentStep: 0, totalSteps: 6, steps: [], status: "failed", error: err.message });
    }
    setLoading(false);
  };

  const stepIcon = (status: string) => {
    switch (status) {
      case "completed": return "✅";
      case "failed": return "❌";
      case "skipped": return "⏭️";
      case "running": return "⏳";
      default: return "⬜";
    }
  };

  const industries = [
    { value: "医学", icon: "🩺" },
    { value: "教育", icon: "📚" },
    { value: "科技", icon: "💻" },
    { value: "金融", icon: "💰" },
  ];

  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
        <h3 className="text-base font-semibold text-gray-800 mb-1">知识库冷启动</h3>
        <p className="text-xs text-gray-400 mb-6">
          根据行业自动导入术语、红线、受众画像、平台规则等种子知识
        </p>

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">行业</label>
            <div className="flex gap-2">
              {industries.map((ind) => (
                <button
                  key={ind.value}
                  onClick={() => setIndustry(ind.value)}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-medium transition-all border ${
                    industry === ind.value
                      ? "bg-blue-50 border-blue-300 text-blue-700"
                      : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"
                  }`}
                >
                  <span className="text-base block mb-0.5">{ind.icon}</span>
                  {ind.value}
                </button>
              ))}
            </div>
          </div>
          <div className="col-span-2">
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">种子竞品（逗号分隔）</label>
            <input
              value={competitors}
              onChange={(e) => setCompetitors(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              placeholder="学术圈日报, 科研圈"
            />
          </div>
        </div>

        <button
          onClick={handleStart}
          disabled={loading}
          className="px-8 py-3 bg-gradient-to-r from-blue-600 to-violet-600 text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-50 transition-all"
        >
          {loading ? "⏳ 初始化中..." : "🚀 开始冷启动"}
        </button>
      </div>

      {/* 进度 */}
      {progress && (
        <div>
          <div className={`rounded-xl p-4 mb-4 text-sm font-semibold border ${
            progress.status === "completed"
              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
              : progress.status === "failed"
              ? "bg-red-50 border-red-200 text-red-700"
              : "bg-blue-50 border-blue-200 text-blue-700"
          }`}>
            {progress.status === "completed" && "🎉 冷启动完成！知识库已初始化"}
            {progress.status === "failed" && `❌ 失败: ${progress.error}`}
            {progress.status === "running" && "⏳ 执行中..."}
          </div>

          <div className="space-y-2">
            {progress.steps.map((s) => (
              <div key={s.step} className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
                <span className="text-lg">{stepIcon(s.status)}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-700">
                    步骤 {s.step}: {s.name}
                  </div>
                  {s.message && <div className="text-xs text-gray-400 mt-0.5">{s.message}</div>}
                </div>
                {s.itemCount !== undefined && s.itemCount > 0 && (
                  <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full">
                    +{s.itemCount}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
