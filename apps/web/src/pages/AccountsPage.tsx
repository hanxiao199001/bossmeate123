import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "../components/Toast";
import { api } from "../utils/api";
import { PLATFORM_META } from "../utils/i18n";
import PageHeader from "../components/ui/PageHeader";

// ===== 类型定义 =====
interface Account {
  id: string;
  platform: string;
  accountName: string;
  accountId?: string | null; // 平台真实账号ID(抖音号等), 扫码登录回填
  metadata?: { realNickname?: string } | null; // 含扫码回填的真实昵称
  credentials: Record<string, unknown>;
  groupName?: string;
  journalScope?: string; // PR-K 期刊定位 domestic/international/both
  discipline?: string | null; // PR-W5 领域定位(旧单选)
  disciplines?: string[]; // PR-W5b 领域定位多选
  persona?: string | null; // PR-X1 人设画像
  styleProfile?: string | null; // PR-X3 风格画像
  status: string;
  isVerified: boolean;
  lastPublishAt?: string;
  // PR-S4: 浏览器登录态 (抖音/视频号扫码登录 → 推草稿箱)
  loginStatus?: "none" | "logged_in" | "expired";
  loginAt?: string;
  agentDeviceId?: string | null; // 6-17 #4: 绑定的本地Agent设备
  agentOnline?: boolean; // 6-17 #4: 该设备是否在线(后端按 lastSeenAt<90s 判定)
  createdAt: string;
  updatedAt: string;
}

// ===== 平台配置 ===== (6-11 施工包A: 收口到 utils/i18n.ts 的 PLATFORM_META,8 份重复表合一)

// PR-P2: 半自动平台 — 第三方无稳定发布 API, 内容人工发布, 凭证选填(账号=矩阵号标签)
const SEMI_AUTO_PLATFORMS = new Set(["douyin", "wechat_video", "xiaohongshu"]);

const CREDENTIAL_FIELDS: Record<string, Array<{ key: string; label: string; type: "input" | "textarea" | "password"; placeholder: string; required: boolean }>> = {
  wechat: [
    { key: "appId", label: "AppID", type: "input", placeholder: "微信公众号AppID", required: true },
    { key: "appSecret", label: "AppSecret", type: "password", placeholder: "微信公众号AppSecret", required: true },
  ],
  baijiahao: [
    { key: "accessToken", label: "AccessToken", type: "textarea", placeholder: "百家号开放平台的AccessToken", required: true },
  ],
  toutiao: [
    { key: "accessToken", label: "AccessToken", type: "textarea", placeholder: "头条号开放平台的AccessToken", required: true },
  ],
  zhihu: [
    { key: "cookie", label: "Cookie", type: "textarea", placeholder: "浏览器登录知乎后获取的Cookie", required: true },
    { key: "columnId", label: "专栏ID（可选）", type: "input", placeholder: "如 my-column", required: false },
  ],
  xiaohongshu: [
    { key: "cookie", label: "Cookie", type: "textarea", placeholder: "浏览器登录小红书后获取的Cookie", required: true },
  ],
  douyin: [
    { key: "clientKey", label: "Client Key", type: "input", placeholder: "抖音开放平台 Client Key", required: true },
    { key: "clientSecret", label: "Client Secret", type: "password", placeholder: "抖音开放平台 Client Secret", required: true },
    { key: "accessToken", label: "Access Token", type: "textarea", placeholder: "OAuth2 授权获取的 access_token", required: true },
    { key: "openId", label: "Open ID", type: "input", placeholder: "用户 open_id（授权回调返回）", required: false },
  ],
  wechat_video: [
    { key: "appId", label: "AppID", type: "input", placeholder: "公众号 AppID（需绑定视频号）", required: true },
    { key: "appSecret", label: "AppSecret", type: "password", placeholder: "公众号 AppSecret", required: true },
  ],
};

const STATUS_LABELS: Record<string, string> = {
  verified: "已验证",
  expired: "已过期",
  disabled: "已禁用",
  pending: "待验证",
};

const STATUS_COLORS: Record<string, string> = {
  verified: "bg-green-100 text-green-700",
  expired: "bg-red-100 text-red-600",
  disabled: "bg-gray-100 text-gray-600",
  pending: "bg-yellow-100 text-yellow-700",
};

export default function AccountsPage() {

  // 账号列表状态
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);

  // 筛选状态
  const [filterPlatform, setFilterPlatform] = useState("全部");
  const [filterGroup, setFilterGroup] = useState("全部");

  // 添加账号表单状态
  const [showAddForm, setShowAddForm] = useState(false);
  const [keepaliveBusy, setKeepaliveBusy] = useState(false); // 6-11 登录态保活手动巡检
  const [selectedPlatform, setSelectedPlatform] = useState("wechat");
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [accountName, setAccountName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [journalScope, setJournalScope] = useState("both"); // PR-K 期刊定位
  const [isCertified, setIsCertified] = useState(false); // 已认证(full capability)
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState("");

  // 操作状态
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  // 获取账号列表
  const fetchAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterPlatform !== "全部") params.set("platform", filterPlatform);
      if (filterGroup !== "全部") params.set("group", filterGroup);

      const res = await api.get<Account[]>(`/accounts?${params.toString()}`);
      if (res.data) {
        const list = Array.isArray(res.data) ? res.data : [];
        setAccounts(list);
        // 从账号列表中提取分组
        const groupSet = new Set(list.map(a => a.groupName).filter(Boolean) as string[]);
        setGroups(Array.from(groupSet));
      }
    } catch (err) {
      console.error("获取账号列表失败", err);
    } finally {
      setLoading(false);
    }
  }, [filterPlatform, filterGroup]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // 初始化凭证字段
  useEffect(() => {
    const fields = CREDENTIAL_FIELDS[selectedPlatform] || [];
    const newFormData: Record<string, string> = {};
    fields.forEach(f => {
      newFormData[f.key] = "";
    });
    setFormData(newFormData);
  }, [selectedPlatform]);

  // 添加账号
  const handleAddAccount = async () => {
    if (!accountName.trim()) {
      setAddMsg("请输入账号名称");
      return;
    }

    const fields = CREDENTIAL_FIELDS[selectedPlatform] || [];
    if (!SEMI_AUTO_PLATFORMS.has(selectedPlatform)) {
      for (const field of fields) {
        if (field.required && !formData[field.key]?.trim()) {
          setAddMsg(`请填写 ${field.label}`);
          return;
        }
      }
    }

    setAdding(true);
    setAddMsg("");
    try {
      // PR-P2: 只提交非空凭证 — 空字符串占位会让后端误判"有凭证"走 API 验证, 半自动账号被标"验证失败"
      const nonEmptyCreds = Object.fromEntries(
        Object.entries(formData).filter(([, v]) => v && v.trim())
      );
      const res = await api.post<Account>("/accounts", {
        platform: selectedPlatform,
        accountName: accountName.trim(),
        credentials: nonEmptyCreds,
        groupName: groupName.trim() || undefined,
        journalScope,
        // 仅微信需要这个字段；默认 draft_only 保守兜底
        capability: selectedPlatform === "wechat" && isCertified ? "full" : "draft_only",
      });

      if (res.data) {
        setAddMsg("账号添加成功！");
        setShowAddForm(false);
        setAccountName("");
        setGroupName("");
        setIsCertified(false);
        const newFields = CREDENTIAL_FIELDS[selectedPlatform] || [];
        const resetFormData: Record<string, string> = {};
        newFields.forEach(f => {
          resetFormData[f.key] = "";
        });
        setFormData(resetFormData);
        fetchAccounts();
        setTimeout(() => setAddMsg(""), 3000);
      }
    } catch (err) {
      setAddMsg(`添加失败：${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setAdding(false);
    }
  };

  // 验证账号
  const handleVerify = async (accountId: string) => {
    setVerifying(prev => ({ ...prev, [accountId]: true }));
    try {
      const res = await api.post(`/accounts/${accountId}/verify`, {});
      if (res.data) {
        fetchAccounts();
      }
    } catch (err) {
      console.error("验证失败", err);
      toast.error((err as any)?.response?.data?.message || "验证失败，请稍后重试");
    } finally {
      setVerifying(prev => ({ ...prev, [accountId]: false }));
    }
  };

  // PR-S4: 扫码登录 (抖音/视频号 → 浏览器登录态 → 推草稿箱)
  const [qrModal, setQrModal] = useState<{
    accountId: string;
    accountName: string;
    sessionId?: string;
    status: "starting" | "waiting" | "waiting_sms" | "success" | "expired" | "failed";
    qrPng?: string;
    error?: string;
  } | null>(null);
  const [smsCode, setSmsCode] = useState("");
  const [smsSubmitting, setSmsSubmitting] = useState(false);

  const submitSms = async () => {
    if (!qrModal?.sessionId || !smsCode.trim() || smsSubmitting) return;
    setSmsSubmitting(true);
    try {
      await api.post(`/accounts/qr-login/${qrModal.sessionId}/sms-code`, { code: smsCode.trim() });
      toast.success("验证码已提交, 等待平台校验…");
      setSmsCode("");
    } catch (err) {
      toast.error((err as any)?.response?.data?.message || "提交失败, 请重试");
    } finally {
      setSmsSubmitting(false);
    }
  };

  const clickBusyRef = useRef(false);
  const remoteClickShot = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!qrModal?.sessionId || clickBusyRef.current) return;
    clickBusyRef.current = true;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    // object-contain 有留白: 必须按"实际画面区域"换算坐标, 否则点击横/纵向偏移点不中
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const dispW = img.naturalWidth * scale;
    const dispH = img.naturalHeight * scale;
    const offX = rect.left + (rect.width - dispW) / 2;
    const offY = rect.top + (rect.height - dispH) / 2;
    const x = (e.clientX - offX) / dispW;
    const y = (e.clientY - offY) / dispH;
    if (x < 0 || x > 1 || y < 0 || y > 1) { clickBusyRef.current = false; return; } // 点在留白处, 忽略
    try {
      await api.post(`/accounts/qr-login/${qrModal.sessionId}/click`, { x, y });
      toast.success("已点击, 画面刷新中…");
    } catch (err) {
      toast.error((err as any)?.response?.data?.message || "点击失败");
    } finally {
      clickBusyRef.current = false;
    }
  };

  const resendSms = async () => {
    if (!qrModal?.sessionId) return;
    try {
      await api.post(`/accounts/qr-login/${qrModal.sessionId}/resend-sms`, {});
      toast.success("已请求重新发送验证码");
    } catch (err) {
      toast.error((err as any)?.response?.data?.message || "重发失败");
    }
  };

  const startQrLogin = async (account: Account) => {
    setQrModal({ accountId: account.id, accountName: account.accountName, status: "starting" });
    try {
      const res = await api.post<{ sessionId: string }>(`/accounts/${account.id}/qr-login`, {});
      if (res.data?.sessionId) {
        setQrModal((m) => m && { ...m, sessionId: res.data!.sessionId });
      } else {
        setQrModal((m) => m && { ...m, status: "failed", error: "发起登录失败" });
      }
    } catch (err) {
      setQrModal((m) => m && { ...m, status: "failed", error: (err as any)?.response?.data?.message || "发起登录失败" });
    }
  };

  // 轮询扫码状态
  useEffect(() => {
    if (!qrModal?.sessionId) return;
    if (qrModal.status === "success" || qrModal.status === "expired" || qrModal.status === "failed") return;
    const t = setInterval(async () => {
      try {
        const res = await api.get<{ status: string; qrPng?: string; error?: string }>(
          `/accounts/qr-login/${qrModal.sessionId}`
        );
        if (res.data) {
          const d = res.data;
          setQrModal((m) => m && { ...m, status: d.status as any, qrPng: d.qrPng ?? m.qrPng, error: d.error });
          if (d.status === "success") {
            toast.success("扫码登录成功");
            fetchAccounts();
          }
        }
      } catch { /* 会话过期等, 下轮再说 */ }
    }, 2000);
    return () => clearInterval(t);
  }, [qrModal?.sessionId, qrModal?.status, fetchAccounts]);

  // 删除账号
const handleScopeChange = async (accountId: string, scope: string) => {
    try {
      await api.patch(`/accounts/${accountId}`, { journalScope: scope });
      fetchAccounts();
    } catch {
      // 静默, 失败保持原值
    }
  };

  // PR-W5b: 账号领域定位(多选) — 一键生成 exclusive 模式从该号的领域池里选题
  const handleDisciplineToggle = async (account: Account, disc: string) => {
    const cur = new Set(account.disciplines ?? (account.discipline ? [account.discipline] : []));
    cur.has(disc) ? cur.delete(disc) : cur.add(disc);
    try {
      await api.patch(`/accounts/${account.id}`, { disciplines: [...cur] });
      fetchAccounts();
    } catch { /* 静默 */ }
  };
  const [discEditId, setDiscEditId] = useState<string | null>(null);
  const DISC_OPTIONS: Array<[string, string]> = [
    ["medicine", "医学"], ["psychology", "心理"], ["engineering", "工程"], ["economics", "经管"],
    ["biology", "生物"], ["education", "教育"], ["law", "法学"], ["agriculture", "农林"],
    ["computer", "计算机"], ["environment", "环境"], ["chemistry", "化学"], ["physics", "物理"],
  ];
  const discLabel = (v: string) => DISC_OPTIONS.find(([k]) => k === v)?.[1] ?? v;

  // PR-X1/X3: 人设 + 风格学习面板
  const [personaEditId, setPersonaEditId] = useState<string | null>(null);
  const [personaDraft, setPersonaDraft] = useState("");
  const [samplesDraft, setSamplesDraft] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [styleLearning, setStyleLearning] = useState(false);
  const openPersona = (a: Account) => {
    setPersonaEditId(personaEditId === a.id ? null : a.id);
    setPersonaDraft(a.persona ?? "");
    setSamplesDraft("");
  };
  const savePersona = async (accountId: string) => {
    setPersonaSaving(true);
    try {
      await api.patch(`/accounts/${accountId}`, { persona: personaDraft.trim() || null });
      toast.success("人设已保存");
      fetchAccounts();
    } catch { toast.error("保存失败"); } finally { setPersonaSaving(false); }
  };
  const learnStyle = async (accountId: string) => {
    const samples = samplesDraft.split(/\n-{3,}\n/).map((t) => t.trim()).filter((t) => t.length >= 100);
    if (samples.length === 0) { toast.error("贴至少 1 篇 ≥100 字的范文 (多篇用单独一行 --- 分隔)"); return; }
    setStyleLearning(true);
    try {
      await api.post(`/accounts/${accountId}/learn-style`, { samples });
      toast.success("风格画像已提炼并保存");
      setSamplesDraft("");
      fetchAccounts();
    } catch { toast.error("风格提炼失败"); } finally { setStyleLearning(false); }
  };

  const handleDelete = async (accountId: string) => {
    if (!confirm("确定要删除这个账号吗？")) return;

    setDeleting(prev => ({ ...prev, [accountId]: true }));
    try {
      await api.delete(`/accounts/${accountId}`);
      fetchAccounts();
    } catch (err) {
      console.error("删除失败", err);
      toast.error((err as any)?.response?.data?.message || "删除失败，请稍后重试");
    } finally {
      setDeleting(prev => ({ ...prev, [accountId]: false }));
    }
  };

  // 获取可用平台列表
  const availablePlatforms = ["全部", ...Object.keys(PLATFORM_META)];
  const availableGroups = ["全部", ...groups];

  // 过滤账号列表
  const filteredAccounts = accounts.filter(acc => {
    const platformMatch = filterPlatform === "全部" || acc.platform === filterPlatform;
    const groupMatch = filterGroup === "全部" || acc.groupName === filterGroup;
    return platformMatch && groupMatch;
  });

  // 按平台分组
  const accountsByPlatform: Record<string, Account[]> = {};
  filteredAccounts.forEach(acc => {
    if (!accountsByPlatform[acc.platform]) {
      accountsByPlatform[acc.platform] = [];
    }
    accountsByPlatform[acc.platform].push(acc);
  });

  // 6-11: 手动触发登录态保活巡检(串行慢任务, 后台跑)
  const runKeepalive = async () => {
    setKeepaliveBusy(true);
    try {
      const r = await api.post<{ message?: string }>("/accounts/keepalive", {});
      toast.info((r as any).message || "巡检已启动, 稍后刷新查看登录状态");
    } catch {
      /* api 层已统一弹错 */
    } finally {
      setKeepaliveBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      {/* 6-11 施工包C2-a (审计2.5): 手写顶栏已删, 导航统一走 MainLayout 侧边栏 (标题在下方 h1, 退出在 Sidebar 底部) */}
      <div className="max-w-7xl mx-auto py-6 px-6">
        {/* 页面标题与操作 */}
        <PageHeader
          title="多平台账号管理"
          subtitle="管理和验证您在各个平台的内容发布账号"
          actions={
            <div className="flex items-center gap-2">
              <button
                onClick={runKeepalive}
                disabled={keepaliveBusy}
                title="巡检所有已扫码账号的登录态: 在线的顺手续期, 掉线的标红提醒(每日 05:00 也会自动跑)"
                className="px-3 h-9 bg-white border border-slate-200 text-slate-700 hover:border-slate-300 text-sm font-medium rounded-lg transition-all disabled:opacity-50"
              >
                {keepaliveBusy ? "启动中…" : "登录态巡检"}
              </button>
              <button
                onClick={() => setShowAddForm(!showAddForm)}
                className="px-4 h-9 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg shadow-sm transition-all active:scale-95"
              >
                + 添加账号
              </button>
            </div>
          }
        />

        {/* 6-11: 登录失效醒目提醒(保活巡检发现掉线 → 这里催扫码) */}
        {(() => {
          const expiredAccounts = accounts.filter((a) => a.loginStatus === "expired");
          if (expiredAccounts.length === 0) return null;
          return (
            <div className="mb-6 p-3 rounded-lg text-sm bg-amber-50 text-amber-800 border border-amber-200 flex items-center justify-between">
              <span>
                ⚠️ {expiredAccounts.length} 个账号登录已失效(
                {expiredAccounts.slice(0, 3).map((a) => a.accountName).join("、")}
                {expiredAccounts.length > 3 ? " 等" : ""}
                ),推送会跳过它们 — 请在下方列表点「重新扫码」恢复
              </span>
            </div>
          );
        })()}

        {/* 成功提示 */}
        {addMsg && (
          <div className={`mb-6 p-3 rounded-lg text-sm ${addMsg.includes("成功") ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
            {addMsg}
          </div>
        )}

        {/* 添加账号表单 */}
        {showAddForm && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">添加新账号</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* 平台选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  选择平台 <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedPlatform}
                  onChange={(e) => setSelectedPlatform(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                >
                  {Object.entries(PLATFORM_META).map(([key, info]) => (
                    <option key={key} value={key}>{info.label}</option>
                  ))}
                </select>
              </div>

              {/* 账号名称 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  账号名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="例如：医学期刊助手"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {/* 分组 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">分组（可选）</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="例如：医学"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {/* PR-K: 期刊定位 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">期刊定位</label>
                <select
                  value={journalScope}
                  onChange={(e) => setJournalScope(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="both">两者都做（不限）</option>
                  <option value="domestic">只做国内核心</option>
                  <option value="international">只做国外期刊</option>
                </select>
                <p className="mt-1 text-xs text-gray-400">生成内容时自动只选该定位的期刊</p>
              </div>
            </div>

            {/* 动态凭证字段 */}
            <div className="space-y-4 mb-6">
              <div className="border-t border-gray-200 pt-4">
                {/* PR-P2: 半自动平台凭证整区折叠为"选填", 默认收起 — 只填账号名即可直接添加 */}
                {SEMI_AUTO_PLATFORMS.has(selectedPlatform) ? (
                  <>
                    <p className="text-xs text-amber-600 mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      半自动平台：内容由系统生成、人工发布，<b>无需凭证</b>，只填账号名即可添加（账号作矩阵号标签使用）。
                    </p>
                    <details className="group">
                      <summary className="text-sm text-gray-500 cursor-pointer select-none hover:text-gray-700">
                        ▸ 开放平台 API 凭证（选填，以备将来自动发布）
                      </summary>
                      <div className="space-y-3 mt-3">
                        {(CREDENTIAL_FIELDS[selectedPlatform] || []).map((field) => (
                          <div key={field.key}>
                            <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
                            {field.type === "textarea" ? (
                              <textarea
                                value={formData[field.key] || ""}
                                onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                                placeholder={field.placeholder}
                                rows={3}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                              />
                            ) : (
                              <input
                                type={field.type}
                                value={formData[field.key] || ""}
                                onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                                placeholder={field.placeholder}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  </>
                ) : (
                <>
                {/* 公众号 API 凭证录入引导 (路线决策: 保持官方 API, 不走扫码 — 登录态永不过期且合法稳定) */}
                {selectedPlatform === "wechat" && (
                  <div className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 mb-3 space-y-1.5">
                    <p className="font-medium">📋 凭证获取与配置（一次配好，永不过期）：</p>
                    <p>1. 用公众号管理员微信扫码登录 <a href="https://mp.weixin.qq.com" target="_blank" rel="noreferrer" className="underline font-medium">mp.weixin.qq.com</a></p>
                    <p>2. 左侧菜单 <b>设置与开发 → 基本配置</b>：页面上方即 <b>AppID</b>；<b>AppSecret</b> 点"重置"生成（仅显示一次，立即复制；重置不影响已有功能）</p>
                    <p>3. 同页 <b>IP白名单</b> 点"查看"→ 添加服务器 IP：<code className="px-1 py-0.5 bg-blue-100 rounded font-mono font-bold select-all">106.53.163.120</code>（不加白名单接口会报 40164 错误）</p>
                    <p>4. 回到本页填入两项凭证，保存后自动验证</p>
                  </div>
                )}
                <h4 className="text-sm font-medium text-gray-700 mb-3">凭证信息</h4>
                <div className="space-y-3">
                  {(CREDENTIAL_FIELDS[selectedPlatform] || []).map((field) => (
                    <div key={field.key}>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {field.label} {field.required && <span className="text-red-500">*</span>}
                      </label>
                      {field.type === "textarea" ? (
                        <textarea
                          value={formData[field.key] || ""}
                          onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                          placeholder={field.placeholder}
                          rows={3}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                        />
                      ) : (
                        <input
                          type={field.type}
                          value={formData[field.key] || ""}
                          onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                          placeholder={field.placeholder}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      )}
                    </div>
                  ))}
                </div>
                </>
                )}
              </div>
            </div>

            {/* 认证状态（仅微信显示） */}
            {selectedPlatform === "wechat" && (
              <div className="mb-6 border-t border-gray-200 pt-4">
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isCertified}
                    onChange={(e) => setIsCertified(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-gray-800">此账号已通过微信认证（可自动群发）</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      未认证订阅号只能建草稿，需手动发送。勾选后系统会尝试调用 freepublish 接口自动群发；
                      若后续被微信拒（errcode 48001），系统会自动降级为草稿箱模式，不丢内容。
                    </span>
                  </span>
                </label>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex gap-3">
              <button
                onClick={handleAddAccount}
                disabled={adding}
                className={`px-6 py-2 rounded-lg text-sm font-medium text-white transition-all ${
                  adding
                    ? "bg-gray-400 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 active:scale-95"
                }`}
              >
                {adding ? "保存中..." : "保存账号"}
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="px-6 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 transition-all"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {/* 平台筛选 */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {availablePlatforms.map((p) => (
            <button
              key={p}
              onClick={() => setFilterPlatform(p)}
              className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                filterPlatform === p
                  ? "bg-blue-600 text-white"
                  : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* 分组筛选 */}
        {availableGroups.length > 1 && (
          <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
            {availableGroups.map((g) => (
              <button
                key={g}
                onClick={() => setFilterGroup(g)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                  filterGroup === g
                    ? "bg-purple-100 text-purple-700 border border-purple-300"
                    : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        {/* 账号列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="text-4xl mb-3">📭</div>
            <h3 className="text-lg font-medium text-gray-700 mb-2">暂无账号</h3>
            <p className="text-sm text-gray-500">点击上方 "添加账号" 按钮添加您的平台账号</p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(accountsByPlatform).map(([platformKey, platformAccounts]) => {
              const platformInfo = PLATFORM_META[platformKey];
              return (
                <div key={platformKey}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-2xl">{platformInfo.icon}</span>
                    <h3 className="text-lg font-bold text-gray-900">{platformInfo.label}</h3>
                    <span className="text-xs text-gray-400">({platformAccounts.length})</span>
                  </div>

                  <div className="space-y-3">
                    {platformAccounts.map((account) => (
                      <div
                        key={account.id}
                        className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <h4 className="font-medium text-gray-900">{account.accountName}</h4>
                              {(account.metadata?.realNickname || account.accountId) && (
                                <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full" title="扫码登录回填的真实账号">
                                  实登: {account.metadata?.realNickname || ""}{account.accountId ? ` (${account.accountId})` : ""}
                                </span>
                              )}
                              <span
                                className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${
                                  STATUS_COLORS[account.status] || "bg-gray-100 text-gray-600"
                                }`}
                              >
                                {STATUS_LABELS[account.status] || account.status}
                              </span>
                              {account.groupName && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                                  {account.groupName}
                                </span>
                              )}
                              <select
                                value={account.journalScope || "both"}
                                onChange={(e) => handleScopeChange(account.id, e.target.value)}
                                title="期刊定位"
                                className="text-xs px-2 py-0.5 rounded-full border border-teal-200 bg-teal-50 text-teal-700 focus:outline-none cursor-pointer"
                              >
                                <option value="both">两者都做</option>
                                <option value="domestic">国内核心</option>
                                <option value="international">国外期刊</option>
                              </select>
                              <button
                                onClick={() => setDiscEditId(discEditId === account.id ? null : account.id)}
                                title="领域定位(可多选) — 一键生成时该账号只产这些领域的内容"
                                className="text-xs px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 cursor-pointer hover:bg-indigo-100"
                              >
                                {(() => {
                                  const ds = account.disciplines ?? (account.discipline ? [account.discipline] : []);
                                  return ds.length > 0 ? `领域: ${ds.map(discLabel).join("·")}` : "领域不限 ▾";
                                })()}
                              </button>
                              <button
                                onClick={() => openPersona(account)}
                                title="人设画像与风格学习 — 该账号生成内容的语气与文风"
                                className={`text-xs px-2 py-0.5 rounded-full border cursor-pointer ${account.persona || account.styleProfile ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100" : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100"}`}
                              >
                                {account.persona || account.styleProfile ? "人设·风格 ✓" : "人设·风格 ▾"}
                              </button>
                            </div>
                            {discEditId === account.id && (
                              <div className="flex flex-wrap gap-1.5 my-1.5">
                                {DISC_OPTIONS.map(([k, label]) => {
                                  const ds = new Set(account.disciplines ?? (account.discipline ? [account.discipline] : []));
                                  const on = ds.has(k);
                                  return (
                                    <button
                                      key={k}
                                      onClick={() => handleDisciplineToggle(account, k)}
                                      className={`text-xs px-2 py-0.5 rounded-full border ${on ? "border-indigo-500 bg-indigo-600 text-white" : "border-gray-200 bg-white text-gray-600 hover:border-indigo-300"}`}
                                    >
                                      {label}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                            {personaEditId === account.id && (
                              <div className="my-2 p-3 rounded-lg border border-amber-100 bg-amber-50/40 space-y-2">
                                <div>
                                  <div className="text-xs font-medium text-gray-700 mb-1">人设画像 (语气 / 自称 / 受众称呼 / 口头禅 / 禁忌)</div>
                                  <textarea
                                    value={personaDraft}
                                    onChange={(e) => setPersonaDraft(e.target.value)}
                                    rows={3}
                                    placeholder="例: 自称「卡卡学姐」, 称读者「同学们」, 语气亲切带点毒舌, 爱用反问句, 禁谈政治, 受众是硕博生和青椒..."
                                    className="w-full text-sm px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-amber-400"
                                  />
                                  <button onClick={() => void savePersona(account.id)} disabled={personaSaving}
                                    className="mt-1 text-xs px-3 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                                    {personaSaving ? "保存中…" : "保存人设"}
                                  </button>
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-gray-700 mb-1">
                                    风格学习 — 贴 1-5 篇范文 (自己的爆款或对标号文章, 多篇用单独一行 --- 分隔)
                                    {account.styleProfile && <span className="text-emerald-600 ml-2">已有风格画像 ✓ (重新提炼会覆盖)</span>}
                                  </div>
                                  <textarea
                                    value={samplesDraft}
                                    onChange={(e) => setSamplesDraft(e.target.value)}
                                    rows={4}
                                    placeholder="把范文全文贴进来..."
                                    className="w-full text-sm px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-amber-400"
                                  />
                                  <button onClick={() => void learnStyle(account.id)} disabled={styleLearning}
                                    className="mt-1 text-xs px-3 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                                    {styleLearning ? "提炼中… (约30秒)" : "提炼风格画像"}
                                  </button>
                                </div>
                              </div>
                            )}
                            <div className="flex items-center gap-3 text-xs text-gray-500">
                              <span>创建于 {new Date(account.createdAt).toLocaleDateString("zh-CN")}</span>
                              {account.lastPublishAt && (
                                <span>
                                  最后发布 {new Date(account.lastPublishAt).toLocaleDateString("zh-CN")}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* 操作按钮 */}
                          <div className="flex items-center gap-2 ml-4">
                            {/* PR-S4: 抖音/视频号 — 登录状态 + 扫码登录 (推草稿箱前置条件) */}
                            {["douyin", "wechat_video"].includes(account.platform) && (
                              <>
                                {/* 6-17 #4: 抖音/视频号发布走本地Agent → 徽标看"Agent设备是否在线", 不再用服务器扫码态(会显示"已登录"实则发不出) */}
                                <span className={`text-xs px-2 py-0.5 rounded-full ${
                                  account.agentOnline
                                    ? "bg-green-100 text-green-700"
                                    : account.agentDeviceId
                                      ? "bg-amber-100 text-amber-700"
                                      : "bg-gray-100 text-gray-500"
                                }`} title={account.agentDeviceId ? "已绑定本地Agent设备" : "尚未绑定任何Agent设备 — 在客户机扫码登录后自动绑定"}>
                                  {account.agentOnline ? "🟢 Agent在线" : account.agentDeviceId ? "⚪ Agent离线" : "未绑定设备"}
                                </span>
                                <button
                                  onClick={() => startQrLogin(account)}
                                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-100 text-blue-700 hover:bg-blue-200 active:scale-95 transition-all"
                                >
                                  {account.agentDeviceId ? "重新扫码" : "📱 扫码登录"}
                                </button>
                              </>
                            )}
                            {!account.isVerified && (
                              <button
                                onClick={() => handleVerify(account.id)}
                                disabled={verifying[account.id]}
                                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                                  verifying[account.id]
                                    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                                    : "bg-amber-100 text-amber-700 hover:bg-amber-200 active:scale-95"
                                }`}
                              >
                                {verifying[account.id] ? "验证中..." : "验证"}
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(account.id)}
                              disabled={deleting[account.id]}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                                deleting[account.id]
                                  ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                                  : "bg-red-100 text-red-600 hover:bg-red-200 active:scale-95"
                              }`}
                            >
                              {deleting[account.id] ? "删除中..." : "删除"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* PR-S4: 扫码登录 Modal */}
      {qrModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setQrModal(null)}>
          <div className="bg-white rounded-2xl p-6 w-[360px] text-center" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">扫码登录</h3>
            <p className="text-xs text-gray-500 mb-4">{qrModal.accountName} — 用该账号绑定的手机扫码</p>
            {qrModal.status === "starting" && (
              <div className="py-12 flex flex-col items-center gap-3">
                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-gray-500">正在打开平台登录页…</span>
              </div>
            )}
            {qrModal.status === "waiting" && (
              qrModal.qrPng ? (
                <img src={`data:image/png;base64,${qrModal.qrPng}`} alt="登录二维码" className="mx-auto w-56 h-56 object-contain border border-gray-100 rounded-lg" />
              ) : (
                <div className="py-12 text-sm text-gray-500">二维码加载中…</div>
              )
            )}
            {qrModal.status === "waiting_sms" && (
              <div className="space-y-3">
                {qrModal.qrPng && (
                  <img
                    src={`data:image/png;base64,${qrModal.qrPng}`}
                    alt="身份验证页面 (可点击操作)"
                    onClick={remoteClickShot}
                    className="mx-auto w-full max-h-72 object-contain border border-gray-100 rounded-lg cursor-crosshair"
                    title="直接点击画面操作页面"
                  />
                )}
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-left">
                  抖音要求身份验证。<b>上方画面可直接点击操作</b>：先点「发送短信验证」那一行 → 画面刷新后点「获取验证码」→ 手机收到短信后在下方输入验证码提交
                </p>
                <div className="flex gap-2">
                  <input
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    onKeyDown={(e) => { if (e.key === "Enter") submitSms(); }}
                    placeholder="短信验证码"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={submitSms}
                    disabled={smsSubmitting || !smsCode.trim()}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >{smsSubmitting ? "提交中…" : "提交"}</button>
                </div>
                <button onClick={resendSms} className="text-xs text-blue-600 hover:text-blue-800">没收到？重新发送验证码</button>
              </div>
            )}
            {qrModal.status === "success" && (
              <div className="py-10 text-green-600 text-sm font-medium">✅ 登录成功,登录态已保存</div>
            )}
            {(qrModal.status === "expired" || qrModal.status === "failed") && (
              <div className="py-8 space-y-3">
                <p className="text-sm text-red-500">{qrModal.error || "二维码已过期"}</p>
                <button
                  onClick={() => { const acc = accounts.find(a => a.id === qrModal.accountId); if (acc) startQrLogin(acc); }}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >重新获取二维码</button>
              </div>
            )}
            <button onClick={() => setQrModal(null)} className="mt-4 text-xs text-gray-400 hover:text-gray-600">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}
