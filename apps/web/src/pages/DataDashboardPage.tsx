import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ============ 类型 ============

interface DashboardData {
  content: { total: number; drafts: number; published: number; reviewing: number };
  tokens: {
    weeklyInput: number; weeklyOutput: number; weeklyTotal: number; weeklyCalls: number;
    trend: Array<{ date: string; tokens: number; calls: number }>;
  };
  knowledge: {
    totalEntries: number; vectorizedEntries: number; activeLibraries: number;
    totalLibraries: number; coverageRate: number;
    breakdown: Record<string, { pgCount: number; vectorCount: number }>;
  };
  resources: { keywords: number; competitors: number };
  recentContents: Array<{
    id: string; title: string; type: string; status: string;
    tokens: number; qualityScore?: number; createdAt: string;
  }>;
}

// ============ 主页面 ============

export default function DataDashboardPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<any>("/dashboard/overview");
      setData(res.data || res);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-gray-400 hover:text-blue-600 transition-colors">
            ← 首页
          </Link>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-lg font-bold text-gray-900">数据看板</span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-blue-600 hover:text-blue-700 disabled:opacity-50"
          >
            {loading ? "刷新中..." : "🔄 刷新"}
          </button>
          <span className="text-sm text-gray-500">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-400 hover:text-red-500 transition-colors">退出</button>
        </div>
      </header>

      <main className="max-w-[1360px] mx-auto px-6 py-6">
        {loading && !data ? (
          <div className="text-center py-32 text-gray-400">加载中...</div>
        ) : data ? (
          <div className="space-y-6">
            {/* Row 1: 核心指标 */}
            <div className="grid grid-cols-5 gap-4">
              <MetricCard
                label="内容总量"
                value={data.content.total}
                sub={`${data.content.published} 已发布`}
                icon="📝"
                color="blue"
              />
              <MetricCard
                label="知识库条目"
                value={data.knowledge.totalEntries}
                sub={`${data.knowledge.vectorizedEntries} 向量化`}
                icon="📚"
                color="violet"
              />
              <MetricCard
                label="活跃子库"
                value={data.knowledge.activeLibraries}
                sub={`/ ${data.knowledge.totalLibraries} 总计`}
                icon="🗃️"
                color="emerald"
              />
              <MetricCard
                label="关键词库"
                value={data.resources.keywords}
                sub="已收录"
                icon="🔑"
                color="amber"
              />
              <MetricCard
                label="本周 AI 调用"
                value={data.tokens.weeklyCalls}
                sub={`${formatTokens(data.tokens.weeklyTotal)} tokens`}
                icon="🤖"
                color="rose"
              />
            </div>

            {/* Row 2: 图表区域 */}
            <div className="grid grid-cols-3 gap-4">
              {/* 知识库覆盖率环形图 */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">知识库健康度</h3>
                <div className="flex items-center justify-center mb-4">
                  <RingChart
                    value={data.knowledge.coverageRate}
                    label="向量覆盖率"
                    size={120}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div>
                    <div className="text-lg font-bold text-blue-600">{data.knowledge.totalEntries}</div>
                    <div className="text-[11px] text-gray-400">总条目</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold text-emerald-600">{data.knowledge.vectorizedEntries}</div>
                    <div className="text-[11px] text-gray-400">已向量化</div>
                  </div>
                </div>
              </div>

              {/* Token 趋势 */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Token 消耗趋势 (7天)</h3>
                {data.tokens.trend.length > 0 ? (
                  <BarChart data={data.tokens.trend} />
                ) : (
                  <div className="text-center py-10 text-gray-300 text-sm">暂无数据</div>
                )}
                <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                  <div>
                    <div className="text-sm font-bold text-gray-700">{formatTokens(data.tokens.weeklyInput)}</div>
                    <div className="text-[11px] text-gray-400">输入</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-gray-700">{formatTokens(data.tokens.weeklyOutput)}</div>
                    <div className="text-[11px] text-gray-400">输出</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-blue-600">{data.tokens.weeklyCalls}</div>
                    <div className="text-[11px] text-gray-400">调用次数</div>
                  </div>
                </div>
              </div>

              {/* 内容状态分布 */}
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">内容状态</h3>
                <div className="space-y-3">
                  <StatusBar label="草稿" count={data.content.drafts} total={data.content.total} color="bg-gray-400" />
                  <StatusBar label="审核中" count={data.content.reviewing} total={data.content.total} color="bg-amber-400" />
                  <StatusBar label="已发布" count={data.content.published} total={data.content.total} color="bg-emerald-500" />
                </div>
                <div className="mt-6 pt-4 border-t border-gray-50">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-gray-800">{data.content.total}</div>
                    <div className="text-xs text-gray-400">内容总量</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Row 3: 知识库子库分布 + 最近内容 */}
            <div className="grid grid-cols-5 gap-4">
              {/* 子库分布 */}
              <div className="col-span-3 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-700">子库数据分布</h3>
                  <Link to="/knowledge" className="text-xs text-blue-600 hover:underline">管理 →</Link>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {Object.entries(data.knowledge.breakdown).map(([key, val]) => {
                    const maxCount = Math.max(...Object.values(data.knowledge.breakdown).map((v) => v.pgCount), 1);
                    const pct = (val.pgCount / maxCount) * 100;
                    return (
                      <div key={key} className="text-center">
                        <div className="h-20 flex items-end justify-center mb-1">
                          <div
                            className="w-6 rounded-t bg-blue-400 transition-all"
                            style={{ height: `${Math.max(pct, 4)}%`, opacity: val.pgCount > 0 ? 1 : 0.2 }}
                          />
                        </div>
                        <div className="text-xs font-bold text-gray-700">{val.pgCount}</div>
                        <div className="text-[10px] text-gray-400 truncate" title={key}>
                          {key.replace(/_/g, " ")}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 最近内容 */}
              <div className="col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-700">最近内容</h3>
                  <Link to="/content" className="text-xs text-blue-600 hover:underline">查看全部 →</Link>
                </div>
                <div className="space-y-3">
                  {data.recentContents.length === 0 && (
                    <div className="text-center py-6 text-gray-300 text-sm">暂无内容</div>
                  )}
                  {data.recentContents.map((c) => (
                    <div key={c.id} className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                        c.status === "published" ? "bg-emerald-50 text-emerald-600" :
                        c.status === "reviewing" ? "bg-amber-50 text-amber-600" :
                        "bg-gray-50 text-gray-400"
                      }`}>
                        {c.qualityScore ?? "--"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-700 truncate">{c.title}</div>
                        <div className="text-[11px] text-gray-400 flex items-center gap-2">
                          <span>{STATUS_LABELS[c.status] || c.status}</span>
                          <span>·</span>
                          <span>{new Date(c.createdAt).toLocaleDateString("zh-CN")}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-32 text-gray-400">加载失败</div>
        )}
      </main>
    </div>
  );
}

// ============ 子组件 ============

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", reviewing: "审核中", approved: "已通过", published: "已发布",
};

function MetricCard({ label, value, sub, icon, color }: {
  label: string; value: number; sub: string; icon: string;
  color: "blue" | "violet" | "emerald" | "amber" | "rose";
}) {
  const bgMap = { blue: "bg-blue-50", violet: "bg-violet-50", emerald: "bg-emerald-50", amber: "bg-amber-50", rose: "bg-rose-50" };
  const textMap = { blue: "text-blue-600", violet: "text-violet-600", emerald: "text-emerald-600", amber: "text-amber-600", rose: "text-rose-600" };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl ${bgMap[color]} flex items-center justify-center text-xl shrink-0`}>
        {icon}
      </div>
      <div>
        <div className={`text-2xl font-bold ${textMap[color]}`}>{value.toLocaleString()}</div>
        <div className="text-[11px] text-gray-400">{label} · {sub}</div>
      </div>
    </div>
  );
}

function RingChart({ value, label, size }: { value: number; label: string; size: number }) {
  const r = (size - 12) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (value / 100) * circumference;
  const color = value > 70 ? "#10b981" : value > 40 ? "#f59e0b" : "#94a3b8";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth="10" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold" style={{ color }}>{value}%</span>
        <span className="text-[10px] text-gray-400">{label}</span>
      </div>
    </div>
  );
}

function BarChart({ data }: { data: Array<{ date: string; tokens: number; calls: number }> }) {
  const maxTokens = Math.max(...data.map((d) => d.tokens), 1);
  return (
    <div className="flex items-end justify-between gap-1" style={{ height: 80 }}>
      {data.map((d, i) => {
        const h = Math.max((d.tokens / maxTokens) * 100, 4);
        const dayLabel = d.date.slice(5); // MM-DD
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full flex items-end justify-center" style={{ height: 60 }}>
              <div
                className="w-full max-w-[20px] rounded-t bg-blue-400 hover:bg-blue-500 transition-all cursor-default"
                style={{ height: `${h}%` }}
                title={`${d.date}: ${d.tokens.toLocaleString()} tokens, ${d.calls} 次`}
              />
            </div>
            <span className="text-[9px] text-gray-400">{dayLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatusBar({ label, count, total, color }: {
  label: string; count: number; total: number; color: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600 font-medium">{label}</span>
        <span className="text-gray-400">{count}</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
