import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

interface WechatConfig {
  appId: string;
  appSecretMask: string;
  accountName: string;
  isVerified: boolean;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  updatedAt: string;
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
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

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

  // T4-3-5: 模板偏好统计
  const [templatePrefs, setTemplatePrefs] = useState<TemplatePreferenceItem[]>([]);
  const [templateTotalSelections, setTemplateTotalSelections] = useState(0);
  const [loadingTemplatePrefs, setLoadingTemplatePrefs] = useState(true);

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
    <div className="min-h-screen bg-gray-50">
      {/* 顶栏 */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-xl font-bold text-green-600">BossMate</Link>
          <span className="text-gray-300">|</span>
          <span className="text-gray-600 font-medium">{"\u2699\uFE0F"} 系统设置</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">{user?.name || user?.email}</span>
          <button onClick={logout} className="text-gray-400 hover:text-red-500">退出</button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        {/* 面包屑 */}
        <div className="mb-6">
          <Link to="/" className="text-sm text-blue-600 hover:underline">{"\u2190"} 返回首页</Link>
        </div>

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

        {/* 内容方向偏好 */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-xl">{"\uD83C\uDFAF"}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">内容方向偏好</h2>
              <p className="text-sm text-gray-500">选择你关注的学科方向，AI会优先生成这些领域的内容。不选则覆盖全部学科。</p>
            </div>
          </div>

          {prefLoading ? (
            <div className="text-center py-6 text-gray-400">加载中...</div>
          ) : (
            <div className="space-y-5">
              {/* 学科选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">关注学科（可多选）</label>
                <div className="flex flex-wrap gap-2">
                  {ALL_DISCIPLINES.map((d) => {
                    const isSelected = focusDisciplines.includes(d.code);
                    return (
                      <button
                        key={d.code}
                        onClick={() => toggleDiscipline(d.code)}
                        className={`px-4 py-2 rounded-full text-sm font-medium border transition-all ${
                          isSelected
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  {focusDisciplines.length === 0
                    ? "当前：全学科模式（每个学科均衡推荐）"
                    : `已选 ${focusDisciplines.length} 个学科`}
                </p>
              </div>

              {/* 每日文章数 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">每日生成文章数</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={dailyArticleLimit}
                    onChange={(e) => setDailyArticleLimit(Number(e.target.value))}
                    className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <span className="text-sm font-bold text-blue-600 w-8 text-center">{dailyArticleLimit}</span>
                </div>
              </div>

              {/* 保存结果 */}
              {prefResult && (
                <div className={`p-3 rounded-lg text-sm ${prefResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
                  {prefResult.msg}
                </div>
              )}

              {/* 保存按钮 */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={handleSavePreferences}
                  disabled={prefSaving}
                  className={`px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${prefSaving ? "bg-gray-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 active:scale-95"}`}
                >
                  {prefSaving ? "保存中..." : "保存偏好"}
                </button>
                {focusDisciplines.length > 0 && (
                  <button
                    onClick={() => setFocusDisciplines([])}
                    className="px-4 py-2.5 rounded-lg text-sm text-gray-500 hover:text-red-500"
                  >
                    清空选择
                  </button>
                )}
              </div>
            </div>
          )}
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

        {/* 微信公众号配置 */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-lg bg-green-100 flex items-center justify-center text-xl">{"\uD83D\uDCF1"}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">微信公众号配置</h2>
              <p className="text-sm text-gray-500">配置AppID和AppSecret后，可一键将文章发布到公众号草稿箱</p>
            </div>
            {wechatConfig?.isVerified && (
              <span className="ml-auto px-3 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-full">{"\u2705"} 已验证</span>
            )}
            {wechatConfig && !wechatConfig.isVerified && (
              <span className="ml-auto px-3 py-1 text-xs font-medium bg-red-100 text-red-600 rounded-full">{"\u274C"} 验证失败</span>
            )}
          </div>

          {loading ? (
            <div className="text-center py-8 text-gray-400">加载中...</div>
          ) : (
            <div className="space-y-4">
              {/* AppID */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  AppID <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="wx1234567890abcdef"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                />
                <p className="text-xs text-gray-400 mt-1">在微信公众平台 → 设置与开发 → 基本配置 中获取</p>
              </div>

              {/* AppSecret */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  AppSecret <span className="text-red-400">*</span>
                  {wechatConfig?.appSecretMask && (
                    <span className="ml-2 text-xs text-gray-400 font-normal">
                      当前: {wechatConfig.appSecretMask}
                    </span>
                  )}
                </label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    placeholder={wechatConfig ? "留空则保持不变" : "请输入AppSecret"}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 pr-20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
                  >
                    {showSecret ? "隐藏" : "显示"}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">AppSecret只显示一次，请妥善保管。如遗忘可在公众平台重置</p>
              </div>

              {/* 公众号名称（可选） */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">公众号名称（可选）</label>
                <input
                  type="text"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="例如：医学期刊助手"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                />
              </div>

              {/* 保存结果提示 */}
              {saveResult && saveResult.msg === "IP_WHITELIST_ERROR" && (
                <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{"\u26A0\uFE0F"}</span>
                    <strong className="text-amber-800">AppID/AppSecret正确，但服务器IP未加白名单</strong>
                  </div>
                  <p className="text-amber-700 mb-3">微信要求将调用API的服务器IP加入白名单才能使用。请按以下步骤操作：</p>
                  <ol className="space-y-2 text-amber-700">
                    <li className="flex gap-2">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-xs font-bold shrink-0">1</span>
                      <span>登录 <a href="https://mp.weixin.qq.com" target="_blank" rel="noreferrer" className="text-blue-600 underline">微信公众平台</a></span>
                    </li>
                    <li className="flex gap-2">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-xs font-bold shrink-0">2</span>
                      <span>进入 <strong>设置与开发 → 基本配置 → IP白名单</strong></span>
                    </li>
                    <li className="flex gap-2">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-xs font-bold shrink-0">3</span>
                      <span>添加IP: <code className="px-2 py-0.5 bg-amber-100 rounded font-mono text-amber-900 font-bold">106.53.163.120</code></span>
                    </li>
                    <li className="flex gap-2">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center text-xs font-bold shrink-0">4</span>
                      <span>回到此页面，点击 "保存并验证" 即可通过</span>
                    </li>
                  </ol>
                </div>
              )}
              {saveResult && saveResult.msg !== "IP_WHITELIST_ERROR" && (
                <div className={`p-3 rounded-lg text-sm ${saveResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
                  {saveResult.msg}
                </div>
              )}

              {/* 保存按钮 */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className={`px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all ${saving ? "bg-gray-400 cursor-not-allowed" : "bg-green-600 hover:bg-green-700 active:scale-95"}`}
                >
                  {saving ? "保存并验证中..." : "保存并验证"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 配置指南 */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-base font-bold text-gray-900 mb-4">{"\uD83D\uDCD6"} 公众号配置指南</h3>
          <div className="space-y-3 text-sm text-gray-600">
            <div className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold shrink-0">1</span>
              <p>登录 <a href="https://mp.weixin.qq.com" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">微信公众平台 mp.weixin.qq.com</a></p>
            </div>
            <div className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold shrink-0">2</span>
              <p>进入 "设置与开发" → "基本配置"</p>
            </div>
            <div className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold shrink-0">3</span>
              <p>复制 AppID，点击重置获取 AppSecret</p>
            </div>
            <div className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold shrink-0">4</span>
              <p>在 "IP白名单" 中添加服务器IP: <code className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">106.53.163.120</code></p>
            </div>
            <div className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-xs font-bold shrink-0">5</span>
              <p>回到此页面，填入AppID和AppSecret，点击 "保存并验证"</p>
            </div>
          </div>

          <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-700">
            <strong>{"\u26A0\uFE0F"} 注意:</strong> 需要<strong>已认证的服务号</strong>才能使用草稿箱和发布API。订阅号无法使用此功能，但仍可通过 "复制文本" 或 "导出HTML" 手动发布。
          </div>
        </div>
      </div>
    </div>
  );
}
