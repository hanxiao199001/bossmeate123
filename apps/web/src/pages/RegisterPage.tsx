import { useState, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";

/* ───── 动画粒子背景（与 LoginPage 一致） ───── */
function ParticleBg() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-slate-900 to-purple-950" />
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-indigo-500/20 rounded-full blur-3xl animate-pulse" />
      <div className="absolute -bottom-32 -right-32 w-80 h-80 bg-purple-500/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "1s" }} />
      <div className="absolute top-1/3 right-1/4 w-64 h-64 bg-cyan-400/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "2s" }} />
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />
    </div>
  );
}

/* ───── 密码可见切换图标 ───── */
function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  ) : (
    <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

/* ───── 密码强度指示器 ───── */
function PasswordStrength({ password }: { password: string }) {
  const { score, label, color, segments } = useMemo(() => {
    if (!password) return { score: 0, label: "", color: "", segments: 0 };

    let s = 0;
    if (password.length >= 6) s++;
    if (password.length >= 10) s++;
    if (/[A-Z]/.test(password)) s++;
    if (/[0-9]/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;

    const levels: Array<{ label: string; color: string; segments: number }> = [
      { label: "", color: "", segments: 0 },
      { label: "弱", color: "bg-red-500", segments: 1 },
      { label: "较弱", color: "bg-orange-500", segments: 2 },
      { label: "中等", color: "bg-yellow-500", segments: 3 },
      { label: "强", color: "bg-green-500", segments: 4 },
      { label: "很强", color: "bg-emerald-400", segments: 5 },
    ];

    return { score: s, ...levels[s] };
  }, [password]);

  if (!password) return null;

  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-all duration-300 ${
              i <= segments ? color : "bg-white/10"
            }`}
          />
        ))}
      </div>
      <p className={`text-xs mt-1 transition-colors ${
        score <= 2 ? "text-red-400" : score <= 3 ? "text-yellow-400" : "text-green-400"
      }`}>
        密码强度：{label}
      </p>
    </div>
  );
}

export default function RegisterPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    tenantName: "",
    phone: "",
  });
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<1 | 2>(1); // 分步注册
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleNext() {
    setError("");
    if (!form.tenantName.trim()) {
      setError("请填写企业/机构名称");
      return;
    }
    if (!form.name.trim()) {
      setError("请填写您的姓名");
      return;
    }
    setStep(2);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!form.email.trim()) {
      setError("请填写邮箱");
      return;
    }
    if (form.password.length < 6) {
      setError("密码至少需要 6 位");
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setLoading(true);

    try {
      const { confirmPassword, ...payload } = form;
      const res = await api.post<{
        token: string;
        user: { id: string; name: string; email: string; role: string };
        tenant: { id: string; name: string; slug: string };
      }>("/auth/register", payload);

      if (res.data) {
        login(res.data.token, res.data.user, res.data.tenant);
        navigate("/");
      }
    } catch (err: any) {
      setError(err.message || "注册失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <ParticleBg />

      <div className="relative z-10 w-full max-w-md mx-4">
        <div
          className="backdrop-blur-xl rounded-3xl p-8 sm:p-10 shadow-2xl border border-white/10"
          style={{ background: "rgba(255,255,255,0.07)" }}
        >
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/30 mb-4">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">创建账户</h1>
            <p className="text-sm text-slate-400 mt-1">BossMate · AI 内容工厂</p>
          </div>

          {/* 步骤指示器 */}
          <div className="flex items-center gap-3 mb-8">
            <div className="flex items-center gap-2 flex-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                step >= 1 ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30" : "bg-white/10 text-slate-500"
              }`}>1</div>
              <span className={`text-xs font-medium transition-colors ${step >= 1 ? "text-indigo-300" : "text-slate-600"}`}>基本信息</span>
            </div>
            <div className={`flex-1 h-px transition-colors ${step >= 2 ? "bg-indigo-500" : "bg-white/10"}`} />
            <div className="flex items-center gap-2 flex-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                step >= 2 ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30" : "bg-white/10 text-slate-500"
              }`}>2</div>
              <span className={`text-xs font-medium transition-colors ${step >= 2 ? "text-indigo-300" : "text-slate-600"}`}>账户设置</span>
            </div>
          </div>

          {/* Step 1: 基本信息 */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">企业 / 机构名称</label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={form.tenantName}
                    onChange={(e) => updateField("tenantName", e.target.value)}
                    className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                    placeholder="如：某某期刊社"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">姓名</label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => updateField("name", e.target.value)}
                    className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                    placeholder="您的姓名"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">手机号（选填）</label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                    </svg>
                  </div>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => updateField("phone", e.target.value)}
                    className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                    placeholder="13800138000"
                  />
                </div>
              </div>

              {/* 错误提示 */}
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 p-3 rounded-xl">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                  </svg>
                  {error}
                </div>
              )}

              <button
                type="button"
                onClick={handleNext}
                className="w-full py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 transition-all shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 active:scale-[0.98] flex items-center justify-center gap-2"
              >
                下一步
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
              </button>
            </div>
          )}

          {/* Step 2: 账户设置 */}
          {step === 2 && (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">邮箱</label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                    </svg>
                  </div>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => updateField("email", e.target.value)}
                    className="w-full pl-11 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                    placeholder="your@email.com"
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">密码</label>
                <div className="relative">
                  <input
                    type={showPwd ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => updateField("password", e.target.value)}
                    className="w-full px-4 py-3 pr-12 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                    placeholder="至少 6 位，建议包含大小写和数字"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd(!showPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded-lg transition-colors"
                    tabIndex={-1}
                  >
                    <EyeIcon visible={showPwd} />
                  </button>
                </div>
                <PasswordStrength password={form.password} />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">确认密码</label>
                <div className="relative">
                  <input
                    type={showConfirmPwd ? "text" : "password"}
                    value={form.confirmPassword}
                    onChange={(e) => updateField("confirmPassword", e.target.value)}
                    className={`w-full px-4 py-3 pr-12 bg-white/5 border rounded-xl text-white placeholder-slate-500 focus:ring-2 outline-none transition-all ${
                      form.confirmPassword && form.confirmPassword !== form.password
                        ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
                        : form.confirmPassword && form.confirmPassword === form.password
                          ? "border-green-500/50 focus:border-green-500 focus:ring-green-500/30"
                          : "border-white/10 focus:border-indigo-500 focus:ring-indigo-500/30"
                    }`}
                    placeholder="再次输入密码"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPwd(!showConfirmPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-white/10 rounded-lg transition-colors"
                    tabIndex={-1}
                  >
                    <EyeIcon visible={showConfirmPwd} />
                  </button>
                </div>
                {form.confirmPassword && form.confirmPassword !== form.password && (
                  <p className="text-xs text-red-400 mt-1.5">两次输入的密码不一致</p>
                )}
                {form.confirmPassword && form.confirmPassword === form.password && (
                  <p className="text-xs text-green-400 mt-1.5">密码一致</p>
                )}
              </div>

              {/* 错误提示 */}
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 p-3 rounded-xl">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                  </svg>
                  {error}
                </div>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => { setStep(1); setError(""); }}
                  className="px-6 py-3.5 bg-white/5 border border-white/10 text-slate-300 font-medium rounded-xl hover:bg-white/10 transition-all active:scale-[0.98]"
                >
                  返回
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-1 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 active:scale-[0.98]"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      注册中...
                    </span>
                  ) : "创建账户"}
                </button>
              </div>
            </form>
          )}

          {/* 登录链接 */}
          <p className="text-center text-sm text-slate-500 mt-8">
            已有账号？{" "}
            <Link to="/login" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
              立即登录
            </Link>
          </p>
        </div>

        {/* 底部版权 */}
        <p className="text-center text-xs text-slate-600 mt-6">
          &copy; 2026 BossMate &middot; 顺仕美途科研服务平台
        </p>
      </div>
    </div>
  );
}
