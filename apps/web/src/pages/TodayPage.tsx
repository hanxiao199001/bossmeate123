/**
 * PR-W2: 今日驾驶舱 — 老板每日工作流统一入口。
 * 早上打开这一页: 今日生成了什么 → 哪些等我动手(抖音点发布/失败重试) → 今天花了多少钱。
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";
import Greeting from "../components/dashboard/Greeting";
import OnboardingChecklist from "../components/OnboardingChecklist"; // 7-05 老板首登向导

interface TodayContent {
  id: string;
  type: string;
  title: string | null;
  status: string;
  createdAt: string;
  hasVideo: boolean;
  reviewReason?: string | null;
  reviewWeak?: Array<{ label: string; score: number; fixHint: string }>; // 7-05 ① 失败维度+fixHint
  source: string | null;
}

interface TodayAgentTask {
  id: string;
  contentId?: string;
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
  autoDistribute?: boolean; // PR-W6 每日自动分发开关
  publishHealth?: { stuckPending: number; loginExpired: number; failed: number }; // 6-17 #1 发布健康
}

const PLATFORM_LABEL: Record<string, string> = { douyin: "抖音", wechat_video: "视频号", wechat: "公众号" };
const CONTENT_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "bg-gray-100 text-gray-600" },
  generating: { label: "生成中", cls: "bg-blue-50 text-blue-600" },
  generated: { label: "已生成", cls: "bg-emerald-50 text-emerald-600" },
  published: { label: "已发布", cls: "bg-indigo-50 text-indigo-600" },
  needs_review: { label: "待审·质检未过", cls: "bg-amber-50 text-amber-700" },
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

/** PR-W4: 原始报错 → 人话 (老板不需要看堆栈) */
function friendlyError(raw: string | null, status: string): string {
  if (status === "login_expired") return "登录失效 — 需在客户机重新扫码";
  if (!raw) return "失败";
  if (/SingletonLock|Failed to launch the browser process|ProcessSingleton/.test(raw)) return "浏览器启动冲突 (旧版本问题, 已修复, 可忽略)";
  if (/status 须为/.test(raw)) return "服务器版本不匹配 (已修复, 可忽略)";
  if (/fetch failed|ECONNREFUSED|timeout/i.test(raw)) return "网络波动, 可重派";
  return raw.slice(0, 60);
}

export default function TodayPage() {
  const user = useAuthStore((s) => s.user);
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

  // PR-U2: 采用待审内容
  const [approving, setApproving] = useState<string | null>(null);
  const approveContent = async (contentId: string) => {
    setApproving(contentId);
    try {
      await api.post(`/today/approve/${contentId}`, {});
      void load();
    } finally {
      setApproving(null);
    }
  };
  // 7-05 ③: 驳回待审内容(→草稿, 落校准样本)
  const [rejecting, setRejecting] = useState<string | null>(null);
  const rejectContent = async (contentId: string) => {
    const reason = window.prompt("驳回理由(可选, 会记入校准样本):") ?? undefined;
    setRejecting(contentId);
    try {
      await api.post(`/today/reject/${contentId}`, reason ? { reason } : {});
      void load();
    } finally {
      setRejecting(null);
    }
  };

  // PR-W8: 手动触发今日生成
  const [genNow, setGenNow] = useState(false);
  const triggerGenerate = async () => {
    setGenNow(true);
    try {
      await api.post("/today/generate-now", {});
      // 生成异步进行, 30s 后刷新一次
      setTimeout(() => void load(), 30000);
    } finally {
      setTimeout(() => setGenNow(false), 30000);
    }
  };

  // 6-19: 立即配对预览 → 确认分发(= 把每天 07:00 自动分发现在手动跑一次, 仅公众号; 抖音/视频号走手动)
  const isAdmin = !!user && (user.role === "owner" || user.role === "admin");
  const [previewing, setPreviewing] = useState(false);
  const [distributing, setDistributing] = useState(false);
  type PreviewRow = { contentId: string; accountId: string; title: string; accountName: string; discipline: string | null };
  const [preview, setPreview] = useState<null | {
    poolSource: string; poolSize: number; freshCount: number; skippedCount: number;
    fresh: PreviewRow[]; skipped: PreviewRow[]; unmatched: Array<{ title: string; reason: string }>;
  }>(null);
  const openPreview = async () => {
    setPreviewing(true);
    try {
      const res = await api.post<{ data?: unknown }>("/admin/auto-distribute/preview", {});
      setPreview(((res.data as { data?: unknown })?.data ?? res.data) as never);
    } catch (e) {
      alert("配对预览失败：" + ((e as { message?: string })?.message ?? "未知错误"));
    } finally {
      setPreviewing(false);
    }
  };
  const confirmDistribute = async () => {
    if (!preview || preview.fresh.length === 0) return;
    setDistributing(true);
    try {
      const pairs = preview.fresh.map((p) => ({ articleId: p.contentId, accountId: p.accountId }));
      const res = await api.post<{ data?: { queued?: number; skipped?: number } }>("/admin/bulk-distribute", { pairs });
      const d = (res.data as { data?: { queued?: number; skipped?: number } })?.data ?? (res.data as { queued?: number; skipped?: number });
      alert(`已入队 ${d?.queued ?? pairs.length} 个分发任务（${d?.skipped ?? 0} 重复跳过），稍后进各号草稿箱。`);
      setPreview(null);
      setTimeout(() => void load(), 3000);
    } catch (e) {
      alert("分发失败：" + ((e as { message?: string })?.message ?? "未知错误"));
    } finally {
      setDistributing(false);
    }
  };

  // PR-P1: 指标录入
  const [metricFor, setMetricFor] = useState<string | null>(null);
  const [mViews, setMViews] = useState("");
  const [mFollowers, setMFollowers] = useState("");
  const [mInquiries, setMInquiries] = useState("");
  const [mPlatform, setMPlatform] = useState("wechat");
  const [mSaving, setMSaving] = useState(false);
  const saveMetric = async (contentId: string) => {
    setMSaving(true);
    try {
      await api.post("/today/metrics", {
        contentId, accountId: "", platform: mPlatform,
        views: Number(mViews) || 0, followers: Number(mFollowers) || 0, inquiries: Number(mInquiries) || 0,
      });
      setMetricFor(null); setMViews(""); setMFollowers(""); setMInquiries("");
      const r = await api.get("/today/roi?days=7");
      setRoi((r.data as any)?.data ?? r.data);
    } finally { setMSaving(false); }
  };

  // PR-FW3: 资产效果榜
  const [assets, setAssets] = useState<{ templates: Array<{ key: string; label: string; count: number; avgViews: number }>; avatars: Array<{ key: string; label: string; count: number; avgViews: number }> } | null>(null);
  useEffect(() => {
    api.get("/today/asset-performance")
      .then((r) => setAssets((r.data as any)?.data ?? r.data))
      .catch(() => { /* 无数据 */ });
  }, []);

  // PR-P1: ROI 周报
  const [roi, setRoi] = useState<{ rangeDays: number; measuredCount: number; totalViews: number; totalFollowers: number; totalInquiries: number; avgViews: number; topContents: Array<{ contentId: string; title: string | null; views: number; platform: string }> } | null>(null);
  useEffect(() => {
    api.get("/today/roi?days=7")
      .then((r) => setRoi((r.data as any)?.data ?? r.data))
      .catch(() => { /* 无数据 */ });
  }, []);

  // PR-W7: 生成/分发时间设置
  const [times, setTimes] = useState<{ generateTime: string; distributeTime: string } | null>(null);
  const [timeEditing, setTimeEditing] = useState(false);
  const [genT, setGenT] = useState("03:00");
  const [distT, setDistT] = useState("07:00");
  const [timeSaving, setTimeSaving] = useState(false);
  useEffect(() => {
    api.get<{ generateTime: string; distributeTime: string }>("/admin/schedule-times")
      .then((r) => {
        const d = (r.data as any)?.data ?? r.data;
        if (d?.generateTime) { setTimes(d); setGenT(d.generateTime); setDistT(d.distributeTime); }
      })
      .catch(() => { /* 非 admin 等, 不显示 */ });
  }, []);
  const saveTimes = async () => {
    setTimeSaving(true);
    try {
      const r = await api.patch("/admin/schedule-times", { generateTime: genT, distributeTime: distT });
      const d = (r.data as any)?.data ?? r.data;
      if (d?.generateTime) setTimes(d);
      setTimeEditing(false);
    } finally {
      setTimeSaving(false);
    }
  };

  // PR-W6: 每日自动分发开关
  const [autoSaving, setAutoSaving] = useState(false);
  const toggleAutoDistribute = async () => {
    if (!data) return;
    setAutoSaving(true);
    try {
      await api.put("/today/automation", { autoDistribute: !data.autoDistribute });
      void load();
    } finally {
      setAutoSaving(false);
    }
  };

  // PR-W4: 任务收口 — 已发完 / 取消
  const [finishing, setFinishing] = useState<string | null>(null);
  const finishTask = async (id: string, action: "published" | "cancel", contentId?: string, platform?: string) => {
    setFinishing(id);
    try {
      await api.post(`/agent-admin/tasks/${id}/finish`, { action });
      // PR-B2 发布即填: 标记已发完后自动打开填数据框, 把回填并进发布动作
      if (action === "published" && contentId) {
        setMetricFor(contentId);
        if (platform) setMPlatform(platform);
      }
      void load();
    } finally {
      setFinishing(null);
    }
  };

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
  const failedTasks = data.agentTasks.filter((t) => t.status === "failed" || t.status === "login_expired").slice(0, 5);
  const articles = data.contents.filter((c) => c.type !== "video");
  const videos = data.contents.filter((c) => c.type === "video");
  const dailyBudget = data.budget.dailyLimitYuan;
  const pct = dailyBudget ? Math.min(100, Math.round(data.spend.todayCents / (dailyBudget * 100) * 100)) : null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <Greeting userName={user?.name} />
      <OnboardingChecklist />
      {/* 头部: 日期 + 花费 + 预算 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">今日 · {data.date}</h1>
          <p className="text-xs text-gray-400 mt-0.5">老板看板 — 今天产出什么、花了多少、效果如何、要你点什么，一屏看完</p>
          <p className="text-sm text-gray-500 mt-0.5">
            生成 {data.contents.length} 条 · 发布 {data.publishedToday} 条
            {manualTasks.length > 0 && <span className="text-amber-600 font-medium"> · {manualTasks.length} 条等你点发布</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void toggleAutoDistribute()}
            disabled={autoSaving}
            title="开启后每天 07:00 自动把当日推荐按账号领域配对分发到各公众号草稿箱"
            className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${data.autoDistribute ? "border-emerald-500 bg-emerald-50 text-emerald-700 font-medium" : "border-gray-200 text-gray-500 hover:border-gray-300"}`}
          >
            {data.autoDistribute ? "每日自动分发: 开" : "每日自动分发: 关"}
          </button>
          {times && !timeEditing && (
            <button onClick={() => setTimeEditing(true)} title="每日生成与自动分发的执行时间"
              className="text-xs px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:border-gray-300">
              ⏰ 生成 {times.generateTime} · 分发 {times.distributeTime}
            </button>
          )}
          {timeEditing && (
            <span className="flex items-center gap-1.5 text-xs">
              生成 <input type="time" value={genT} onChange={(e) => setGenT(e.target.value)} className="px-1 py-0.5 border border-gray-200 rounded" />
              分发 <input type="time" value={distT} onChange={(e) => setDistT(e.target.value)} className="px-1 py-0.5 border border-gray-200 rounded" />
              <button onClick={() => void saveTimes()} disabled={timeSaving}
                className="px-2 py-0.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">{timeSaving ? "…" : "保存"}</button>
              <button onClick={() => setTimeEditing(false)} className="text-gray-400 hover:text-gray-600">取消</button>
            </span>
          )}
          <button onClick={() => void triggerGenerate()} disabled={genNow}
            title="立即生成一轮今日推荐内容 (不必等定时, 约30秒-1分钟后刷新可见)"
            className="text-xs px-2.5 py-1 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50">
            {genNow ? "生成中…稍后刷新" : "立即生成今日内容"}
          </button>
          {isAdmin && (
            <button onClick={() => void openPreview()} disabled={previewing}
              title="按各账号的国内/国外定位+领域, 把今日已生成的文章配对分发到公众号草稿(先预览再确认; 抖音/视频号不在此, 走手动)"
              className="text-xs px-2.5 py-1 rounded-lg border border-teal-200 text-teal-600 hover:bg-teal-50 disabled:opacity-50">
              {previewing ? "配对中…" : "立即配对分发"}
            </button>
          )}
          <button onClick={() => void load()} className="text-xs text-indigo-600 hover:underline">刷新</button>
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => { if (!distributing) setPreview(null); }}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-gray-900">配对预览</h3>
              <button onClick={() => setPreview(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              今日池 {preview.poolSize} 篇（{preview.poolSource === "system" ? "系统共享池" : "本租户自有池"}） · 将分发 <b className="text-teal-600">{preview.freshCount}</b> 篇 · 已发过跳过 {preview.skippedCount} · 没配上 {preview.unmatched.length}
            </p>
            {preview.fresh.length > 0 ? (
              <div className="border border-gray-100 rounded-lg divide-y mb-4">
                {preview.fresh.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="flex-1 truncate text-gray-800">{p.title || "(无标题)"}</span>
                    <span className="text-gray-300">→</span>
                    <span className="text-teal-700 font-medium whitespace-nowrap">{p.accountName}</span>
                    {p.discipline && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 whitespace-nowrap">{p.discipline}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-400 py-6 text-center">没有可分发的新配对（可能都已发过，或没有定位/领域匹配的号）。</div>
            )}
            {preview.unmatched.length > 0 && (
              <details className="mb-4 text-xs">
                <summary className="cursor-pointer text-amber-600">{preview.unmatched.length} 篇没配上号（点开看原因）</summary>
                <div className="mt-2 space-y-1">
                  {preview.unmatched.map((u, i) => (
                    <div key={i} className="text-gray-500"><span className="text-gray-700">{u.title || "(无标题)"}</span> — {u.reason}</div>
                  ))}
                </div>
              </details>
            )}
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setPreview(null)} disabled={distributing} className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">取消</button>
              <button onClick={() => void confirmDistribute()} disabled={distributing || preview.fresh.length === 0}
                className="px-5 py-2 text-sm rounded-lg bg-teal-600 text-white font-medium hover:bg-teal-700 disabled:opacity-50">
                {distributing ? "分发中…" : `确认分发 ${preview.freshCount} 篇`}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* 6-17 #1 发布健康告警: 派了却发不出的主动提示 */}
      {data.publishHealth && (data.publishHealth.stuckPending > 0 || data.publishHealth.loginExpired > 0) && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-rose-700 mb-1.5">🔴 发布异常 — 有内容没能发出去</h2>
          <div className="text-sm text-rose-700/90 space-y-1">
            {data.publishHealth.stuckPending > 0 && (
              <div>· <b>{data.publishHealth.stuckPending}</b> 条任务超过 10 分钟没被领取 — 多半是客户电脑的 Agent 没开机或掉线，请提醒客户启动 Agent。</div>
            )}
            {data.publishHealth.loginExpired > 0 && (
              <div>· <b>{data.publishHealth.loginExpired}</b> 条任务登录态失效 — 到 <Link to="/accounts" className="text-indigo-600 hover:underline">账号矩阵</Link> 重新扫码登录。</div>
            )}
            {data.publishHealth.failed > 0 && (
              <div className="text-rose-600/70">· 另有 {data.publishHealth.failed} 条发布失败，见下方任务列表。</div>
            )}
          </div>
        </div>
      )}

      {/* 等你动手 */}
      {(manualTasks.length > 0 || failedTasks.length > 0) && (
        <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-amber-800 mb-2">⚡ 等你动手</h2>
          <div className="space-y-1.5">
            {manualTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm text-gray-800 min-w-0">
                <span className="px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700 shrink-0">{PLATFORM_LABEL[t.platform] ?? t.platform}</span>
                <span className="font-medium shrink-0 whitespace-nowrap">{t.accountName}</span>
                <span className="text-gray-600 truncate min-w-0 flex-1">已填好停在发布页 — 去浏览器点【发布】</span>
                <button onClick={() => void finishTask(t.id, "published", t.contentId, t.platform)} disabled={finishing === t.id}
                  className="shrink-0 text-xs px-2 py-0.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">已发完 ✓</button>
                <button onClick={() => void finishTask(t.id, "cancel")} disabled={finishing === t.id}
                  className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50">取消</button>
              </div>
            ))}
            {failedTasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm text-gray-800 min-w-0">
                <span className="px-1.5 py-0.5 rounded text-xs bg-rose-100 text-rose-700 shrink-0">{PLATFORM_LABEL[t.platform] ?? t.platform}</span>
                <span className="font-medium shrink-0 whitespace-nowrap">{t.accountName}</span>
                <span className="text-rose-600 truncate min-w-0 flex-1">{friendlyError(t.error, t.status)}</span>
                <button onClick={() => void finishTask(t.id, "cancel")} disabled={finishing === t.id}
                  className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50">忽略</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PR-P1: ROI 周报 */}
      <div className="bg-white border border-gray-100 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-800">近 7 天效果 (ROI)</h2>
          <span className="text-xs text-gray-400">{roi?.measuredCount ? `已回收 ${roi.measuredCount} 篇数据` : "暂无回收数据 — 运营在内容详情页填阅读量后显示"}</span>
        </div>
        {roi && roi.measuredCount > 0 ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: "总阅读", v: roi.totalViews },
                { label: "篇均阅读", v: roi.avgViews },
                { label: "涨粉", v: roi.totalFollowers },
                { label: "咨询线索", v: roi.totalInquiries },
              ].map((m) => (
                <div key={m.label} className="bg-gray-50 rounded-lg px-3 py-2">
                  <div className="text-xs text-gray-400">{m.label}</div>
                  <div className="text-lg font-bold text-gray-900">{m.v.toLocaleString()}</div>
                </div>
              ))}
            </div>
            {roi.topContents.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-gray-400 mb-1">本周 Top 内容</div>
                <div className="space-y-1">
                  {roi.topContents.map((c) => (
                    <Link key={c.contentId} to={`/content/${c.contentId}`} className="flex items-center gap-2 text-sm hover:bg-gray-50 px-2 -mx-2 py-0.5 rounded">
                      <span className="text-xs text-gray-400 shrink-0">{PLATFORM_LABEL[c.platform] ?? c.platform}</span>
                      <span className="text-gray-800 truncate flex-1">{c.title ?? "(无标题)"}</span>
                      <span className="text-xs text-indigo-600 shrink-0">{c.views.toLocaleString()} 阅读</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-gray-400">发布后,运营把各平台后台的阅读量填回内容详情页,这里就能看到效果汇总和续费依据。</div>
        )}
      </div>

      {/* PR-FW3: 模板效果榜 (数据足够才显示) */}
      {assets && (assets.templates.length > 0 || assets.avatars.length > 0) && (
        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-gray-800 mb-2">哪种内容更受欢迎 (近期成熟数据)</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {assets.templates.length > 0 && (
              <div>
                <div className="text-xs text-gray-400 mb-1">图文模板 · 平均阅读</div>
                <div className="space-y-1">
                  {assets.templates.map((t, i) => (
                    <div key={t.key} className="flex items-center gap-2 text-sm">
                      <span className={`w-4 text-xs ${i === 0 ? "text-amber-500" : "text-gray-300"}`}>{i === 0 ? "★" : i + 1}</span>
                      <span className="text-gray-700 flex-1 truncate">{t.label}</span>
                      <span className="text-xs text-gray-400">{t.count}篇</span>
                      <span className="text-indigo-600 font-medium">{t.avgViews.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {assets.avatars.length > 0 && (
              <div>
                <div className="text-xs text-gray-400 mb-1">数字人形象 · 平均播放</div>
                <div className="space-y-1">
                  {assets.avatars.map((t, i) => (
                    <div key={t.key} className="flex items-center gap-2 text-sm">
                      <span className={`w-4 text-xs ${i === 0 ? "text-amber-500" : "text-gray-300"}`}>{i === 0 ? "★" : i + 1}</span>
                      <span className="text-gray-700 flex-1 truncate">{t.label}</span>
                      <span className="text-xs text-gray-400">{t.count}条</span>
                      <span className="text-indigo-600 font-medium">{t.avgViews.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-2">系统会自动多用表现好的配方/模板。数据越多越准。</div>
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
                        {c.status === "needs_review" && c.reviewReason && (
                          <span className="shrink-0 max-w-[260px] truncate text-xs text-amber-600" title={c.reviewReason}>⚠ {c.reviewReason}</span>
                        )}
                        {c.status === "needs_review" && (
                          <button
                            onClick={() => void approveContent(c.id)}
                            disabled={approving === c.id}
                            title="质检未过, 看过没问题就采用 (转为可发, 并记为校准样本)"
                            className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                          >
                            {approving === c.id ? "…" : "采用"}
                          </button>
                        )}
                        {c.status === "needs_review" && (
                          <button
                            onClick={() => void rejectContent(c.id)}
                            disabled={rejecting === c.id}
                            title="退回草稿, 并记为校准样本(评分器偏松证据)"
                            className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {rejecting === c.id ? "…" : "驳回"}
                          </button>
                        )}
                        {c.status === "generated" && eligible.length > 0 && (
                          <button
                            onClick={() => { setPicking(isPicking ? null : c); setPickedIds(new Set()); }}
                            className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50"
                          >
                            {isPicking ? "收起" : "发布到…"}
                          </button>
                        )}
                        <button
                          onClick={() => setMetricFor(metricFor === c.id ? null : c.id)}
                          title="录入该内容的阅读量等效果数据"
                          className="shrink-0 text-xs px-2 py-0.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                        >
                          填数据
                        </button>
                      </div>
                      {c.status === "needs_review" && c.reviewWeak && c.reviewWeak.length > 0 && (
                        <div className="ml-2 mb-2 p-2.5 rounded-lg border border-amber-100 bg-amber-50/60 space-y-1">
                          <div className="text-[11px] font-medium text-amber-700">六维失败维度 · 改这些再采用</div>
                          {c.reviewWeak.map((w, i) => (
                            <div key={i} className="text-[11px] text-gray-600 leading-relaxed">
                              <span className="font-medium text-amber-700">{w.label} {w.score}/10</span>
                              {w.fixHint ? <span className="text-gray-500"> → {w.fixHint}</span> : null}
                            </div>
                          ))}
                        </div>
                      )}
                      {metricFor === c.id && (
                        <div className="ml-2 mb-2 p-3 rounded-lg border border-gray-200 bg-gray-50 flex flex-wrap items-end gap-2">
                          <select value={mPlatform} onChange={(e) => setMPlatform(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg">
                            <option value="wechat">公众号</option>
                            <option value="douyin">抖音</option>
                            <option value="wechat_video">视频号</option>
                          </select>
                          <label className="text-xs text-gray-500">阅读<input value={mViews} onChange={(e) => setMViews(e.target.value)} className="ml-1 w-16 px-1 py-1 border border-gray-200 rounded" /></label>
                          <label className="text-xs text-gray-500">涨粉<input value={mFollowers} onChange={(e) => setMFollowers(e.target.value)} className="ml-1 w-14 px-1 py-1 border border-gray-200 rounded" /></label>
                          <label className="text-xs text-gray-500">咨询<input value={mInquiries} onChange={(e) => setMInquiries(e.target.value)} className="ml-1 w-12 px-1 py-1 border border-gray-200 rounded" /></label>
                          <button onClick={() => void saveMetric(c.id)} disabled={mSaving} className="text-xs px-3 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">{mSaving ? "…" : "保存"}</button>
                        </div>
                      )}
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
          <div className="text-sm text-gray-400">今日暂无发布任务 — 去 <Link to="/workbench" className="text-indigo-600 hover:underline">内容工坊</Link> 挑内容派发</div>
        ) : (
          <div className="space-y-1">
            {data.agentTasks.map((t) => {
              const st = TASK_STATUS[t.status] ?? { label: t.status, cls: "bg-gray-100 text-gray-500" };
              return (
                <div key={t.id} className="flex items-center gap-2 py-1 min-w-0">
                  <span className={`px-1.5 py-0.5 rounded text-xs shrink-0 ${st.cls}`}>{st.label}</span>
                  <span className="text-xs text-gray-400 shrink-0">{PLATFORM_LABEL[t.platform] ?? t.platform}</span>
                  <span className="text-sm text-gray-800 shrink-0 whitespace-nowrap">{t.accountName}</span>
                  {(t.status === "failed" || t.status === "login_expired") && <span className="text-xs text-rose-500 truncate min-w-0 flex-1">{friendlyError(t.error, t.status)}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
