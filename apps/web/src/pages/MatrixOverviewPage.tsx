/**
 * 7-10 矩阵总览 — 老板"一个人管所有抖音号+公众号"的总控一屏。
 *
 * 数据源: GET /admin/matrix-overview (adminOnly, 纯聚合现有表)。
 * - 顶部 6 张汇总卡: 账号总数(按平台) / 今日生成 / 今日已发 / 待审池 / 草稿待选 / 异常账号
 * - "今日待办"条: 待审 → 跳今日页; 草稿待选 → 提示去公众号后台选发
 * - 主体表格: 后端已按健康严重度排序(异常置顶), 健康列彩色徽章, 行点击跳账号矩阵页
 * - 平台 tab 过滤(服务端 ?platform=), 60s 自动轮询(同 SettingsPage 设备轮询模式)
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../utils/api";
import PageHeader from "../components/ui/PageHeader";

type AccountHealth =
  | "healthy" | "login_expired" | "token_invalid" | "agent_offline"
  | "manual_upload_stale" | "idle_3d" | "no_content_today" | "disabled";

interface MatrixAccountRow {
  id: string;
  platform: string;
  accountName: string;
  status: string;
  disciplines: string[];
  hasPersona: boolean;
  agentDeviceId: string | null;
  agentOnline: boolean;
  /** 7-27 发布模式: auto=客户端自动发 / manual=人工下载后自己传(不判离线/登录态) */
  publishMode: "auto" | "manual";
  /** 7-27 manual 号: 待下载上传条数(运营的待办清单) */
  pendingUpload: number;
  oldestPendingUploadAt: string | null;
  generatedToday: number;
  dispatchedToday: number;
  publishedToday: number;
  draftPending: number;
  lastSuccessAt: string | null;
  health: AccountHealth;
  healthFlags: AccountHealth[];
}

interface MatrixOverview {
  date: string;
  summary: {
    totalAccounts: number;
    byPlatform: Record<string, number>;
    generatedToday: number;
    needsReview: number;
    publishedToday: number;
    draftPending: number;
    abnormalAccounts: number;
    /** 7-27 人工号数量 / 人工号待下载上传总条数 */
    manualAccounts: number;
    pendingManualUpload: number;
  };
  accounts: MatrixAccountRow[];
}

const PLATFORM_LABEL: Record<string, string> = {
  wechat: "公众号", douyin: "抖音", wechat_video: "视频号",
  xiaohongshu: "小红书", zhihu: "知乎", baijiahao: "百家号", toutiao: "头条号",
};
const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

const PLATFORM_TABS: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部" },
  { value: "douyin", label: "抖音" },
  { value: "wechat_video", label: "视频号" },
  { value: "wechat", label: "公众号" },
];

const HEALTH_BADGE: Record<AccountHealth, { label: string; cls: string }> = {
  healthy: { label: "正常", cls: "bg-green-100 text-green-700" },
  login_expired: { label: "登录失效", cls: "bg-red-100 text-red-700" },
  token_invalid: { label: "凭证失效", cls: "bg-red-100 text-red-700" },
  agent_offline: { label: "Agent 离线", cls: "bg-slate-200 text-slate-600" },
  manual_upload_stale: { label: "待上传积压 2 天+", cls: "bg-orange-100 text-orange-700" },
  idle_3d: { label: "3 天未发", cls: "bg-orange-100 text-orange-700" },
  no_content_today: { label: "今日无内容", cls: "bg-amber-100 text-amber-700" },
  disabled: { label: "已停用", cls: "bg-gray-100 text-gray-400" },
};

const DISC_LABEL: Record<string, string> = {
  medicine: "医学", psychology: "心理", engineering: "工程", economics: "经管",
  biology: "生物", education: "教育", law: "法学", agriculture: "农林",
  computer: "计算机", environment: "环境", chemistry: "化学", physics: "物理",
};

function formatTime(s: string | null): string {
  if (!s) return "从未";
  const d = new Date(s);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString("zh-CN");
}

function Card({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${tone ?? "text-slate-900"}`}>{value}</div>
      {sub ? <div className="text-[11px] text-slate-400 mt-0.5 truncate" title={sub}>{sub}</div> : null}
    </div>
  );
}

export default function MatrixOverviewPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MatrixOverview | null>(null);
  const [platform, setPlatform] = useState("all");
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async (p: string) => {
    try {
      const res = await api.get<MatrixOverview>(
        `/admin/matrix-overview${p !== "all" ? `?platform=${encodeURIComponent(p)}` : ""}`,
      );
      if (res.data) {
        setData(res.data);
        setUpdatedAt(new Date());
      }
    } catch (err) {
      console.error("矩阵总览加载失败", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初次 + 切 tab 立即拉; 60s 轮询保持新鲜 (同 SettingsPage 设备轮询模式)
  useEffect(() => {
    setLoading(true);
    void load(platform);
    const timer = setInterval(() => void load(platform), 60_000);
    return () => clearInterval(timer);
  }, [platform, load]);

  const s = data?.summary;
  const byPlatformText = s
    ? Object.entries(s.byPlatform).map(([p, n]) => `${platformLabel(p)} ${n}`).join(" · ")
    : "";

  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      <div className="max-w-7xl mx-auto py-6 px-6">
        <PageHeader
          title="矩阵总览"
          subtitle="一屏看全部账号的今日状态与健康度"
          actions={
            updatedAt ? (
              <span className="text-xs text-slate-400">
                {updatedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 更新 · 60s 自动刷新
              </span>
            ) : undefined
          }
        />

        {/* 汇总卡 */}
        {s && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            <Card label="账号总数" value={s.totalAccounts} sub={byPlatformText} />
            <Card label="今日生成" value={s.generatedToday} />
            <Card label="今日已发" value={s.publishedToday} tone="text-green-700" />
            <Card label="待审池" value={s.needsReview} tone={s.needsReview > 0 ? "text-amber-600" : undefined} />
            <Card label="草稿待选" value={s.draftPending} tone={s.draftPending > 0 ? "text-sky-700" : undefined} />
            <Card label="异常账号" value={s.abnormalAccounts} tone={s.abnormalAccounts > 0 ? "text-red-600" : "text-green-700"} />
          </div>
        )}

        {/* 今日待办条 */}
        {s && (s.needsReview > 0 || s.draftPending > 0 || (s.pendingManualUpload ?? 0) > 0) && (
          <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-indigo-900">
            <span className="font-medium">今日待办</span>
            {/* 7-27 人工号的核心信号: 系统已出片, 等人下载后手动传 —— 放第一位, 这是运营每天的主活 */}
            {(s.pendingManualUpload ?? 0) > 0 && (
              <span>
                待下载上传 <strong>{s.pendingManualUpload}</strong> 条（{s.manualAccounts} 个人工上传号）— 按下表「待上传」列逐号下载, 传完即清
              </span>
            )}
            {s.needsReview > 0 && (
              <span>
                待审 <strong>{s.needsReview}</strong> 篇
                <Link to="/" className="ml-1.5 underline underline-offset-2 hover:text-indigo-700">去今日页审核 →</Link>
              </span>
            )}
            {s.draftPending > 0 && (
              <span>
                草稿待选 <strong>{s.draftPending}</strong> 篇 — 已推到公众号草稿箱, 请运营到公众号后台挑选群发
              </span>
            )}
          </div>
        )}

        {/* 平台 tab */}
        <div className="flex items-center gap-1.5 mb-3">
          {PLATFORM_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setPlatform(t.value)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                platform === t.value
                  ? "bg-slate-900 text-white font-medium"
                  : "bg-white border border-slate-200 text-slate-600 hover:border-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 账号表格 (后端已按健康严重度排序, 异常置顶) */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-gray-100">
                <th className="px-4 py-2.5 font-medium">健康</th>
                <th className="px-4 py-2.5 font-medium">平台</th>
                <th className="px-4 py-2.5 font-medium">账号</th>
                <th className="px-4 py-2.5 font-medium">领域</th>
                <th className="px-4 py-2.5 font-medium">人设</th>
                <th className="px-4 py-2.5 font-medium text-right">今日生成</th>
                <th className="px-4 py-2.5 font-medium text-right">今日已发</th>
                <th className="px-4 py-2.5 font-medium text-right">草稿待选</th>
                <th className="px-4 py-2.5 font-medium text-right" title="人工上传号: 系统已出片、等运营下载后手动上传的条数">待上传</th>
                <th className="px-4 py-2.5 font-medium">最后成功发布</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400">加载中…</td></tr>
              ) : !data || data.accounts.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-slate-400">
                    暂无账号 — 先到 <Link to="/accounts" className="text-indigo-600 underline">账号矩阵</Link> 添加平台账号
                  </td>
                </tr>
              ) : (
                data.accounts.map((a) => {
                  const abnormal = a.health !== "healthy" && a.health !== "disabled";
                  const badge = HEALTH_BADGE[a.health] ?? HEALTH_BADGE.healthy;
                  return (
                    <tr
                      key={a.id}
                      onClick={() => navigate("/accounts")}
                      title="点击去账号矩阵页管理该账号"
                      className={`border-b border-gray-50 cursor-pointer transition-colors hover:bg-slate-50 ${
                        abnormal ? "bg-red-50/40" : ""
                      } ${a.health === "disabled" ? "opacity-50" : ""}`}
                    >
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badge.cls}`}
                          title={a.healthFlags.length > 1
                            ? `全部告警: ${a.healthFlags.map((f) => HEALTH_BADGE[f]?.label ?? f).join(" / ")}`
                            : undefined}
                        >
                          {badge.label}
                          {a.healthFlags.length > 1 ? ` +${a.healthFlags.length - 1}` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                        {platformLabel(a.platform)}
                        {a.publishMode === "manual" && (
                          <span
                            className="ml-1.5 px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 text-[10px] align-middle"
                            title="人工上传号: 运营下载后在自己手机/浏览器上传, 客户端不需要开机, 不判离线/登录态"
                          >人工上传</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-900 max-w-[200px] truncate" title={a.accountName}>
                        {a.accountName}
                        {/* 7-27: manual 号不显示设备在离线点 —— 客户端本来就不开, 灰点只制造焦虑 */}
                        {a.agentDeviceId && a.publishMode !== "manual" && (
                          <span
                            className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full align-middle ${a.agentOnline ? "bg-green-500" : "bg-slate-300"}`}
                            title={a.agentOnline ? "Agent 设备在线" : "Agent 设备离线"}
                          />
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {a.disciplines.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {a.disciplines.slice(0, 3).map((d) => (
                              <span key={d} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">
                                {DISC_LABEL[d] ?? d}
                              </span>
                            ))}
                            {a.disciplines.length > 3 && (
                              <span className="text-xs text-slate-400">+{a.disciplines.length - 3}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-300">不限</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {a.hasPersona
                          ? <span className="text-green-600 text-xs">✓ 有</span>
                          : <span className="text-slate-300 text-xs">无</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                        {a.generatedToday > 0 ? a.generatedToday : <span className="text-slate-300">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {a.publishedToday > 0
                          ? <span className="text-green-700 font-medium">{a.publishedToday}</span>
                          : <span className="text-slate-300">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {a.draftPending > 0
                          ? <span className="text-sky-700">{a.draftPending}</span>
                          : <span className="text-slate-300">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {a.publishMode === "manual" && a.pendingUpload > 0 ? (
                          <span
                            className={a.health === "manual_upload_stale" ? "text-orange-600 font-semibold" : "text-indigo-700 font-medium"}
                            title={a.oldestPendingUploadAt ? `最早一条 ${formatTime(a.oldestPendingUploadAt)} 生成` : undefined}
                          >
                            {a.pendingUpload}
                          </span>
                        ) : (
                          <span className="text-slate-300">{a.publishMode === "manual" ? 0 : "—"}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{formatTime(a.lastSuccessAt)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-slate-400">
          健康判定: 登录失效 = Agent 任务近 24h 报 login_expired 或登录态过期; 凭证失效 = 平台凭证验证失败;
          Agent 离线 = 绑定设备 90s 内无心跳; 3 天未发 = 前天/昨天/今天均无成功发布; 今日无内容 = 今天没分到任何内容。
          <br />
          「人工上传」号(在账号矩阵页设置)不判 Agent 离线/登录失效/3 天未发 —— 运营在自己设备上传, 客户端不需要开机;
          它的唯一硬指标是「待上传」积压: 最早一条压过 2 天没人动才标异常。
        </p>
      </div>
    </div>
  );
}
