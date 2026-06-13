/**
 * 5-21 P0 全重设计 — Sidebar (全局 MainLayout 包) + Greeting + KpiStrip + PrimaryActionBar + 2 列 (Recommendation/Leads)。
 *
 * 5-21 前的老 hero (HeroSection / Pipeline24hStrip / PreviewCardRow) 已搬出主 render,
 * 老组件文件已于 6-11 施工包A删除 (连同 SmartInput.tsx,审计 2.4 确认零引用)。
 * 本文件下方 WorkflowSection / ToolGrid / FactoryHero / PendingReviewQueue / TopicStrip 函数定义保留作 dead code,
 * 方便 revert 或重新接入；主 render 不再调用。
 */
import { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";
import Greeting from "../components/dashboard/Greeting";
import KpiStrip, { type KpiItem } from "../components/dashboard/KpiStrip";
import PrimaryActionBar from "../components/dashboard/PrimaryActionBar";
import RecommendationPanel, { type RecommendationPreview } from "../components/dashboard/RecommendationPanel";
import LeadsPanel, { type LeadPreview } from "../components/dashboard/LeadsPanel";
import { SALES_RADAR_ENABLED } from "../utils/featureFlags";

// ============ 类型定义 ============

interface TodayHero {
  systemTenantArticlesToday: number;
  pipeline24h: { keywordsCrawled: number; articlesGenerated: number; articlesPublished: number; totalReadsToday: number };
}
interface SalesStats {
  totalLeads: number; unreadLeads: number; needHumanCount: number; humanModeCount: number;
  todayNew: number; weekWarm: number; monthConverted: number;
}
interface SalesLead {
  id: string; name?: string | null; stage: string; intentScore?: number | null; lastMessageAt?: string | null;
}
interface AgentInfo { name: string; displayName: string; status: string }
interface PlanTask { id: string; status: string; type: string; topic: string; platform: string; scheduledPublishAt: string }
interface ReviewItem { id: string; topic: string; status?: string; platform: string; type: string; createdAt: string; summary?: string }
interface Recommendation {
  id: string; keyword: string; trend: string; heatChange: string;
  relatedJournals: Array<{ name: string; impactFactor: number | null; partition: string | null }>;
  reason: string;
}

// ============ 主页面 ============

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  const [today, setToday] = useState<any | null>(null);
  const [roi, setRoi] = useState<any | null>(null);
  const [genNow, setGenNow] = useState(false);

  const load = () => {
    api.get("/today").then((r) => setToday((r.data as any)?.data ?? r.data)).catch(() => {});
    api.get("/today/roi?days=7").then((r) => setRoi((r.data as any)?.data ?? r.data)).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const contents: any[] = today?.contents ?? [];
  const tasks: any[] = today?.agentTasks ?? [];
  const accounts: any[] = today?.accounts ?? [];
  const generatedToday = contents.length;
  const publishedToday = today?.publishedToday ?? 0;
  const needsReview = contents.filter((c) => c.status === "needs_review").length;
  const manualPending = tasks.filter((t) => t.status === "manual_pending").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "login_expired").length;
  const todoCount = needsReview + manualPending + failed;
  const idleAccounts = accounts.filter((a) => (a.publishedToday ?? 0) === 0 && (a.queuedToday ?? 0) === 0).length;
  const spendToday = today?.spend?.todayCents ?? 0;
  const weekViews = roi?.totalViews ?? 0;

  const triggerGenerate = async () => {
    setGenNow(true);
    try {
      await api.post("/today/generate-now", {});
      setTimeout(load, 30000);
    } finally {
      setTimeout(() => setGenNow(false), 30000);
    }
  };

  const summary = generatedToday > 0
    ? `今天已自动生成 ${generatedToday} 条内容${publishedToday > 0 ? `、发布 ${publishedToday} 条` : ""}${todoCount > 0 ? `,有 ${todoCount} 件事等你处理` : "，暂无待办"}。`
    : "今天还没有生成内容 — 可以点下方「立即生成今日内容」,或等每日定时自动生成。";

  return (
    <div className="max-w-4xl mx-auto py-8 px-6">
      <Greeting userName={user?.name} />
      <p className="text-sm text-gray-500 mt-1 mb-6">{summary}</p>

      {/* 老板每日工作流三步 */}
      <div className="grid sm:grid-cols-3 gap-4">
        {/* 第1步: 看产出 */}
        <button onClick={() => navigate("/today")}
          className="text-left bg-white border border-gray-100 rounded-2xl p-5 hover:border-indigo-200 hover:shadow-sm transition-all">
          <div className="text-xs text-indigo-500 font-medium mb-2">第 1 步 · 看产出</div>
          <div className="text-3xl font-bold text-gray-900">{generatedToday}<span className="text-base font-normal text-gray-400 ml-1">条</span></div>
          <div className="text-sm text-gray-500 mt-1">今天生成 · 已发 {publishedToday} 条</div>
          <div className="text-xs text-indigo-600 mt-3">进今日页看明细 →</div>
        </button>

        {/* 第2步: 处理待办 */}
        <button onClick={() => navigate("/today")}
          className={`text-left rounded-2xl p-5 transition-all border ${todoCount > 0 ? "bg-amber-50 border-amber-200 hover:shadow-sm" : "bg-white border-gray-100 hover:border-indigo-200"}`}>
          <div className={`text-xs font-medium mb-2 ${todoCount > 0 ? "text-amber-600" : "text-gray-400"}`}>第 2 步 · 待你处理</div>
          <div className={`text-3xl font-bold ${todoCount > 0 ? "text-amber-700" : "text-gray-900"}`}>{todoCount}<span className="text-base font-normal text-gray-400 ml-1">件</span></div>
          <div className="text-sm text-gray-500 mt-1">
            {todoCount > 0
              ? [needsReview ? `${needsReview} 条待审` : "", manualPending ? `${manualPending} 条待发布` : "", failed ? `${failed} 条失败` : ""].filter(Boolean).join(" · ")
              : "暂无待办,省心"}
          </div>
          <div className={`text-xs mt-3 ${todoCount > 0 ? "text-amber-700 font-medium" : "text-gray-400"}`}>{todoCount > 0 ? "去处理 →" : "都处理完了"}</div>
        </button>

        {/* 第3步: 看效果 */}
        <button onClick={() => navigate("/today")}
          className="text-left bg-white border border-gray-100 rounded-2xl p-5 hover:border-indigo-200 hover:shadow-sm transition-all">
          <div className="text-xs text-emerald-600 font-medium mb-2">第 3 步 · 看效果</div>
          <div className="text-3xl font-bold text-gray-900">¥{(spendToday / 100).toFixed(0)}<span className="text-base font-normal text-gray-400 ml-1">今日花费</span></div>
          <div className="text-sm text-gray-500 mt-1">{weekViews > 0 ? `近7天阅读 ${weekViews.toLocaleString()}` : "发布后填阅读量看 ROI"}</div>
          <div className="text-xs text-emerald-600 mt-3">看花费与 ROI →</div>
        </button>
      </div>

      {/* 账号矩阵提醒 */}
      {idleAccounts > 0 && (
        <div className="mt-4 text-sm text-gray-500 bg-white border border-gray-100 rounded-xl px-4 py-3">
          有 <span className="text-amber-600 font-medium">{idleAccounts}</span> 个账号今天还空着 ——
          <button onClick={() => navigate("/today")} className="text-indigo-600 hover:underline ml-1">去账号矩阵派发内容</button>
        </div>
      )}

      {/* 快捷操作 */}
      <div className="mt-8">
        <div className="text-xs text-gray-400 mb-2">快捷操作</div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void triggerGenerate()} disabled={genNow}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {genNow ? "生成中…稍后刷新" : "立即生成今日内容"}
          </button>
          <button onClick={() => navigate("/workbench")} className="px-4 py-2 rounded-xl border border-gray-200 text-gray-700 text-sm hover:bg-gray-50">去内容工坊精修</button>
          <button onClick={() => navigate("/accounts")} className="px-4 py-2 rounded-xl border border-gray-200 text-gray-700 text-sm hover:bg-gray-50">管理账号</button>
          {isAdmin && <button onClick={() => navigate("/onboarding")} className="px-4 py-2 rounded-xl border border-gray-200 text-gray-700 text-sm hover:bg-gray-50">开通新客户</button>}
        </div>
      </div>
    </div>
  );
}

// ============ 进度步骤类型 ============

interface StepProgress {
  step: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
}

// ============ 1. 工厂指挥中心（Hero） — 5-21 dead code, 函数保留方便 revert ============

function FactoryHero() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [plan, setPlan] = useState<{ tasks?: PlanTask[]; status?: string } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchDone, setLaunchDone] = useState(false);
  const [error, setError] = useState("");

  const [runProgress, setRunProgress] = useState(0);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [showSteps, setShowSteps] = useState(false);

  const fetchData = () => {
    api.get<{ agents: AgentInfo[] }>("/agents/status").then((r) => setAgents(r.data?.agents || [])).catch(() => {});
    api.get<{ plan: any }>("/agents/daily-plan").then((r) => setPlan(r.data?.plan || null)).catch(() => {});
  };

  const isExecuting = plan?.status === "executing";
  useEffect(() => {
    fetchData();
    const interval = isExecuting ? 3_000 : 10_000;
    const id = setInterval(fetchData, interval);
    return () => clearInterval(id);
  }, [isExecuting]);

  const isAnyRunning = agents.some((a) => a.status === "running");
  const hasPlan = plan && plan.tasks && plan.tasks.length > 0;
  const tasks = plan?.tasks || [];
  const published = tasks.filter((t) => t.status === "published").length;
  const reviewing = tasks.filter((t) => t.status === "review" || t.status === "pending_review").length;
  const writing = tasks.filter((t) => t.status === "writing" || t.status === "quality_check").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length;
  const done = published + reviewing + tasks.filter((t) => t.status === "approved").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const stDot: Record<string, string> = { running: "bg-green-500", idle: "bg-gray-300", error: "bg-red-500", paused: "bg-yellow-400" };

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const launchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (launchTimeoutRef.current) { clearTimeout(launchTimeoutRef.current); launchTimeoutRef.current = null; }
  }, []);

  async function handleLaunch() {
    setLaunching(true);
    setError("");
    setRunProgress(0);
    setShowSteps(true);
    setSteps([
      { step: "data-crawl", label: "数据抓取", status: "pending" },
      { step: "keyword-analysis", label: "关键词分析", status: "pending" },
      { step: "knowledge-engine", label: "知识引擎", status: "pending" },
      { step: "content-director", label: "内容规划", status: "pending" },
      { step: "read-plan", label: "读取计划", status: "pending" },
      { step: "queue-tasks", label: "任务排队", status: "pending" },
    ]);

    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (launchTimeoutRef.current) { clearTimeout(launchTimeoutRef.current); launchTimeoutRef.current = null; }

    try {
      await api.post("/agents/orchestrator/trigger", {});
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.get<any>("/agents/orchestrator/progress");
          const d = res.data;
          if (!d || !d.running && !d.done) return;
          setRunProgress(d.progress || 0);
          if (d.steps) setSteps(d.steps);
          if (d.done) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (launchTimeoutRef.current) { clearTimeout(launchTimeoutRef.current); launchTimeoutRef.current = null; }
            setLaunching(false);
            if (d.success) { setRunProgress(100); setLaunchDone(true); } else { setError(d.summary || "执行异常"); }
            setTimeout(fetchData, 500);
            setTimeout(() => setShowSteps(false), 8000);
          }
        } catch { /* 轮询失败不中断 */ }
      }, 500);
      launchTimeoutRef.current = setTimeout(() => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; setLaunching(false); fetchData(); }
        launchTimeoutRef.current = null;
      }, 600_000);
    } catch (err: any) {
      setError(err?.message || "启动失败");
      setLaunching(false);
    }
  }

  // 函数体压缩, render 部分原样 (dead code, 不被主 render 调用)
  void stDot; void isAnyRunning; void hasPlan; void total; void published; void reviewing; void writing; void pending; void failed; void progress;
  void handleLaunch; void launching; void launchDone; void error; void runProgress; void steps; void showSteps;
  return null;
}

// ============ 2. 最近内容 - dead code ============
function PendingReviewQueue() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    api.get<{ items: ReviewItem[]; count: number }>("/agents/review/pending")
      .then((res) => { setItems(res.data?.items || []); setTotal(res.data?.count || 0); })
      .catch(() => {});
  }, []);
  void items; void total; void navigate;
  return null;
}

// ============ 3. 今日选题推荐 - dead code ============
function TopicStrip() {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const navigate = useNavigate();
  useEffect(() => {
    api.get<{ recommendations: Recommendation[] }>("/recommendations/today")
      .then((res) => setRecs(res.data?.recommendations || [])).catch(() => {});
  }, []);
  void recs; void navigate;
  return null;
}

// ============ 4. 工作流入口 - dead code (sidebar 替代) ============
function WorkflowSection() { return null; }

// ============ 5. 工具导航网格 - dead code (sidebar 替代) ============
function ToolGrid() { return null; }

// 引用一次, 让 lint / tsc 不报 unused
void FactoryHero; void PendingReviewQueue; void TopicStrip; void WorkflowSection; void ToolGrid;
void Link;
