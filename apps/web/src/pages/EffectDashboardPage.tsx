/**
 * 7-18 效果分析 — 真实公众号回流数据的分析看板 (adminOnly)。
 *
 * 数据源: GET /admin/effect-dashboard?days=7|30|90 (纯聚合 content_metrics 真实回流)。
 * 与"价值测算"(/cost-comparison, ROI 测算器/非真数据)区分: 本页全部真实回流, 无数据维度显式空态。
 *
 * 布局: 时间范围切换 → 总览卡 + 覆盖率提示 → 每账号表现表(可排序) → 内容排行榜 →
 *       趋势折线(内联 SVG, 无图表库) → 学科维度(CSS bar)。
 * 反造假: 无回流数据时显示"T+1 回流"引导, 不满屏 0。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import PageHeader from "../components/ui/PageHeader";

type RangeDays = 7 | 30 | 90;

interface Overview {
  totalViews: number;
  totalShares: number;
  totalSaves: number;
  totalFollowers: number;
  totalInquiries: number;
  measuredCount: number;
  publishedCount: number;
  coverageRate: number | null;
  sourceApiCount: number;
  sourceManualCount: number;
}
interface AccountPerformance {
  accountId: string | null;
  accountName: string;
  platform: string;
  publishedCount: number;
  totalViews: number;
  avgViews: number;
  maxViews: number;
}
interface ContentRankItem {
  contentId: string;
  title: string;
  accountName: string;
  platform: string;
  views: number;
  shares: number;
  publishDate: string | null;
}
interface TrendPoint {
  date: string;
  reads: number;
}
interface DisciplineStat {
  discipline: string;
  count: number;
  avgViews: number;
}
interface EffectDashboard {
  rangeDays: RangeDays;
  hasData: boolean;
  overview: Overview;
  accounts: AccountPerformance[];
  ranking: ContentRankItem[];
  trend: TrendPoint[];
  disciplines: DisciplineStat[];
  emptyDimensions: { accounts: boolean; ranking: boolean; trend: boolean; disciplines: boolean };
}

const PLATFORM_LABEL: Record<string, string> = {
  wechat: "公众号", douyin: "抖音", wechat_video: "视频号",
  xiaohongshu: "小红书", zhihu: "知乎", baijiahao: "百家号", toutiao: "头条号",
};
const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

const DISC_LABEL: Record<string, string> = {
  medicine: "医学", psychology: "心理", engineering: "工程", economics: "经管",
  biology: "生物", education: "教育", law: "法学", agriculture: "农林",
  computer: "计算机", environment: "环境", chemistry: "化学", physics: "物理",
};
const discLabel = (d: string) => DISC_LABEL[d] ?? d;

const RANGE_TABS: Array<{ value: RangeDays; label: string }> = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
];

function fmt(n: number): string {
  return n.toLocaleString("zh-CN");
}

type SortKey = "totalViews" | "avgViews" | "publishedCount" | "maxViews";

export default function EffectDashboardPage() {
  const [days, setDays] = useState<RangeDays>(30);
  const [data, setData] = useState<EffectDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("totalViews");

  const reqSeq = useRef(0);
  const load = useCallback(async (d: RangeDays) => {
    const seq = ++reqSeq.current; // codex P2: 快速切区间会并发多请求, 慢的后到会覆盖新的 → 只认最新一次, 丢弃陈旧响应
    setError(false);
    try {
      const res = await api.get<EffectDashboard>(`/admin/effect-dashboard?days=${d}`);
      if (seq !== reqSeq.current) return;
      if (res.data) setData(res.data);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      console.error("效果看板加载失败", err);
      setError(true);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load(days);
  }, [days, load]);

  const ov = data?.overview;

  const sortedAccounts = useMemo(() => {
    if (!data) return [];
    return [...data.accounts].sort((a, b) => b[sortKey] - a[sortKey]);
  }, [data, sortKey]);

  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      <div className="max-w-7xl mx-auto py-6 px-6">
        <PageHeader
          title="效果分析"
          subtitle="真实公众号阅读回流数据 · 证明产品价值 · 反哺选题"
          actions={
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {RANGE_TABS.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setDays(t.value)}
                  className={`px-3 py-1 text-sm rounded-md transition-colors ${
                    days === t.value ? "bg-white text-slate-900 font-medium shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />

        {loading && <div className="py-20 text-center text-slate-400 text-sm">加载中…</div>}

        {!loading && error && (
          <div className="py-20 text-center text-slate-500 text-sm">
            数据加载失败，请稍后重试。
          </div>
        )}

        {/* 全局空态: 完全没有回流数据 */}
        {!loading && !error && data && !data.hasData && (
          <div className="rounded-2xl border border-slate-200 bg-white px-8 py-16 text-center">
            <div className="text-4xl mb-3">📊</div>
            <div className="text-slate-800 font-medium mb-1.5">当前暂无回流数据</div>
            <p className="text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
              内容发布后 <strong>T+1 天</strong>开始回流阅读数据（认证服务号自动回流，未认证订阅号由运营手填）。
              {ov && ov.publishedCount > 0 ? (
                <> 本区间已发布 <strong>{ov.publishedCount}</strong> 篇，等待数据回流后此处将显示表现分析。</>
              ) : (
                <> 先去内容工坊发布内容，明天回来看效果。</>
              )}
            </p>
          </div>
        )}

        {!loading && !error && data && data.hasData && ov && (
          <>
            {/* 总览卡 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
              <StatCard label="总阅读" value={fmt(ov.totalViews)} tone="text-indigo-700" />
              <StatCard label="总分享" value={fmt(ov.totalShares)} />
              <StatCard label="总收藏" value={fmt(ov.totalSaves)} />
              <StatCard label="总新增关注" value={fmt(ov.totalFollowers)} tone="text-green-700" />
              <StatCard label="总咨询" value={fmt(ov.totalInquiries)} tone={ov.totalInquiries > 0 ? "text-amber-600" : undefined} />
            </div>

            {/* 数据覆盖率提示 */}
            <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="text-slate-500">数据覆盖</span>
              <span className="text-slate-800">
                已回流 <strong>{ov.measuredCount}</strong> 篇 / 已发布 <strong>{ov.publishedCount}</strong> 篇
                {ov.coverageRate !== null ? (
                  <span className={`ml-1.5 ${ov.coverageRate >= 80 ? "text-green-600" : ov.coverageRate >= 40 ? "text-amber-600" : "text-red-500"}`}>
                    （覆盖率 {ov.coverageRate}%）
                  </span>
                ) : (
                  <span className="ml-1.5 text-slate-400">（暂无发布记录）</span>
                )}
              </span>
              <span className="text-slate-400 text-xs">
                来源: API 自动回流 {ov.sourceApiCount} · 运营手填 {ov.sourceManualCount}
              </span>
              {ov.coverageRate !== null && ov.coverageRate < 80 && (
                <span className="text-xs text-amber-600">部分内容尚未回流，数据可能不全</span>
              )}
            </div>

            {/* 每账号表现 */}
            <Section title="每账号表现" hint="哪个号运营得好（按所选指标排序）">
              {data.emptyDimensions.accounts ? (
                <EmptyHint text="暂无账号回流数据" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-400 border-b border-slate-100">
                        <th className="py-2 px-3 font-medium">账号</th>
                        <th className="py-2 px-3 font-medium">平台</th>
                        <SortableTh label="发布篇数" active={sortKey === "publishedCount"} onClick={() => setSortKey("publishedCount")} />
                        <SortableTh label="总阅读" active={sortKey === "totalViews"} onClick={() => setSortKey("totalViews")} />
                        <SortableTh label="篇均阅读" active={sortKey === "avgViews"} onClick={() => setSortKey("avgViews")} />
                        <SortableTh label="最高单篇" active={sortKey === "maxViews"} onClick={() => setSortKey("maxViews")} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedAccounts.map((a, i) => (
                        <tr key={a.accountId ?? `p-${i}`} className="border-b border-slate-50 hover:bg-slate-50/50">
                          <td className="py-2 px-3 text-slate-800 font-medium">{a.accountName}</td>
                          <td className="py-2 px-3 text-slate-500">{platformLabel(a.platform)}</td>
                          <td className="py-2 px-3 text-slate-600 text-right">{a.publishedCount}</td>
                          <td className="py-2 px-3 text-slate-900 text-right font-medium">{fmt(a.totalViews)}</td>
                          <td className="py-2 px-3 text-slate-600 text-right">{fmt(a.avgViews)}</td>
                          <td className="py-2 px-3 text-slate-600 text-right">{fmt(a.maxViews)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* 趋势折线 */}
            <Section title="每日阅读趋势" hint={`近 ${days} 天每日新增阅读`}>
              {data.emptyDimensions.trend ? (
                <EmptyHint text="暂无每日增量数据（趋势依赖 API 自动回流的当日增量）" />
              ) : (
                <TrendChart points={data.trend} />
              )}
            </Section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* 内容排行榜 */}
              <Section title="内容排行榜" hint="什么内容最受欢迎（点击看详情）">
                {data.emptyDimensions.ranking ? (
                  <EmptyHint text="暂无内容回流数据" />
                ) : (
                  <ol className="space-y-1.5">
                    {data.ranking.map((c, i) => (
                      <li key={`${c.contentId}-${c.platform}`}>
                        <Link
                          to={`/content/${c.contentId}`}
                          className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 transition-colors"
                        >
                          <span className={`shrink-0 w-5 text-center text-xs font-semibold ${i < 3 ? "text-indigo-600" : "text-slate-300"}`}>{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-slate-800">{c.title}</span>
                          <span className="shrink-0 text-xs text-slate-400">{c.accountName}</span>
                          <span className="shrink-0 text-sm text-slate-900 font-medium tabular-nums w-16 text-right">{fmt(c.views)}</span>
                        </Link>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              {/* 学科维度 */}
              <Section title="学科维度" hint="哪个学科的内容读者爱看（反哺选题）">
                {data.emptyDimensions.disciplines ? (
                  <EmptyHint text="暂无学科维度数据（内容需关联期刊学科）" />
                ) : (
                  <DisciplineBars items={data.disciplines} />
                )}
              </Section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${tone ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function SortableTh({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <th className="py-2 px-3 font-medium text-right">
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-0.5 hover:text-slate-700 ${active ? "text-indigo-600" : ""}`}
      >
        {label}
        <span className="text-[10px]">{active ? "▼" : "⇅"}</span>
      </button>
    </th>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="py-8 text-center text-sm text-slate-400">{text}</div>;
}

/** 内联 SVG 折线图 (无图表库依赖) */
function TrendChart({ points }: { points: TrendPoint[] }) {
  const W = 720, H = 180, PAD_L = 44, PAD_R = 12, PAD_T = 12, PAD_B = 24;
  const max = Math.max(1, ...points.map((p) => p.reads));
  const n = points.length;
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.reads).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(H - PAD_B).toFixed(1)} L${x(0).toFixed(1)},${(H - PAD_B).toFixed(1)} Z`;
  // x 轴稀疏标签: 首/中/尾
  const labelIdx = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="每日阅读趋势折线图">
      {/* 网格线 3 条 + y 轴刻度 */}
      {[0, 0.5, 1].map((t) => {
        const gy = PAD_T + t * (H - PAD_T - PAD_B);
        const val = Math.round(max * (1 - t));
        return (
          <g key={t}>
            <line x1={PAD_L} y1={gy} x2={W - PAD_R} y2={gy} stroke="#eef2f7" strokeWidth={1} />
            <text x={PAD_L - 6} y={gy + 3} textAnchor="end" fontSize={10} fill="#94a3b8">{fmt(val)}</text>
          </g>
        );
      })}
      <path d={area} fill="#6366f1" fillOpacity={0.08} />
      <path d={line} fill="none" stroke="#6366f1" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {labelIdx.map((i) => (
        <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={10} fill="#94a3b8">
          {points[i]?.date.slice(5)}
        </text>
      ))}
    </svg>
  );
}

function DisciplineBars({ items }: { items: DisciplineStat[] }) {
  const max = Math.max(1, ...items.map((d) => d.avgViews));
  return (
    <div className="space-y-2.5">
      {items.map((d) => (
        <div key={d.discipline} className="flex items-center gap-3 text-sm">
          <span className="w-16 shrink-0 text-slate-600">{discLabel(d.discipline)}</span>
          <div className="flex-1 h-5 rounded bg-slate-100 overflow-hidden">
            <div
              className="h-full bg-indigo-400 rounded"
              style={{ width: `${Math.max(4, (d.avgViews / max) * 100)}%` }}
            />
          </div>
          <span className="w-14 shrink-0 text-right text-slate-900 font-medium tabular-nums">{fmt(d.avgViews)}</span>
          <span className="w-10 shrink-0 text-right text-xs text-slate-400">{d.count} 篇</span>
        </div>
      ))}
    </div>
  );
}
