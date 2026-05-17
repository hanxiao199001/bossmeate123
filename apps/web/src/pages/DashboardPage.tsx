import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
// 5-17 P0: SmartInput 从主 render 砍出，P3 chat 抽屉重新接入时再 import
// import SmartInput from "../components/SmartInput";
import { api } from "../utils/api";
// 5-17 P0 hero
import HeroSection from "../components/dashboard/HeroSection";
import Pipeline24hStrip from "../components/dashboard/Pipeline24hStrip";
import PreviewCardRow, { type LatestArticle, type RecentPublished } from "../components/dashboard/PreviewCardRow";
import { loadInputs as loadCostInputs, computeMetrics } from "../utils/cost-comparison";

// 5-17 P0 hero: /dashboard/overview todayHero 数据形状
interface TodayHero {
  systemTenantArticlesToday: number;
  pipeline24h: { keywordsCrawled: number; articlesGenerated: number; articlesPublished: number; totalReadsToday: number };
  latestArticlePreview: LatestArticle | null;
  recentPublished: RecentPublished[];
}

// ============ 类型定义 ============

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
  const logout = useAuthStore((s) => s.logout);

  // 5-17 P0: 问候 / 日期已移入 <HeroSection /> 内部 (todayLabel + 接 userName)，主 render 不再用 greeting/dateStr

  // 5-17 P0 hero: 拉 todayHero + 算 ROI/月省 (localStorage cost inputs)
  const [hero, setHero] = useState<TodayHero | null>(null);
  useEffect(() => {
    api.get<{ data?: { todayHero?: TodayHero } }>("/dashboard/overview")
      .then((r) => { const h = (r.data as any)?.todayHero; if (h) setHero(h); })
      .catch(() => { /* 静默, hero 用 fallback 渲染 */ });
  }, []);
  const costMetrics = useMemo(() => computeMetrics(loadCostInputs()), []);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航 (5-17 P0: 加首页/推荐 feed 导航链接，方便老板 demo 切换) */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-5">
          <span className="text-lg font-bold text-blue-600">BossMate</span>
          <span className="text-xs text-gray-400">AI超级员工</span>
          <Link to="/" className="text-sm font-medium text-blue-600">首页</Link>
          <Link to="/recommendations" className="text-sm text-gray-600 hover:text-gray-900">📰 推荐 feed</Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">
            退出
          </button>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto py-6 px-6">
        {/* 5-17 P0 hero: 3 大数字 + 双 CTA */}
        <HeroSection
          systemArticlesToday={hero?.systemTenantArticlesToday ?? 0}
          monthlySavings={costMetrics.savePerMonth}
          roiMultiple={costMetrics.roiMultiple}
          userName={user?.name}
        />

        {/* 5-17 P0: 24h pipeline 状态条 */}
        <Pipeline24hStrip
          keywordsCrawled={hero?.pipeline24h.keywordsCrawled ?? 0}
          articlesGenerated={hero?.pipeline24h.articlesGenerated ?? 0}
          articlesPublished={hero?.pipeline24h.articlesPublished ?? 0}
          totalReadsToday={hero?.pipeline24h.totalReadsToday ?? 0}
        />

        {/* 5-17 P0: 3 列预览卡 */}
        <PreviewCardRow
          latestArticle={hero?.latestArticlePreview ?? null}
          recentPublished={hero?.recentPublished ?? []}
          monthlySavings={costMetrics.savePerMonth}
          roiMultiple={costMetrics.roiMultiple}
        />

        {/* PR Q.7 B 方案（5-7 user 拍板）：AI 内容工厂 widget 隐藏，V3 batch agent 默认关闭。
            FactoryHero 组件保留代码（不删），后续如需重启 V3 batch 可解注释 + 设 V3_BATCH_AGENT_ENABLED=true。 */}
        {/* <FactoryHero /> */}

        {/* 5-17 P0: 砍 <PendingReviewQueue /> / <TopicStrip /> / <SmartInput /> 出主 render
            (函数定义保留, P1 工坊 / P2 风控 / P3 chat 抽屉会重新接入) */}

        {/* 工作流入口：图文 / 视频 / AI 销售 */}
        <WorkflowSection />

        {/* 工具导航（5-17 P0: 缩水到 admin 必要项，砍其余 8 个 tile） */}
        <ToolGrid />
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

// ============ 1. 工厂指挥中心（Hero） ============

function FactoryHero() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [plan, setPlan] = useState<{ tasks?: PlanTask[]; status?: string } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchDone, setLaunchDone] = useState(false);
  const [error, setError] = useState("");

  // 实时进度状态
  const [runProgress, setRunProgress] = useState(0);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [showSteps, setShowSteps] = useState(false);

  const fetchData = () => {
    api.get<{ agents: AgentInfo[] }>("/agents/status").then((r) => setAgents(r.data?.agents || [])).catch(() => {});
    api.get<{ plan: any }>("/agents/daily-plan").then((r) => setPlan(r.data?.plan || null)).catch(() => {});
  };

  // plan 执行中时加快轮询（3s），否则 10s
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
  // 进度 = 已完成写作的任务（review + approved + published）/ 总数
  const done = published + reviewing + tasks.filter((t) => t.status === "approved").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const stDot: Record<string, string> = { running: "bg-green-500", idle: "bg-gray-300", error: "bg-red-500", paused: "bg-yellow-400" };

  // 轮询进度：必须用 useRef，否则每次 render 都会新建对象，clearInterval 指向错乱
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const launchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 组件卸载时清理所有定时器，避免泄漏与状态竞争
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

    // 先清理上一次的定时器（用户连续点击启动时）
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (launchTimeoutRef.current) { clearTimeout(launchTimeoutRef.current); launchTimeoutRef.current = null; }

    try {
      // 1. 触发执行（立即返回）
      await api.post("/agents/orchestrator/trigger", {});

      // 2. 开始轮询进度（每 500ms）
      pollRef.current = setInterval(async () => {
        try {
          const res = await api.get<any>("/agents/orchestrator/progress");
          const d = res.data;
          if (!d || !d.running && !d.done) return;

          // 更新进度条
          setRunProgress(d.progress || 0);

          // 更新步骤状态
          if (d.steps) {
            setSteps(d.steps);
          }

          // 执行完成
          if (d.done) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            if (launchTimeoutRef.current) { clearTimeout(launchTimeoutRef.current); launchTimeoutRef.current = null; }
            setLaunching(false);

            if (d.success) {
              setRunProgress(100);
              setLaunchDone(true);
            } else {
              setError(d.summary || "执行异常");
            }

            // 刷新数据，3秒后收起
            setTimeout(fetchData, 500);
            setTimeout(() => setShowSteps(false), 8000);
          }
        } catch {
          // 轮询失败不中断，下次重试
        }
      }, 500);

      // 安全超时：10分钟后停止轮询（含数据抓取，耗时较长）；timeout 句柄放进 ref 以便 unmount 清理
      launchTimeoutRef.current = setTimeout(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setLaunching(false);
          fetchData();
        }
        launchTimeoutRef.current = null;
      }, 600_000);

    } catch (err: any) {
      setError(err?.message || "启动失败");
      setLaunching(false);
    }
  }

  const stepIcon = (status: StepProgress["status"]) => {
    switch (status) {
      case "completed":
        return (
          <span className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>
        );
      case "running":
        return (
          <span className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center animate-pulse">
            <span className="w-2 h-2 rounded-full bg-white" />
          </span>
        );
      case "failed":
        return (
          <span className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        );
      default:
        return <span className="w-5 h-5 rounded-full bg-gray-200 border-2 border-gray-300" />;
    }
  };

  return (
    <div className="mb-6 bg-white rounded-2xl border border-gray-200 overflow-hidden">
      {/* 顶栏：标题 + 按钮 */}
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">AI 内容工厂</h2>
            {hasPlan ? (
              <p className="text-xs text-gray-400">{total} 个任务 · {progress}% 完成</p>
            ) : (
              <p className="text-xs text-gray-400">知识抓取 → AI选题 → 并发写作 → 多平台发布</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Agent 状态点 */}
          <div className="hidden md:flex items-center gap-2">
            {agents.map((a) => (
              <span key={a.name} className="flex items-center gap-1" title={a.displayName}>
                <span className={`w-2 h-2 rounded-full ${stDot[a.status] || "bg-gray-300"} ${a.status === "running" ? "animate-pulse" : ""}`} />
                <span className="text-xs text-gray-400">{a.displayName}</span>
              </span>
            ))}
          </div>

          <button
            onClick={handleLaunch}
            disabled={launching || isAnyRunning}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              launching || isAnyRunning
                ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                : hasPlan
                  ? "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  : "bg-blue-600 text-white hover:bg-blue-700 active:scale-95"
            }`}
          >
            {launching ? "执行中..." : isAnyRunning ? "运行中" : launchDone ? "已启动" : hasPlan ? "重新执行" : "一键启动"}
          </button>
        </div>
      </div>

      {/* 实时执行进度（执行过程中显示） */}
      {showSteps && (
        <div className="px-5 pb-4">
          {/* 总进度条 */}
          <div className="mb-3">
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${runProgress}%`,
                  background: error
                    ? "linear-gradient(90deg, #3b82f6, #ef4444)"
                    : runProgress >= 100
                      ? "linear-gradient(90deg, #3b82f6, #22c55e)"
                      : "linear-gradient(90deg, #3b82f6, #60a5fa)",
                }}
              />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-xs text-gray-400">
                {runProgress >= 100 ? "执行完成" : launching ? "正在执行..." : "准备中"}
              </span>
              <span className="text-xs text-gray-400">{runProgress}%</span>
            </div>
          </div>

          {/* 步骤列表 */}
          <div className="flex items-center gap-1">
            {steps.map((s, i) => (
              <div key={s.step} className="flex items-center">
                <div className="flex items-center gap-1.5" title={s.error || ""}>
                  {stepIcon(s.status)}
                  <span className={`text-xs font-medium ${
                    s.status === "completed" ? "text-green-600" :
                    s.status === "running" ? "text-blue-600" :
                    s.status === "failed" ? "text-red-500" :
                    "text-gray-400"
                  }`}>
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div className={`w-6 h-px mx-1.5 ${
                    s.status === "completed" ? "bg-green-300" : "bg-gray-200"
                  }`} />
                )}
              </div>
            ))}
          </div>

          {/* 错误提示（在步骤下方） */}
          {error && (
            <div className="mt-2 px-3 py-1.5 bg-red-50 border border-red-100 rounded-lg">
              <p className="text-xs text-red-600">{error}</p>
            </div>
          )}
        </div>
      )}

      {/* 进度条（有计划时显示，不在执行时） */}
      {hasPlan && !showSteps && (
        <>
          <div className="px-5">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-700"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* 数据行 */}
          <div className="px-5 py-3 flex items-center gap-6 border-t border-gray-50 mt-3">
            {[
              { n: published, l: "已发布", c: "text-green-600", bg: "bg-green-50" },
              { n: reviewing, l: "待审核", c: "text-amber-600", bg: "bg-amber-50" },
              { n: writing, l: "写作中", c: "text-blue-600", bg: "bg-blue-50" },
              { n: pending, l: "排队中", c: "text-gray-500", bg: "bg-gray-50" },
              ...(failed > 0 ? [{ n: failed, l: "失败", c: "text-red-500", bg: "bg-red-50" }] : []),
            ].map((s) => (
              <div key={s.l} className="flex items-center gap-2">
                <span className={`text-base font-bold ${s.c}`}>{s.n}</span>
                <span className="text-xs text-gray-400">{s.l}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 非执行期间的错误提示 */}
      {error && !showSteps && <div className="px-5 pb-3 text-xs text-red-500">{error}</div>}
    </div>
  );
}

// ============ 2. 最近内容 + 内容快捷入口 ============

function PendingReviewQueue() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ items: ReviewItem[]; count: number }>("/agents/review/pending")
      .then((res) => {
        setItems(res.data?.items || []);
        setTotal(res.data?.count || 0);
      })
      .catch((err) => { console.warn("内容查询失败:", err); })
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  const statusLabels: Record<string, string> = {
    draft: "草稿", reviewing: "待审核", approved: "已通过", published: "已发布",
  };
  const statusColors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-600",
    reviewing: "bg-amber-100 text-amber-700",
    approved: "bg-green-100 text-green-700",
    published: "bg-blue-100 text-blue-700",
  };
  const platformNames: Record<string, string> = {
    xiaohongshu: "小红书", zhihu: "知乎", wechat: "公众号", douyin: "抖音", toutiao: "头条",
  };

  const displayed = items.slice(0, 4);

  return (
    <div className="mb-6">
      {/* 标题 — 始终显示 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-gray-900">最近内容</h2>
          {total > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded-md">{total}</span>
          )}
        </div>
        <button
          onClick={() => navigate("/content")}
          className="text-xs text-gray-400 hover:text-blue-500 transition"
        >
          内容管理 &rarr;
        </button>
      </div>

      {/* 有内容时显示卡片 */}
      {total > 0 ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {displayed.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(`/content/${item.id}`)}
              className="text-left bg-white rounded-xl border border-gray-200 p-4 hover:border-blue-300 hover:shadow-sm transition-all group"
            >
              <p className="text-sm font-medium text-gray-800 line-clamp-2 mb-2 group-hover:text-blue-700 transition-colors">
                {item.topic}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-1.5 py-0.5 rounded ${statusColors[item.status || "draft"] || "bg-gray-100 text-gray-500"}`}>
                  {statusLabels[item.status || "draft"] || item.status}
                </span>
                <span className="text-xs text-gray-300">{item.type === "article" ? "图文" : "视频"}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        /* 没有内容时显示空状态 */
        <div
          className="bg-white rounded-xl border border-dashed border-gray-200 p-6 text-center cursor-pointer hover:border-blue-300 hover:bg-blue-50/30 transition-all"
          onClick={() => navigate("/content")}
        >
          <div className="text-2xl mb-2">📭</div>
          <p className="text-sm text-gray-500">
            暂无内容，点击「一键启动」或「开始图文创作」生成第一篇图文
          </p>
        </div>
      )}
    </div>
  );
}

// ============ 3. 今日选题推荐（横向条带） ============

function TopicStrip() {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ recommendations: Recommendation[] }>("/recommendations/today")
      .then((res) => setRecs(res.data?.recommendations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(recId: string) {
    try {
      const res = await api.post<{ conversationId: string; autoMessage: string }>(
        `/recommendations/create-from/${recId}`, {}
      );
      if (res.data?.conversationId) {
        navigate(`/chat/${res.data.conversationId}?autoMessage=${encodeURIComponent(res.data.autoMessage)}`);
      }
    } catch (err) {
      console.error("一键创作失败:", err);
    }
  }

  const trendConfig: Record<string, { bg: string; text: string; label: string }> = {
    exploding: { bg: "bg-red-50", text: "text-red-600", label: "爆发" },
    rising: { bg: "bg-orange-50", text: "text-orange-600", label: "上升" },
    new: { bg: "bg-blue-50", text: "text-blue-600", label: "新词" },
    stable: { bg: "bg-gray-50", text: "text-gray-500", label: "稳定" },
  };

  if (loading) {
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-4 w-20 bg-gray-200 rounded animate-pulse" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 w-40 bg-gray-100 rounded-xl animate-pulse shrink-0" />
          ))}
        </div>
      </div>
    );
  }

  // 空状态 — 一行提示
  if (recs.length === 0) {
    return (
      <div className="mb-6 flex items-center gap-2 px-4 py-2.5 bg-orange-50 border border-orange-100 rounded-xl">
        <span className="text-sm">&#x1F525;</span>
        <span className="text-sm text-gray-500">今日选题推荐生成中</span>
        <span className="text-xs text-gray-400">· 每天 7:00 自动更新</span>
        <Link to="/keywords" className="text-xs text-orange-500 hover:text-orange-600 ml-auto">
          关键词库 &rarr;
        </Link>
      </div>
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-gray-900">今日选题</h2>
          <span className="text-xs text-gray-400">{recs.length} 个推荐</span>
        </div>
        <Link to="/keywords" className="text-xs text-gray-400 hover:text-blue-500 transition">
          查看全部热词 &rarr;
        </Link>
      </div>

      {/* 横向滚动卡片 */}
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-hide">
        {recs.slice(0, 8).map((rec, idx) => {
          const t = trendConfig[rec.trend] || trendConfig.stable;
          return (
            <button
              key={rec.id}
              onClick={() => handleCreate(rec.id)}
              className="shrink-0 text-left bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-orange-300 hover:shadow-sm transition-all group w-44"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-xs px-1.5 py-0.5 rounded ${t.bg} ${t.text}`}>{t.label}</span>
                {idx === 0 && <span className="text-xs text-orange-400 font-medium">TOP</span>}
              </div>
              <p className="text-sm font-medium text-gray-800 group-hover:text-orange-600 transition-colors line-clamp-2 leading-snug">
                {rec.keyword}
              </p>
              {rec.heatChange && (
                <p className="text-xs text-gray-400 mt-1">{rec.heatChange}</p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============ 4. 工作流入口（图文 + 视频 8步流水线 + AI助手） ============

function WorkflowSection() {
  const articleSteps = [
    { label: "关键词搜索", desc: "抓取全网学术热词" },
    { label: "关键词聚类", desc: "AI自动分组归类" },
    { label: "标题生成", desc: "多风格标题候选" },
    { label: "找期刊文章", desc: "匹配高IF期刊论文" },
    { label: "匹配模版", desc: "适配各平台格式" },
    { label: "AI + 知识库RAG", desc: "结合知识库深度写作" },
    { label: "核对准确度", desc: "AI事实核查校验" },
    { label: "一键发布", desc: "多平台同步分发" },
  ];

  const videoSteps = [
    { label: "关键词搜索", desc: "抓取全网学术热词" },
    { label: "关键词聚类", desc: "AI自动分组归类" },
    { label: "标题生成", desc: "多风格标题候选" },
    { label: "找期刊文章", desc: "匹配高IF期刊论文" },
    { label: "视频脚本", desc: "AI生成分镜脚本" },
    { label: "数字人/AI配音", desc: "自动合成视频内容" },
    { label: "核对准确度", desc: "AI事实核查校验" },
    { label: "一键发布", desc: "多平台同步分发" },
  ];

  return (
    <div className="mb-8">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">内容工作流</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 图文创作 */}
        <Link
          to="/chat?skill=article"
          className="group bg-white rounded-2xl border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all overflow-hidden"
        >
          <div className="px-5 pt-5 pb-3 flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center text-xl">&#x1F4DD;</span>
            <div>
              <h3 className="text-base font-bold text-gray-900 group-hover:text-blue-600 transition-colors">图文创作</h3>
              <p className="text-xs text-gray-400">8步流水线 · 从选题到发布</p>
            </div>
          </div>
          <div className="px-5 pb-4 space-y-1">
            {articleSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2.5 py-1">
                <span className="w-5 h-5 rounded-full bg-blue-50 text-blue-600 text-xs flex items-center justify-center font-medium shrink-0">
                  {i + 1}
                </span>
                <span className="text-sm text-gray-700">{step.label}</span>
                <span className="text-xs text-gray-300 hidden lg:inline">— {step.desc}</span>
              </div>
            ))}
          </div>
          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50">
            <span className="text-sm text-blue-600 font-medium group-hover:underline">开始图文创作 &rarr;</span>
          </div>
        </Link>

        {/* 视频制作 */}
        <Link
          to="/chat?skill=video"
          className="group bg-white rounded-2xl border border-gray-200 hover:border-purple-400 hover:shadow-md transition-all overflow-hidden"
        >
          <div className="px-5 pt-5 pb-3 flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center text-xl">&#x1F3AC;</span>
            <div>
              <h3 className="text-base font-bold text-gray-900 group-hover:text-purple-600 transition-colors">视频制作</h3>
              <p className="text-xs text-gray-400">8步流水线 · 从选题到发布</p>
            </div>
          </div>
          <div className="px-5 pb-4 space-y-1">
            {videoSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2.5 py-1">
                <span className="w-5 h-5 rounded-full bg-purple-50 text-purple-600 text-xs flex items-center justify-center font-medium shrink-0">
                  {i + 1}
                </span>
                <span className="text-sm text-gray-700">{step.label}</span>
                <span className="text-xs text-gray-300 hidden lg:inline">— {step.desc}</span>
              </div>
            ))}
          </div>
          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50">
            <span className="text-sm text-purple-600 font-medium group-hover:underline">开始视频制作 &rarr;</span>
          </div>
        </Link>

        {/* AI 销售对话（占据原 AI 助手位置，作为第一入口） */}
        {(() => {
          const salesEnabled = import.meta.env.VITE_SALES_ENABLED === "true";
          const cardBody = (
            <>
              <span className="absolute top-3 right-3 text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                Beta · 即将上线
              </span>
              <div className="px-5 pt-5 pb-3 flex items-center gap-3">
                <span className="w-10 h-10 rounded-xl bg-rose-100 flex items-center justify-center text-xl">&#x1F3AF;</span>
                <div>
                  <h3 className="text-base font-bold text-gray-900 group-hover:text-rose-600 transition-colors">AI 销售对话</h3>
                  <p className="text-xs text-gray-400">管理客户沟通 · 实时接管</p>
                </div>
              </div>
              <div className="px-5 pb-4 space-y-1">
                {[
                  { label: "线索收集", desc: "多渠道统一入口" },
                  { label: "AI 自动回复", desc: "拟人化『小王老师』" },
                  { label: "一键接管", desc: "关键节点真人上场" },
                  { label: "未读提醒", desc: "红点 + 需关注徽章" },
                  { label: "意向评分", desc: "实时排序跟进" },
                  { label: "全量对话", desc: "入库可回溯" },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2.5 py-1">
                    <span className="w-5 h-5 rounded-full bg-rose-50 text-rose-600 text-xs flex items-center justify-center shrink-0">
                      &#x2713;
                    </span>
                    <span className="text-sm text-gray-700">{item.label}</span>
                    <span className="text-xs text-gray-300 hidden lg:inline">— {item.desc}</span>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50">
                <span className="text-sm text-rose-600 font-medium group-hover:underline">
                  {salesEnabled ? "打开销售管理台 →" : "敬请期待"}
                </span>
              </div>
            </>
          );
          return salesEnabled ? (
            <Link
              to="/sales"
              className="relative group bg-white rounded-2xl border border-gray-200 hover:border-rose-400 hover:shadow-md transition-all overflow-hidden"
            >
              {cardBody}
            </Link>
          ) : (
            <div
              className="relative group bg-white rounded-2xl border border-gray-200 overflow-hidden cursor-not-allowed opacity-70"
              aria-disabled="true"
            >
              {cardBody}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ============ 5. 工具导航网格 ============

function ToolGrid() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "owner" || role === "admin";
  // 5-17 P0: 缩水到 admin 必要项 (账号管理 / 期刊审计)；其余 8 个 tile (关键词库/内容管理/AI助手/
  // 知识库/数据看板/图片转视频/成本对比/系统设置) 砍出主 hero 页 — 入口仍在 /content 等直接路径下可达。
  const tools = [
    { to: "/accounts", icon: "&#x1F4F1;", label: "账号管理", desc: "多平台" },
    ...(isAdmin
      ? [{ to: "/admin/journals/audit", icon: "&#x1F4CA;", label: "期刊审计", desc: "数据可信度" }]
      : []),
  ];

  return (
    <div>
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">工具</h2>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {tools.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="flex flex-col items-center gap-1.5 py-3 px-2 bg-white rounded-xl border border-gray-100 hover:border-blue-200 hover:shadow-sm transition-all group"
          >
            <span className="text-xl" dangerouslySetInnerHTML={{ __html: t.icon }} />
            <span className="text-xs font-medium text-gray-700 group-hover:text-blue-600 transition-colors">{t.label}</span>
            <span className="text-xs text-gray-400 hidden md:block">{t.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
