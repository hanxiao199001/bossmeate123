import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import ContactMetaSection from "../components/ContactMetaSection";
import PageHeader from "../components/ui/PageHeader";
import { toast } from "../components/Toast";
import { useAuthStore } from "../hooks/useAuthStore";
import { IconMonitor } from "../components/ui/Icons";

interface WechatConfig {
  appId: string;
  appSecretMask: string;
  accountName: string;
  isVerified: boolean;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  updatedAt: string;
}

// Agent-3: 本地发布 Agent 设备（GET /agent-admin/devices）
interface AgentDevice {
  id: string;
  name: string;
  status: string; // active | disabled(已吊销)
  lastSeenAt: string | null;
  version: string | null;
  online: boolean;
  accounts?: Array<{ accountName: string; platform: string }>; // PR-A16: 该设备持有登录态的账号
}

const AGENT_PLATFORM_LABEL: Record<string, string> = { douyin: "抖音", wechat_video: "视频号" };

function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "从未上线";
  const min = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60000);
  if (min < 1) return "最后心跳刚刚";
  if (min < 60) return `最后心跳 ${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `最后心跳 ${hr} 小时前`;
  return `最后心跳 ${Math.floor(hr / 24)} 天前`;
}

// T4-3-5: 模板偏好统计（来自 /content-engine/template-preferences）
interface TemplatePreferenceItem {
  templateId: string;
  name: string;
  icon?: string;
  description: string;
  selectedCount: number;
  rejectedCount: number;
  weight: number;
}

// 所有可选学科
const ALL_DISCIPLINES = [
  { code: "medicine", label: "医学" },
  { code: "education", label: "教育" },
  { code: "economics", label: "经济管理" },
  { code: "engineering", label: "工程技术" },
  { code: "computer", label: "计算机" },
  { code: "agriculture", label: "农林" },
  { code: "environment", label: "环境科学" },
  { code: "law", label: "法学" },
  { code: "psychology", label: "心理学" },
  { code: "biology", label: "生物" },
  { code: "chemistry", label: "化学" },
  { code: "physics", label: "物理" },
];

export default function SettingsPage() {

  // 微信配置状态
  const [wechatConfig, setWechatConfig] = useState<WechatConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accountName, setAccountName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  // 内容偏好状态
  const [focusDisciplines, setFocusDisciplines] = useState<string[]>([]);
  const [dailyArticleLimit, setDailyArticleLimit] = useState(5);
  const [prefLoading, setPrefLoading] = useState(true);
  const [prefSaving, setPrefSaving] = useState(false);
  const [prefResult, setPrefResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // PR #224: 每日推荐配额 (每学科篇数)
  const [quota, setQuota] = useState<Record<string, number>>({});
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaResult, setQuotaResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // PR-O: 每日内容配置(按类型)
  const [contentQuota, setContentQuota] = useState<Record<string, { count: number; disciplines: string[] }>>({});
  const [cqSaving, setCqSaving] = useState(false);
  const [cqResult, setCqResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // T4-3-5: 模板偏好统计
  const [templatePrefs, setTemplatePrefs] = useState<TemplatePreferenceItem[]>([]);
  const [templateTotalSelections, setTemplateTotalSelections] = useState(0);
  const [loadingTemplatePrefs, setLoadingTemplatePrefs] = useState(true);

  // Agent-3: 本地发布 Agent — 配对码 + 设备列表
  const [agentDevices, setAgentDevices] = useState<AgentDevice[]>([]);
  const [agentLoading, setAgentLoading] = useState(true);
  const [pairing, setPairing] = useState<{ code: string; expiresInSec: number } | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadAgentDevices = async () => {
    try {
      const res = await api.get<{ devices: AgentDevice[] }>("/agent-admin/devices");
      setAgentDevices(res.data?.devices || []);
    } catch {
      /* 错误已由 api 统一 toast */
    } finally {
      setAgentLoading(false);
    }
  };

  // 在线判定窗口 90s, 30s 轮询一次保持状态新鲜
  useEffect(() => {
    loadAgentDevices();
    const timer = setInterval(loadAgentDevices, 30_000);
    return () => clearInterval(timer);
  }, []);

  const handleGeneratePairingCode = async () => {
    setPairingLoading(true);
    try {
      const res = await api.post<{ code: string; expiresInSec: number }>("/agent-admin/pairing-code", {});
      if (res.data) setPairing(res.data);
    } catch {
      /* 错误已由 api 统一 toast */
    } finally {
      setPairingLoading(false);
    }
  };

  // 下载客户配置 bossmate.cfg (含服务器地址 + 一次性配对码) — 客户放进 agent 文件夹双击启动器即免输码
  const handleDownloadClientConfig = async () => {
    try {
      const res = await api.post<{ cfg: string; pairCode: string; serverUrl: string; expiresInSec: number }>(
        "/agent-admin/launcher-config",
        { origin: window.location.origin },
      );
      if (!res.data?.cfg) return;
      const blob = new Blob([res.data.cfg], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bossmate.cfg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 延迟释放 blob URL: 立即 revoke 会让部分浏览器(尤其带安全扫描的)下载不收尾, 卡成 .crdownload
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("已下载 bossmate.cfg — 放进客户的 agent 启动包文件夹, 再双击启动器即可");
    } catch {
      /* 错误已由 api 统一 toast */
    }
  };

  // 一键下载完整客户包 zip (含预构建 dist + 启动器 + 内置配对码) — 客户解压双击即用
  const [pkgLoading, setPkgLoading] = useState(false);
  const handleDownloadClientPackage = async (platform: "windows" | "mac", portable = false) => {
    setPkgLoading(true);
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch("/api/v1/agent-admin/client-package", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ origin: window.location.origin, platform, portable }),
      });
      if (!res.ok) {
        let msg = "生成客户包失败";
        try { const j = await res.json(); if (j?.message) msg = j.message; } catch { /* 非JSON */ }
        toast.error(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = portable
        ? (platform === "windows" ? "bossmate-agent-Windows-免装Node.zip" : "bossmate-agent-Mac-免装Node.zip")
        : (platform === "windows" ? "bossmate-agent-Windows.zip" : "bossmate-agent-Mac.zip");
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 延迟释放 blob URL: 立即 revoke 会让部分浏览器(尤其带安全扫描的)下载不收尾, 卡成 .crdownload
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success(`已下载 ${platform === "windows" ? "Windows" : "Mac"} ${portable ? "免装Node " : ""}客户包 — 发给客户解压双击即可`);
    } catch {
      toast.error("下载失败, 请重试");
    } finally {
      setPkgLoading(false);
    }
  };

  // 吊销: 二次点击确认 (toast 提醒 + 按钮变「确认吊销」, 4s 内未确认自动复原)
  const handleRevokeDevice = async (deviceId: string) => {
    if (revokeConfirmId !== deviceId) {
      setRevokeConfirmId(deviceId);
      toast.warning("再点一次「确认吊销」— 吊销后该设备 Token 立即失效");
      setTimeout(() => setRevokeConfirmId((cur) => (cur === deviceId ? null : cur)), 4000);
      return;
    }
    setRevokeConfirmId(null);
    setRevokingId(deviceId);
    try {
      await api.delete(`/agent-admin/devices/${deviceId}`);
      toast.success("设备已吊销");
      await loadAgentDevices();
    } catch {
      /* 错误已由 api 统一 toast */
    } finally {
      setRevokingId(null);
    }
  };

  // 加载现有配置
  useEffect(() => {
    loadConfig();
    loadPreferences();
    loadTemplatePreferences();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const res = await api.get<any>("/wechat/config");
      if (res.data) {
        setWechatConfig(res.data);
        setAppId(res.data.appId || "");
        setAccountName(res.data.accountName || "");
      }
    } catch (err) {
      console.error("加载微信配置失败", err);
    } finally {
      setLoading(false);
    }
  };

  const loadPreferences = async () => {
    setPrefLoading(true);
    try {
      const res = await api.get<any>("/agents/config");
      const cfg = res.data?.config || {};
      setFocusDisciplines(cfg.focusDisciplines || []);
      setDailyArticleLimit(cfg.dailyArticleLimit || 5);
    } catch (err) {
      console.error("加载内容偏好失败", err);
    } finally {
      setPrefLoading(false);
    }
  };

  // T4-3-5: 拉取「我的模板偏好」(对应 boss_edits select_variant 累计统计)
  const loadTemplatePreferences = async () => {
    setLoadingTemplatePrefs(true);
    try {
      const res = await api.get<{
        preferences: TemplatePreferenceItem[];
        totalSelections: number;
      }>("/content-engine/template-preferences");
      if (res.data) {
        setTemplatePrefs(res.data.preferences || []);
        setTemplateTotalSelections(res.data.totalSelections || 0);
      }
    } catch (err) {
      console.error("加载模板偏好失败", err);
    } finally {
      setLoadingTemplatePrefs(false);
    }
  };

  const handleSavePreferences = async () => {
    setPrefSaving(true);
    setPrefResult(null);
    try {
      await api.patch<any>("/agents/config", {
        focusDisciplines,
        dailyArticleLimit,
      });
      setPrefResult({ ok: true, msg: "内容偏好已保存，下次执行时生效" });
    } catch (err: any) {
      setPrefResult({ ok: false, msg: err?.message || "保存失败" });
    } finally {
      setPrefSaving(false);
    }
  };

  // PR #224: 加载/保存 每日推荐配额
  useEffect(() => {
    api.get<{ quota: Record<string, number> }>("/admin/daily-recommendation-config")
      .then((res) => setQuota(res.data?.quota || {}))
      .catch(() => { /* 非 admin 或无配置, 忽略 */ });
  }, []);

  const handleSaveQuota = async () => {
    setQuotaSaving(true);
    setQuotaResult(null);
    try {
      const res = await api.patch<{ total: number }>("/admin/daily-recommendation-config", { quota });
      setQuotaResult({ ok: true, msg: `已保存, 每日共 ${res.data?.total ?? 0} 篇, 次日推荐生效` });
    } catch (err: any) {
      setQuotaResult({ ok: false, msg: err?.message || "保存失败" });
    } finally {
      setQuotaSaving(false);
    }
  };

  // PR-O: 加载/保存 每日内容配置(按类型)
  useEffect(() => {
    api.get<{ contentQuota: Record<string, { count: number; disciplines: string[] }> }>("/admin/daily-content-config")
      .then((res) => setContentQuota(res.data?.contentQuota || {}))
      .catch(() => { /* 非 admin 忽略 */ });
  }, []);
  const setCqCount = (t: string, n: number) =>
    setContentQuota((p) => ({ ...p, [t]: { count: Math.max(0, Math.min(50, n)), disciplines: p[t]?.disciplines || [] } }));
  const toggleCqDisc = (t: string, code: string) =>
    setContentQuota((p) => {
      const cur = p[t] || { count: 0, disciplines: [] };
      const has = cur.disciplines.includes(code);
      return { ...p, [t]: { count: cur.count, disciplines: has ? cur.disciplines.filter((x) => x !== code) : [...cur.disciplines, code] } };
    });
  const handleSaveContentQuota = async () => {
    setCqSaving(true); setCqResult(null);
    try {
      const res = await api.patch<{ total: number }>("/admin/daily-content-config", { contentQuota });
      setCqResult({ ok: true, msg: `已保存, 每日共 ${res.data?.total ?? 0} 篇, 次日生效` });
    } catch (err: any) {
      setCqResult({ ok: false, msg: err?.message || "保存失败" });
    } finally { setCqSaving(false); }
  };

  const toggleDiscipline = (code: string) => {
    setFocusDisciplines((prev) =>
      prev.includes(code) ? prev.filter((d) => d !== code) : [...prev, code]
    );
  };

  const handleSave = async () => {
    if (!appId.trim()) {
      setSaveResult({ ok: false, msg: "请输入AppID" });
      return;
    }
    if (!appSecret.trim() && !wechatConfig?.appSecretMask) {
      setSaveResult({ ok: false, msg: "请输入AppSecret" });
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await api.post<any>("/wechat/config", {
        appId: appId.trim(),
        appSecret: appSecret.trim() || undefined,
        accountName: accountName.trim() || undefined,
      });
      const isIpError = res.data?.verifyError?.includes("40164") || res.message?.includes("40164");
      setSaveResult({
        ok: res.data?.isVerified ?? false,
        msg: res.data?.isVerified
          ? "\u2705 \u914D\u7F6E\u4FDD\u5B58\u6210\u529F\uFF0C\u9A8C\u8BC1\u901A\u8FC7\uFF01\u73B0\u5728\u53EF\u4EE5\u5728\u5DE5\u4F5C\u6D41Step 8\u4E2D\u4E00\u952E\u53D1\u5E03\u5230\u516C\u4F17\u53F7\u4E86\u3002"
          : isIpError
            ? "IP_WHITELIST_ERROR"
            : `\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u4F46\u9A8C\u8BC1\u5931\u8D25: ${res.data?.verifyError || res.message || "\u672A\u77E5\u9519\u8BEF"}`,
      });
      setAppSecret(""); // 清空密钥输入
      loadConfig(); // 重新加载
    } catch (err: any) {
      setSaveResult({ ok: false, msg: err?.message || "保存失败" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      {/* 6-11 施工包C2-a (审计2.5): 手写顶栏已删, 导航走 MainLayout 侧边栏 (退出在 Sidebar 底部); 标题迁到内容区顶部 */}
      <div className="max-w-4xl mx-auto p-6">
        <PageHeader title="系统设置" />

        {/* 快速导航卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Link
            to="/accounts"
            className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow cursor-pointer"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center text-2xl">
                🌐
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">多平台账号管理</h3>
                <p className="text-sm text-gray-500">管理微信、小红书等平台账号</p>
              </div>
            </div>
          </Link>
        </div>

        {/* Agent-3: 本地发布 Agent — 配对码 + 设备管理 */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600">
              <IconMonitor size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">本地发布 Agent</h2>
              <p className="text-sm text-gray-500">
                在你或客户的电脑上运行 BossMate Agent, 用本机浏览器自动发布到视频号/抖音(登录态保存在本机, 更稳更合规)
              </p>
            </div>
          </div>

          {/* 配对码 */}
          <div className="mb-5">
            <button
              onClick={handleGeneratePairingCode}
              disabled={pairingLoading}
              className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                pairingLoading ? "bg-gray-400 cursor-not-allowed" : "bg-indigo-600 hover:bg-indigo-700 active:scale-95"
              }`}
            >
              {pairingLoading ? "生成中…" : pairing ? "重新生成配对码" : "生成配对码"}
            </button>
            <button
              onClick={() => handleDownloadClientPackage("windows")}
              disabled={pkgLoading}
              className={`ml-2 px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                pkgLoading ? "bg-gray-400 cursor-not-allowed" : "bg-emerald-600 hover:bg-emerald-700 active:scale-95"
              }`}
            >
              {pkgLoading ? "打包中…" : "下载客户包 · Windows"}
            </button>
            <button
              onClick={() => handleDownloadClientPackage("mac")}
              disabled={pkgLoading}
              className={`ml-2 px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                pkgLoading ? "bg-gray-400 cursor-not-allowed" : "bg-emerald-600 hover:bg-emerald-700 active:scale-95"
              }`}
            >
              {pkgLoading ? "打包中…" : "下载客户包 · Mac"}
            </button>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => handleDownloadClientPackage("windows", true)}
                disabled={pkgLoading}
                className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                  pkgLoading ? "bg-gray-400 cursor-not-allowed" : "bg-violet-600 hover:bg-violet-700 active:scale-95"
                }`}
              >
                {pkgLoading ? "生成中…" : "下载 · Windows(免装Node)"}
              </button>
              <button
                onClick={() => handleDownloadClientPackage("mac", true)}
                disabled={pkgLoading}
                className={`px-5 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                  pkgLoading ? "bg-gray-400 cursor-not-allowed" : "bg-violet-600 hover:bg-violet-700 active:scale-95"
                }`}
              >
                {pkgLoading ? "生成中…" : "下载 · Mac(免装Node)"}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              「免装Node」版客户解压双击即用、无需装任何东西(推荐)。首次点击服务器要现打包, 约 1-2 分钟, 请耐心等; 之后秒下。
            </p>
            <button
              onClick={handleDownloadClientConfig}
              className="ml-2 px-5 py-2 rounded-lg text-sm font-medium text-indigo-700 border border-indigo-200 bg-white hover:bg-indigo-50 active:scale-95 transition-all"
            >
              只下载配置(含配对码)
            </button>
            <p className="mt-2 text-xs text-slate-500">
              按客户系统下载对应包(只含该系统启动器, 防点错): Windows 解压双击 start-agent.bat, Mac 双击 start-agent.command。
              客户已有客户包时, 用「只下载配置」拿 bossmate.cfg 覆盖即可换新码。
            </p>
            {pairing && (
              <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-4">
                <div className="font-mono text-3xl font-bold tracking-[0.35em] text-indigo-600 select-all">
                  {pairing.code}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {Math.round(pairing.expiresInSec / 60)} 分钟内有效, 在客户电脑运行:
                </p>
                <code className="mt-1 inline-block rounded bg-slate-900 text-slate-100 text-xs font-mono px-2.5 py-1.5 select-all">
                  bossmate-agent pair {window.location.origin} {pairing.code}
                </code>
              </div>
            )}
          </div>

          {/* 设备列表 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-800">已配对设备</h3>
              <button onClick={loadAgentDevices} className="text-xs text-indigo-600 hover:underline">
                刷新
              </button>
            </div>
            {agentLoading ? (
              <div className="text-sm text-gray-500">加载中…</div>
            ) : agentDevices.length === 0 ? (
              <div className="text-sm text-gray-500 bg-gray-50 border border-dashed border-gray-200 rounded-lg p-4">
                还没有设备, 生成配对码开始接入
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                {agentDevices.map((d) => {
                  const revoked = d.status === "disabled";
                  const dot = revoked ? "bg-rose-500" : d.online ? "bg-emerald-500" : "bg-slate-300";
                  const statusText = revoked ? "已吊销" : d.online ? "在线" : `离线 · ${formatLastSeen(d.lastSeenAt)}`;
                  const statusColor = revoked ? "text-rose-600" : d.online ? "text-emerald-600" : "text-slate-500";
                  return (
                    <div key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{d.name || "未命名设备"}</div>
                        <div className="text-xs text-gray-400">
                          {d.version ? `v${d.version.replace(/^v/, "")}` : "版本未知"} ·{" "}
                          <span className={statusColor}>{statusText}</span>
                        </div>
                        {(d.accounts?.length ?? 0) > 0 && (
                          <div className="text-xs text-gray-500 mt-0.5 truncate">
                            持有登录:{" "}
                            {d.accounts!
                              .map((a) => `${AGENT_PLATFORM_LABEL[a.platform] ?? a.platform}·${a.accountName}`)
                              .join("、")}
                          </div>
                        )}
                      </div>
                      {!revoked && (
                        <button
                          onClick={() => handleRevokeDevice(d.id)}
                          disabled={revokingId === d.id}
                          className={`shrink-0 px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                            revokeConfirmId === d.id
                              ? "border-rose-500 bg-rose-500 text-white hover:bg-rose-600"
                              : "border-rose-200 text-rose-600 hover:bg-rose-50"
                          } ${revokingId === d.id ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          {revokingId === d.id ? "吊销中…" : revokeConfirmId === d.id ? "确认吊销" : "吊销"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* PR-O: 每日内容配置(按类型) */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-lg bg-teal-100 flex items-center justify-center text-xl">{"\uD83D\uDDC2\uFE0F"}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">每日内容配置（按类型）</h2>
              <p className="text-sm text-gray-500">设置每天各类型内容各生成几篇、各类各做哪些学科。数字人暂不自动生成；总数=各类之和。未选学科=全学科轮转。</p>
            </div>
          </div>
          <div className="space-y-3">
            {([["domestic", "国内核心"], ["international", "国外期刊"], ["roundup", "多刊盘点"]] as const).map(([t, label]) => {
              const cur = contentQuota[t] || { count: 0, disciplines: [] };
              return (
                <div key={t} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-gray-800">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">每日</span>
                      <input type="number" min={0} max={50} value={cur.count}
                        onChange={(e) => setCqCount(t, Math.floor(Number(e.target.value)) || 0)}
                        className="w-16 text-center border border-gray-300 rounded px-2 py-1 text-sm" />
                      <span className="text-xs text-gray-500">篇</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ALL_DISCIPLINES.map((d) => {
                      const on = cur.disciplines.includes(d.code);
                      return (
                        <button key={d.code} onClick={() => toggleCqDisc(t, d.code)}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${on ? "border-teal-500 bg-teal-50 text-teal-700" : "border-gray-200 text-gray-500 hover:border-gray-300"}`}>
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400">{cur.disciplines.length === 0 ? "未选学科 = 全学科轮转" : `${cur.disciplines.length} 个学科`}</p>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-3">
            <button onClick={handleSaveContentQuota} disabled={cqSaving}
              className={`px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${cqSaving ? "bg-gray-400 cursor-not-allowed" : "bg-teal-600 hover:bg-teal-700 active:scale-95"}`}>
              {cqSaving ? "保存中..." : "保存内容配置"}
            </button>
          </div>
          {cqResult && <div className={`mt-3 text-sm ${cqResult.ok ? "text-green-600" : "text-red-600"}`}>{cqResult.msg}</div>}
        </div>

        {/* T4-3-5: 我的模板偏好（boss_edits 累计 → 加权选副版本模板） */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-xl">{"📋"}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">我的模板偏好</h2>
              <p className="text-sm text-gray-500">
                每次选「这版」都会累积偏好，AI 越来越懂你 — 副版本模板会按你的历史选择加权
              </p>
            </div>
          </div>

          {loadingTemplatePrefs ? (
            <div className="text-sm text-gray-500">加载中…</div>
          ) : templateTotalSelections === 0 ? (
            <div className="text-sm text-gray-500 bg-gray-50 border border-dashed border-gray-200 rounded-lg p-4">
              你还没有选择过模板。生成多版本文章后选择「这版」会自动累积偏好。
            </div>
          ) : (
            <div>
              <div className="text-sm text-gray-600 mb-4">
                累计选择 <strong className="text-blue-600">{templateTotalSelections}</strong> 次
              </div>
              <div className="space-y-4">
                {templatePrefs.map((p) => {
                  const pct = templateTotalSelections > 0
                    ? (p.selectedCount / templateTotalSelections) * 100
                    : 0;
                  return (
                    <div key={p.templateId}>
                      <div className="flex items-center gap-2 mb-1">
                        <span>{p.icon ?? "📄"}</span>
                        <span className="font-medium text-gray-900">{p.name}</span>
                        <span className="text-xs text-gray-500 ml-auto">
                          {p.selectedCount} 次（{pct.toFixed(0)}%）
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="text-xs text-gray-500 mt-1">{p.description}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Day 2 PR A: 联系方式（contact_meta）— 区块 21 渲染源 */}
        <ContactMetaSection />

      </div>
    </div>
  );
}
