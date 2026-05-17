/**
 * 5-21 P3 — 销售雷达 (老板视角): hero 3 大数字 + 5 stage tab + leads 列表。
 * 决策 1: stage map 冷=new / 温=contacted / 热=qualified+negotiating+need_human / 转化=won / 已流失=lost
 * 决策 2: /sales/stats 已扩 todayNew/weekWarm/monthConverted (additive)
 */
import { useEffect, useState, useCallback } from "react";
// 5-21 P0: 顶部 nav 搬 sidebar 后, 本页不再用 Link
import { api } from "../utils/api";

type Tab = "all" | "cold" | "warm" | "hot" | "won" | "lost";

interface SalesStats {
  totalLeads: number;
  unreadLeads: number;
  todayNew: number;
  weekWarm: number;
  monthConverted: number;
}

interface Lead {
  id: string;
  channel: string;
  name: string | null;
  stage: string;
  intentScore: number;
  lastMessageAt: string | null;
  handoverMode: string;
  createdAt: string;
  unreadCount?: number;
}

const TABS: Array<{ key: Tab; label: string; stageQuery: string; muted?: boolean }> = [
  { key: "all", label: "全部", stageQuery: "" },
  { key: "cold", label: "❄ 冷", stageQuery: "new" },
  { key: "warm", label: "温", stageQuery: "contacted" },
  { key: "hot", label: "🔥 热", stageQuery: "qualified,negotiating,need_human" },
  { key: "won", label: "✅ 转化", stageQuery: "won" },
  { key: "lost", label: "已流失", stageQuery: "lost", muted: true },
];

const CHANNEL_ICON: Record<string, string> = {
  comment_wechat: "💬", comment_zhihu: "🔵", dm: "✉️", wechat_work: "🏢", manual: "✋",
};

function scoreBadge(score: number): { icon: string; color: string } {
  if (score >= 70) return { icon: "🔥", color: "text-red-600" };
  if (score >= 40) return { icon: "⚡", color: "text-amber-600" };
  return { icon: "❄", color: "text-blue-500" };
}

function relTime(t: string | null): string {
  if (!t) return "—";
  const d = Date.now() - new Date(t).getTime();
  const h = Math.floor(d / 3_600_000);
  if (h < 1) return "刚刚"; if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

export default function SalesRadarPage() {
  // 5-21 P0: user/logout 已搬 sidebar (MainLayout)

  const [stats, setStats] = useState<SalesStats | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [leadsList, setLeadsList] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<SalesStats>("/sales/stats")
      .then((r) => setStats((r as any).data ?? null))
      .catch(() => setStats(null));
  }, []);

  const loadTab = useCallback((t: Tab) => {
    const sq = TABS.find((x) => x.key === t)?.stageQuery ?? "";
    const url = sq ? `/sales/leads?stage=${encodeURIComponent(sq)}&pageSize=50` : "/sales/leads?pageSize=50";
    setLoading(true);
    api.get<{ items?: Lead[] } | Lead[]>(url)
      .then((r) => {
        const d = (r as any).data;
        const arr = Array.isArray(d) ? d : (Array.isArray(d?.items) ? d.items : (Array.isArray(d?.leads) ? d.leads : []));
        setLeadsList(arr as Lead[]);
      })
      .catch(() => setLeadsList([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 5-21 P0: 顶部 nav 搬 sidebar (MainLayout) */}
      <main className="max-w-6xl mx-auto px-6 py-6 space-y-5">
        {/* Hero 3 大数字 */}
        <section className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-gray-500 mb-1">今日新增</p>
              <p className="text-5xl font-bold text-blue-600">{stats?.todayNew ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">🔥 活跃热线索</p>
              <p className="text-5xl font-bold text-amber-600">{stats?.weekWarm ?? "—"}</p>
              <p className="text-xs text-gray-400 mt-1">当前管线里的热线索</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">本月成交</p>
              <p className="text-5xl font-bold text-emerald-600">{stats?.monthConverted ?? "—"}</p>
            </div>
          </div>
        </section>

        {/* tabs */}
        <div className="flex items-center gap-1 border-b border-gray-200">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                  active ? "border-blue-600 text-blue-700 font-medium"
                    : t.muted ? "border-transparent text-gray-400 hover:text-gray-600"
                    : "border-transparent text-gray-600 hover:text-gray-900"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* 列表 */}
        <section className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          {loading ? (
            <p className="text-center py-12 text-gray-400 text-sm">⏳ 加载中…</p>
          ) : leadsList.length === 0 ? (
            <p className="text-center py-12 text-gray-400 text-sm">该 stage 暂无线索</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">渠道</th>
                  <th className="px-4 py-2 text-left">联系人</th>
                  <th className="px-4 py-2 text-left">阶段</th>
                  <th className="px-4 py-2 text-left">模式</th>
                  <th className="px-4 py-2 text-left">评分</th>
                  <th className="px-4 py-2 text-left">最后消息</th>
                </tr>
              </thead>
              <tbody>
                {leadsList.map((l) => {
                  const sb = scoreBadge(l.intentScore);
                  return (
                    <tr key={l.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2 text-xl">{CHANNEL_ICON[l.channel] || "🌐"}</td>
                      <td className="px-4 py-2 font-medium text-gray-900">{l.name || "—"}</td>
                      <td className="px-4 py-2 text-gray-600">{l.stage}</td>
                      <td className="px-4 py-2"><span className={l.handoverMode === "human" ? "text-purple-600" : "text-gray-500"}>{l.handoverMode === "human" ? "人工" : "AI"}</span></td>
                      <td className={`px-4 py-2 font-semibold ${sb.color}`}>{l.intentScore} {sb.icon}</td>
                      <td className="px-4 py-2 text-gray-400 text-xs">{relTime(l.lastMessageAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  );
}
