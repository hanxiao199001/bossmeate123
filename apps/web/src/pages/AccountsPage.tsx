import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ===== 类型定义 =====
interface Account {
  id: string;
  platform: string;
  accountName: string;
  credentials: Record<string, unknown>;
  groupName?: string;
  status: string;
  isVerified: boolean;
  lastPublishAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ===== 平台配置 =====
const PLATFORM_INFO: Record<string, { name: string; icon: string; color: string }> = {
  wechat: { name: "微信公众号", icon: "💬", color: "bg-green-100 text-green-700" },
  baijiahao: { name: "百家号", icon: "📰", color: "bg-blue-100 text-blue-700" },
  toutiao: { name: "头条号", icon: "📱", color: "bg-red-100 text-red-700" },
  zhihu: { name: "知乎", icon: "🔍", color: "bg-blue-100 text-blue-600" },
  xiaohongshu: { name: "小红书", icon: "📕", color: "bg-pink-100 text-pink-700" },
};

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
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  // 账号列表状态
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);

  // 筛选状态
  const [filterPlatform, setFilterPlatform] = useState("全部");
  const [filterGroup, setFilterGroup] = useState("全部");

  // 添加账号表单状态
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState("wechat");
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [accountName, setAccountName] = useState("");
  const [groupName, setGroupName] = useState("");
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
    for (const field of fields) {
      if (field.required && !formData[field.key]?.trim()) {
        setAddMsg(`请填写 ${field.label}`);
        return;
      }
    }

    setAdding(true);
    setAddMsg("");
    try {
      const res = await api.post<Account>("/accounts", {
        platform: selectedPlatform,
        accountName: accountName.trim(),
        credentials: formData,
        groupName: groupName.trim() || undefined,
      });

      if (res.data) {
        setAddMsg("账号添加成功！");
        setShowAddForm(false);
        setAccountName("");
        setGroupName("");
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
    } finally {
      setVerifying(prev => ({ ...prev, [accountId]: false }));
    }
  };

  // 删除账号
  const handleDelete = async (accountId: string) => {
    if (!confirm("确定要删除这个账号吗？")) return;

    setDeleting(prev => ({ ...prev, [accountId]: true }));
    try {
      await api.delete(`/accounts/${accountId}`);
      fetchAccounts();
    } catch (err) {
      console.error("删除失败", err);
    } finally {
      setDeleting(prev => ({ ...prev, [accountId]: false }));
    }
  };

  // 获取可用平台列表
  const availablePlatforms = ["全部", ...Object.keys(PLATFORM_INFO)];
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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-blue-600">BossMate</span>
            <span className="text-xs text-gray-400">AI超级员工</span>
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-sm font-medium text-gray-700">多平台账号管理</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">
            退出
          </button>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto py-6 px-6">
        {/* 页面标题与操作 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">多平台账号管理</h1>
            <p className="text-sm text-gray-500 mt-1">管理和验证您在各个平台的内容发布账号</p>
          </div>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-5 py-2 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-medium rounded-lg transition-all active:scale-95"
          >
            + 添加账号
          </button>
        </div>

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
                  {Object.entries(PLATFORM_INFO).map(([key, info]) => (
                    <option key={key} value={key}>{info.name}</option>
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
            </div>

            {/* 动态凭证字段 */}
            <div className="space-y-4 mb-6">
              <div className="border-t border-gray-200 pt-4">
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
              </div>
            </div>

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
              const platformInfo = PLATFORM_INFO[platformKey];
              return (
                <div key={platformKey}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-2xl">{platformInfo.icon}</span>
                    <h3 className="text-lg font-bold text-gray-900">{platformInfo.name}</h3>
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
                            </div>
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
    </div>
  );
}
