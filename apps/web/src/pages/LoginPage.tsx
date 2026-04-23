import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";

/* ───── 动画粒子背景 ───── */
function ParticleBg() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* 渐变背景 */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 via-slate-900 to-purple-950" />
      {/* 光晕 */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-indigo-500/20 rounded-full blur-3xl animate-pulse" />
      <div className="absolute -bottom-32 -right-32 w-80 h-80 bg-purple-500/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "1s" }} />
      <div className="absolute top-1/3 right-1/4 w-64 h-64 bg-cyan-400/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: "2s" }} />
      {/* 网格线 */}
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

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  // 恢复"记住我"的邮箱
  useEffect(() => {
    const saved = localStorage.getItem("bossmate_remember_email");
    if (saved) setEmail(saved);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("请填写邮箱和密码");
      return;
    }
    setLoading(true);

    try {
      const res = await api.post<{
        token: string;
        user: { id: string; name: string; email: string; role: string };
      }>("/auth/login", { email: email.trim(), password });

      if (res.data) {
        // 记住邮箱
        if (remember) {
          localStorage.setItem("bossmate_remember_email", email.trim());
        } else {
          localStorage.removeItem("bossmate_remember_email");
        }
        login(res.data.token, res.data.user);
        navigate("/");
      }
    } catch (err: any) {
      setError(err.message || "登录失败，请检查邮箱和密码");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <ParticleBg />

      {/* ─ 登录卡片 ─ */}
      <div className="relative z-10 w-full max-w-md mx-4">
        {/* 毛玻璃卡片 */}
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
            <h1 className="text-2xl font-bold text-white tracking-tight">BossMate</h1>
            <p className="text-sm text-slate-400 mt-1">AI 内容工厂 · 智能期刊推荐平台</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* 邮箱 */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">邮箱</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                placeholder="your@email.com"
                autoComplete="email"
                required
              />
            </div>

            {/* 密码 */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">密码</label>
              <div className="relative">
                <input
                  type={showPwd ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 pr-12 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition-all"
                  placeholder="请输入密码"
                  autoComplete="current-password"
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
            </div>

            {/* 记住我 */}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="w-4 h-4 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500/30"
                />
                <span className="text-sm text-slate-400">记住邮箱</span>
              </label>
              <button type="button" className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                忘记密码？
              </button>
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

            {/* 登录按钮 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold rounded-xl hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40 active:scale-[0.98]"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  登录中...
                </span>
              ) : "登 录"}
            </button>
          </form>

          {/* 注册链接 */}
          <p className="text-center text-sm text-slate-500 mt-8">
            还没有账号？{" "}
            <Link to="/register" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
              立即注册
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
