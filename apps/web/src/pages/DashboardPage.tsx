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

  const [hero, setHero] = useState<TodayHero | null>(null);
  const [salesStats, setSalesStats] = useState<SalesStats | null>(null);
  const [recItems, setRecItems] = useState<RecommendationPreview[]>([]);
  const [recTotal, setRecTotal] = useState(0);
  const [recLoading, setRecLoading] = useState(true);
  const [leadItems, setLeadItems] = useState<LeadPreview[]>([]);
  const [leadTotal, setLeadTotal] = useState(0);
  const [leadLoading, setLeadLoading] = useState(true);

  useEffect(() => {
    api.get<{ data?: { todayHero?: TodayHero } }>("/dashboard/overview")
      .then((r) => { const h = (r.data as any)?.todayHero; if (h) setHero(h); })
      .catch(() => {});

    if (SALES_RADAR_ENABLED) {
      api.get<SalesStats>("/sales/stats")
        .then((r) => { if (r.data) setSalesStats(r.data as SalesStats); })
        .catch(() => {});
    }

    api.get<{ data?: { items?: any[] } } | { items?: any[] }>("/content/recommendations?limit=20")
      .then((r) => {
        const items = (r as any).data?.items ?? (r as any).items ?? [];
        setRecTotal(items.length);
        setRecItems(items.map((it: any) => ({
          id: it.id, title: it.title || it.topic || "未命名",
          platform: it.platform ?? null,
          // 5-23 PR Bug #1 fix: API 返回 it.journal.coverImageUrl (LetPub CDN), 老 mapping 漏读
          coverUrl: it.coverUrl ?? it.journal?.coverImageUrl ?? it.journal?.coverUrlHd ?? null,
        })));
      })
      .catch(() => {})
      .finally(() => setRecLoading(false));

    if (!SALES_RADAR_ENABLED) { setLeadLoading(false); return; }
    api.get<{ data?: { items?: SalesLead[]; total?: number } } | { items?: SalesLead[]; total?: number }>("/sales/leads?pageSize=20")
      .then((r) => {
        const items: SalesLead[] = (r as any).data?.items ?? (r as any).items ?? [];
        const total = (r as any).data?.total ?? (r as any).total ?? items.length;
        // 优先 negotiating + qualified, intentScore 高到低
        const ranked = [...items].sort((a, b) => {
          const stageOrder: Record<string, number> = { negotiating: 0, qualified: 1, new: 2, won: 3, lost: 4 };
          const sa = stageOrder[a.stage] ?? 9;
          const sb = stageOrder[b.stage] ?? 9;
          if (sa !== sb) return sa - sb;
          return (b.intentScore ?? 0) - (a.intentScore ?? 0);
        });
        setLeadTotal(total);
        setLeadItems(ranked.map((it) => ({
          id: it.id, name: it.name, stage: it.stage,
          intentScore: it.intentScore, lastMessageAt: it.lastMessageAt,
        })));
      })
      .catch(() => {})
      .finally(() => setLeadLoading(false));
  }, []);

  const todayGenerated = hero?.pipeline24h.articlesGenerated ?? 0;
  const todayPublished = hero?.pipeline24h.articlesPublished ?? 0;
  const weekWarm = salesStats?.weekWarm ?? 0;
  const monthConverted = salesStats?.monthConverted ?? 0;
  const isEmpty = todayGenerated === 0 && todayPublished === 0 && recItems.length === 0 && leadItems.length === 0;

  const salesKpis: KpiItem[] = SALES_RADAR_ENABLED ? [
    {
      key: "warm",
      value: weekWarm,
      label: "活跃热线索",
      hint: "管线里的热客户",
      to: "/sales-radar",
    },
    {
      key: "converted",
      value: monthConverted,
      label: "本月已转化",
      hint: "已成交客户数",
    },
  ] : [];

  const kpis: KpiItem[] = [
    {
      key: "today",
      value: todayGenerated,
      label: "今日产出",
      hint: todayPublished > 0 ? `已发 ${todayPublished} 篇` : "篇图文 / 视频",
      emphasis: true,
    },
    {
      key: "rec",
      value: recTotal,
      label: "待你采用",
      hint: "推荐 → 内容工坊",
      to: "/workbench",
    },
    ...salesKpis,
  ];

  return (
    <div className="max-w-6xl mx-auto py-6 px-6">
      <Greeting userName={user?.name} />

      <KpiStrip items={kpis} />

      <PrimaryActionBar mode={isEmpty ? "empty" : "normal"} />

      <div className={`grid grid-cols-1 gap-4 ${SALES_RADAR_ENABLED ? "lg:grid-cols-2" : ""}`}>
        <RecommendationPanel items={recItems} totalCount={recTotal} loading={recLoading} />
        {SALES_RADAR_ENABLED && <LeadsPanel items={leadItems} totalCount={leadTotal} loading={leadLoading} />}
      </div>

      {/* PR Q.7 B 方案（5-7 user 拍板）：AI 内容工厂 widget 隐藏。FactoryHero 函数定义保留, 不渲染。 */}
      {/* <FactoryHero /> */}
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
