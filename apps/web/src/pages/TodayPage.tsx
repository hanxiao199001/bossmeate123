/**
 * PR-W2: 今日驾驶舱 — 老板每日工作流统一入口。
 * 早上打开这一页: 今日生成了什么 → 哪些等我动手(抖音点发布/失败重试) → 今天花了多少钱。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";

interface TodayContent {
  id: string;
  type: string;
  title: string | null;
  status: string;
  createdAt: string;
  hasVideo: boolean;
  source: string | null;
}

interface TodayAgentTask {
  id: string;
  platform: string;
  accountName: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

interface TodayAccount {
  id: string;
  platform: string;
  accountName: string;
  publishedToday: number;
  queuedToday: number;
}

interface TodayData {
  date: string;
  contents: TodayContent[];
  agentTasks: TodayAgentTask[];
  accounts: TodayAccount[];
  publishedToday: number;
  spend: { todayCents: number; monthCents: number };
  budget: { dailyLimitYuan?: number; monthlyLimitYuan?: number };
}

const PLATFORM_LABEL: Record<string, string> = { douyin: "抖音", wechat_video: "视频号", wechat: "公众号" };
const CONTENT_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "bg-gray-100 text-gray-600" },
  generating: { label: "生成中", cls: "bg-blue-50 text-blue-600" },
  generated: { label: "已生成", cls: "bg-emerald-50 text-emerald-600" },
  published: { label: "已发布", cls: "bg-indigo-50 text-indigo-600" },
  failed: { label: "失败", cls: "bg-rose-50 text-rose-600" },
  archived: { label: "已归档", cls: "bg-gray-100 text-gray-400" },
};
const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "排队中", cls: "bg-gray-100 text-gray-600" },
  claimed: { label: "执行中", cls: "bg-blue-50 text-blue-600" },
  manual_pending: { label: "待你点发布", cls: "bg-amber-50 text-amber-700 font-semibold" },
  success: { label: "已推送", cls: "bg-emerald-50 text-emerald-600" },
  failed: { label: "失败", cls: "bg-rose-50 text-rose-600" },
  login_expired: { label: "登录失效", cls: "bg-rose-50 text-rose-600" },
  canceled: { label: "已取消", cls: "bg-gray-100 text-gray-400" },
};

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export default function TodayPage() {
  const [data, setData] = useState<TodayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [budgetEditing, setBudgetEditing] = useState(false);
  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<TodayData>("/today");
      setData(res.data ?? null);
      setDaily(res.data?.budget?.dailyLimitYuan ? String(res.data.budget.dailyLimitYuan) : "");
      setMonthly(res.data?.budget?.monthlyLimitYuan ? String(res.data.budget.monthlyLimitYuan) : "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // PR-W3: 一键派发 — 视频→本地Agent(dispatch), 文章→服务器发布(/publish)
  const AGENT_PLATFORMS = new Set(["douyin", "wechat_video"]);
  const [picking, setPicking] = useState<TodayContent | null>(null);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);

  const togglePick = (id: string) => {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const doDispatch = async () => {
    if (!picking || pickedIds.size === 0 || !data) return;
    setDispatching(true);
    setDispatchMsg(null);
    try {
      const picked = data.accounts.filter((a) => pickedIds.has(a.id));
      const agentIds = picked.filter((a) => AGENT_PLATFORMS.has(a.platform)).map((a) => a.id);
      const serverIds = picked.filter((a) => !AGENT_PLATFORMS.has(a.platform)).map((a) => a.id);
      const parts: string[] = [];
      if (agentIds.length > 0) {
        await api.post("/agent-admin/dispatch", { contentId: picking.id, accountIds: agentIds });
        parts.push(`本地Agent ${agentIds.length} 个账号已派单`);
      }
      if (serverIds.length > 0) {
        await api.post("/publish", { contentId: picking.id, accountIds: serverIds });
        parts.push(`服务器发布 ${serverIds.length} 个账号已触发`);
      }
      setDispatchMsg(parts.join(" · ") || "没有可派发的账号");
      setPicking(null);
      setPickedIds(new Set());
      void load();
    } catch (err) {
      setDispatchMsg(`派发失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDispatching(false);
    }
  };

  const saveBudget = async () => {
    setSaving(true);
    try {
      await api.put("/today/budget", {
        dailyLimitYuan: daily ? Number(daily) : undefined,
        monthlyLimitYuan: monthly ? Number(monthly) : undefined,
      });
      setBudgetEditing(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return <div className="p-6 text-sm text-gray-500">加载今日数据…</div>;
  }
  if (!data) {
    return <div className="p-6 text-sm text-gray-500">暂无数据</div>;
  }

  const manualTasks = data.agentTasks.filter((t) => t.status === "manual_pending");
  const failedTasks = data.agentTasks.filter((t) => t.status === "failed" || t.status === "login_expired");
  const articles = data.contents.filter((c) => c.type !== "video");
  const videos = data.contents.filter((c) => c.type === "video");
  const dailyBudget = data.budget.dailyLimitYuan;
  const pct = dailyBudget ? Math.min(100, Math.round(data.spend.todayCents / (dailyBudget * 100) * 100)) : null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* 头部: 日期 + 花费 + 预算 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">今日 · {data.date}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            生成 {data.contents.length} 条 · 发布 {data.publishedToday} 条
            {manualTasks.length > 0 && <span className="text-amber-600 font-medium"> · {manualTasks.length} 条等你点发布</span>}
          </p>
        </div>
        <button onClick={() => void load()} className="text-xs text-indigo-600 hover:underline">刷新</button>
      </div>

      {/* 花费卡 */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-8">
            <div>
              <div className="text-xs text-gray-400">今日消耗</div>
              <div className="text-lg font-bold text-gray-900">¥{yuan(data.spend.todayCents)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">本月消耗</div>
              <div className="text-lg font-bold text-gray-900">¥{yuan(data.spend.monthCents)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">预算</div>
              <div className="text-sm text-gray-700 mt-1">
                {dailyBudget ? `每日 ¥${dailyBudget}` : "未设"}
                {data.budget.monthlyLimitYuan ? ` · 每月 ¥${data.budget.monthlyLimitYuan}` : ""}
              </div>
            </div>
          </div>
          {budgetEditing ? (
            <div className="flex items-center gap-2 text-sm">
              <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="每日(元)" className="w-24 px-2 py-1 border border-gray-200 rounded-lg text-sm" />
              <input value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="每月(元)" className="w-24 px-2 py-1 border border-gray-200 rounded-lg text-sm" />
              <button onClick={() => void saveBudget()} disabled={saving} className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 disabled:opacity-50">{saving ? "保存中…" : "保存"}</button>
              <button onClick={() => setBudgetEditing(false)} className="text-xs text-gray-400 hover:text-gray-600">取消</button>
            </div>
          ) : (
            <button onClick={() => setBudgetEditing(true)} className="text-xs text-indigo-600 hover:underline">设预算</button>
          )}
        </div>
        {pct != null && (
          <div className="mt-3">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${pct >= 100 ? "bg-rose-500" : pct >= 80 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-gray-400 mt-1">已用 {pct}%{pct >= 100 ? " — 超出每日预算, 数字人合成已熔断" : pct >= 80 ? " — 接近每日预算" : ""}</div>
          </div>
        )}
      </div>

      {/* 等你动手 */}
      {(manualTasks.length > 0 || failedTasks.length > 0) && (
        <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-amber-800 mb-2">⚡ 等你动手</h2>
          <div className="space-y-1.5">
            {manualTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm text-gray-800">
                <span className="px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700">{PLATFORM_LABEL[t.platform] ?? t.platform}</span>
                <span className="font-medium">{t.accountName}</span>
                <span className="text-gray-600">内容已填好停在发布页 — 去弹出的浏览器窗口点【发布】</span>
              </div>
            ))}
            {failedTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm text-gray-800">
                <span className="px-1.5 py-0.5 rounded text-xs bg-rose-100 text-rose-700">{PLATFORM_LABEL[t.platform] ?? t.platform}</span>
                <span className="font-medium">{t.accountName}</span>
                <span className="text-rose-600 truncate">{t.status === "login_expired" ? "登录失效, 需在客户机重新扫码" : (t.error ?? "失败")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 账号发布矩阵 */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-800 mb-2">账号矩阵 ({data.accounts.length})</h2>
        {data.accounts.length === 0 ? (
          <div className="text-sm text-gray-400">还没有账号 — 去 <Link to="/accounts" className="text-indigo-600 hover:underline">账号</Link> 页添加</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {data.accounts.map((a) => {
              const idle = a.publishedToday === 0 && a.queuedToday === 0;
              return (
                <div key={a.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${idle ? "border-amber-200 bg-amber-50/40" : "border-gray-100"}`}>
                  <span className="px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600 shrink-0">{PLATFORM_LABEL[a.platform] ?? a.platform}</span>
                  <span className="text-sm text-gray-800 truncate flex-1">{a.accountName}</span>
                  <span className={`text-xs shrink-0 ${idle ? "text-amber-600" : "text-gray-400"}`}>
                    {idle ? "今日空着" : `已发 ${a.publishedToday}${a.queuedToday ? ` · 队列 ${a.queuedToday}` : ""}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dispatchMsg && (
        <div className="text-sm px-4 py-2.5 rounded-xl border border-indigo-100 bg-indigo-50/60 text-indigo-700">{dispatchMsg}</div>
      )}

      {/* 今日内容 */}
      <div className="grid md:grid-cols-2 gap-4">
        {[{ title: `文章 (${articles.length})`, list: articles }, { title: `视频 (${videos.length})`, list: videos }].map((g) => (
          <div key={g.title} className="bg-white border border-gray-100 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-2">{g.title}</h2>
            {g.list.length === 0 ? (
              <div className="text-sm text-gray-400">今日暂无</div>
            ) : (
              <div className="space-y-1">
                {g.list.map((c) => {
                  const st = CONTENT_STATUS[c.status] ?? { label: c.status, cls: "bg-gray-100 text-gray-500" };
                  const isVideo = c.type === "video";
                  const eligible = data.accounts.filter((a) => (isVideo ? AGENT_PLATFORMS.has(a.platform) : !AGENT_PLATFORMS.has(a.platform)));
                  const isPicking = picking?.id === c.id;
                  return (
                    <div key={c.id}>
                      <div className="flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-lg hover:bg-gray-50 group">
                        <span className={`px-1.5 py-0.5 rounded text-xs shrink-0 ${st.cls}`}>{st.label}</span>
                        <Link to={`/content/${c.id}`} className="text-sm text-gray-800 truncate flex-1 group-hover:text-indigo-600">{c.title ?? "(无标题)"}</Link>
                        {(c.status === "generated" || c.status === "draft") && eligible.length > 0 && (
                          <button
                            onClick={() => { setPicking(isPicking ? null : c); setPickedIds(new Set()); }}
                            className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50"
                          >
                            {isPicking ? "收起" : "发布到…"}
                          </button>
                        )}
                      </div>
                      {isPicking && (
                        <div className="ml-2 mb-2 p-3 rounded-lg border border-indigo-100 bg-indigo-50/40">
                          <div className="text-xs text-gray-500 mb-1.5">
                            {isVideo ? "视频走本地 Agent (视频号自动 / 抖音填好后通知你点发布)" : "文章走服务器发布"}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {eligible.map((a) => (
                              <button
                                key={a.id}
                                onClick={() => togglePick(a.id)}
                                className={`text-xs px-2 py-1 rounded-lg border ${pickedIds.has(a.id) ? "border-indigo-500 bg-indigo-600 text-white" : "border-gray-200 bg-white text-gray-700 hover:border-indigo-300"}`}
                              >
                                {PLATFORM_LABEL[a.platform] ?? a.platform} · {a.accountName}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => void doDispatch()}
                            disabled={dispatching || pickedIds.size === 0}
                            className="mt-2 px-3 py-1 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
                          >
                            {dispatching ? "派发中…" : `派发 (${pickedIds.size})`}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 发布任务 */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-gray-800 mb-2">本地 Agent 发布任务 ({data.agentTasks.length})</h2>
        {data.agentTasks.length === 0 ? (
          <div className="text-sm text-gray-400">今日暂无发布任务 — 去 <Link to="/content" className="text-indigo-600 hover:underline">内容管理</Link> 挑内容派发</div>
        ) : (
          <div className="space-y-1">
            {data.agentTasks.map((t) => {
              const st = TASK_STATUS[t.status] ?? { label: t.status, cls: "bg-gray-100 text-gray-500" };
              return (
                <div key={t.id} className="flex items-center gap-2 py-1">
                  <span className={`px-1.5 py-0.5 rounded text-xs shrink-0 ${st.cls}`}>{st.label}</span>
                  <span className="text-xs text-gray-400 shrink-0">{PLATFORM_LABEL[t.platform] ?? t.platform}</span>
                  <span className="text-sm text-gray-800 truncate">{t.accountName}</span>
                  {t.error && t.status !== "manual_pending" && <span className="text-xs text-rose-500 truncate">{t.error}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
